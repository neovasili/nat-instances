import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct, IConstruct } from 'constructs';

import { NUMBER_OF_AVAILABILITY_ZONES } from '../constants/Common';

/**
 * Vpc basic stack
 */
class VpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: 'vpc',
      maxAzs: NUMBER_OF_AVAILABILITY_ZONES,
      natGateways: NUMBER_OF_AVAILABILITY_ZONES,
      subnetConfiguration: [{
        name: 'public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 24,
      },{
        name: 'private',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        cidrMask: 24,
      }],
      restrictDefaultSecurityGroup: false,
    });
    // Export VPC values
    new ssm.StringParameter(this, 'VpcId', {
      parameterName: '/Vpc/Id',
      stringValue: vpc.vpcId,
    });
    new ssm.StringParameter(this, 'VpcCidrBlock', {
      parameterName: '/Vpc/CidrBlock',
      stringValue: vpc.vpcCidrBlock,
    });

    // Export Public subnets relevant values
    vpc.publicSubnets.map((subnet: ec2.ISubnet, index: number) => {
      const camelCaseAzName = VpcStack.getCamelCaseAvailabilityZoneName(subnet.availabilityZone);

      new ssm.StringParameter(this, `PublicSubnet${camelCaseAzName}Id`, {
        parameterName: `/Vpc/PublicSubnet/${subnet.availabilityZone}/Id`,
        description: `Subnet ID of 'publicSubnet${index + 1}' in '${subnet.availabilityZone}' Az`,
        stringValue: subnet.subnetId,
      });
      const natGateways = subnet.node.children.filter((element: IConstruct) => element.node.id === 'NATGateway');
      // There is only one NatGateway per Subnet so we can safety assume item in position 0 is there
      const aZNatGateway = natGateways[0] as ec2.CfnNatGateway;

      new ssm.StringParameter(this, `PublicSubnet${camelCaseAzName}NatGatewayId`, {
        parameterName: `/Vpc/NatGateway/${subnet.availabilityZone}/Id`,
        description: `NatGateway ID in '${subnet.availabilityZone}' Az`,
        stringValue: aZNatGateway.attrNatGatewayId,
      });
    });

    // Export Private subnets relevant values
    vpc.privateSubnets.map((subnet: ec2.ISubnet, index: number) => {
      const camelCaseAzName = VpcStack.getCamelCaseAvailabilityZoneName(subnet.availabilityZone);

      new ssm.StringParameter(this, `PrivateSubnet${camelCaseAzName}Id`, {
        parameterName: `/Vpc/PrivateSubnet/${subnet.availabilityZone}/Id`,
        description: `Subnet ID of 'privateSubnet${index + 1}' in '${subnet.availabilityZone}' Az`,
        stringValue: subnet.subnetId,
      });
      new ssm.StringParameter(this, `PrivateRouteTable${camelCaseAzName}Id`, {
        parameterName: `/Vpc/PrivateRouteTable/${subnet.availabilityZone}/Id`,
        description: `PrivateRouteTable ID in '${subnet.availabilityZone}' Az`,
        stringValue: subnet.routeTable.routeTableId,
      });
    });
  }

  /**
   * Utility method that receives an availability zone name as dashed normal format and returns a CameCase version of it
   * 
   * @example eu-west-1a -> EuWest1a
   * 
   * @param availabilityZone Name of the availability zone to convert
   * @returns CamelCase name of the availability zone
   */
  public static getCamelCaseAvailabilityZoneName(availabilityZone: string): string {
    return availabilityZone.split('-').map((part: string) => part[0].toUpperCase().concat(part.substring(1))).join('');
  }
}

export {
  VpcStack,
}
