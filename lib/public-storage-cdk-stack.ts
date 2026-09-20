import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';

const DOMAIN_NAME = 'storage.cateiru.dev';
const GITHUB_OWNER = 'cateiru';
// GitHub側で immutable subject claims (`use_immutable_subject: true`) が有効な場合、
// OIDCトークンの sub は `repo:<owner>@<owner_id>/<repo>@<repo_id>:...` の形式になる。
// `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` で確認したこのアカウントの owner_id。
const GITHUB_OWNER_ID = '24271196';

// S3のライフサイクルルールは「タグが無いオブジェクトを対象にする」条件を作れないため、
// 自動削除したいオブジェクト側にこのタグを付ける運用にする(付けなければ index.html 含め永続保持される)。
const AUTO_EXPIRE_TAG_KEY = 'auto-expire';
const AUTO_EXPIRE_TAG_VALUE = 'true';
const AUTO_EXPIRE_AFTER_DAYS = 180;

export class PublicStorageCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3: ファイル格納用バケット ---
    // 誰でも閲覧できるようにするが、S3 への直接公開はせず CloudFront (OAC) 経由のみ許可する。
    // 実データを保持するため、誤って削除されないよう RETAIN にしておく。
    const bucket = new s3.Bucket(this, 'StorageBucket', {
      bucketName: 'cateiru-public-storage',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireTaggedObjects',
          enabled: true,
          tagFilters: {
            [AUTO_EXPIRE_TAG_KEY]: AUTO_EXPIRE_TAG_VALUE,
          },
          expiration: cdk.Duration.days(AUTO_EXPIRE_AFTER_DAYS),
        },
      ],
    });

    // --- ACM: CloudFront にアタッチする証明書 (us-east-1 必須) ---
    // DNS は利用者側で管理しているため、Hosted Zone は指定せず、
    // 発行される検証用 CNAME レコードを手動で追加してもらう運用とする。
    const certificate = new acm.Certificate(this, 'StorageCertificate', {
      domainName: DOMAIN_NAME,
      validation: acm.CertificateValidation.fromDns(),
    });

    // --- CloudFront: storage.cateiru.dev で公開するディストリビューション ---
    const distribution = new cloudfront.Distribution(this, 'StorageDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [DOMAIN_NAME],
      certificate,
      defaultRootObject: 'index.html',
    });

    // --- GitHub Actions OIDC ---
    // github.com/cateiru 配下の全リポジトリ(全ブランチ・全 environment)からの
    // AssumeRoleWithWebIdentity を許可する。
    // 同一 AWS アカウントに OIDC プロバイダーが既に存在する場合は
    // `new iam.OpenIdConnectProvider` が `EntityAlreadyExists` で失敗するため、
    // その場合は下記を `iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(...)` に
    // 置き換えること（README 参照）。
    const githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const githubActionsRole = new iam.Role(this, 'GitHubActionsRole', {
      roleName: 'github-actions-public-storage',
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            // immutable subject claimsが無効(従来形式)/有効(owner_id/repo_id付き)の
            // どちらでもマッチするよう両方のパターンを許可する。
            'token.actions.githubusercontent.com:sub': [
              `repo:${GITHUB_OWNER}/*`,
              `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/*`,
            ],
          },
        },
      ),
      description: `Assumed by GitHub Actions workflows in github.com/${GITHUB_OWNER} repositories to access the storage bucket`,
      maxSessionDuration: cdk.Duration.hours(1),
    });

    bucket.grantReadWrite(githubActionsRole);

    githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
      }),
    );

    // --- Outputs ---
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: `DNS で ${DOMAIN_NAME} の CNAME/ALIAS としてこの値を指定してください`,
    });
    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', { value: githubActionsRole.roleArn });
  }
}
