<!-- i18n-source: README.md @ 4e1bd85438a374689397b47e29650310c502f016 -->
> 간체 중국어판이 기준입니다. 이 번역은 원문보다 늦을 수 있으며, 기계 번역의 도움을 받았습니다. 수정은 환영합니다.

# TigerCat

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

코딩 에이전트를 위한 Super-agent 라우터입니다. 상주하는 ACP 라우터 하나가 작업을 Claude Code, Codex, 또는 임의의 ACP agent에 넘깁니다.

TigerCat은 [Agent Client Protocol](https://agentclientprotocol.com) 위에 있습니다. 업스트림에서 보면 이것**이 곧** ACP agent입니다(`tigercat acp`). 그래서 cc-connect나 Zed 같은 호스트가 이를 구동할 수 있습니다. 다운스트림에서는 ACP 클라이언트이며, 등록된 어떤 ACP runtime에서든 Worker를 띄웁니다. Feishu와 DingTalk은 그 호스트에 남고, TigerCat은 IM 채널을 구현하지 않습니다.

이것은 subagent 도구가 아닙니다. 상주 Router는 라우팅하고 사람과 대화할 뿐입니다. Worker는 작업을 하나씩 맡고, Thread를 구독하고, Router에 결과를 보고합니다.

플러그인 모드에서는 현재 Codex 세션의 네이티브 셸, 편집, 파일 쓰기 도구를 Codex가 제어합니다. TigerCat의 MCP 서버는 자신의 도구를 등록하며, Codex의 네이티브 도구를 검사하거나 제거할 수 없습니다. 셸, 편집, 쓰기가 Router의 유효 도구 집합에 남아 있는 동안 플러그인 프로세스는 시작을 거부하며, 더 느슨한 권한 모드로 물러나지 않습니다. 이것은 도구 격리가 아니며 M0도 통과하지 않았습니다. TigerCat의 Skill은 메인 세션이 구현을 Worker에게 맡기도록 안내합니다. Worker 권한 정책은 TigerCat이 시작한 Worker를 제약하고, 메인 세션이 도구를 직접 쓸 때는 Codex 호스트 설정을 따릅니다.

같은 디렉터리의 `server/cli.js plugin`은 MCP 진입점이고, 작업 디렉터리는 플러그인 루트입니다. Codex, Claude Code 또는 다른 호스트가 이것을 띄우면 프로세스는 시작을 거부합니다. 이유는 위에 있습니다. `.codex-plugin` 매니페스트는 Codex가 설치를 찾게 할 뿐이며, Worker/ACP 핵심은 특정 호스트에 의존하지 않습니다.

조정 도구 계약에는 `runtimes`, `spawn`, `resume`, `list`, `send`, `read`, `interrupt`, `wait`, `kill`, `subscribe`, `unsubscribe`이 포함됩니다. Lark 바인딩을 설정하면 계약에 `lark_status`, `lark_discover`, `lark_execute`도 들어갑니다. 이것은 지금 노출된 도구 면이 아닙니다. 저장소 조사, 구현, 테스트, 지속 작업은 사용자가 "TigerCat을 써"라고 말하기 전에 메인 세션이 Worker에게 넘깁니다. 설명, 확인, 잡담은 메인 세션이 직접 처리합니다. 외부 부작용은 여전히 사용자 확인이 필요합니다. `spawn`에는 사용자 프로젝트의 절대 `cwd`가 있어야 합니다. `wait`는 한 번에 최대 30초입니다. 플러그인 시작 디렉터리는 설치 위치이며, 그것으로 프로젝트 경로를 알 수 없습니다. Worker의 실제 코딩 능력은 선택한 ACP runtime에서 옵니다.

MCP 연결을 닫으면 Worker가 정리됩니다. 기본은 플러그인 프로세스마다 임시 상태를 갖는 것입니다. `TIGERCAT_PLUGIN_DB`를 설정하면 기록을 남길 수 있지만, 그 데이터베이스는 플러그인 프로세스 하나만 쓸 수 있습니다. 재시작이 `session/load`를 호출하는지는 adapter가 `initialize`에서 보고하는 `agentInfo`로 정하고, runtime 이름으로 정하지 않습니다. 복구는 `agentInfo.name`이 `@agentclientprotocol/claude-agent-acp`이고 `agentInfo.version`이 `0.108.0`이거나, `agentInfo.name`이 `@agentclientprotocol/codex-acp`이고 `agentInfo.version`이 `2.7.0`이며, `loadSession`이 true일 때만 허용합니다. 이 두 이름은 설치된 고정 adapter가 `initialize` 응답에 쓰는 `agentInfo.name`입니다. `session/load` 요청이 진행되는 동안 다시 보낸 기록 `session/update`는 버리고 새 `worker.update`로 저장하지 않습니다. TigerCat은 `recovered`가 true이고 `nativeSession`이 `loaded`인 `worker.update`를 하나 기록합니다. 불러오기 응답 뒤에 adapter가 보내는 알림(claude-agent-acp의 `available_commands_update` 등)은 보통 `worker.update`로 저장합니다. Feishu와 업스트림 ACP는 `worker.turn_end`와 `worker.error`만 전달하므로 이 행들은 밖으로 배달되지 않습니다. 이름은 같아도 버전이 목록에 없는 내장 adapter는 `session/load`를 호출하지 않고 `lost`(`worker.lost`, `reason`은 `builtin_no_restore`)가 되며 구독은 Router로 돌아갑니다. 작업은 자동으로 다시 실행되지 않습니다. `loadSession`이 true가 아니면 `reason`은 `load_unsupported`입니다. 그 밖의 `agentInfo.name`은 `loadSession`을 알리면 불러오기를 시도합니다. 이름이 `claude-code`여도 목록의 adapter를 가리키면 복구하고, 다른 곳을 가리키면 그 adapter 자신의 `initialize` 신원으로 판단합니다. `running`이나 `starting`은 그대로 `lost`(`reason`은 `in_flight_turn`)이며 `session/load`를 호출하지 않습니다. `codex-acp` 2.7.0의 `session/load` 응답에는 `sessionId`가 없어서 이 경로에서는 `session_mismatch`가 나지 않습니다. `interrupted`는 명시적 interrupt를 위한 것이며 이 재시작에는 쓰지 않습니다. 이것은 M0을 통과했다는 뜻이 아닙니다. 비정상 종료로 남은 `.plugin-lock`은 옛 프로세스가 끝났는지 확인한 뒤에 지웁니다. 이 버전은 Codex 세션의 자동 깨움, 연결이 끊긴 뒤의 계속 실행, 지속적인 결과 전달을 약속하지 않습니다.

이 저장소는 1주차 타당성 골격입니다. 완성된 M0이 아닙니다. 실제 Claude Code / Codex 세션, Feishu 왕복, 실제 모델을 Router로 쓰는 것, 그리고 벤더 harness에 네이티브 shell이나 편집 도구가 없다는 증명은 모두 아직 검증되지 않았습니다. CI는 stdio stub으로 `claude-code`와 `codex` 프로필을 구동합니다. 실제 바이너리용 수동 명령은 아래에 있습니다. TigerCat 자신의 MCP 카탈로그가 그 도구를 넣지 않는다고 해서, 다운스트림 agent가 스스로 가진 도구가 무엇인지를 말해 주지는 않습니다. 채널을 넘는 진입과 공유 PR 진입은 M1이며, 이 골격의 범위가 아닙니다.

## 빠른 시작

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run build
npm link

tigercat runtime list
tigercat runtime discover
tigercat runtime test claude-code
tigercat runtime test codex
```

`claude-code`와 `codex`는 내장되어 있습니다. `runtime test`는 `initialize`, `session/new`, `session/prompt`를 실행합니다.

`claude`나 `codex` 바이너리가 없고 `TIGERCAT_RUNTIME_LIVE`도 설정하지 않으면, 이 테스트는 로컬 dry-run agent와 핸드셰이크합니다. 보고서에는 `mode: "dry-run"`과 `vendorExecuted: false`가 있습니다. Claude Code와 Codex는 시작되지 않으며, API 키도 읽지 않습니다.

바이너리를 넣은 뒤 실제로 실행하는 명령은 다음과 같습니다.

```bash
tigercat runtime discover --json
tigercat runtime test claude-code
tigercat runtime test codex
```

`TIGERCAT_CLAUDE_BIN`은 `CLAUDE_CODE_EXECUTABLE`로 전달됩니다. `TIGERCAT_CODEX_BIN`은 `CODEX_PATH`로 전달됩니다. Claude Code는 기존 `claude` 로그인 또는 `ANTHROPIC_API_KEY`를 사용합니다. Codex는 `CODEX_API_KEY` 또는 `OPENAI_API_KEY`를 사용합니다. 화면이 없는 머신에서는 `NO_BROWSER=1`을 설정해 Codex가 ChatGPT 로그인 화면을 열지 않게 합니다.

이 adapter들은 CLI도 함께 포함합니다. 벤더 바이너리가 `PATH`에 없을 때 `TIGERCAT_RUNTIME_LIVE=1`은 그 adapter를 실행합니다. 패키지를 받아 벤더와 통신하므로 자격 증명이 필요합니다.

```bash
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test claude-code
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test codex
```

| 런타임 | 패키지 | 버전 | 실행 파일 |
|---|---|---|---|
| `claude-code` | `@agentclientprotocol/claude-agent-acp` | 0.108.0 | `claude-agent-acp` |
| `codex` | `@agentclientprotocol/codex-acp` | 2.7.0 | `codex-acp` |

이 버전들은 2026-11-18에 npm registry에서 고정했습니다. `claude-code`는 `CLAUDE_AGENT_ACP_PROTOCOL=v1`을 붙여 시작하므로, 세션은 이 클라이언트가 구현한 안정적인 v1 수명 주기(`session/new`, `session/prompt`, `session/cancel`)에 머뭅니다. adapter를 이미 설치했다면 그것이 `npx`를 대신합니다.

```bash
TIGERCAT_CLAUDE_CODE_ACP=/usr/local/bin/claude-agent-acp tigercat runtime test claude-code
TIGERCAT_CODEX_ACP=/usr/local/bin/codex-acp tigercat runtime test codex
```

같은 이름의 `runtime add`는 내장 항목을 덮어씁니다. 두 이름 모두 `coordinator_runtime`이 될 수 있습니다. Router 도구 목록은 여전히 spawn, list, send, read, interrupt, wait, kill, subscribe, unsubscribe뿐입니다.

`coordinator_runtime`은 직접 설치한 ACP agent의 이름입니다. 이 저장소는 그 프로그램을 넣지 않습니다. 필드를 비워 두면 스크립트 brain이 유지됩니다. [docs/operations.md](docs/i18n/ko/operations.md)를 보세요. 입장 정책 파일은 `examples/rules.default.toml`이며, 현재 버전은 `2026-11-19.1`입니다. 메시지 전체가 명시적인 잡담(`thanks`, `lol`, `morning`, 그리고 그 파일의 일본어·한국어·스페인어 확인)이면 결과는 `ignore`이고 Router 호출은 없습니다. 구독자가 없을 때 `Morning all`이나 `coffee break` 같은 알 수 없는 자연어는 `candidate`입니다. 이미 구독된 Thread에서 확인을 하면 그 Worker에 대한 `respond`입니다. `candidate`는 `ignore`로 다시 쓰이지 않습니다. 트리거 본문은 NFKC입니다. 규칙의 리터럴도 같이 접히고, 접히며 생긴 정규식 메타문자는 이스케이프되므로 전각 문장부호는 리터럴로 남습니다. 백슬래시 뒤의 비 ASCII 문자도 그 리터럴에 들어가므로 `\＊`는 `*`와 맞습니다. 일치는 항상 대소문자를 가리지 않고, 악센트는 유지됩니다. 목록에 없는 `adios`는 `adiós`와 맞지 않습니다. 문자 클래스 안의 코드 포인트 하나가 여러 코드 포인트로 접히면 `loadConfig`가 규칙 이름을 담아 실패하고, 규칙을 고치기 전에는 서비스가 시작되지 않습니다. 일본어와 한국어는 부분 문자열, 라틴 문자는 유니코드 글자 경계 `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`입니다(규칙이 `u` 플래그를 가지며 `\b`는 쓰지 않습니다). 문장에 작업이 함께 있으면 이 규칙은 무시하지 않습니다.

```bash
tigercat acp
```

## Router로서의 DeepSeek

`router.provider = "deepseek"`는 스크립트 brain을 DeepSeek Chat Completions로 바꿉니다(`POST {base_url}/chat/completions`, `Authorization: Bearer $DEEPSEEK_API_KEY`, 모델 `deepseek-flash`, thinking은 끔). Router가 호출할 수 있는 것은 `spawn`, `list`, `send`, `read`, `interrupt`, `wait`, `kill`, `subscribe`, `unsubscribe`뿐입니다. 키가 없으면 `tigercat acp`는 어떤 요청보다 먼저 멈춥니다. 제공자 오류는 ACP prompt에 `Router failed: ...`로 돌아옵니다. dry-run도 없고, 스크립트로 되돌리는 길도 없습니다.

```toml
default_worker_runtime = "claude-code"

[router]
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
```

이 호출은 문서에 근거하며, 이 저장소에서 실기 테스트는 하지 않았습니다. 제공자 HTTP 오류는 상태만 보고합니다. 응답 본문은 버립니다.

Claude Code는 [Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)의 절차입니다. `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN`에 DeepSeek 키, `ANTHROPIC_MODEL=deepseek-flash[1m]`(그 페이지의 기본 opus/sonnet/haiku와 subagent 변수도 포함). [Messages API](https://api-docs.deepseek.com/api/create-message)는 `x-api-key` 또는 `Authorization: Bearer`와 모델 `deepseek-flash`를 받습니다. 그것은 Chat Completions가 아닙니다.

Codex는 [Integrate with Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)와 [Using the Responses API](https://api-docs.deepseek.com/guides/responses_api)의 절차입니다. Codex는 Responses API를 말합니다. 문서의 제공자 설정은 `base_url = "https://api.deepseek.com/"`, `wire_api = "responses"`, `model = "deepseek-flash"`, `~/.codex/models.json` 목록, 그리고 DeepSeek 키로 둔 `experimental_bearer_token`입니다. 이 저장소는 `CODEX_API_KEY`나 `OPENAI_API_KEY`가 그 제공자를 고른다고 보지 않습니다.

`deepseek-flash`는 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)의 모델 id입니다. 도구 호출은 `POST /chat/completions`입니다([Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion), [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)). Thinking은 기본적으로 켜져 있습니다. 이 Router는 `{"thinking": {"type": "disabled"}}`를 보내 `tool_choice`가 thinking이 아닌 경로에 머물게 합니다([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)).

`spawn`은 실제 adapter 명령을 실행합니다. 바이너리나 키가 없을 때의 실패는 숨기지 않습니다. ACP prompt는 Worker를 기다리지 않습니다. `session/prompt`를 열어 두면 cc-connect가 바쁘고 다음 Feishu 메시지가 큐에 들어갑니다. Worker가 나중에 끝나면, `CC_SESSION_KEY`가 설정되어 있을 때 TigerCat은 `cc-connect send --stdin`을 실행합니다(cc-connect가 ACP agent를 시작할 때 그 값을 넣습니다). 그것은 데몬 소켓으로 보내고, 데몬이 플랫폼 세션에서 전송합니다. prompt가 반환된 뒤의 `session/update`는 그 전송이 아닙니다. `CC_SESSION_KEY`가 없으면 prompt는 결과가 Feishu에 닿지 않는다고 말합니다.

## cc-connect

TigerCat을 범용 ACP agent로 등록합니다. Feishu 또는 DingTalk 채널은 호스트가 가집니다.

```toml
type = "acp"
cmd = "tigercat"
args = ["acp"]
```

호스트가 주제나 pull request를 알고 있으면 prompt의 `_meta.thread_id`에 Thread id를 넘깁니다. 없으면 업스트림 세션 자체가 하나의 Thread가 됩니다(`acp:<sessionId>`).

## 운영

포그라운드에서의 시작, 중지, 재시작, 자격 증명을 나누는 방법, 스크립트 데모 설정은 [docs/operations.md](docs/i18n/ko/operations.md)에 있습니다. [examples/config.example.toml](examples/config.example.toml)은 `coordinator_runtime`을 설정하지 않습니다. 그것은 모델 Router가 아니며, 이 저장소는 그것을 넣지 않습니다. `start`도 `stop`도 하위 명령이 없습니다. `runtime add --env`는 평문을 `config.toml`에 씁니다. API 키를 거기에 넣지 마세요.

## 1주차에 하는 일

Trigger는 순서가 있는 규칙 엔진에 입장한 뒤 다음과 같이 라우팅됩니다.

- `ignore`는 버려집니다. Router 호출은 없습니다.
- 이미 Worker가 구독한 Thread에는 이후 Trigger가 직접 갑니다. Router 턴은 생기지 않습니다.
- 그 밖의 것은 Router의 다음 턴으로 묶입니다. `candidate` 판단은 거기서만 합니다. 구독자가 없는 `respond`는 spawn됩니다.
- `spawn`은 즉시 `{ "status": "started" }`를 반환합니다. 결과는 Router가 한가할 때 밀어 넣고, 바쁠 때는 하나의 배치로 대기합니다. `wait`는 선택입니다.
- 규칙에 있는 정지 구문은 현재 턴을 취소하고(`session/cancel`) 구독은 **유지합니다**. 그래서 「멈추고, 대신 X를 하라」는 그 Worker에게 그대로 도달합니다.
- `interrupt`는 현재 턴을 취소하고 구독은 유지합니다. Worker를 `lost`로 표시하지 않습니다. `interrupted`는 이 명시적 interrupt를 위한 것이며 재시작에는 쓰지 않습니다. `kill`이나 비정상 종료는 구독을 모두 놓고 worktree는 남깁니다. `session/load` 호출 여부는 `initialize`의 `agentInfo`로 정하고 runtime 이름으로 정하지 않습니다. 목록은 `@agentclientprotocol/claude-agent-acp` `0.108.0`과 `@agentclientprotocol/codex-acp` `2.7.0`뿐이며 `loadSession`이 true일 때입니다. 이 `agentInfo.name`은 설치된 고정 adapter의 것입니다. `session/load`가 진행되는 동안 다시 보낸 기록은 버리고 새 `worker.update`로 저장하지 않습니다. TigerCat은 `recovered: true`, `nativeSession: "loaded"`인 `worker.update`를 하나 기록합니다. 응답 뒤의 알림(claude-agent-acp의 `available_commands_update` 등)은 보통 `worker.update`입니다. Feishu와 업스트림 ACP는 `worker.turn_end`와 `worker.error`만 전달하므로 이 행들은 밖으로 배달되지 않습니다. 같은 이름의 다른 버전인 내장 신원은 `session/load`를 호출하지 않고 `lost`(`reason`은 `builtin_no_restore`)가 되며 구독은 Router로 돌아가고 worktree는 남습니다. `loadSession`이 true가 아니면 `reason`은 `load_unsupported`입니다. 그 밖의 신원은 `loadSession`을 알리고 불러오기가 성공할 때만 원래 ACP session id와 구독을 남깁니다. 이름이 `claude-code`이고 목록의 adapter를 가리키면 복구하고, 다른 곳을 가리키면 그 신원으로 판단합니다. `running`이나 `starting`은 `lost`(`reason`은 `in_flight_turn`)이며 `session/load`를 호출하지 않습니다. `codex-acp` 2.7.0의 불러오기 응답에는 `sessionId`가 없어 `session_mismatch`가 되지 않습니다. 자동 테스트는 이 신원을 보고하는 stdio stub을 쓰며, 이 저장소의 테스트는 실제 Claude Code나 Codex를 시작하지 않습니다. 이것은 M0을 통과했다는 뜻이 아닙니다. `lost` 뒤에 그 Thread는 다시 Router를 거칩니다.

`worker.turn_end.awaitingInput`은 TigerCat이 붙이는 주석이며 ACP 필드가 아닙니다. agent의 `stopReason`은 ACP가 보낸 그대로 저장됩니다(보통 `end_turn`). 그 이유가 `end_turn`이고 Worker 텍스트가 질문이나 확인 요청처럼 보일 때에만 TigerCat은 `awaitingInput`을 세웁니다.

상태는 `Store` 인터페이스 뒤의 `node:sqlite`에 있습니다. 프로세스가 유지하는 것은 socket과 timer뿐입니다. 재시작은 Thread와 아직 전달되지 않은 Router 큐를 다시 읽습니다. 재시작은 `initialize`의 `agentInfo.name`과 `agentInfo.version`으로 `session/load`를 호출할지 정하고, runtime 이름으로 정하지 않습니다. 목록은 `@agentclientprotocol/claude-agent-acp` `0.108.0`과 `@agentclientprotocol/codex-acp` `2.7.0`뿐이며 `loadSession`이 true일 때입니다. 같은 이름의 다른 버전은 `lost`(`reason`은 `builtin_no_restore`)가 되고 구독은 놓이며 Thread는 Router로 돌아갑니다. 이 두 이름이 아닌 사용자 runtime은 `loadSession`이 true이고 불러오기가 성공하면 원래 ACP session id와 구독을 남깁니다. 설정 이름이 `claude-code`여도 실제 adapter의 `initialize` 신원으로 판단합니다. `session/load` 도중의 기록 재생은 버리고 새 `worker.update`로 저장하지 않습니다. TigerCat은 `recovered`가 true인 `worker.update`를 하나 기록합니다. 응답 뒤의 알림(`available_commands_update` 등)은 보통 `worker.update`입니다. Feishu와 업스트림 ACP는 `worker.turn_end`와 `worker.error`만 전달합니다. 턴이 아직 진행 중이면 `lost`(`reason`은 `in_flight_turn`)가 되고 `idle`로 바꾸지 않으며 `session/load`도 호출하지 않습니다. `codex-acp` 2.7.0의 `session/load` 응답에는 `sessionId`가 없어 그 때문에 `session_mismatch`가 나지 않습니다. 이것은 이 신원을 보고하는 stdio stub으로 확인한 것이며, 이 저장소 테스트가 실제 Claude Code나 Codex를 시작한 결과가 아니고 M0을 통과했다는 뜻도 아닙니다.

## 테스트

```bash
npm test
```

`npm run test:tck`는 [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0`을 `tigercat acp`에 대해 실행합니다([uv](https://docs.astral.sh/uv/)가 필요합니다). harness가 끝나면 스크립트는 그 상태 코드로 종료하며, `os.killpg`를 통과로 보지 않습니다. 어느 플랫폼에서든 MANDATORY 실패는 0이 아닌 종료입니다. `uvx`가 없으면 종료 코드는 2이고, `dist/cli.js`가 없으면 1입니다. Windows에서 이 고정된 버전은 자신의 teardown에서 `os.killpg`를 호출합니다. 그때 스크립트는 해당 requirement id를 **UNVERIFIED**로 추가로 출력하고, 이 단계는 0이 아닌 코드로 종료합니다. 그것은 통과가 아닙니다. CI는 VERDICT, MANDATORY의 passed/failed/skipped 개수, 합계, 그리고 UNVERIFIED 줄이 있으면 그것을 job summary에 씁니다. 재생 fixture는 테스트 엔지니어의 JSONL schema를 씁니다. harness는 `test/harness/`에 있습니다. Fixture 파일은 QA 소유이며, 라벨 차이를 지우려고 여기서 수정하지 않습니다.
