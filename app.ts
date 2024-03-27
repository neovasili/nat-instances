#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from './src/stacks/Vpc';
import { NatInstancesStack } from './src/stacks/NatInstances';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

const vpcStack = new VpcStack(app, 'VpcStack', {
  stackName: 'VpcStack',
  env: { account, region },
});

const natInstancesStack = new NatInstancesStack(app, 'NatInstancesStack', {
  stackName: 'NatInstancesStack',
  env: { account, region },
});
natInstancesStack.addDependency(vpcStack);
