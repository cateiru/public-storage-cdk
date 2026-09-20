---
name: deploy
description: public-storage-cdk スタックを実際にAWSへデプロイする手順。「デプロイして」「cdk deployしたい」「AWSに反映したい」「証明書の検証が終わらない」「bootstrapエラー」など、このリポジトリのAWS環境構築・デプロイに関する依頼があったときに読み込む。
---

# public-storage-cdk デプロイ手順

このスキルは `public-storage-cdk` リポジトリを初めて（または新しいAWSアカウントに）デプロイする際の手順と、実際にハマったポイントをまとめたものです。設計の詳細は `CLAUDE.md` を、コマンド一覧は `README.md` を参照してください。

## 前提: AWS認証情報の準備

CDKはローカルのAWS認証情報（アクセスキー、SSOなど）が必要。未設定だと `Unable to resolve AWS account to use` で失敗する。

1. AWS CLIが無ければインストール（例: Arch Linuxなら `sudo pacman -S aws-cli`）
2. IAMユーザーを用意し、**`AdministratorAccess` を持つグループに所属させる**
   - CDK bootstrap は CloudFormation / S3 / ECR / SSM / IAM ロール作成など広範な権限を必要とし、このスタック自体もIAM OIDCプロバイダーやIAMロールを作成するため、絞った権限だと途中で必ず `AccessDenied` に当たる。個人アカウントでの一時利用なら Admin を素直に付与するのが現実的。
   - ユーザーへの直接アタッチではなく「グループ」にAdministratorAccessを付けてユーザーをグループに入れる方式でも可（このプロジェクトで実際に採用した方法）。
3. `aws configure` またはSSOでクレデンシャルを設定する

## デプロイ手順

### 1. 依存関係インストール

```bash
pnpm install
```

### 2. CDK Bootstrap（アカウント×リージョンごとに初回のみ）

```bash
pnpm exec cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

このスタックは `bin/public-storage-cdk.ts` で `region: 'us-east-1'` に固定されている（CloudFrontにアタッチするACM証明書がus-east-1必須のため）。他リージョンをbootstrapしても意味がない。

### 3. デプロイ実行

```bash
pnpm exec cdk deploy
```

**重要:** IAM関連の変更（OIDCプロバイダー作成、ロール作成など）を含むため、CDKは実行前に差分を表示してy/n確認を求める。この確認はTTYが無い環境（AIエージェント経由のシェルなど）では出せずに `Stack includes security-sensitive updates, but terminal (TTY) is not attached` で停止する。**必ずユーザー自身が対話的なターミナルから実行し、差分を確認した上で `y` を入力すること。** `--require-approval never` で自動承認しない（何が変更されるか見ずに承認するべきではない）。

### 4. ACM証明書のDNS検証待ち（初回デプロイ時に必ず発生する）

初回デプロイは `StorageCertificate` (ACM証明書) がDNS検証待ちで `CREATE_IN_PROGRESS` のまま長時間停止する。これは正常な動作（エラーではない）。

1. AWSコンソールで**リージョンを us-east-1 に切り替えて** ACM (Certificate Manager) を開く
   - リージョンを間違えると証明書が「存在しない」ように見える（実際にはus-east-1にしかない）
2. `storage.cateiru.dev` の証明書（ステータス: 保留中の検証）を開き、表示されている **CNAME名** と **CNAME値**（`....acm-validations.aws.` で終わる）をそのままコピーする
3. `storage.cateiru.dev` を管理しているDNSに、その名前・値でCNAMEレコードを追加する
   - **`storage.cateiru.dev` 自体にレコードを追加するのではなく**、ACMが指定する `_ランダム文字列.storage.cateiru.dev` という別名にレコードを追加する（`storage.cateiru.dev` 本体は後で使うため触らない）
   - Cloudflareを使っている場合、このレコードは**必ずDNSのみ（グレー雲、プロキシOFF）にする**。プロキシをONにすると外部からの名前解決がCloudflareのIPに置き換わり、ACMの検証・自動更新が壊れる。
4. 反映確認（`dig` の結果に `acm-validations.aws.` を含む値が返ればOK）:
   ```bash
   dig +short CNAME <ACMが指定したCNAME名>
   ```
5. DNS検証が完了すると自動的にデプロイが再開する（DNS伝播に数分〜30分程度）

### 5. CloudFront Distribution作成待ち

証明書検証完了後、`StorageDistribution` の作成に進む。CloudFront Distributionの作成は**5〜20分程度**かかるのが通常であり、途中で止まっているように見えても正常（今回の実績: 全体で約36分 = 2154秒）。

### 6. デプロイ完了後: 最終DNS設定

`Outputs` に表示される `DistributionDomainName`（例: `d18n6c7aohv138.cloudfront.net`）に対して、`storage.cateiru.dev` からのCNAME（またはALIAS）レコードをDNSに追加する。

- `storage.cateiru.dev` はゾーンのapexではなくサブドメインなので、CNAMEで問題ない
- Cloudflareのプロキシ（オレンジ雲）をこのレコードに対してONにすること自体は可能。ただしCloudFront側とCloudflare側でキャッシュが二重になるため、GitHub Actionsで `aws cloudfront create-invalidation` するだけではCloudflare側のキャッシュは消えない点に注意（必要ならCIにCloudflareキャッシュパージも追加する）
- Cloudflareを使うなら暗号化モードは「フル (厳密)」推奨（CloudFrontが正当なACM証明書を提示するため）

## トラブルシューティング（実際に遭遇したエラー）

| エラー | 原因 | 対処 |
|---|---|---|
| `Unable to resolve AWS account to use` | AWS認証情報が未設定 | `aws configure` 等で設定 |
| `current credentials could not be used to assume '...cdk-...-role...'` | bootstrap未実施でロールが存在しない、または権限不足 | bootstrap実行、権限確認 |
| `ssm:GetParameter ... AccessDeniedException` | IAMユーザーの権限不足 | AdministratorAccessを付与 |
| `cloudformation:ExecuteChangeSet ... AccessDenied`（Admin付与直後） | グループ作成/ポリシーアタッチが未保存、または反映待ち | IAMコンソールでグループのポリシーアタッチとユーザーの所属を再確認 |
| `SSM parameter /cdk-bootstrap/.../version not found` | bootstrap未実施 | `cdk bootstrap aws://<ACCOUNT_ID>/us-east-1` を実行 |
| `Stack includes security-sensitive updates, but terminal (TTY) is not attached` | 非対話環境からの実行 | 対話的なターミナルから直接 `cdk deploy` を実行し、差分を見てから `y` |
| ACMコンソールに証明書が見当たらない | コンソールのリージョンがus-east-1になっていない | リージョンをus-east-1に切り替える |
| `StorageCertificate` が長時間 `CREATE_IN_PROGRESS` | DNS検証用CNAME未追加、または追加先を間違えている（`storage.cateiru.dev`本体に追加してしまった等） | ACMコンソール記載の正確な名前・値で、指定された別名（`_xxxx.storage.cateiru.dev`）にCNAMEを追加する |
| `StorageDistribution` が長時間 `CREATE_IN_PROGRESS` | CloudFront Distribution作成は通常5〜20分かかる | エラーが出ていなければ待つ |
| GitHub Actionsの`configure-aws-credentials`で `Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity`（ログに `role session tags are being used.` あり） | `configure-aws-credentials@v4` がデフォルトで付与するセッションタグに対し、CDKが作る信頼ポリシーのActionが `sts:AssumeRoleWithWebIdentity` のみで `sts:TagSession` を許可していない | ワークフローの`configure-aws-credentials`ステップに `role-skip-session-tagging: true` を追加する（信頼ポリシー変更＋IAM再デプロイは不要） |
| 上記を修正しても同じ `Not authorized to perform sts:AssumeRoleWithWebIdentity` が続く | `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` で `use_immutable_subject: true` の場合、OIDCトークンの`sub`が `repo:cateiru/*` ではなく `repo:cateiru@<owner_id>/<repo>@<repo_id>:...` 形式になり、信頼ポリシーの条件と一致しない | `lib/public-storage-cdk-stack.ts` の信頼ポリシー条件に `repo:cateiru@<owner_id>/*` パターンを追加してから `cdk deploy`（実際のclaimはワークフローに一時デバッグステップを入れてOIDCトークンをデコードすると確認できる） |

## 既に別スタックでOIDCプロバイダーが存在する場合

`EntityAlreadyExists` で失敗したら、`lib/public-storage-cdk-stack.ts` の `new iam.OpenIdConnectProvider(...)` を、既存プロバイダーのARNを使った `iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(...)` に置き換える（詳細はREADMEのコード例を参照）。
