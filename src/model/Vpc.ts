/**
 * VPC availability zones configuration, used to map public/private subnets with their private route table
 */
interface AzConfiguration {
  /**
   * Name of the Availability Zone
   *
   * @see https://aws.amazon.com/about-aws/global-infrastructure/regions_az/
   */
  availabilityZone: string;
  /**
   * Public subnet ID used in this AZ
   */
  publicSubnetId: string;
  /**
   * ID of the NatGateway in this avilability zone
   */
  natGatewayId: string;
  /**
   * Private subnet ID used in this AZ
   */
  privateSubnetId: string;
  /**
   * Private route table ID used in this AZ
   */
  privateRouteTableId: string;
}

export {
  AzConfiguration,
}
