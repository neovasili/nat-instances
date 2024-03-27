import os
import logging
import boto3


logger = logging.getLogger()
logger.setLevel(logging.INFO)

client = boto3.client("ec2")

# Fetch configuration values from environment variables or failover to default values
NAT_IMAGES_AMI_NAME_TAG_PATTERN = os.getenv("NAT_IMAGES_AMI_NAME_TAG_PATTERN", "NAT-*")


def handler(event: dict, context: dict):
    """
    Get latest NAT instance image ID function. It get all owned NAT instances images (using tags and name to filter)
    and returns only the most recent one.

    Parameters
    ----------
    event : dict
        Lambda input event - not used at this time
    context : dict
        Lambda context used to pass to the fetch the AWS account ID

    Returns
    -------
    str
        The latest AMI ID of the NAT instances images
    """
    logger.info("Fetching Latest NAT instance image")

    aws_account_id = context.invoked_function_arn.split(":")[4]

    response = client.describe_images(
        Filters=[
            {
                "Name": "name",
                "Values": [NAT_IMAGES_AMI_NAME_TAG_PATTERN],
            },
            {
                "Name": "tag:CreatedBy",
                "Values": ["EC2 Image Builder"],
            },
        ],
        IncludeDeprecated=False,
        Owners=[aws_account_id],
    )

    # Sort the returned list descending by CreationDate so the first element is the most recent one
    images = sorted(response["Images"], key=lambda field: field["CreationDate"], reverse=True)

    latest_image_id = images[0]["ImageId"]

    logger.info(f"Latest image ID is '{latest_image_id}'")

    return latest_image_id
