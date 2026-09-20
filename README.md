# public-storage-cdk

AWS CDK (TypeScript) で管理する、パブリック公開用のファイルストレージ基盤です。

## 構成

- **S3バケット** (`cateiru-public-storage`)
  - ファイルの実体を格納します。
  - バケット自体はパブリックアクセスをすべてブロックしており、CloudFront (Origin Access Control) 経由でのみ読み取りを許可します。
  - 誤削除防止のため、削除ポリシーは `RETAIN` にしています。
- **CloudFront Distribution**
  - `storage.cateiru.dev` を代替ドメイン名 (CNAME) として設定し、S3バケットをオリジンとして配信します。
  - 認証は設けていないため、誰でもアクセスできます。
- **ACM証明書**
  - CloudFrontにアタッチするため `us-east-1` に作成しています。
  - DNS検証方式で、Hosted Zoneはこのスタックでは管理していません（DNSは利用者側で別途管理するため）。
- **GitHub Actions用 OIDC**
  - `token.actions.githubusercontent.com` のOIDCプロバイダーと、それを信頼するIAMロール (`github-actions-public-storage`) を作成します。
  - 信頼ポリシーの条件は `repo:cateiru/*` (StringLike) なので、`github.com/cateiru` 配下の全リポジトリ・全ブランチ・全environmentからAssumeRoleWithWebIdentityが可能です。
  - ロールの権限はS3バケットへの読み書きと、対象CloudFront DistributionへのCreateInvalidationのみです（最小権限）。

## デプロイ手順

このスタックは環境非依存にせず、`us-east-1` に固定してデプロイします（ACM証明書がCloudFront向けに`us-east-1`必須のため）。

0. AWS認証情報を設定し（`aws configure` や環境変数など）、対象アカウントの `us-east-1` をまだCDK Bootstrapしていない場合は実行します。

   ```bash
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
   ```

1. 依存関係をインストールします。

   ```bash
   npm install
   ```

2. 初回デプロイを実行します。

   ```bash
   npx cdk deploy
   ```

   ACM証明書がDNS検証待ちのため、デプロイは `CREATE_IN_PROGRESS` のまま止まります。

3. AWSマネジメントコンソールの ACM (us-east-1) を開き、対象証明書に表示されている検証用CNAMEレコード（`_xxxx.storage.cateiru.dev` のようなレコード）を確認します。

4. 3で確認したCNAMEレコードを、利用者が管理しているDNSに追加します。

   > **注意**: 検証待ちの間にデプロイを中断（Ctrl+Cなど）してロールバックが発生すると、ACM証明書は削除され、次回デプロイ時には**別の値の検証用CNAME**が新たに発行されます。ロールバックが発生した場合は、古いレコードではなく、ACMコンソールで再度最新の検証用CNAMEを確認してください。

5. DNS検証が完了すると自動的にデプロイが進み、完了します。完了後の出力 (`Outputs`) から以下を確認します。
   - `DistributionDomainName`: CloudFrontのドメイン名 (`dxxxxxxxxxxxxx.cloudfront.net`)
   - `BucketName` / `DistributionId` / `GitHubActionsRoleArn`

6. `storage.cateiru.dev` から、5で確認した `DistributionDomainName` へのCNAME（またはALIAS）レコードをDNSに追加します。

### OIDCプロバイダーが既に存在する場合

AWSアカウントには `token.actions.githubusercontent.com` のOIDCプロバイダーを1つしか作成できません。他のスタック等で既に作成済みの場合、デプロイは `EntityAlreadyExists` エラーで失敗します。その場合は `lib/public-storage-cdk-stack.ts` 内の

```ts
const githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
  url: 'https://token.actions.githubusercontent.com',
  clientIds: ['sts.amazonaws.com'],
});
```

を、既存プロバイダーのARNを指定した以下のコードに置き換えてください。

```ts
const githubOidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
  this,
  'GitHubOidcProvider',
  '既存プロバイダーのARN',
);
```

## GitHub Actions側の設定例

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: <GitHubActionsRoleArn の出力値>
      aws-region: us-east-1
  - run: aws s3 sync ./dist s3://cateiru-public-storage/
  - run: aws cloudfront create-invalidation --distribution-id <DistributionId の出力値> --paths "/*"
```

`cloudfront:CreateInvalidation` を許可しているのは、デフォルトのキャッシュポリシーが `CACHING_OPTIMIZED` であるため、アップロード後にキャッシュを無効化しないと更新内容がTTLが切れるまで反映されないためです。

## Useful commands

- `npm run build` : 型チェック
- `npm run watch` : ファイル変更を監視して型チェック
- `npm run test` : Vitestによるユニットテスト実行
- `npm run test:watch` : Vitestをウォッチモードで実行
- `npx cdk synth` : CloudFormationテンプレートを生成
- `npx cdk diff` : デプロイ済みスタックとの差分表示
- `npx cdk deploy` : スタックをデプロイ
