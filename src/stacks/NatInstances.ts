import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

import { StepFunctionsTasks } from '../constructs/StepFunctionsTasks';
import { NatInstancesPipeline } from '../constructs/NatInstancesPipeline';
import { NUMBER_OF_AVAILABILITY_ZONES } from '../constants/Common';
import { AzConfiguration } from '../model/Vpc';

/**
 * Urls used to check the connectivity against to
 */
const CHECK_URLS = [
  'https://google.com',
];

/**
 * Provision a set of resources that enables the usage of NAT instances with NAT Gateways as failover mechanism
 * That reduces dramatically networking costs from NAT Gateways
 */
class NatInstancesStack extends cdk.Stack {
  private readonly azConfigurations: AzConfiguration[];

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const region = props.env?.region || 'eu-west-1';

    // Considering 'NUMBER_OF_AVAILABILITY_ZONES' compute the availability zone names
    const availabilityZones = Array.from(Array(NUMBER_OF_AVAILABILITY_ZONES).keys()).map((index: number) => {
      return `${region}${'abcdefghijk'[index]}`;
    });

    // Import relevant Vpc values
    const vpcId = ssm.StringParameter.fromStringParameterName(this, 'VpcId', '/Vpc/Id').stringValue;
    const vpcCidrBlock = ssm.StringParameter.fromStringParameterName(this, 'VpcCidrBlock', '/Vpc/CidrBlock').stringValue;
    this.azConfigurations = availabilityZones.map((availabilityZone: string, index: number) => {
      return {
        availabilityZone: availabilityZone,
        publicSubnetId: ssm.StringParameter.fromStringParameterName(this, `PublicSubnet${index}Id`,
          `/Vpc/PublicSubnet/${availabilityZone}/Id`).stringValue,
        natGatewayId: ssm.StringParameter.fromStringParameterName(this, `NatGateway${index}Id`,
          `/Vpc/NatGateway/${availabilityZone}/Id`).stringValue,
        privateSubnetId: ssm.StringParameter.fromStringParameterName(this, `PrivateSubnet${index}Id`,
          `/Vpc/PrivateSubnet/${availabilityZone}/Id`).stringValue,
        privateRouteTableId: ssm.StringParameter.fromStringParameterName(this, `PrivateRouteTable${index}Id`,
          `/Vpc/PrivateRouteTable/${availabilityZone}/Id`).stringValue,
      };
    });

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId,
      availabilityZones,
      vpcCidrBlock,
      publicSubnetIds: this.azConfigurations.map((azConfiguration: AzConfiguration) => azConfiguration.publicSubnetId),
      privateSubnetIds: this.azConfigurations.map((azConfiguration: AzConfiguration) => azConfiguration.privateSubnetId),
    });
    const securityGroup = new ec2.SecurityGroup(this, 'DefaultSecurityGroup', {
      vpc,
      securityGroupName: 'test',
    });
    cdk.Tags.of(securityGroup).add('Name', 'test');

    // Create specific NAT instances Security Group and allow traffic for VPC resources
    const natInstancesSecurityGroup = new ec2.SecurityGroup(this, 'NATInstancesSecurityGroup', {
      securityGroupName: 'NATInstancesSecurityGroup',
      description: 'Specific security group for NAT instances',
      vpc,
    });
    cdk.Tags.of(natInstancesSecurityGroup).add('Name', 'NATInstancesSecurityGroup');

    natInstancesSecurityGroup.addIngressRule(securityGroup, ec2.Port.allTraffic(), 'Allow from test SG');

    // Create NAT instances images pipeline resources
    const natInstancePipeline = new NatInstancesPipeline(this, 'NatInstancesPipeline', {
      infrastructureSecurityGroup: securityGroup,  // Default security group should be enough
      // Use the first private subnet
      infrastructureSubnetId: this.azConfigurations[0].privateSubnetId,
    });

    // Create State Machines
    const getLatestImageFunction = StepFunctionsTasks.getLatestImageFunction(this, 'GetLatestNATImage');
    const failoverStateMachine = this.createFailoverStateMachine();
    const replaceInstancesStateMachine = this.createReplaceInstanceStateMachine(
      natInstancesSecurityGroup,
      getLatestImageFunction,
      failoverStateMachine,
    );
    const fallbackStateMachine = this.createFallbackStateMachine();

    this.createMaintenanceStateMachine(
      natInstancePipeline.imagePipeline,
      natInstancePipeline.imageRecipe,
      replaceInstancesStateMachine,
      fallbackStateMachine,
    );

    // Create ConnectivityChecker resources
    const failoverStateMachineArn = failoverStateMachine.stateMachineArn;
    this.createConnectivityCheckerResources(vpc, failoverStateMachineArn);
  }

  /**
   * Creates several resources required to check private subnets internet connectivity for each Availability Zone:
   *  - VPC endpoint for Step Functions endpoint
   *  - Eventbridge scheduled rule to trigger (every minute) the Lambda functions
   *  - Lambda functions per AZ that runs the checks and trigger Failover State Machine in case of failure
   *
   * @param vpc VPC where the resources need to be placed
   * @param failoverStateMachineArn Failover State Machine ARN
   */
  private createConnectivityCheckerResources(
    vpc: ec2.IVpc,
    failoverStateMachineArn: string,
  ): void {
    /**
     * In order to trigger the Failover State Machine, we need to ensure that Lambda functions are able to reach
     * the Step Functions endpoint even when the internet connection is down
     * */
    const statesVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ConnectivityCheckerGuardrail', {
      service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
      vpc,
      privateDnsEnabled: true,
    });
    cdk.Tags.of(statesVpcEndpoint).add('Name', 'Step functions VPC endpoint');

    /**
     * As we want to keep the checker running most of the time this number is used also inside the function and for the
     * EventBridge scheduled trigger
     * */
    const functionTimeoutInSeconds = 300;

    const connectivityCheckerTrigger = new events.Rule(this, 'ConnectivityCheckerScheduledRule', {
      ruleName: 'NATConnectivityChecker',
      description: 'Scheduled event to trigger connectivity checker Lambdas',
      schedule: events.Schedule.rate(cdk.Duration.seconds(functionTimeoutInSeconds)),
    });

    const connectivityCheckerSecurityGroup = new ec2.SecurityGroup(this, 'ConnectivityCheckerSecurityGroup', {
      securityGroupName: 'ConnectivityCheckerSecurityGroup',
      description: 'Specific security for the Connectivity Checker Lambdas',
      vpc,
    });
    cdk.Tags.of(connectivityCheckerSecurityGroup).add('Name', 'ConnectivityCheckerSecurityGroup');

    // Create a ConnectivityChecker Lambda function per AZ using the provided AZ configurations
    this.azConfigurations.map((azConfiguration:AzConfiguration) => {
      const availabilityZone = azConfiguration.availabilityZone;

      // Manually create LogGroup to avoid CDK custom resources to put logs retention
      new logs.LogGroup(this, `ConnectivityChecker-${availabilityZone}-LogGroup`, {
        logGroupName: `/aws/lambda/ConnectivityChecker-${availabilityZone}`,
        retention: logs.RetentionDays.ONE_WEEK,  // Low logs retention, since we are emitting metrics
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });

      const connectivityChecker = new lambda.Function(this, `ConnectivityChecker-${availabilityZone}`, {
        functionName: `ConnectivityChecker-${availabilityZone}`,
        /**
         * Function code have been done as simple as possible in order to avoid external dependencies and/or
         * the need of bundling more assets than the strictly necessary
         */
        code: lambda.Code.fromAsset('src/constructs/lambda/connectivity-checker'),
        handler: 'handler.handler',
        runtime: lambda.Runtime.PYTHON_3_11,
        environment: {
          CHECK_URLS: String(CHECK_URLS),
          CONNECTIVITY_CHECK_INTERVAL: String(10),
          FUNCTION_TIMEOUT: String(functionTimeoutInSeconds),
          REQUEST_TIMEOUT: String(8),
          UNHEALTHY_THRESHOLD: String(3),
          FAILOVER_STATE_MACHINE_ARN: failoverStateMachineArn,
          AVAILABILITY_ZONE: availabilityZone,
        },
        vpc,
        vpcSubnets: {
          // Use only "this AZ" private subnet
          subnets: [ec2.Subnet.fromSubnetId(this, `${availabilityZone}-subnet`, azConfiguration.privateSubnetId)],
        },
        securityGroups: [connectivityCheckerSecurityGroup],
        timeout: cdk.Duration.seconds(functionTimeoutInSeconds),
      });
      // Add the function permissions to trigger the Failover State Machine
      connectivityChecker.addToRolePolicy(new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        effect: iam.Effect.ALLOW,
        resources: [failoverStateMachineArn],
      }));
      // Add the function as target for the EventBridge trigger
      connectivityCheckerTrigger.addTarget(new eventsTargets.LambdaFunction(connectivityChecker, {
        retryAttempts: 3,
        maxEventAge: cdk.Duration.seconds(functionTimeoutInSeconds),
      }));
    });
  }

  /**
   * Creates the Failover State Machine that replaces the current internet route with the NAT Gateway one
   *
   * @remarks The State Machine is idempotent and self contained, so it does not require any kind of input
   *
   * @returns State Machine construct
   */
  private createFailoverStateMachine(): sfn.StateMachine {
    // Use Step Functions AWS SDK integrations to avoid having custom code
    const replaceRouteTask = StepFunctionsTasks.getReplaceRouteWithNatGatewayTask(this, 'ReplaceRouteTask',
      this.azConfigurations);
    // Create a failed state for errors
    const failed = StepFunctionsTasks.createStateMachineFailState(this, 'Failover');

    // Pass AZ configurations as "hardcoded values" in a list
    const getAZConfigurations = new sfn.Pass(this, 'GetAZConfigurations', {
      comment: 'Pass list of AZ configurations',
      result: sfn.Result.fromObject({
        azConfigurations: this.azConfigurations,
      }),
    });

    // Let's put all togheter in a State Machine definition
    const stateMachineDefinition = sfn.DefinitionBody.fromChainable(
      // First, get AZ configurations
      getAZConfigurations
        .next(
          // Iterate over (concurrently) each AZ configuration
          new sfn.Map(this, 'MapOfAZConfigurations', {
            comment: 'Process each AZ configuration',
            maxConcurrency: 6,
            inputPath: '$',  // Input comes from the whole output of previous step
            itemsPath: '$.azConfigurations',  // But items input is inside the 'AZConfigurationsIds' which is a list
          })
            .addCatch(failed)  // Add a catch for the whole map block
            .itemProcessor(replaceRouteTask)  // Add iterator task 'replaceRouteTask'
        )
    );

    return new sfn.StateMachine(this, 'FailoverStateMachine', {
      stateMachineName: 'NATInstanceFailover',
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: stateMachineDefinition,
      logs: {
        level: sfn.LogLevel.ERROR,
        destination: new logs.LogGroup(this, 'FailoverStateMachineLogs', {
          logGroupName: '/aws/stepfunctions/FailoverStateMachine',
          retention: logs.RetentionDays.TWO_WEEKS,
        }),
      },
    });
  }

  /**
   * Creates the ReplaceInstances State Machine that after a few sanity checks removes old running NAT instances and
   * place new ones with the latest images
   *
   * In order to make the replacement safety, we need to trigger Failover first, so the first step after passing
   * the singleton check is to trigger the Failover State Machine, that way we ensure connectivity keeps working
   *
   * Terminating instances and creating new ones are done concurrently so we save time
   *
   * @remarks The State Machine is idempotent and self contained, so it does not require any kind of input -
   * it also uses singleton pattern, causing failed execution when is already running
   *
   * @param natInstancesSecurityGroup Nat instances dedicated security group
   * @param getLatestImageFunction Lambda function used to fetch the latest AMI
   * @param failoverStateMachine Failover State Machine construct
   * @returns State Machine construct
   */
  private createReplaceInstanceStateMachine(
    natInstancesSecurityGroup: ec2.ISecurityGroup,
    getLatestImageFunction: lambda.IFunction,
    failoverStateMachine: sfn.IStateMachine,
  ): sfn.StateMachine {
    const stateMachineName = 'NATInstanceReplaceInstance';
    // This is done as a 'hardcoded' value to avoid circular dependencies
    const stateMachineArn = `arn:aws:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${stateMachineName}`;
    /** 
     * Let's create some of state machine tasks as separated elements in order to ease the readability
     *
     * Use Step Functions AWS SDK integrations to avoid having custom code whenever is possible
     */
    const getStateMachineRunningTask = StepFunctionsTasks.getStateMachineRunningTask(
      this,
      'GetStateMachineRunningTask',
      stateMachineArn,
    );
    const getNatInstancesTask = StepFunctionsTasks.getNatInstancesTask(this, 'GetNatInstancesTask');
    const getNatInstancesImageTask = StepFunctionsTasks.getNatInstancesImageTask(
      this,
      'GetNatInstanceImageTask',
      getLatestImageFunction,
    );
    const runNatInstanceTask = StepFunctionsTasks.getRunInstanceTask(
      this,
      'RunNatInstanceTask',
      natInstancesSecurityGroup,
      ec2.InstanceType.of('c7gn' as ec2.InstanceClass, ec2.InstanceSize.MEDIUM).toString(),
    );
    const getInstanceStateTask = StepFunctionsTasks.getInstanceStateTask(this, 'GetInstanceStateTask');
    const disableSourceDestCheckTask = StepFunctionsTasks.getDisableInstanceSourceDestCheckTask(
      this,
      'DisableSourceDestCheckTask',
    );
    const disableTerminationProtectionTask = StepFunctionsTasks.getDisableInstanceTerminationProtectionTask(
      this,
      'DisableTerminationProtectionTask',
    );
    const terminateOldInstancesTask = StepFunctionsTasks.getTerminateInstanceTask(this,
        'TerminateOldInstanceTask');

    // Create a failed state for errors
    const failed = StepFunctionsTasks.createStateMachineFailState(this, 'ReplaceInstance');
    const failedAlreadyRunning = StepFunctionsTasks.createStateMachineFailState(this, 'AlreadyRunning');

    const noOpState = new sfn.Pass(this, 'NoOp');

    // This is required, otherwise, status is not properly fetched
    const waitForRun = new sfn.Wait(this, 'WaitForRun', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(10)),
    });

    // This is the instance state check loop, part of the create new instances branch
    const waitRunningInstanceLoop = waitForRun
      .next(
        getInstanceStateTask
          .next(
            new sfn.Choice(this, 'IsInstanceReady?', {
              comment: 'Check if instance is ready',
            })
              // If status was not properly fetched
              .when(sfn.Condition.isNotPresent(
                sfn.JsonPath.stringAt('$.Instance.InstanceStatuses[0]')),
                waitForRun,
              )
              // If status checks are not 'ok' (we have to check both 'InstanceStatus' and 'SystemStatus')
              .when(sfn.Condition.or(
                  sfn.Condition.not(
                    sfn.Condition.stringEquals(
                      sfn.JsonPath.stringAt('$.Instance.InstanceStatuses[0].InstanceStatus.Status'), 'ok')),
                  sfn.Condition.not(
                    sfn.Condition.stringEquals(
                      sfn.JsonPath.stringAt('$.Instance.InstanceStatuses[0].SystemStatus.Status'), 'ok')),
                  ),
                  waitForRun,
              )
              .otherwise(disableSourceDestCheckTask)
          )
      );

    // Terminate instances branch definition
    const terminateOldInstancesBranch = new sfn.Choice(this, 'AnyInstance?', {
      comment: 'Check if there is any instance already running',
    })
      .when(sfn.Condition.isPresent('$.NatInstances.Reservations[0]'),
        new sfn.Map(this, 'DisableInstancesTerminationProtection', {
          comment: 'Disable instances termination protection',
          maxConcurrency: 6,
          inputPath: '$',
          itemsPath: '$.NatInstances.Reservations',
        })
          .itemProcessor(
            disableTerminationProtectionTask
            .next(
              terminateOldInstancesTask
            )
          )
      )
      // All choices require a default state
      .otherwise(noOpState);

    // Create new instances branch definition
    const createNewInstancesBranch = new sfn.Pass(this, 'GetSubnets', {
      comment: 'Pass list of subnets IDs',
      result: sfn.Result.fromObject({
        azConfigurations: this.azConfigurations,
      }),
    })
      .next(
        new sfn.Map(this, 'CreateNewInstances', {
          comment: 'Create new instances for each subnet',
          maxConcurrency: 6,
          inputPath: '$',  // Input comes from the whole output of previous step
          itemsPath: '$.azConfigurations',  // But items input is inside the 'associatedSubnetId' which is a list
        })
        .itemProcessor(
          getNatInstancesImageTask
              .next(
                runNatInstanceTask
                  .next(
                    waitRunningInstanceLoop
                  )
              )
            )
        );

    // The whole State Machine definition that wraps both branches adding the sanity checks at the beginning
    const stateMachineDefinition = sfn.DefinitionBody.fromChainable(
      getStateMachineRunningTask
        .addCatch(failed)
        .next(
          new sfn.Choice(this, 'AlreadyRunningStateMachine?', {
            comment: 'Check if this state machine is already running',
          })
            // We have to consider that the current execution will appear in the results
            // so we check if there is more than one execution
            .when(sfn.Condition.isPresent('$.Executions[1]'), failedAlreadyRunning)
            .otherwise(
              new sfnTasks.StepFunctionsStartExecution(this, 'TriggerFailover', {
                stateMachine: failoverStateMachine,
                comment: 'Trigger failover state machine to ensure that traffic can continue flowing with NAT Gateway',
                // The name 'RUN_JOB' is confusing, but this makes the Step to wait execution to finish before continue
                integrationPattern: sfn.IntegrationPattern.RUN_JOB,
              })
                .addCatch(failed)
                .next(
                  getNatInstancesTask
                    .addCatch(failed)
                    .next(
                      new sfn.Parallel(this, 'InstancesReplacement', {
                        comment: 'Create and terminate instances that require replacement',
                      })
                        .addCatch(failed)
                        .branch(terminateOldInstancesBranch)
                        .branch(createNewInstancesBranch)
                    ),
                )
            )
        )
    );

    return new sfn.StateMachine(this, 'ReplaceInstanceStateMachine', {
      stateMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: stateMachineDefinition,
      // Sanity timeout in case we enter an infinite loop, mean execution time during tests was ~3 minutes
      timeout: cdk.Duration.minutes(5),
      logs: {
        level: sfn.LogLevel.ERROR,
        destination: new logs.LogGroup(this, 'ReplaceInstanceStateMachineLogs', {
          logGroupName: '/aws/stepfunctions/ReplaceInstanceStateMachine',
          retention: logs.RetentionDays.TWO_WEEKS,
        }),
      },
    });
  }

  /**
   * Creates Fallback State Machine that replaces the current internet route with the NAT instances ones
   *
   * @remarks The State Machine is idempotent and self contained, so it does not require any kind of input
   *
   * @returns State Machine construct
   */
  private createFallbackStateMachine(): sfn.StateMachine {
    // Use Step Functions AWS SDK integrations to avoid having custom code
    const getNatInstances = StepFunctionsTasks.getNatInstancesTask(this, 'GetRunningNatInstancesTask');
    const replaceRoute = StepFunctionsTasks.getReplaceRouteWithNatInstanceTask(
      this,
      'ReplaceInstanceRouteTask',
      this.azConfigurations,
    );

    // Create a failed state for errors
    const failed = StepFunctionsTasks.createStateMachineFailState(this, 'Fallback');

    const stateMachineDefinition = sfn.DefinitionBody.fromChainable(
      // First get the existing running instances, if any
      getNatInstances
        .addCatch(failed)
        .next(
            // Iterate over them
            new sfn.Map(this, 'Instances', {
              comment: 'Process each instance ID',
              maxConcurrency: 6,
              inputPath: '$',
              itemsPath: '$.NatInstances.Reservations',
            })
              .addCatch(failed)  // Add a catch for the whole map block
              .itemProcessor(
                new sfn.Pass(this, 'RawAZConfigurations', {
                  comment: 'Pass list of AZ configurations',
                  parameters: {
                    InstanceId: sfn.JsonPath.stringAt('$.Instances[0].InstanceId'),
                    PublicSubnetId: sfn.JsonPath.stringAt('$.Instances[0].SubnetId'),
                    AzConfigurations: sfn.Result.fromArray(this.azConfigurations),
                  },
                })
                  .next(
                    new sfn.Pass(this, 'GetDesiredRouteTableId', {
                      comment: 'Filters AZConfigurations to get the route table ID of the desired AZ',
                      parameters: {
                        InstanceId: sfn.JsonPath.stringAt('$.InstanceId'),
                        // Advanced usage of JsonPath to filter a list based on a property value condition
                        'RouteTable.$': '$.AzConfigurations.value[?(@.publicSubnetId == $.PublicSubnetId)]',
                      },
                    })
                      .next(
                        // Once we have instance ID and route table values we can replace the route
                        replaceRoute
                      )
                  )
              )
          )
        );

    return new sfn.StateMachine(this, 'FallbackStateMachine', {
      stateMachineName: 'NATInstanceFallback',
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: stateMachineDefinition,
      logs: {
        level: sfn.LogLevel.ERROR,
        destination: new logs.LogGroup(this, 'FallbackStateMachineLogs', {
          logGroupName: '/aws/stepfunctions/FallbackStateMachine',
          retention: logs.RetentionDays.TWO_WEEKS,
        }),
      },
    });
  }

  /**
   * Creates the Maintenance State Machine that do the following actions:
   *  - Triggers the image pipeline to build a new image
   *  - Wait for the image to be ready
   *  - Triggers the replace instances State Machine (that first triggers Failover)
   *  - Triggers Fallback State Machine
   *
   * This State Machine execution is scheduled to happen every 14 days so we ensure that NAT instances are up to date
   *
   * To avoid mixing NAT instances with different images, the pipeline execution have a singleton check, so the
   * State Machine fails execution if the pipeline is already running
   *
   * @param imagePipeline Image Builder pipeline construct
   * @param imageRecipe Image Builder recipe construct
   * @param replaceInstancesStateMachine ReplaceInstances State Machine construct
   * @param fallbackStateMachine Fallback State Machine construct
   * @returns State Machine construct
   */
  private createMaintenanceStateMachine(
    imagePipeline: imagebuilder.CfnImagePipeline,
    imageRecipe: imagebuilder.CfnImageRecipe,
    replaceInstancesStateMachine: sfn.IStateMachine,
    fallbackStateMachine: sfn.IStateMachine,
  ): sfn.StateMachine {
    // Build imageVersionArn from recipe values, used to fetch pipeline status
    const imageVersion = `${imageRecipe.name.toLocaleLowerCase()}/${imageRecipe.version}`;
    const imageVersionArn = `arn:aws:imagebuilder:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:image/${imageVersion}`;
    // Use Step Functions AWS SDK integrations to avoid having custom code
    const triggerImagePipelineTask = StepFunctionsTasks.getTriggerImagesPipelineTask(
      this,
      'TriggerImagePipelineTask',
      imagePipeline,
    );
    const imageInitialPipelineStatusTask = StepFunctionsTasks.getCheckImagesPipelineStatusTask(
      this,
      'GetInitialImagePipelineStatusTask',
      imageVersionArn,
    );
    const imagePipelineStatusTask = StepFunctionsTasks.getCheckImagesPipelineStatusTask(
      this,
      'GetImagePipelineStatusTask',
      imageVersionArn,
    );

    // Create a failed states for errors
    const failed = StepFunctionsTasks.createStateMachineFailState(this, 'Generic');
    const failedImagePipeline = StepFunctionsTasks.createStateMachineFailState(this, 'ImagePipeline');
    const failedAlreadyRunningPipeline = StepFunctionsTasks.createStateMachineFailState(this, 'AlreadyRunningPipeline');

    const stateMachineDefinition = sfn.DefinitionBody.fromChainable(
      // Get pipeline status
      imageInitialPipelineStatusTask
        .addCatch(failed)
        .next(
          new sfn.Choice(this, 'AlreadyRunning?', {
            comment: 'Sanity check if there is a pipeline already running',
          })
            .when(sfn.Condition.and(
                sfn.Condition.not(
                  sfn.Condition.stringEquals('$.PipelineStatus', 'AVAILABLE')),
                sfn.Condition.not(
                  sfn.Condition.stringEquals('$.PipelineStatus', 'FAILED')),
              ),
              failedAlreadyRunningPipeline,
            )
            // If it's not running, then trigger it and wait for it to finish
            .otherwise(
              triggerImagePipelineTask
                .addCatch(failed)
                .next(
                  new sfn.Wait(this, 'WaitForPipelineToRun', {
                    comment: 'Wait a prudent amount of time to let the pipeline finish',
                    time: sfn.WaitTime.duration(cdk.Duration.minutes(10)),
                  })
                    .next(
                      imagePipelineStatusTask
                        .addCatch(failed)
                        .next(
                          new sfn.Choice(this, 'Finished?', {
                            comment: 'Check if the pipeline has already finished',
                          })
                          .when(sfn.Condition.stringEquals('$.PipelineStatus', 'FAILED'), failedImagePipeline)
                          .when(sfn.Condition.not(
                              sfn.Condition.stringEquals('$.PipelineStatus', 'AVAILABLE')
                            ),
                            new sfn.Wait(this, 'WaitToFetchStatusAgain', {
                              comment: 'Wait a bit to fetch status again',
                              time: sfn.WaitTime.duration(cdk.Duration.minutes(2)),
                            })
                              .next(imagePipelineStatusTask)
                          )
                          // Once the pipeline finishes, we start to replace instances
                          .otherwise(
                            new sfnTasks.StepFunctionsStartExecution(this, 'TriggerReplaceInstances', {
                              stateMachine: replaceInstancesStateMachine,
                              comment: `Trigger replace instances state machine to remove old instances
                                and create new ones`,
                              integrationPattern: sfn.IntegrationPattern.RUN_JOB,
                            })
                              .addCatch(failed)
                              .next(
                                // and finally change routes back to the new NAT instannces
                                new sfnTasks.StepFunctionsStartExecution(this, 'TriggerFallback', {
                                  stateMachine: fallbackStateMachine,
                                  comment: 'Trigger fallback state machine to change routes again to NAT instances',
                                  integrationPattern: sfn.IntegrationPattern.RUN_JOB,
                                })
                                .addCatch(failed)
                              )
                          )
                        )
                    )
                )
            )
        )
    );

    const maintenanceStateMachine = new sfn.StateMachine(this, 'MaintenanceStateMachine', {
      stateMachineName: 'NATMaintenanceStateMachine',
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: stateMachineDefinition,
      timeout: cdk.Duration.minutes(60),  // Sanity timeout
      logs: {
        level: sfn.LogLevel.ERROR,
        destination: new logs.LogGroup(this, 'NATMaintenanceStateMachineLogs', {
          logGroupName: '/aws/stepfunctions/NATMaintenanceStateMachine',
          retention: logs.RetentionDays.TWO_WEEKS,
        }),
      },
    });

    new events.Rule(this, 'MaintenanceScheduledRule', {
      ruleName: 'NATMaintenanceScheduled',
      enabled: true,
      description: 'Scheduled event to trigger maintenance workflow',
      // Run every 14 days
      schedule: events.Schedule.rate(cdk.Duration.days(14)),
      targets: [new eventsTargets.SfnStateMachine(maintenanceStateMachine, {
        retryAttempts: 3,
      })],
    });

    return maintenanceStateMachine;
  }
}

export {
  NatInstancesStack,
}
