import os
import json
import uuid
import time
import boto3
import socket
import logging
import urllib.request
import urllib.error


logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Some default values
DEFAULT_CONNECTIVITY_CHECK_INTERVAL = 10
DEFAULT_FUNCTION_TIMEOUT = 300
DEFAULT_CHECK_URLS = ["https://www.example.com", "https://www.google.com"]
DEFAULT_REQUEST_TIMEOUT = 8
DEFAULT_UNHEALTHY_THRESHOLD = 3


def emit_connectivity_metric(url: str, latency: float, context: dict, availability_zone: str) -> None:
    """
    Emits CloudWatch metric using embeded metrics in logs so we can measure the connectivity latency of each
    private subnet in our VPCs.

    Parameters
    ----------
    url : str
        url dimension of the connectivity metric
    latency : float
        amount of seconds that the connectivity request took
    context : dict
        Lambda context passed to the function used to fetch function region which is another dimension
    availability_zone : str
        Availability zone to which this metric is referred to
    """
    region = context.invoked_function_arn.split(":")[3]

    metric_record = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": "NatInstances",
                    "Dimensions": [["AvailabilityZone", "Region", "Url"]],
                    "Metrics": [
                        {
                            "Name": "NatLatency",
                            "Unit": "Seconds",
                            "StorageResolution": 60,  # Standard resolution of one minute,
                        },
                    ],
                },
            ],
        },
        "AvailabilityZone": availability_zone,
        "Region": region,
        "Url": url,
        "NatLatency": latency,
    }
    # Emit raw embbeded CloudWatch metrics
    # https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
    print(json.dumps(metric_record, default=str))


def emit_failover_metric(context: dict) -> None:
    """
    Emits CloudWatch metric using embeded metrics in logs so we can know if the Failover processed was triggered
    because of connection issues.

    Parameters
    ----------
    context : dict
        Lambda context passed to the function used to fetch function region which is a dimension
    """
    region = context.invoked_function_arn.split(":")[3]

    metric_record = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": "NatInstances",
                    "Dimensions": [["Region"]],
                    "Metrics": [
                        {
                            "Name": "NatFailover",
                            "Unit": "Unit",
                            "StorageResolution": 60,  # Standard resolution of one minute,
                        },
                    ],
                },
            ],
        },
        "Region": region,
        "NatFailover": 1,
    }
    # Emit raw embbeded CloudWatch metrics
    # https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
    print(json.dumps(metric_record, default=str))


def check_connection(check_url: str, request_timeout: int, context: dict, availability_zone: str) -> bool:
    """
    Checks the connectivity of provided url trying to open url and capturing errors in case they fail.

    Parameters
    ----------
    check_url : str
        Url to check the connectivity to
    request_timeout : int
        Time in seconds to wait for the requests before timing out
    context : dict
        Lambda context passed to the function used to pass to the 'emit_connectivity_metric' method
    availability_zone : str
        Availability zone to which the connectivity is checked to
    """
    try:
        start_time = time.time()
        urllib.request.urlopen(check_url, timeout=request_timeout)
        end_time = time.time()

        try:
            latency = end_time - start_time
            emit_connectivity_metric(check_url, latency, context, availability_zone)
        except Exception as error:
            logger.warning(f"Metric failed to emit: {error}")

    except (urllib.error.URLError, urllib.error.HTTPError) as error:
        logger.error(f"error connecting to {check_url}: {error}")
        return False
    except socket.timeout as error:
        logger.error(f"timeout error connecting {check_url}: {error}")
        return False

    return True


def invoke_failover(context: dict, availability_zone: str, failover_state_machine_arn: str) -> None:
    """
    Method to invoke the NAT instances failover state machine that will change private subnets routes to use
    NAT Gateway instead of NAT instances.

    Parameters
    ----------
    context : dict
        Lambda context passed to the function used to pass to the 'emit_failover_metric' method
    availability_zone : str
        Availability zone causing the failover triggering
    failover_state_machine_arn : str
        ARN of the failover state machine
    """
    region = failover_state_machine_arn.split(":")[3]

    client = boto3.client("stepfunctions", region_name=region)

    client.start_execution(
        stateMachineArn=failover_state_machine_arn,
        name=f"ConnectionFailing_{availability_zone}_{uuid.uuid4()}",
    )
    logger.warning("Triggered Failover state machine")

    try:
        emit_failover_metric(context)
    except Exception as error:
        logger.warning(f"Metric failed to emit: {error}")


def handler(event: dict, context: dict) -> None:
    """
    Connectivity checker Lambda handler function. It will check the provided urls at regular intervals and will emit
    metrics to measure connectivity reliability. It also triggers the Failover state machine in case the
    unhealthy threshold is exceeded.

    Parameters
    ----------
    event : dict
        Lambda input event - not used at this time
    context : dict
        Lambda context used to pass to the 'emit_connectivity_metric' method
    """
    # Fetch configuration values from environment variables or failover to default values
    check_interval = int(os.getenv("CONNECTIVITY_CHECK_INTERVAL", DEFAULT_CONNECTIVITY_CHECK_INTERVAL))
    check_time_limit = int(os.getenv("FUNCTION_TIMEOUT", DEFAULT_FUNCTION_TIMEOUT))
    check_urls = "CHECK_URLS" in os.environ and os.getenv("CHECK_URLS").split(",") or DEFAULT_CHECK_URLS
    request_timeout = int(os.getenv("REQUEST_TIMEOUT", DEFAULT_REQUEST_TIMEOUT))
    unhealthy_threshold = int(os.getenv("UNHEALTHY_THRESHOLD", DEFAULT_UNHEALTHY_THRESHOLD))
    failover_state_machine_arn = os.getenv("FAILOVER_STATE_MACHINE_ARN", "unknown")
    availability_zone = os.getenv("AVAILABILITY_ZONE", "unknown")

    failed_checks_count = 0
    runs_count = 0
    urls_count = len(check_urls)

    runs_limit = (check_time_limit / check_interval) - 1

    while runs_count < runs_limit:
        if failed_checks_count >= (unhealthy_threshold * urls_count):
            invoke_failover(context, availability_zone, failover_state_machine_arn)
            raise RuntimeError("Unhealthy threshold reached. Triggered Failover")

        start_time = time.time()
        for url in check_urls:
            if not check_connection(url, request_timeout, context, availability_zone):
                failed_checks_count += 1

        end_time = time.time()
        wait_time = check_interval - (end_time - start_time)
        wait_time = 0 if wait_time < 0 else wait_time  # sanity check to ensure wait_time is not negative
        time.sleep(wait_time)

        runs_count += 1
