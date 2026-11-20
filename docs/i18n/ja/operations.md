<!-- i18n-source: docs/operations.md @ 3452da8c151a5f5df97290f28906e96d7143b976 -->
> 簡体字中国語版が正本です。この翻訳は遅れることがあり、機械翻訳の助けを借りて作りました。訂正を歓迎します。

# TigerCat の操作

[简体中文](../../operations.md) | [English](../en/operations.md) | [日本語](../ja/operations.md) | [한국어](../ko/operations.md) | [Español](../es/operations.md)

このページは、このリポジトリに今日あるプロセスの操作手順です。コマンドは増やしません。`tigercat --help` に無いコマンドは存在しません。

ここで、実在の DeepSeek アカウント、Claude Code、Codex、cc-connect、Feishu に対して実行した項目はありません。それらの行は未検証です。CI が実行する確認は、テスト済みです。

## 実装されていること

| 振る舞い | 状態 |
| --- | --- |
| `tigercat acp` が stdin/stdout で ACP を話す | 実装済み。上流の適合は、その harness が動く範囲での `npm run test:tck` |
| 組み込みの `claude-code` と `codex` プロファイル | 実装済み。CI はベンダーのバイナリではなく `test/stub-agent.ts` とハンドシェイクする |
| ベンダーのバイナリが無いときの `runtime test` | テスト済み。dry-run agent、`vendorExecuted: false`、API キーは読まない |
| `TIGERCAT_CLAUDE_BIN` / `TIGERCAT_CODEX_BIN` または `TIGERCAT_RUNTIME_LIVE=1` 付きの `runtime test` | 実装済み。CI では実行しておらず、この文書のためにも実行していない |
| `coordinator_runtime` が未設定のときのスクリプト化された Router | プロセス内のスクリプト化された brain でテスト済み |
| `coordinator_runtime` が名指しする ACP Router プロセス | 実装済み（`launchCoordinator`）。実モデルに対しては未実行 |
| sqlite の Thread、イベントログ、未配送の Router キューが新しいプロセスを越えて残る | `Engine.start` に実装済み |
| Worker の ACP セッションが再起動を越えて残る | 未実装。`loadSession` は false と宣言される |
| 次の起動で孤児の worker プロセスを回収する | 未実装 |
| TigerCat の中の Feishu または DingTalk | 未実装。それらのチャンネルはホスト側に残る |
| DeepSeek Chat Completions Router（`router.provider = "deepseek"`） | 実装済み。`DEEPSEEK_API_KEY` を読む。実機テストはしていない |

## 配置

TigerCat は一つのフォアグラウンドプロセスです。このリポジトリに `start`、`stop`、`restart`、サービスユニットはありません。

```bash
tigercat --help
tigercat --version
tigercat acp
tigercat acp --config /path/to/config.toml
```


フラグを省いたとき、`TIGERCAT_CONFIG` は `--config` と同じ上書きです。既定のファイルは `~/.tigercat/config.toml` です。そのファイルが無いときは組み込みの既定を使い、`runtime add` または `runtime remove` まで何も書きません。

データベースは `TIGERCAT_DB`、または設定パスと同じディレクトリの `tigercat.sqlite` です。既定は `~/.tigercat/tigercat.sqlite` です。データベースごとにプロセスは一つです。このコードは `node:sqlite` を直接開き、二人目の書き手を調整しません。

[`examples/config.example.toml`](../../../examples/config.example.toml) はスクリプト化されたデモです。Router の実行ファイルは指名しません。コピーしてもモデルは手に入りません。下の[スクリプトデモと実際の Router](#スクリプトデモと実際の-router) を見てください。

`runtime list` は名前、command、args、permission、そしてその行が組み込みかを印字します。環境変数の値は印字しません。

## 資格情報

`router.provider = "deepseek"` のとき、`tigercat acp` は `DEEPSEEK_API_KEY`（または設定された環境変数名）を読み、その変数が無いとリクエストの前に終了します。この呼び出しは実機テストをしていません。Worker の資格情報は、今までどおり子プロセスが既に持っているものです。

子プロセスの環境は、親の環境にその runtime の `env` 表を足したものです。`tigercat acp` を起動したシェルで export した変数は、Router プロセスとすべての Worker から見えます。`env` の一行はその runtime に変数を足すだけで、親から受け継いだ変数は消しません。runtime ごとの秘密のサンドボックスはありません。その隔離は、実プロセスでは検証していません。

三組の資格情報は分けてください。

1. **Router。** `router.provider = "deepseek"` は `DEEPSEEK_API_KEY` の鍵で DeepSeek Chat Completions を呼びます。この経路は実機テストをしていません。鍵を `config.toml` に置かないでください。`router.provider` を省くとスクリプト化された brain のままで、モデルは呼びません。ACP coordinator は、今までどおり自分でインストールし、`coordinator_runtime` で名前を付ける別プログラムです。`router.provider` と `coordinator_runtime` を同時に設定しないでください。
2. **Worker（`claude-code`、`codex`）。** どちらも組み込みで、permission は `ask` です。Claude Code は既存の `claude` ログインか `ANTHROPIC_API_KEY` を使います。Codex は `CODEX_API_KEY` または `OPENAI_API_KEY` を使います。これらはベンダーのプログラムの変数であり、TigerCat は解析しません。`TIGERCAT_CLAUDE_BIN` は `CLAUDE_CODE_EXECUTABLE` として渡されます。`TIGERCAT_CODEX_BIN` は `CODEX_PATH` として渡されます。Router の鍵を Worker に入れないためには、親の環境で export しないでください。鍵を `runtime add --env` に置くより、各製品自身のログインファイルを優先してください。
3. **cc-connect と Feishu。** チャンネルはホストが持ちます。TigerCat の登録はこれだけです。

   ```toml
   type = "acp"
   cmd = "tigercat"
   args = ["acp"]
   ```


   Feishu のトークンを TigerCat の設定や `runtime env` にコピーしないでください。`tigercat acp` は上流の prompt をすべて `source` `acp` として記録します。最初の既定ルールは `source = "acp"` を `respond` として入場させます。Feishu の thread id を使うのは、ホストが `_meta.thread_id` を設定したときだけです。source はそれでも `acp` です。Feishu の往復は実行していません。

`runtime add --env K=V` は値を平文で `config.toml` に書きます。そのファイルは秘密の保管場所ではありません。値がベンダーのバイナリのような秘密でないパスである場合を除き、`env` は空にしてください。

組み込み worker はコード上 `ask` です。サンプルは runtime の行を足さないので、`permission` を設定しません。`runtime add --permission` は `ask`、`auto`、`deny` を受け付けます。

## スクリプトデモと実際の Router

これらは別物です。サンプルファイルは最初の一つだけです。

### スクリプトデモ

`coordinator_runtime` は未設定のままです。すると `cmdAcp` は `launchCoordinator` を呼びません。Router はこのプロセスの `ScriptedRouter` です。`default_worker_runtime` が名指しする runtime を spawn し、モデルは呼びません。

コード上のその名前の既定は文字列 `worker` です。その名前は組み込みではありません。設定ファイルが無いとき、スクリプト化された brain が spawn すると決めた trigger は `unknown runtime worker` で失敗します。サンプルは `default_worker_runtime` を `claude-code` にします。これは組み込みです。

README のチェックアウト手順は次です。

```bash
npm install
npm run build
npm link
```


`bin/tigercat.js` は `dist/cli.js` を読み込むので、コマンドを起動する前に `npm run build` が必要です。`npm link` は、README が `tigercat` を `PATH` に置くために使っている方法です。チェックアウトから、link せずに使う場合:

```bash
node bin/tigercat.js --help
node bin/tigercat.js runtime list
node bin/tigercat.js acp
```


サンプルのコピーは任意です。それでもモデルは起動しません。

```bash
mkdir -p ~/.tigercat
cp examples/config.example.toml ~/.tigercat/config.toml
tigercat runtime list
tigercat acp
```


そのとき `runtime list` は組み込みの `claude-code` と `codex` を表示します。Router のコマンドは表示しません。サンプルが足していないからです。`tigercat acp` はフォアグラウンドに留まり、stdin と stdout で改行区切りの JSON-RPC を話します。`claude` のバイナリが無く `TIGERCAT_RUNTIME_LIVE` も未設定なら、スクリプト化された brain が `claude-code` として spawn した worker は dry-run agent を使います。その経路は API キーを読みません。それでもモデルではありません。

### 実在の ACP Router

前提であり、ここでは提供しません。自分でインストールし、設定した ACP agent の実行ファイルです。このリポジトリはそれを同梱せず、`router-acp` という名前のプログラムを含まず、DeepSeek や他のモデルのインストール方法も書きません。

そのプログラムが既にマシン上にあるときは、`tigercat --help` が既に載せているコマンドで登録します。山括弧はプレースホルダであり、コピーするコマンドではありません。

```bash
tigercat runtime add <name> --command <existing-acp-agent> --permission ask
```


それから、実際に読み込む設定ファイルで `coordinator_runtime` を `<name>` にします。`tigercat acp` はそのコマンドを spawn します。コマンドが見つからないと、起動は `bad_runtime` で失敗します。プレースホルダを `config.toml` に書いて、動く Router として扱わないでください。

cc-connect や他の ACP クライアントは `tigercat acp` の親です。ログと ACP のトラフィックは stdin と stdout を共有します。秘密を prompt にパイプしないでください。README のホスト断片（`type = "acp"`、`cmd = "tigercat"`、`args = ["acp"]`）は、このリポジトリが読み込むファイルではなく、Feishu の往復も実行していません。このページは cc-connect のインストール手順を足しません。

## 開始

`tigercat acp` がフォアグラウンドプロセスです。デーモンのコマンドはありません。

`tigercat acp` は `process.cwd()` をワークスペースの根にします。Worker のディレクトリはその木の下に作られます。git のチェックアウトの中では `.tigercat/worktrees/<workerId>`、そうでなければ `.tigercat/workers/<workerId>` です。

モデルを持ち出す前に、組み込みを確認してください。`PATH` に `claude` も `codex` も無く、`TIGERCAT_RUNTIME_LIVE` も未設定なら、次は API キーを読みません。

```bash
tigercat runtime test claude-code
tigercat runtime test codex
```


JSON の報告は `mode` が `dry-run`、`vendorExecuted` が false です。実アダプタの起動は `tigercat --help` にある手動コマンドです。この文書のためのテストは、それを実行していません。

## 停止

stop サブコマンドはありません。

きれいな経路は、ACP クライアントが stdin を閉じることです。すると `serveUpstream` が戻り、`engine.close()` が生きている各 worker handle に終了を求め、IPC の待ち受けと sqlite の handle が閉じます。

その経路は 500ms 後に `process.exit(0)` も予定し、上流の MCP クライアントが閉じたときにもう一度予定します。Worker の解体はその窓の中でのベストエフォートです。排出しきる保証ではありません。

このコードに SIGINT と SIGTERM のハンドラはありません。POSIX では worker プロセスは detached で起動されるので、TigerCat のプロセスだけを殺すシグナルはそれらを残します。次の起動は保存された pid を見ず、殺しもしません。

## 再起動と回復

再起動とは、フォアグラウンドプロセスを止めてから、同じ設定とデータベースで `tigercat acp` を再び実行することです。

そのあと `Engine.start` は次をします。

- 既存の Router セッション行を残すか、一行挿入する
- 処理中の Router キュー行を pending に戻し、`router_busy` を `0` にする
- 終端でない Worker をすべて `interrupted` にし、購読を外し、`worker process was not alive after restart` という `worker.error` を記録する

Thread とイベントログは残ります。worktree ディレクトリはディスクに残ります。`removeWorkspace` は存在しますが、この経路では呼びません。

起きないこと:

- `session/load` は呼ばれません。上流の agent は `loadSession: false` と宣言します。`runtime test` は `degraded: ["loadSession"]` と報告します。Worker は前の ACP セッションを再開できません。
- 保存された pid は回収されません。
- ターンの途中だった Worker は再開されません。購読が外れたので、その Thread は再び Router を通ります。

一回きりのコマンド `list`、`send`、`read`、`interrupt`、`wait`、`kill`、`subscribe`、`unsubscribe`、`spawn` は同じデータベースを開き、自分で `Engine.start` を呼びます。終端でない Worker が残るデータベースに対して `tigercat list` を実行すると、別の `tigercat acp` がまだそれらを持っていても、それらの Worker は interrupted になります。実行中プロセスのデータベースにこれらのコマンドを向けないでください。読み取り専用の状態コマンドはありません。

## ログ

イベントのペイロードと CLI のエラー文は、保存または印字の前に伏字化されます。

- runtime の `env` のうち、名前に `key`、`token`、`secret`、`password`、`credential` を含むものの正確な値
- 親の環境にある同種の変数で、値が 8 文字以上かつ引用符も波括弧も含まないもの
- `tigercat mcp --token` に渡すローカルホストの IPC トークン
- `Authorization` の bearer/basic/digest ヘッダ、`x-api-key` / `api_key` の代入、秘密らしい名前の `NAME=value`、対応する JSON フィールド、`sk-` / `sk-ant-` / `sk-proj-` トークン

失敗したハンドシェイクのプロバイダ stderr は、この除去のあとでのみ `bad_runtime` エラーに入ります。ユニットテストは `fake-bearer-token-0001` のような固定の偽文字列を使います。プロバイダは呼びません。

prompt のテキストは、送られたまま保存されます。`trigger.ingested` はそのテキストをコピーしませんが、trigger の行と Router のキューはコピーします。伏字化は prompt を書き換えません。メッセージに貼った鍵は sqlite に残り、Router に渡ることがあります。鍵を prompt に貼らないでください。

限界であり、実プロバイダに対しては未検証です。上のどれにも当てはまらない形で印字された秘密、4 文字より短い値（親の環境では 8）、引用符や波括弧を含む値は、まだ現れることがあります。伏字化だけを制御にしないでください。鍵を prompt、ルールの文、`config.toml` に置かないでください。

`runtime list` は `env` を印字しません。書いた場合、設定ファイルには残っています。

## トラブルシューティング

`runtime test` の JSON が `ok: false` かつ `mode: "dry-run"` なら、失敗したのは dry-run プロセスであり、Claude Code や Codex が鍵を拒んだのではありません。`mode: "adapter"` は、このプロセスが adapter を起動したという意味です。`vendorExecuted: false` は、ベンダーのバイナリを実行していないという意味です。

`unknown runtime <name>` は、その名前が組み込みでも、読み込まれた設定ファイルの `command` でもないという意味です。`--config` と `TIGERCAT_CONFIG` を確認してください。

`max concurrency <n> reached` は設定の `max_concurrency` です（既定 4）。`starting` または `running` の Worker を数えます。

クラッシュのあと、`tigercat list --json` は自分で回復を実行し、Worker は `interrupted` と出ます。そのあとで `tigercat acp` を起動するか、`acp` を直接起動して同じ回復をさせてください。古い ACP セッション id が使えるとは期待しないでください。

二つの `tigercat acp` プロセスが一つの sqlite ファイルを指していたら、両方止めてください。このコードは、二人の書き手が使ったデータベースを修復しません。

権限の問い合わせは、何かが答えるまで Worker に残ります。`tigercat acp` の中に、Worker の `ask` 方針へ自動で答えるものはありません。止まった権限は、`worker.turn_end` に決して到達しない Worker に見えます。

## この木に無いもの

- Router の実行ファイルは無く、そのインストール手順もありません。他に何もインストールしないときに動く Router は、プロセス内のスクリプト化された brain だけです。
- DeepSeek Chat Completions Router は実装されています（`router.provider = "deepseek"`、鍵は `DEEPSEEK_API_KEY`）。実機テストはしていません。既定はスクリプト化された brain のままです。
- 既定の worker runtime 名 `worker` は組み込みではありません。
- `session/load` はオフです。再起動は Worker の ACP セッションを再開せず、保存された pid も回収しません。SIGINT と SIGTERM にハンドラはありません。
- `session.pid` は worker のハンドシェイクが返ったあとに書かれます。この pull request はそこを変えず、待ちも足しません。pid を早く読みすぎる Windows のテストは、開発中のプロセス起動レースです。
- データベースごとに `node:sqlite` の handle は一つです。二人目の書き手は調整されません。
- prompt のテキストは送られたまま保存されます。
- 実在の DeepSeek、Claude Code、Codex、cc-connect、Feishu は実行していません。
