<!-- i18n-source: CONTRIBUTING.md @ ea10d77c5aa02683c50f6f599b25c729839abc7c -->
> 簡体字中国語版が正本です。この翻訳は遅れることがあり、機械翻訳の助けを借りて作りました。訂正を歓迎します。

# TigerCat への貢献

[简体中文](../../../CONTRIBUTING.md) | [English](../en/CONTRIBUTING.md) | [日本語](../ja/CONTRIBUTING.md) | [한국어](../ko/CONTRIBUTING.md) | [Español](../es/CONTRIBUTING.md)

TigerCat への協力に感謝します。この文書は、チェックアウトの準備、コミットメッセージの書き方、pull request の開き方を説明します。

## 開発環境

TigerCat は Node.js 22.13 以降で動きます（`package.json` の `engines` を参照）。リポジトリに `.nvmrc` がある場合は、それでその Node のバージョンを選んでください。

```bash
git clone https://github.com/tornado1110/tigercat.git
cd tigercat
npm ci
```

pull request を開く前に、次を実行してください。

```bash
npm run lint
npm run typecheck
npm test
```

ビルドがコンパイルするコードを変えたときは、`npm run build` も実行してください。

これらのコマンドがカバーする範囲は [TESTING.md](../../../TESTING.md) に書いてあります。実 agent のエンドツーエンドテストは CI では走りません。有料の API キーが必要だからです。その文書は、CI が代わりに何を実行するかを説明しています。API キーをリポジトリや pull request に置かないでください。

## コミットメッセージ

コミットメッセージは [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) に従ってください。[Release Please](../../../RELEASING.md) はそれを読んで `CHANGELOG.md` を維持し、リリースの pull request を開きます。この規約に合わないコミットは changelog に入らず、バージョンも上がりません。

次の形を使います。

```text
<type>[optional scope][!]: <short summary>

[optional body]

[optional footer]
```

要約は英語の命令形にし、小文字で、末尾にピリオドを付けません。

| 種類 | いつ使うか | バージョンの上げ方 |
| --- | --- | --- |
| `feat` | 利用者から見える能力 | minor（`0.1.0` から `0.2.0`） |
| `fix` | 欠陥の修正 | patch（`0.1.0` から `0.1.1`） |
| `feat!` または `BREAKING CHANGE:` フッタ | 破壊的変更 | バージョンが `0.x` の間は minor。`1.0.0` 以降は major |
| `docs`、`test`、`chore`、`ci`、`refactor`、`perf`、`build` | それ以外 | なし。ただし破壊的変更と印を付けたコミットを除く |

例:

```text
feat: route a stalled task to another ACP runtime

fix(client): retry a worker session that closed before the first event

docs: describe the permission ask default
```

パッケージがまだ `0.x` の間、破壊的変更は `1.0.0` へ飛ばず、minor を上げます。それでもフッタには書いてください。

```text
feat!: drop the legacy session id field

BREAKING CHANGE: session ids from 0.1 are not accepted.
```

## プルリクエスト

1. 最新の `main` からブランチを切る。
2. 変更は一つに絞る。pull request 一つにつき、目的は一つ。
3. すべてのコミットで Conventional Commits を使う。pull request が squash でマージされる場合、タイトルは Conventional Commit でなければならない。そのタイトルが `main` 上のコミットになる。
4. `npm run lint`、`npm run typecheck`、`npm test` を実行する。どうテストしたかを含めて、pull request のテンプレートを埋める。
5. 秘密、トークン、`.env` ファイル、それらを含むログをコミットしない。
6. レビューを待つ。自分がメンテナであり、リポジトリの規則が許す場合を除き、自分の pull request をマージしない。

メンテナが、Release Please の開いたリリース pull request をマージします。貢献者は npm へ公開しません。[RELEASING.md](../../../RELEASING.md) を参照してください。

## セキュリティ

[SECURITY.md](SECURITY.md) の手順で、脆弱性を非公開に報告してください。セキュリティ報告のために公開の issue を作らず、issue、pull request、discussion に秘密を貼り付けないでください。

## 行動規範

このプロジェクトは [Contributor Covenant](../../../CODE_OF_CONDUCT.md) に従います。参加することで、あなたはそれに同意します。

## 翻訳

これらの文書の唯一の正本は簡体字中国語です。文書を変えるときは先に中国語で書き、翻訳はそれに従います。どれが遅れているかは、次のコマンドで見ます。

```bash
npm run docs:i18n-check
```

各翻訳の先頭行は出典マーカーです。中国語ソースのリポジトリパスと、そのファイルの git blob ハッシュを記録します。`git rev-parse HEAD:<path>` の 40 文字すべてであり、改行を LF にした内容に対する `git hash-object` と同じ値です。

```html
<!-- i18n-source: <path> @ <blob> -->
```

コミット SHA は記録しません。このリポジトリは rebase マージだけなので、マージでコミット SHA が書き換わり、短い `%h` の長さも変わります。

このコマンドは CRLF を LF に変換し、参照元の blob が古い翻訳を報告します。HEAD を基準に更新も確認します。参照元の blob だけが変更されて翻訳本文が変わっていない場合や、翻訳本文が原文と一致する場合は、終了コードが 0 以外になります。コミット済みの変更を以前のリビジョンと比較するには `-- --base <revision>` を指定します。PR の CI は対象ブランチと比較します。

母語話者によるレビューの pull request を歓迎します。日本語、韓国語、スペイン語は機械翻訳の助けを借りたもので、母語話者のレビューはまだありません。
