# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

AWS CDK (TypeScript) で管理する、単一スタック構成のパブリック公開用ファイルストレージ基盤（`storage.cateiru.dev`）。S3 + CloudFront (OAC) + ACM + GitHub Actions 用 OIDC ロールを1つの CDK スタックで作成する。

パッケージマネージャは pnpm、Node.js バージョンは `.node-version` (`nodenv` 管理) に従う。

## コマンド

- `pnpm install` : 依存関係インストール
- `pnpm run build` : `tsc` による型チェック（`noEmit: true` のためファイル出力はしない）
- `pnpm run watch` : 型チェックのウォッチ
- `pnpm test` : Vitest でユニットテストを実行（`{bin,lib}/**/*.test.ts`）
- `pnpm run test:watch` : Vitest ウォッチモード
- `pnpm test -- -t "<テスト名>"` : 特定のテストのみ実行
- `pnpm exec cdk synth` : CloudFormation テンプレート生成
- `pnpm exec cdk diff` : デプロイ済みスタックとの差分表示
- `pnpm exec cdk deploy` : スタックをデプロイ（実際の AWS リソースに影響するため、ユーザーの明示的な指示がない限り実行しない）

CI (`.github/workflows/ci.yml`) は `pnpm install --frozen-lockfile` → `pnpm run build` → `pnpm test` → `pnpm exec cdk synth` の順に実行する。変更後はローカルでも同じ順序で確認する。

## アーキテクチャ

すべてのインフラ定義は `lib/public-storage-cdk-stack.ts` の `PublicStorageCdkStack` 1クラスに集約されている。`bin/public-storage-cdk.ts` がこのスタックを **`us-east-1` 固定**でインスタンス化する（CloudFront にアタッチする ACM 証明書が `us-east-1` 必須のため）。

スタック内のリソースと依存関係:

1. **S3 バケット** (`cateiru-public-storage`)
   - `BlockPublicAccess.BLOCK_ALL` で直接公開はブロックし、CloudFront (Origin Access Control) 経由のみ読み取りを許可。
   - `removalPolicy: RETAIN`（実データ保持のため誤削除防止）。
2. **ACM 証明書** (`storage.cateiru.dev` 用、DNS 検証)
   - Hosted Zone はこのスタックで管理しない。DNS はスタック利用者側で別途管理する前提のため、検証用 CNAME はデプロイ時に手動で追加する運用（詳細は README のデプロイ手順を参照）。
3. **CloudFront Distribution**
   - S3 バケットをオリジンとし、`storage.cateiru.dev` を代替ドメイン名として設定。認証なし（誰でもアクセス可能）。
   - キャッシュポリシーは `CACHING_OPTIMIZED` のため、S3 更新後は CloudFront のキャッシュ無効化が必要。
4. **GitHub Actions 用 OIDC**
   - `token.actions.githubusercontent.com` の OIDC プロバイダーと IAM ロール (`github-actions-public-storage`) を作成。
   - 信頼ポリシーは `repo:cateiru/*`（StringLike）で、`github.com/cateiru` 配下の全リポジトリ・全ブランチ・全 environment から AssumeRole 可能。
   - 権限は S3 バケットへの読み書きと、対象 CloudFront Distribution への `cloudfront:CreateInvalidation` のみ（最小権限）。
   - **注意**: 同一 AWS アカウントに OIDC プロバイダーが既に存在する場合、`new iam.OpenIdConnectProvider` は `EntityAlreadyExists` で失敗する。その場合は既存プロバイダーの ARN を使った `fromOpenIdConnectProviderArn` に置き換える（README に手順あり）。

`DOMAIN_NAME` と `GITHUB_OWNER` はスタック先頭の定数で定義されており、対象ドメインやリポジトリオーナーを変える場合はここを変更する。

## 公開コンテンツと自動デプロイ

`public/` ディレクトリの中身がS3バケット (`cateiru-public-storage`) にそのまま同期され、`storage.cateiru.dev` として公開される。ファイルを追加・変更する場合はこのディレクトリを編集する。

`.github/workflows/deploy.yml` が `main` へのpush毎に実行され、GitHub Actions用 OIDC ロールを使って `aws s3 sync ./public s3://cateiru-public-storage/ --delete` → `aws cloudfront create-invalidation` を行う。ロールARNとCloudFront Distribution IDは単一アカウント・単一環境向けの個人インフラであるため、このワークフローファイルに直接ハードコードしている。再デプロイ等でDistribution IDが変わった場合はこのファイルの値も更新が必要。

## テスト方針

`lib/public-storage-cdk-stack.test.ts` は `Template.fromStack()` で synth した CloudFormation テンプレートに対して `aws-cdk-lib/assertions` の `Template` API でリソースプロパティを検証するスタイル。新しいリソースやプロパティを追加した場合は、同様のパターンでテストを追加する。

`vitest.setup.ts` で CDK synth 時に作られる一時ディレクトリのクリーンアップ（`CloudAssembly.cleanupTemporaryDirectories()`）を行っている。
