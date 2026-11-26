<!-- i18n-source: README.md @ 88f23225cd4c862315fba74419425867c3561b84 -->
> 簡体字中国語版が正本です。この翻訳は遅れることがあり、機械翻訳の助けを借りて作りました。訂正を歓迎します。

# TigerCat

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

コーディングエージェント向けの Super-agent ルーターです。常駐する一つの ACP ルーターが、作業を Claude Code、Codex、または任意の ACP agent へ振り分けます。

TigerCat は [Agent Client Protocol](https://agentclientprotocol.com) の上に載っています。上流から見ると、これ**そのもの**が ACP agent です（`tigercat acp`）。そのため cc-connect や Zed のようなホストがこれを駆動できます。下流では ACP クライアントであり、登録済みのどの ACP runtime 上でも Worker を起動します。Feishu と DingTalk はそれらのホスト側に残り、TigerCat は IM チャンネルを実装しません。

これは subagent ツールではありません。常駐する Router はルーティングと、人との対話だけを行います。Worker はタスクを一つずつ受け持ち、Thread を購読し、Router に結果を返します。

プラグインモードでは、現在の Codex セッションのネイティブなシェル、編集、およびファイル書き込みのツールは Codex が制御します。TigerCat の MCP サーバーは自分のツールを登録し、Codex のネイティブツールを検査することも取り除くこともできません。シェル、編集、書き込みが Router の有効なツール集合に残っているあいだ、プラグインプロセスは起動を拒否し、より緩い権限モードへは退きません。これはツール隔離ではなく、M0 も通過していません。TigerCat の Skill は、メインセッションに実装を Worker へ委ねるよう案内します。Worker の権限ポリシーは TigerCat が起動した Worker を制約し、メインセッションがツールを直接使うときは Codex ホストの設定に従います。

同じディレクトリの `server/cli.js plugin` は MCP の入口で、作業ディレクトリはプラグインのルートです。Codex、Claude Code、または他のホストがそれを起動すると、プロセスは起動を拒否します。理由は上にあります。`.codex-plugin` のマニフェストは Codex がインストールを見つけるためだけで、Worker/ACP の中核は特定のホストに依存しません。

調整ツールの契約には `runtimes`、`spawn`、`resume`、`list`、`send`、`read`、`interrupt`、`wait`、`kill`、`subscribe`、`unsubscribe` が含まれます。Lark のバインディングを設定すると、契約には `lark_status`、`lark_discover`、`lark_execute` も入ります。これは現在公開されているツール面ではありません。リポジトリの調査、実装、テスト、継続的な作業では、メインセッションがユーザーの「TigerCat を使って」を待たずに Worker へ渡します。説明、確認、雑談はメインセッションが直接扱います。外部への副作用にはユーザーの確認が必要です。`spawn` にはユーザーのプロジェクトの絶対 `cwd` が必要です。`wait` は 1 回あたり最大 30 秒です。プラグインの起動ディレクトリはインストール先であり、そこからプロジェクトのパスは分かりません。Worker の実際のコーディング能力は、選んだ ACP runtime から来ます。

MCP 接続を閉じると Worker は片付けられます。既定ではプラグインプロセスごとに一時的な状態を持ちます。`TIGERCAT_PLUGIN_DB` を設定すると履歴を残せますが、そのデータベースを使えるプラグインプロセスは一つだけです。再起動で `session/load` を呼ぶかは、adapter が `initialize` で報告する `agentInfo` で決まり、runtime の名前では決まりません。回復を許すのは、`agentInfo.name` が `@agentclientprotocol/claude-agent-acp` で `agentInfo.version` が `0.108.0`、または `agentInfo.name` が `@agentclientprotocol/codex-acp` で `agentInfo.version` が `2.7.0` であり、かつ `loadSession` が true のときだけです。この二つの名前は、インストール済みの固定 adapter が `initialize` 応答に書く `agentInfo.name` です。`session/load` 要求の途中で再送された履歴は捨て、新しい `worker.update` にはしません。TigerCat は `recovered` が true、`nativeSession` が `loaded` の `worker.update` を記録します。読み込み応答のあと、adapter が送る状態またはメタデータの通知（例えばコマンド一覧、セッション情報、使用量）は普通の `worker.update` として保存します。古い会話の本文は含みません。Feishu と上流 ACP が転送するのは `worker.turn_end` と `worker.error` だけで、これらの行は外部へ配送しません。名前が同じでも版が名簿に無い組み込み adapter は `session/load` を呼ばず、`lost`（`worker.lost`、`reason` は `builtin_no_restore`）になり、購読は Router に戻ります。タスクは自動では再実行されません。`loadSession` が true でないときの `reason` は `load_unsupported` です。それ以外の `agentInfo.name` は、`loadSession` を宣言していれば読み込みを試みます。名前が `claude-code` でも名簿内の adapter を指していれば回復し、別のものを指すときはその adapter 自身の `initialize` 識別で判断します。`running` または `starting` は `lost`（`reason` は `in_flight_turn`）のままで、`session/load` は呼びません。`codex-acp` 2.7.0 の `session/load` 応答には `sessionId` が無いので、この経路では `session_mismatch` は起きません。`interrupted` は明示的な interrupt のためのものであり、この再起動には使いません。これは M0 を通過したという意味ではありません。異常終了で残った `.plugin-lock` は、古いプロセスが終了したことを確認してから削除します。この版は、Codex セッションの自動起動、切断後の継続、永続的な結果配送を約束しません。

このリポジトリは第 1 週の実現可能性スケルトンです。完成した M0 ではありません。実際の Claude Code / Codex セッション、Feishu の往復、実モデルを Router にすること、そしてベンダーの harness にネイティブの shell や編集ツールが無いという証明は、いずれも未検証です。CI は stdio stub を通して `claude-code` と `codex` のプロファイルを駆動します。実バイナリ向けの手動コマンドは下にあります。TigerCat 自身の MCP カタログがそれらのツールを載せないことは、下流の agent が自分で持っているツールについては何も言いません。クロスチャンネルの入口と共有 PR の入口は M1 であり、このスケルトンの範囲ではありません。

## クイックスタート

Node.js 22.13 以降が必要です。

```bash
npm install
npm run build
npm link

tigercat runtime list
tigercat runtime discover
tigercat runtime test claude-code
tigercat runtime test codex
```

`claude-code` と `codex` は組み込みです。`runtime test` は `initialize`、`session/new`、`session/prompt` を実行します。

`claude` または `codex` のバイナリが無く、`TIGERCAT_RUNTIME_LIVE` も設定されていないとき、このテストはローカルの dry-run agent とハンドシェイクします。レポートには `mode: "dry-run"` と `vendorExecuted: false` があります。Claude Code と Codex は起動せず、API キーも読みません。

バイナリを入れたあと、実際に動かすコマンドは次のとおりです。

```bash
tigercat runtime discover --json
tigercat runtime test claude-code
tigercat runtime test codex
```

`TIGERCAT_CLAUDE_BIN` は `CLAUDE_CODE_EXECUTABLE` として渡されます。`TIGERCAT_CODEX_BIN` は `CODEX_PATH` として渡されます。Claude Code は既存の `claude` ログイン、または `ANTHROPIC_API_KEY` を使います。Codex は `CODEX_API_KEY` または `OPENAI_API_KEY` を使います。画面の無いマシンでは `NO_BROWSER=1` を設定し、Codex が ChatGPT のログイン画面を開かないようにします。

これらの adapter は CLI も同梱しています。ベンダーのバイナリが `PATH` に無いとき、`TIGERCAT_RUNTIME_LIVE=1` はその adapter を起動します。パッケージをダウンロードしてベンダーと通信するため、資格情報が必要です。

```bash
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test claude-code
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test codex
```

| ランタイム | パッケージ | バージョン | 実行ファイル |
|---|---|---|---|
| `claude-code` | `@agentclientprotocol/claude-agent-acp` | 0.108.0 | `claude-agent-acp` |
| `codex` | `@agentclientprotocol/codex-acp` | 2.7.0 | `codex-acp` |

これらのバージョンは 2026-11-18 に npm registry からピン留めしました。`claude-code` は `CLAUDE_AGENT_ACP_PROTOCOL=v1` を付けて起動し、セッションを、このクライアントが実装している安定版 v1 のライフサイクル（`session/new`、`session/prompt`、`session/cancel`）に留めます。adapter を既にインストールしてある場合、それが `npx` の代わりになります。

```bash
TIGERCAT_CLAUDE_CODE_ACP=/usr/local/bin/claude-agent-acp tigercat runtime test claude-code
TIGERCAT_CODEX_ACP=/usr/local/bin/codex-acp tigercat runtime test codex
```

同じ名前の `runtime add` は組み込みを上書きします。どちらの名前も `coordinator_runtime` にできます。Router のツール一覧は、今も spawn、list、send、read、interrupt、wait、kill、subscribe、unsubscribe だけです。

`coordinator_runtime` は、自分でインストールした ACP agent の名前です。このリポジトリはそのプログラムを同梱しません。フィールドを空のままにすると、スクリプト化された brain のままです。[docs/operations.md](docs/i18n/ja/operations.md) を見てください。入場ポリシーのファイルは `examples/rules.default.toml` で、現在のバージョンは `2026-11-19.1` です。メッセージ全体が明示的な雑談（`thanks`、`lol`、`morning`、およびそのファイルの日本語・韓国語・スペイン語の確認）のとき、結果は `ignore` になり、Router の呼び出しはゼロです。誰も購読していないとき、`Morning all` や `coffee break` のような未知の自然言語は `candidate` です。既に購読されている Thread 上の確認は、その Worker への `respond` です。`candidate` が `ignore` に書き換えられることはありません。トリガー本文は NFKC です。規則のリテラルも同様に畳み、畳みで生じた正規表現のメタ文字はエスケープするので、全角の句読点はリテラルのままです。バックスラッシュの直後の非 ASCII 文字もそのリテラルに入り、`\＊` は `*` に一致します。照合は常に大文字小文字を区別せず、アクセントは残します。一覧にない `adios` は `adiós` に一致しません。文字クラス内の 1 符号位置が複数の符号位置に畳まれる場合、`loadConfig` は規則名付きで失敗し、直すまでサービスは起動しません。日本語と韓国語は部分文字列、ラテン文字は Unicode の文字境界 `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` です（規則が `u` フラグを持ち、`\b` は使いません）。文にタスクも含まれるときは無視しません。

```bash
tigercat acp
```

## Router としての DeepSeek

`router.provider = "deepseek"` は、スクリプト化された brain を DeepSeek Chat Completions に置き換えます（`POST {base_url}/chat/completions`、`Authorization: Bearer $DEEPSEEK_API_KEY`、モデル `deepseek-flash`、thinking は無効）。Router が呼べるのは `spawn`、`list`、`send`、`read`、`interrupt`、`wait`、`kill`、`subscribe`、`unsubscribe` だけです。鍵が無いと、`tigercat acp` はリクエストの前に止まります。プロバイダのエラーは ACP の prompt 上で `Router failed: ...` として返ります。dry-run はなく、スクリプト化されたフォールバックもありません。

```toml
default_worker_runtime = "claude-code"

[router]
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
```

これらの呼び出しはドキュメントに基づいており、このリポジトリから実機テストはしていません。プロバイダの HTTP エラーはステータスだけを報告します。レスポンス本文は捨てます。

Claude Code は [Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) の手順です。`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_AUTH_TOKEN` に DeepSeek の鍵、`ANTHROPIC_MODEL=deepseek-flash[1m]`（そのページにある既定の opus/sonnet/haiku と subagent の変数も含む）。[Messages API](https://api-docs.deepseek.com/api/create-message) は `x-api-key` または `Authorization: Bearer` とモデル `deepseek-flash` を受け付けます。これは Chat Completions ではありません。

Codex は [Integrate with Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex) と [Using the Responses API](https://api-docs.deepseek.com/guides/responses_api) の手順です。Codex は Responses API を話します。文書化されたプロバイダ設定は `base_url = "https://api.deepseek.com/"`、`wire_api = "responses"`、`model = "deepseek-flash"`、`~/.codex/models.json` のカタログ、そして DeepSeek の鍵を入れた `experimental_bearer_token` です。このリポジトリは、`CODEX_API_KEY` や `OPENAI_API_KEY` がそのプロバイダを選ぶとは見なしません。

`deepseek-flash` は [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) にあるモデル id です。ツール呼び出しは `POST /chat/completions` です（[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)）。Thinking は既定でオンです。この Router は `{"thinking": {"type": "disabled"}}` を送り、`tool_choice` が thinking 以外の経路に留まるようにします（[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)）。

`spawn` は実際の adapter コマンドを起動します。バイナリや鍵が無い失敗は、隠さず表に出ます。ACP の prompt は Worker を待ちません。`session/prompt` を開いたままにすると cc-connect が塞がり、次の Feishu メッセージがキューに入ります。Worker が後で終わったとき、`CC_SESSION_KEY` が設定されていれば TigerCat は `cc-connect send --stdin` を実行します（cc-connect は ACP agent を起動するときにそれを注入します）。それはデーモンのソケットへ投稿し、プラットフォームのセッションで送信します。prompt が返ったあとの `session/update` はその送信ではありません。`CC_SESSION_KEY` が無いとき、prompt は結果が Feishu に届かないと述べます。

## cc-connect

TigerCat を汎用の ACP agent として登録します。Feishu または DingTalk のチャンネルはホストが持ちます。

```toml
type = "acp"
cmd = "tigercat"
args = ["acp"]
```

ホストがトピックまたは pull request を知っているときは、prompt の `_meta.thread_id` に Thread id を渡します。無い場合、上流のセッション自身が一つの Thread になります（`acp:<sessionId>`）。

起動方法、ホスト側の断片、ルールと Thread、そしてこの経路がまだ実行していない内容は [docs/cc-connect.md](docs/cc-connect.md) にあります。そのページに録画はなく、Feishu の 4 ステップや M0 を完了とも書いていません。

## 運用

前台での開始、停止、再起動、資格情報の分離、スクリプト化されたデモ設定は [docs/operations.md](docs/i18n/ja/operations.md) にあります。[examples/config.example.toml](examples/config.example.toml) は `coordinator_runtime` を設定しません。それはモデル Router ではなく、このリポジトリはそれを同梱しません。`start` も `stop` もサブコマンドはありません。`runtime add --env` は平文を `config.toml` に書きます。API キーをそこに置かないでください。

## 第 1 週ですること

Trigger は順序付きのルールエンジンで入場したあと、次のようにルーティングされます。

- `ignore` は捨てられます。Router の呼び出しはゼロです。
- 既に Worker が購読している Thread では、その後の Trigger が直接届きます。Router のターンは発生しません。
- それ以外は Router の次のターンにまとめられます。`candidate` の判定はそこでだけ行います。購読者のいない `respond` は spawn されます。
- `spawn` は直ちに `{ "status": "started" }` を返します。結果は Router が空いているときに押し出され、忙しいときは一つのバッチに並びます。`wait` は任意です。
- ルールにある停止の句は、現在のターンを取り消し（`session/cancel`）、購読は**残します**。そのため「止めて、代わりに X をする」は、その Worker に届いたままです。
- `interrupt` は現在のターンを取り消し、購読は残します。Worker を `lost` にはしません。`interrupted` はこの明示的な interrupt のためのもので、再起動には使いません。`kill` またはクラッシュは購読をすべて外し、worktree は残します。`session/load` を呼ぶかは `initialize` の `agentInfo` で決まり、runtime の名前では決まりません。名簿は `@agentclientprotocol/claude-agent-acp` `0.108.0` と `@agentclientprotocol/codex-acp` `2.7.0` だけで、かつ `loadSession` が true のときです。この `agentInfo.name` はインストール済みの固定 adapter のものです。`session/load` の途中で再送された履歴は捨て、新しい `worker.update` にはしません。TigerCat は `recovered` が true、`nativeSession` が `loaded` の `worker.update` を記録します。応答のあと、adapter が送る状態またはメタデータの通知（例えばコマンド一覧、セッション情報、使用量）は普通の `worker.update` です。古い会話の本文は含みません。Feishu と上流 ACP が転送するのは `worker.turn_end` と `worker.error` だけで、これらの行は外部へ配送しません。同じ名前で別の版の組み込み識別は `session/load` を呼ばず、`lost`（`reason` は `builtin_no_restore`）になり、購読は Router に戻り、worktree は残ります。`loadSession` が true でないときの `reason` は `load_unsupported` です。それ以外の識別は、`loadSession` を宣言して読み込みが成功したときだけ、元の ACP session id と購読を残します。名前が `claude-code` で名簿内の adapter を指す設定は回復し、別のものを指すときはその識別で判断します。`running` または `starting` は `lost`（`reason` は `in_flight_turn`）で、`session/load` は呼びません。`codex-acp` 2.7.0 の読み込み応答に `sessionId` は無く、`session_mismatch` にはなりません。自動テストはこれらの識別を報告する stdio stub で、このリポジトリのテストは本物の Claude Code や Codex を起動しません。これは M0 を通過したという意味ではありません。`lost` のあと、その Thread は再び Router を通ります。

`worker.turn_end.awaitingInput` は TigerCat が付ける注釈であり、ACP のフィールドではありません。agent の `stopReason` は ACP が送ったまま保存します（通常は `end_turn`）。この理由が `end_turn` であり、かつ Worker のテキストが質問か、確認を求めているように見えるときだけ、TigerCat は `awaitingInput` を立てます。

状態は `Store` インターフェースの背後にある `node:sqlite` に置きます。プロセスが保持するのは socket と timer だけです。再起動すると Thread と、まだ届いていない Router のキューを読み直します。再起動は `initialize` の `agentInfo.name` と `agentInfo.version` で `session/load` を呼ぶか決め、runtime の名前では決めません。名簿は `@agentclientprotocol/claude-agent-acp` `0.108.0` と `@agentclientprotocol/codex-acp` `2.7.0` だけで、かつ `loadSession` が true のときです。同じ名前で別の版は `lost`（`reason` は `builtin_no_restore`）になり、購読は外れ、Thread は Router に戻ります。この二つの名前以外のユーザー runtime は、`loadSession` が true で読み込みが成功したとき、元の ACP session id と購読を残します。設定上の名前が `claude-code` でも、実際の adapter の `initialize` 識別で判断します。`session/load` の途中の履歴再送は捨て、新しい `worker.update` にはしません。TigerCat は `recovered` が true、`nativeSession` が `loaded` の `worker.update` を記録します。応答のあと、adapter が送る状態またはメタデータの通知（例えばコマンド一覧、セッション情報、使用量）は普通の `worker.update` です。古い会話の本文は含みません。Feishu と上流 ACP が転送するのは `worker.turn_end` と `worker.error` だけで、これらの行は外部へ配送しません。まだ進行中のターンは `lost`（`reason` は `in_flight_turn`）になり、`idle` にはせず、`session/load` も呼びません。`codex-acp` 2.7.0 の `session/load` 応答に `sessionId` は無く、それで `session_mismatch` にはなりません。これはこれらの識別を報告する stdio stub で確認したもので、このリポジトリのテストが本物の Claude Code や Codex を起動した結果ではなく、M0 を通過したという意味でもありません。

## テスト

```bash
npm test
```

`npm run test:tck` は [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0` を `tigercat acp` に対して実行します（[uv](https://docs.astral.sh/uv/) が必要です）。harness が終わったあと、スクリプトはその終了ステータスで終了し、`os.killpg` を合格にはしません。どのプラットフォームでも、MANDATORY の失敗は非ゼロ終了です。`uvx` が見つからないときの終了コードは 2、`dist/cli.js` が無いときは 1 です。Windows では、このピン留めした版が自分の teardown で `os.killpg` を呼びます。当たったときは、スクリプトが該当する requirement id を **UNVERIFIED** と追加で印字し、このステップは非ゼロで終了します。それは合格ではありません。CI は VERDICT、MANDATORY の passed/failed/skipped の件数、合計、そして UNVERIFIED 行があればそれを job summary に書き出します。リプレイの fixture はテストエンジニアの JSONL schema を使います。harness は `test/harness/` にあります。Fixture ファイルは QA が所有しており、ラベルの差を消すために、ここで編集することはありません。
