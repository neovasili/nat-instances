import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

import {
  AwsService,
  DEFAULT_TASK_TIMEOUT,
  NAT_INSTANCES_TAGS,
  NAT_INSTANCES_NAME_TAG,
} from '../constants/Common';
import { AzConfiguration } from '../model/Vpc';


abstract class StepFunctionsNatInstances {
  /**
   * Gets a Step Functions AWS API Call task that replaces private route table "internet route" with NAT Gateway ID
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @param azConfigurations Availability Zones configurations used to configure NAT routing
   * @returns CallAwsService Step Functions Task
   */
  public static getReplaceRouteWithNatGatewayTask(
    scope: Construct,
    id: string,
    azConfigurations: AzConfiguration[],
  ): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Replace internet route with Nat Gateway in a route table',
      service: AwsService.EC2,
      action: 'replaceRoute',
      iamResources: azConfigurations.map((azConfiguration: AzConfiguration) =>
        `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:route-table/${azConfiguration.privateRouteTableId}`,
      ),
      parameters: {
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: sfn.JsonPath.stringAt('$.natGatewayId'),
        // Received from step input
        RouteTableId: sfn.JsonPath.stringAt('$.privateRouteTableId'),
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }

  /**
   * Gets a Step Functions AWS API Call task that replaces private route table "internet route" with NAT instance ID
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @param azConfigurations Availability Zones configurations used to configure NAT routing
   * @returns CallAwsService Step Functions Task
   */
  public static getReplaceRouteWithNatInstanceTask(
    scope: Construct,
    id: string,
    azConfigurations: AzConfiguration[],
  ): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Replace internet route with Nat instance in a route table',
      service: AwsService.EC2,
      action: 'replaceRoute',
      iamResources: azConfigurations.map((azConfiguration: AzConfiguration) =>
        `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:route-table/${azConfiguration.privateRouteTableId}`,
      ),
      parameters: {
        DestinationCidrBlock: '0.0.0.0/0',
        // Received from step input
        InstanceId: sfn.JsonPath.stringAt('$.InstanceId'),
        // Received from step input
        RouteTableId: sfn.JsonPath.stringAt('$.RouteTable[0].privateRouteTableId'),
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that fetches all currently running NAT instances using multiple filters
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @returns CallAwsService Step Functions Task
   */
  public static getNatInstancesTask(scope: Construct, id: string): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Get currently running NAT instances',
      service: AwsService.EC2,
      action: 'describeInstances',
      iamResources: ['*'],
      parameters: {
        Filters: [{
          Name: 'tag:Name',
          Values: [NAT_INSTANCES_NAME_TAG],
        },{
          Name: 'tag:StateMachine',
          Values: ['NATInstanceReplaceInstance'],
        },{
          Name: 'instance-state-name',
          Values: ['running'],
        }]
      },
      // Result of API Call added to task output to avoid remove previous inputs
      resultPath: '$.NatInstances',
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Lambda function to fetch the latest produced AMI for NAT instances
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Lambda function and its LogGroup
   * @returns Lambda function to get the latest NAT instances AMI
   */
  public static getLatestImageFunction(scope: Construct, id: string): lambda.IFunction {
    // Manually create LogGroup to avoid CDK custom resources to put logs retention
    new logs.LogGroup(scope, `${id}LogGroup`, {
      logGroupName: `/aws/lambda/${id}`,
      retention: logs.RetentionDays.TWO_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
  
    const getLatestImageFunction = new lambda.Function(scope, id, {
      functionName: id,
      /**
       * Function code have been done as much simple as possible in order to avoid external dependencies and/or the need
       * of bundling more assets than the strictly necessary
       */
      code: lambda.Code.fromAsset('src/constructs/lambda/latest-nat-image'),
      handler: 'handler.handler',
      runtime: lambda.Runtime.PYTHON_3_11,
      environment: {
        NAT_IMAGES_AMI_NAME_TAG_PATTERN: `${NAT_INSTANCES_NAME_TAG}-*`,
      },
      timeout: cdk.Duration.seconds(60),
    });
    getLatestImageFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeImages'],
      effect: iam.Effect.ALLOW,
      resources: ['*'],
    }));
    return getLatestImageFunction;
  }
  
  /**
   * Gets a Step Functions AWS API Call task that fetches the latest produced AMI for NAT instances using a Lambda
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @param getLatestImageFunction Lambda function used for the task
   * @returns CallAwsService Step Functions Task
   */
  public static getNatInstancesImageTask(
    scope: Construct,
    id: string,
    getLatestImageFunction: lambda.IFunction,
  ): sfnTasks.LambdaInvoke {
    return new sfnTasks.LambdaInvoke(scope, id, {
      comment: 'Get latest NAT instances image',
      lambdaFunction: getLatestImageFunction,
      resultSelector: {
        ImageId: sfn.JsonPath.stringAt('$.Payload'),
      },
      resultPath: '$.Image',
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that runs a NAT instance
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @param natInstancesSecurityGroup Security group for the NAT instnace
   * @param natInstanceType NAT Instance type to use
   * @returns CallAwsService Step Functions Task
   */
  public static getRunInstanceTask(
    scope: Construct,
    id: string,
    natInstancesSecurityGroup: ec2.ISecurityGroup,
    natInstanceType: string,
  ): sfnTasks.CallAwsService {
    const resourcesToTag = ['instance', 'volume', 'network-interface'];
  
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Get currently running NAT instances',
      service: AwsService.EC2,
      action: 'runInstances',
      iamResources: ['*'],
      // Required to add tags to the instance, is not automatically added by CDK
      additionalIamStatements: [new iam.PolicyStatement({
        actions: ['ec2:CreateTags'],
        effect: iam.Effect.ALLOW,
        resources: ['*'],
      })],
      parameters: {
        ImageId: sfn.JsonPath.stringAt('$.Image.ImageId'),
        InstanceType: natInstanceType,
        MinCount: 1,
        MaxCount: 1,
        // Protect instances against accidental termination
        DisableApiTermination: true,
        TagSpecifications: resourcesToTag.map((resourceType: string) => {
          return {
            ResourceType: resourceType,
            Tags: NAT_INSTANCES_TAGS,
          };
        }),
        // We don't need IMDS, hence disabling it on launch to reduce attack surface
        MetadataOptions: {
          HttpEndpoint: 'disabled',
        },
        // Required in order to provide public IP address to the instance
        NetworkInterfaces: [{
          DeviceIndex: 0,
          AssociatePublicIpAddress: true,
          DeleteOnTermination: true,
          // Received from step input
          SubnetId: sfn.JsonPath.stringAt('$.publicSubnetId'),
          Groups: [ natInstancesSecurityGroup.securityGroupId ],
        }],
      },
      resultSelector: {
        // Returned to output
        InstanceId: sfn.JsonPath.stringAt('$.Instances[0].InstanceId'),
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that gets a NAT instance status
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @returns CallAwsService Step Functions Task
   */
  public static getInstanceStateTask(scope: Construct, id: string): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Get instance state',
      service: AwsService.EC2,
      action: 'describeInstanceStatus',
      iamResources: ['*'],
      parameters: {
        // Received from step input
        InstanceIds: sfn.JsonPath.array(sfn.JsonPath.stringAt('$.InstanceId')),
      },
      // Result of API Call added to task output to avoid remove previous inputs
      resultPath: '$.Instance',
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that disables source and destination check from a running instance
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @returns CallAwsService Step Functions Task
   */
  public static getDisableInstanceSourceDestCheckTask(scope: Construct, id: string): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Unset instance source and destination check',
      service: AwsService.EC2,
      action: 'modifyInstanceAttribute',
      iamResources: ['*'],
      parameters: {
        // Received from step input
        InstanceId: sfn.JsonPath.stringAt('$.InstanceId'),
        SourceDestCheck: {
          Value: false,
        },
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that disables termination protection from a running instance
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @returns CallAwsService Step Functions Task
   */
  public static getDisableInstanceTerminationProtectionTask(scope: Construct, id: string): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Disable instance termination protection',
      service: AwsService.EC2,
      action: 'modifyInstanceAttribute',
      iamResources: ['*'],
      parameters: {
        // Received from step input
        InstanceId: sfn.JsonPath.stringAt('$.Instances[0].InstanceId'),
        DisableApiTermination: {
          Value: false,
        },
      },
      // Result of API Call added to task output to avoid remove previous inputs
      resultPath: '$.DisableTerminationProtection',
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that terminates a running instance
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @returns CallAwsService Step Functions Task
   */
  public static getTerminateInstanceTask(scope: Construct, id: string): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Teminates a running instance',
      service: AwsService.EC2,
      action: 'terminateInstances',
      iamResources: ['*'],
      parameters: {
        // Received from step input
        InstanceIds: sfn.JsonPath.array(sfn.JsonPath.stringAt('$.Instances[0].InstanceId')),
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that gets a State Machine running executions
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @param stateMachineArn State Machine ARN to which fetch running executions
   * @returns CallAwsService Step Functions Task
   */
  public static getStateMachineRunning(scope: Construct, id: string, stateMachineArn: string): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Get running executions for the specified state machine',
      service: AwsService.STEP_FUNCTIONS,
      action: 'listExecutions',
      iamResources: ['*'],
      // We have to manually add permissions because CDK is not adding the appropiate name of the actions
      additionalIamStatements: [
        new iam.PolicyStatement({
          actions: ['stepfunctions:ListExecutions'],
          effect: iam.Effect.ALLOW,
          resources: [stateMachineArn],
        }),
      ],
      parameters: {
        StateMachineArn: stateMachineArn,
        StatusFilter: 'RUNNING',
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that triggers the Image Builder pipeline
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @param imagePipeline The Image Builder Pipeline construct, used to get its attributes as reference
   * @returns CallAwsService Step Functions Task
   */
  public static getTriggerImagesPipeline(
    scope: Construct,
    id: string,
    imagePipeline: imagebuilder.CfnImagePipeline,
  ): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Triggers NAT Image pipeline',
      service: AwsService.IMAGE_BUILDER,
      action: 'startImagePipelineExecution',
      iamResources: ['*'],
      // We have to manually add permissions because CDK is not adding the appropiate name of the actions
      additionalIamStatements: [
        new iam.PolicyStatement({
          actions: ['imagebuilder:StartImagePipelineExecution'],
          effect: iam.Effect.ALLOW,
          resources: [imagePipeline.attrArn],
        }),
      ],
      parameters: {
        // It's weird this parameter is required, since using SDK it's automatically added
        ClientToken: sfn.JsonPath.uuid(),
        ImagePipelineArn: imagePipeline.attrArn,
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
  
  /**
   * Gets a Step Functions AWS API Call task that gets the Image Builder pipeline status
   *
   * @param scope In which construct this resource must be provisioned
   * @param id ID of the Task
   * @param imageVersionArn ARN of the image version we want to fetch the status from
   * @returns CallAwsService Step Functions Task
   */
  public static getCheckImagesPipelineStatus(
    scope: Construct,
    id: string,
    imageVersionArn: string,
  ): sfnTasks.CallAwsService {
    return new sfnTasks.CallAwsService(scope, id, {
      comment: 'Triggers NAT Image pipeline',
      service: AwsService.IMAGE_BUILDER,
      action: 'listImageBuildVersions',
      iamResources: ['*'],
      // We have to manually add permissions because CDK is not adding the appropiate name of the actions
      additionalIamStatements: [
        new iam.PolicyStatement({
          actions: ['imagebuilder:ListImageBuildVersions'],
          effect: iam.Effect.ALLOW,
          resources: [imageVersionArn],
        }),
      ],
      parameters: {
        ImageVersionArn: imageVersionArn,
      },
      resultSelector: {
        // Returned to output
        PipelineStatus: sfn.JsonPath.stringAt('$.ImageSummaryList[0].State.Status'),
      },
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    });
  }
}

export {
  StepFunctionsNatInstances,
}
