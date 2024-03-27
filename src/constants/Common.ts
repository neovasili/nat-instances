import { Duration } from 'aws-cdk-lib';
import { Timeout, JsonPath } from 'aws-cdk-lib/aws-stepfunctions';

/**
 * Number of availability zones to use
 */
const NUMBER_OF_AVAILABILITY_ZONES = 3;

/**
 * Version of the image recipe
 *
 * This value needs to be changed if anything in the recipe changes, including components versions
 */
const IMAGE_RECIPE_VERSION = '0.1.0';

/**
 * Default Stemp Function tasks timeout
 */
const DEFAULT_TASK_TIMEOUT = Timeout.duration(Duration.seconds(10));

/**
 * Name of the result AMIs
 */
const NAT_INSTANCES_NAME_TAG = 'NAT';

/**
 * Running NAT instances tags
 *
 * @remarks some values depends on the State Machine context that is passing the run instances method
 */
const NAT_INSTANCES_TAGS = [{
  Key: 'Name',
  Value: NAT_INSTANCES_NAME_TAG,
},{
  Key: 'StateMachine',
  Value: JsonPath.stringAt('$$.StateMachine.Name'),
},{
  Key: 'ExecutionId',
  Value: JsonPath.stringAt('$$.Execution.Id'),
},{
  Key: 'StateName',
  Value: JsonPath.stringAt('$$.State.Name'),
},{
  Key: 'StateTime',
  Value: JsonPath.stringAt('$$.State.EnteredTime'),
},{
  Key: 'Deploy',
  Value: 'Automated',
},{
  Key: 'Reason',
  Value: 'Maintenance',
}];

/**
 * Enum to ease the definition of AWS API Call tasks
 */
enum AwsService {
  EC2 = 'ec2',
  EVENT_BRIDGE = 'eventbridge',
  IMAGE_BUILDER = 'imagebuilder',
  STEP_FUNCTIONS = 'sfn',
}

export {
  AwsService,
  NUMBER_OF_AVAILABILITY_ZONES,
  DEFAULT_TASK_TIMEOUT,
  NAT_INSTANCES_NAME_TAG,
  IMAGE_RECIPE_VERSION,
  NAT_INSTANCES_TAGS,
}
