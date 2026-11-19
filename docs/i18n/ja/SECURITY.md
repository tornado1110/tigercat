<!-- i18n-source: SECURITY.md @ 023e9ea6731ad9ceead7895dbe7c0765d2646630 -->
> 簡体字中国語版が正本です。この翻訳は遅れることがあり、機械翻訳の助けを借りて作りました。訂正を歓迎します。

# セキュリティポリシー

[简体中文](../../../SECURITY.md) | [English](../en/SECURITY.md) | [日本語](../ja/SECURITY.md) | [한국어](../ko/SECURITY.md) | [Español](../es/SECURITY.md)

## 脆弱性の報告

セキュリティ上の脆弱性は、[GitHub Private Vulnerability Reporting](https://github.com/tornado1110/tigercat/security/advisories/new) から非公開で報告してください。

疑わしい脆弱性について、公開の issue、discussion、pull request を開かないでください。公開の文章を書く前に、メンテナが確認して直す時間を取ってください。

issue、pull request、コミット、ログ、discussion に秘密を投稿しないでください。これには API キー、トークン、パスワード、セッション cookie、非公開のエンドポイントが含まれます。秘密が既に漏れている場合は、まずそれを無効化し、そのあと上の非公開の経路から、その露出を報告してください。

## サポートするバージョン

TigerCat はまだ 1.0 より前です。セキュリティ修正は、最新のリリースだけに入ります。

## セキュリティモデル

TigerCat は worker agent を調整します。資格情報の保管場所ではなく、チェックアウトを自分では編集しません。

1. API キーとトークンは、環境変数か、その runtime 自身の認証で渡します。コミットはされません。エラー文とイベントのペイロードは、印字または保存の前に伏字化されます。そのパターンと、覆わない場合は [docs/operations.md](operations.md) にあります。`config.toml` は秘密の保管場所ではありません。
2. 資格情報がモデルのコンテキストに入ってはいけません。coordinator の prompt、worker の prompt、ツール結果、イベントの要約のいずれにも入れません。
3. Worker の権限要求の既定は `ask` です。TigerCat は、既定ではそれらを自動承認しません。
4. coordinator はコードを直接変更できません。作業を worker agent に渡すだけです。
