#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { PublicStorageCdkStack } from '../lib/public-storage-cdk-stack';

const app = new cdk.App();

// CloudFront にアタッチする ACM 証明書は us-east-1 でのみ作成できるため、
// スタック全体を us-east-1 に固定する。
new PublicStorageCdkStack(app, 'PublicStorageCdkStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
