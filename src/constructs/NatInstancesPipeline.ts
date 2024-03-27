import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import { Construct } from "constructs";
import { readFileSync } from 'fs';

import { IMAGE_RECIPE_VERSION, NAT_INSTANCES_NAME_TAG } from '../constants/Common';

interface NatInstancesPipelineProps {
  infrastructureSecurityGroup: ec2.ISecurityGroup;
  infrastructureSubnetId: string;
}

/**
 * Construct to create NAT instances Images pipeline resources
 */
class NatInstancesPipeline extends Construct {
  private readonly imageRecipeVersion: string;
  public readonly imageRecipe: imagebuilder.CfnImageRecipe;
  public readonly imagePipeline: imagebuilder.CfnImagePipeline;

  constructor(scope: Construct, id: string, props: NatInstancesPipelineProps) {
    super(scope, id);

    // This value needs to be changed if anything in the recipe changes, including components versions
    this.imageRecipeVersion = IMAGE_RECIPE_VERSION;
    // Create NAT images pipeline
    const enableNatComponent = this.createEnableNatComponent();
    const hardenNatComponent = this.createHardenNatComponent();
    const testNatComponent = this.createTestNatComponent();
    const infraConfiguration = this.createInfrastructureConfiguration(
      props.infrastructureSecurityGroup,  // Default security group should be enough
      props.infrastructureSubnetId,  // Use the first private subnet
    );
    const distributionSettings = this.createDistributionSettings();

    this.imageRecipe = this.createNatImageRecipe(enableNatComponent, hardenNatComponent, testNatComponent);
    this.imagePipeline = this.createImageBuilderPipeline(this.imageRecipe, infraConfiguration, distributionSettings);
  }

  /**
   * Create Image Builder custom component to enable NAT instances
   *
   * @returns Image Builder component construct
   */
  private createEnableNatComponent(): imagebuilder.CfnComponent {
    const componentYamlContent = readFileSync('src/constructs/image-builder-components/enable-nat.yaml').toString();
    // Using a separated script file so it's more comprehensive to make changes
    const componentScriptContent = readFileSync('src/constructs/image-builder-components/enable-nat.sh').toString();
    // Proper indentation is mandatory for components yaml
    const indentedScriptContent = componentScriptContent.split('\n').map((line: string) => {
      return `              ${line}`;
    }).join('\n');
    const componentContent = componentYamlContent.replace('{{ENABLE_NAT_SCRIPT}}', indentedScriptContent);

    return new imagebuilder.CfnComponent(this, 'EnableNATComponent', {
      name: 'enable-nat',
      platform: 'Linux',
      version: '0.1.0',  // Change this value if something changes in the component definition
      description: 'Component that enables NAT routing in an instance',
      supportedOsVersions: ['Amazon Linux 2'],
      data: componentContent,
    });
  }

  /**
   * Create Image Builder custom component to apply hardening to NAT instances - empty for now
   *
   * @returns Image Builder component construct
   */
  private createHardenNatComponent(): imagebuilder.CfnComponent {
    const componentYamlContent = readFileSync('src/constructs/image-builder-components/harden-nat.yaml').toString();
    // Using a separated script file so it's more comprehensive to make changes
    const componentScriptContent = readFileSync('src/constructs/image-builder-components/harden-nat.sh').toString();
    // Proper indentation is mandatory for components yaml
    const indentedScriptContent = componentScriptContent.split('\n').map((line: string) => {
      return `              ${line}`;
    }).join('\n');
    const componentContent = componentYamlContent.replace('{{HARDEN_NAT_SCRIPT}}', indentedScriptContent);

    return new imagebuilder.CfnComponent(this, 'HardenNATComponent', {
      name: 'harden-nat',
      platform: 'Linux',
      version: '0.1.0',  // Change this value if something changes in the component definition
      description: 'Component that hardens NAT instances image',
      supportedOsVersions: ['Amazon Linux 2'],
      data: componentContent,
    });
  }

  /**
   * Create Image Builder custom component to test NAT instances configuration
   *
   * @returns Image Builder component construct
   */
  private createTestNatComponent(): imagebuilder.CfnComponent {
    const componentYamlContent = readFileSync('src/constructs/image-builder-components/test-nat.yaml').toString();
    // Using a separated script file so it's more comprehensive to make changes
    const componentScriptContent = readFileSync('src/constructs/image-builder-components/test-nat.sh').toString();
    // Proper indentation is mandatory for components yaml
    const indentedScriptContent = componentScriptContent.split('\n').map((line: string) => {
      return `              ${line}`;
    }).join('\n');
    const componentContent = componentYamlContent.replace('{{TEST_NAT_SCRIPT}}', indentedScriptContent);

    return new imagebuilder.CfnComponent(this, 'TestNATComponent', {
      name: 'test-nat',
      platform: 'Linux',
      version: '0.1.0',  // Change this value if something changes in the component definition
      description: 'Component that tests NAT routing in an instance',
      supportedOsVersions: ['Amazon Linux 2'],
      data: componentContent,
    });
  }

  /**
   * Creates Image Builder recipe to create NAT instances images
   *
   * @param enableNatComponent Enable NAT custom Image Builder component construct
   * @param hardenNatComponent Harden NAT custom Image Builder component construct
   * @param testNatComponent Test NAT custom Image Builder component construct
   * @returns Image Builder recipe construct
   */
  private createNatImageRecipe(
    enableNatComponent: imagebuilder.CfnComponent,
    hardenNatComponent: imagebuilder.CfnComponent,
    testNatComponent: imagebuilder.CfnComponent,
  ): imagebuilder.CfnImageRecipe {
    return new imagebuilder.CfnImageRecipe(this, 'NatInstanceRecipe', {
      name: 'NatInstance',
      description: 'NAT instance',
      parentImage: `arn:aws:imagebuilder:${cdk.Aws.REGION}:aws:image/amazon-linux-2-arm64/x.x.x`,
      version: this.imageRecipeVersion,
      components: [{
        // Enable NAT component
        componentArn: enableNatComponent.attrArn,
      },{
        // Harden NAT component
        componentArn: hardenNatComponent.attrArn,
      },{
        // TEST component - reboot-test-linux
        componentArn: `arn:aws:imagebuilder:${cdk.Aws.REGION}:aws:component/reboot-test-linux/x.x.x`,
      },{
        // TEST component - test NAT instance requirements
        componentArn: testNatComponent.attrArn,
      }],
      additionalInstanceConfiguration: {
        // SSM is not required for NAT instances to run, so remove it
        systemsManagerAgent: {
          uninstallAfterBuild: true,
        },
      },
    });
  }

  /**
   * Creates Image Builder infrastructure configuration used to create the images
   *
   * @param securityGroup Security Group construct to use
   * @param subnetId Subnet ID where to place the building instances
   * @returns Image Builder infrastructure configuration construct
   */
  private createInfrastructureConfiguration(
    securityGroup: ec2.ISecurityGroup,
    subnetId: string,
  ): imagebuilder.CfnInfrastructureConfiguration {
    const infraConfigName = 'NatInfraConfiguration';

    const imageRole = new iam.Role(this, 'ImageBuilderRole', {
      roleName: infraConfigName,
      description: 'Role used to build NAT instances images',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // TODO: tighten this permissions as much as feasible
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSImageBuilderReadOnlyAccess'),
      ],
    });
    const instanceProfile = new iam.InstanceProfile(this, 'InstanceProfile', {
      instanceProfileName: infraConfigName,
      role: imageRole,
    });

    return new imagebuilder.CfnInfrastructureConfiguration(this, 'InfrastructureConfigruation', {
      name: infraConfigName,
      description: 'Infrastructure configuration for NAT instances builder pipeline',
      instanceProfileName: instanceProfile.instanceProfileName,
      instanceTypes: [ec2.InstanceType.of('c7gn' as ec2.InstanceClass, ec2.InstanceSize.MEDIUM).toString()],
      securityGroupIds: [securityGroup.securityGroupId],
      subnetId: subnetId,
    });
  }

  /**
   * Creates Image Builder distribution settings that essentially copy AMIs to other regions and apply tags
   *
   * @returns Image Builder distribution configuration construct
   */
  private createDistributionSettings(): imagebuilder.CfnDistributionConfiguration {
    // We are considering copy of AMIs to the DR region too
    const regions = [cdk.Aws.REGION, 'us-east-1'];

    return new imagebuilder.CfnDistributionConfiguration(this, 'DistributionSettigns', {
      name: 'NatInstancesDistribution',
      description: 'Distribution settings for NAT instances images',
      distributions: regions.map((region: string) => {
        return {
          region: region,
          amiDistributionConfiguration: {
            name: `${NAT_INSTANCES_NAME_TAG}-{{ imagebuilder:buildVersion }}-{{ imagebuilder:buildDate }}`,
            description: 'NAT instances image',
            amiTags: {
              Name: 'NAT instances image',
              Version: '{{ imagebuilder:buildVersion }}',
              CreationDate: '{{ imagebuilder:buildDate }}',
              'deploy:tool': 'EC2 builder pipeline',
              'deploy:type': 'ImagePipeline',
              'project:name': 'my-project',
              'project:version': 'v1',
              'stack:name': cdk.Stack.of(this).stackName,
            },
          },
        }
      }),
    });
  }

  /**
   * Creates the Image Builder Pipeline for NAT instances that uses the image recipe,
   * infrastructure configuration and distribution settings specified in the parameters
   *
   * @param imageRecipe Image Builder recipe construct
   * @param infrastructureConfiguration Image Builder infrastructure configuration construct
   * @param distributionSettings Image Builder distribution configuration construct
   * @returns Image Builder Pipeline construct
   */
  private createImageBuilderPipeline(
    imageRecipe: imagebuilder.CfnImageRecipe,
    infrastructureConfiguration: imagebuilder.CfnInfrastructureConfiguration,
    distributionSettings: imagebuilder.CfnDistributionConfiguration,
  ): imagebuilder.CfnImagePipeline {
    return new imagebuilder.CfnImagePipeline(this, 'NatInstanceImagePipeline', {
      name: 'NATInstanceBuilder',
      description: 'Pipeline to build NAT instances images',
      infrastructureConfigurationArn: infrastructureConfiguration.attrArn,
      distributionConfigurationArn: distributionSettings.attrArn,
      imageRecipeArn: imageRecipe.attrArn,
      imageTestsConfiguration: {
        imageTestsEnabled: true,
        timeoutMinutes: 60,
      },
      status: 'ENABLED',
    });
  }
}

export {
  NatInstancesPipeline,
}
