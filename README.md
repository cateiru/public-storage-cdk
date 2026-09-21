# public-storage-cdk

AWS CDK (TypeScript) で管理する、パブリック公開用のファイルストレージ基盤です。

## 構成

- **S3バケット** (`cateiru-public-storage`)
  - ファイルの実体を格納します。
  - バケット自体はパブリックアクセスをすべてブロックしており、CloudFront (Origin Access Control) 経由でのみ読み取りを許可します。
  - 誤削除防止のため、削除ポリシーは `RETAIN` にしています。
  - オブジェクトに `auto-expire=true` タグを付けてアップロードすると、180日後に自動削除されます。タグを付けなければ（`index.html`など）自動削除の対象にはなりません。
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
   pnpm exec cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
   ```

1. 依存関係をインストールします。

   ```bash
   pnpm install
   ```

2. 初回デプロイを実行します。

   ```bash
   pnpm exec cdk deploy
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

`.github/workflows/deploy.yml` に、`main` へのpush時に `public/` ディレクトリの中身をS3に同期し、CloudFrontのキャッシュを無効化するワークフローを実装済みです。

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: <GitHubActionsRoleArn の出力値>
      aws-region: us-east-1
  - run: aws s3 sync ./public s3://cateiru-public-storage/
  - run: aws cloudfront create-invalidation --distribution-id <DistributionId の出力値> --paths "/*"
```

`cateiru-public-storage` バケットは他リポジトリのCIも同じロールで直接書き込む共有バケットのため、`aws s3 sync` に `--delete` は付けていません。付けるとこのリポジトリの `public/` に無いオブジェクト(＝他リポジトリが書き込んだファイル)がpush毎に全削除されてしまいます。

`cloudfront:CreateInvalidation` を許可しているのは、デフォルトのキャッシュポリシーが `CACHING_OPTIMIZED` であるため、アップロード後にキャッシュを無効化しないと更新内容がTTLが切れるまで反映されないためです。

`role-to-assume` と `--distribution-id` は、このスタックが単一アカウント・単一環境向けの個人インフラであるため、`.github/workflows/deploy.yml` 内に実際の値を直接ハードコードしています。再デプロイ等でDistribution IDが変わった場合は、このファイルの値も更新してください。

## Useful commands

- `pnpm run build` : 型チェック
- `pnpm run watch` : ファイル変更を監視して型チェック
- `pnpm test` : Vitestによるユニットテスト実行
- `pnpm run test:watch` : Vitestをウォッチモードで実行
- `pnpm exec cdk synth` : CloudFormationテンプレートを生成
- `pnpm exec cdk diff` : デプロイ済みスタックとの差分表示
- `pnpm exec cdk deploy` : スタックをデプロイ
