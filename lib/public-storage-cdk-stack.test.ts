import { test, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { PublicStorageCdkStack } from '../lib/public-storage-cdk-stack';

function synthTemplate() {
  const app = new cdk.App();
  const stack = new PublicStorageCdkStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

test('S3 バケットが Public Access Block 有効かつ RETAIN で作成される', () => {
  const template = synthTemplate();

  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'cateiru-public-storage',
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
  });
});

test('S3 バケットに auto-expire タグ付きオブジェクトを180日で削除するライフサイクルルールがある', () => {
  const template = synthTemplate();

  template.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: {
      Rules: [
        {
          Status: 'Enabled',
          ExpirationInDays: 180,
          TagFilters: [{ Key: 'auto-expire', Value: 'true' }],
        },
      ],
    },
  });
});

test('storage.cateiru.dev 向けの ACM 証明書 (DNS 検証) が us-east-1 に作られる', () => {
  const template = synthTemplate();

  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'storage.cateiru.dev',
    ValidationMethod: 'DNS',
  });
});

test('CloudFront Distribution が storage.cateiru.dev のエイリアスを持つ', () => {
  const template = synthTemplate();

  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      Aliases: ['storage.cateiru.dev'],
    },
  });
});

test('GitHub Actions ロールの信頼ポリシーが cateiru 配下の全リポジトリを許可する', () => {
  const template = synthTemplate();

  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'github-actions-public-storage',
    AssumeRolePolicyDocument: {
      Statement: [
        {
          Action: 'sts:AssumeRoleWithWebIdentity',
          Effect: 'Allow',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            },
            StringLike: {
              'token.actions.githubusercontent.com:sub': [
                'repo:cateiru/*',
                'repo:cateiru@24271196/*',
              ],
            },
          },
        },
      ],
    },
  });
});
