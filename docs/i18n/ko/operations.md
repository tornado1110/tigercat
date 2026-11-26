<!-- i18n-source: docs/operations.md @ 6e533b72167c00b3f382125fc5ce236415bd1246 -->
> 간체 중국어판이 기준입니다. 이 번역은 원문보다 늦을 수 있으며, 기계 번역의 도움을 받았습니다. 수정은 환영합니다.

# TigerCat 운영

[简体中文](../../operations.md) | [English](../en/operations.md) | [日本語](../ja/operations.md) | [한국어](../ko/operations.md) | [Español](../es/operations.md)

이 페이지는 이 저장소에 오늘 있는 프로세스를 다루는 방법입니다. 명령을 추가하지 않습니다. `tigercat --help`에 없는 명령은 존재하지 않습니다.

여기서 실제 DeepSeek 계정, Claude Code, Codex, cc-connect, Feishu에 대해 실행한 항목은 없습니다. 그 행은 검증되지 않은 것으로 표시합니다. CI가 실행하는 확인은 테스트된 것으로 표시합니다.

## 구현된 동작

| 동작 | 상태 |
| --- | --- |
| `tigercat acp`가 stdin/stdout으로 ACP를 말한다 | 구현됨. 업스트림 적합성은 그 harness가 동작하는 범위의 `npm run test:tck` |
| 내장 `claude-code`와 `codex` 프로필 | 구현됨. CI는 벤더 바이너리가 아니라 `test/stub-agent.ts`와 핸드셰이크한다 |
| 벤더 바이너리가 없을 때의 `runtime test` | 테스트됨. dry-run agent, `vendorExecuted: false`, API 키를 읽지 않음 |
| `TIGERCAT_CLAUDE_BIN` / `TIGERCAT_CODEX_BIN` 또는 `TIGERCAT_RUNTIME_LIVE=1`이 있는 `runtime test` | 구현됨. CI에서 실행하지 않았고, 이 문서를 위해 실행하지도 않음 |
| `coordinator_runtime`이 비어 있을 때의 스크립트 Router | 프로세스 안의 스크립트 brain으로 테스트됨 |
| `coordinator_runtime`이 가리키는 ACP Router 프로세스 | 구현됨(`launchCoordinator`). 실제 모델에 대해서는 실행하지 않음 |
| sqlite의 Thread, 이벤트 로그, 아직 전달되지 않은 Router 큐가 새 프로세스에도 남는다 | `Engine.start`에 구현됨 |
| Worker의 ACP 세션이 재시작 뒤에도 남는다 | `initialize`의 `agentInfo`로 판단하고 runtime 이름으로는 판단하지 않는다. 목록은 `@agentclientprotocol/claude-agent-acp` `0.108.0`과 `@agentclientprotocol/codex-acp` `2.7.0`뿐이며 `loadSession`이 true일 때다. 이 `agentInfo.name`은 설치된 고정 adapter의 것이다. 같은 이름의 다른 버전은 `lost`(`reason`은 `builtin_no_restore`)다. `loadSession`이 true가 아니면 `load_unsupported`다. 그 밖의 `agentInfo.name`은 `loadSession`을 알리고 `session/load`가 성공하면 구독을 남긴다. 이름이 `claude-code`인 설정은 실제 adapter의 신원으로 판단한다. `session/load` 도중 다시 보낸 `session/update`는 새 `worker.update`로 저장하지 않고 전달하지도 않는다. `running`이나 `starting`은 `in_flight_turn`이며 `session/load`를 호출하지 않는다. `codex-acp` 2.7.0의 불러오기 응답에는 `sessionId`가 없어 그 때문에 `session_mismatch`가 되지 않는다. 자동 테스트는 stdio stub이다. 이것은 M0을 통과했다는 뜻이 아니다 |
| 다음 시작 때 고아 worker 프로세스를 거둔다 | 구현됨. 기록된 pid의 명령줄이 아직 그 runtime과 맞으면 복구 전에 죽인다. stdio stub으로 테스트했다. Windows에서는 명령줄을 읽을 수 있고 맞을 때만 죽인다 |
| TigerCat 안의 Feishu 또는 DingTalk | 구현되지 않음. 그 채널은 호스트에 남는다 |
| DeepSeek Chat Completions Router(`router.provider = "deepseek"`) | 구현됨. `DEEPSEEK_API_KEY`를 읽는다. 실기 테스트는 하지 않음 |

## 배치

TigerCat은 포그라운드 프로세스 하나입니다. 이 저장소에는 `start`, `stop`, `restart`도 없고 서비스 유닛도 없습니다.

```bash
tigercat --help
tigercat --version
tigercat acp
tigercat acp --config /path/to/config.toml
```


플래그를 생략하면 `TIGERCAT_CONFIG`는 `--config`와 같은 덮어쓰기입니다. 기본 파일은 `~/.tigercat/config.toml`입니다. 그 파일이 없으면 내장 기본값을 쓰고, `runtime add` 또는 `runtime remove` 전까지는 아무것도 쓰지 않습니다.

데이터베이스는 `TIGERCAT_DB`이거나, 설정 경로와 같은 디렉터리의 `tigercat.sqlite`입니다. 기본은 `~/.tigercat/tigercat.sqlite`입니다. 데이터베이스마다 프로세스는 하나입니다. 이 코드는 `node:sqlite`를 직접 열고, 두 번째 쓰는 쪽을 조율하지 않습니다.

[`examples/config.example.toml`](../../../examples/config.example.toml)은 스크립트 데모입니다. Router 실행 파일 이름을 적지 않습니다. 복사해도 모델이 생기지는 않습니다. 아래의 [스크립트 데모와 실제 Router](#스크립트-데모와-실제-router)를 보세요.

`runtime list`는 이름, command, args, permission, 그리고 그 행이 내장인지 출력합니다. 환경 변수 값은 출력하지 않습니다.

## 자격 증명

`router.provider = "deepseek"`이면 `tigercat acp`는 `DEEPSEEK_API_KEY`(또는 설정된 환경 변수 이름)를 읽고, 그 변수가 없으면 어떤 요청보다 먼저 종료합니다. 이 호출은 실기 테스트를 하지 않았습니다. Worker 자격 증명은 여전히 자식 프로세스가 이미 가진 것입니다.

자식 환경은 부모 환경에 그 runtime의 `env` 표를 더한 것입니다. `tigercat acp`를 시작한 셸에서 내보낸 변수는 Router 프로세스와 모든 Worker에 보입니다. `env` 항목은 그 runtime에 변수를 더할 뿐, 부모에게서 물려받은 변수를 지우지 않습니다. runtime마다 비밀을 가두는 샌드박스는 없습니다. 그 격리는 실제 프로세스로 검증하지 않았습니다.

자격 증명 세 묶음은 나누어 두세요.

1. **Router.** `router.provider = "deepseek"`는 `DEEPSEEK_API_KEY`의 키로 DeepSeek Chat Completions를 호출합니다. 이 경로는 실기 테스트를 하지 않았습니다. 키를 `config.toml`에 넣지 마세요. `router.provider`를 생략하면 스크립트 brain이 유지되고, 모델을 호출하지 않습니다. ACP coordinator는 여전히 따로 설치해서 `coordinator_runtime`으로 이름을 붙이는 프로그램입니다. `router.provider`와 `coordinator_runtime`을 함께 설정하지 마세요.
2. **Worker(`claude-code`, `codex`).** 둘 다 내장이고 permission은 `ask`입니다. Claude Code는 기존 `claude` 로그인 또는 `ANTHROPIC_API_KEY`를 사용합니다. Codex는 `CODEX_API_KEY` 또는 `OPENAI_API_KEY`를 사용합니다. 이것은 벤더 프로그램의 변수이며 TigerCat은 해석하지 않습니다. `TIGERCAT_CLAUDE_BIN`은 `CLAUDE_CODE_EXECUTABLE`로 전달됩니다. `TIGERCAT_CODEX_BIN`은 `CODEX_PATH`로 전달됩니다. Router 키가 Worker에 들어가지 않게 하려면 부모 환경에 내보내지 마세요. 키를 `runtime add --env`에 넣기보다 각 제품 자신의 로그인 파일을 우선하세요.
3. **cc-connect와 Feishu.** 채널은 호스트가 가집니다. TigerCat 등록은 이것뿐입니다.

   ```toml
   type = "acp"
   cmd = "tigercat"
   args = ["acp"]
   ```


   Feishu 토큰을 TigerCat 설정이나 `runtime env`에 복사하지 마세요. `tigercat acp`는 업스트림 prompt를 모두 `source` `acp`로 기록합니다. 첫 기본 규칙은 `source = "acp"`를 `respond`로 입장시킵니다. Feishu thread id는 호스트가 `_meta.thread_id`를 설정할 때만 쓰입니다. source는 여전히 `acp`입니다. Feishu 왕복은 실행하지 않았습니다.

`runtime add --env K=V`는 값을 평문으로 `config.toml`에 씁니다. 그 파일은 비밀 저장소가 아닙니다. 값이 벤더 바이너리 같은 비밀이 아닌 경로가 아니면 `env`는 비워 두세요.

내장 worker는 코드에서 `ask`입니다. 샘플은 runtime 행을 더하지 않으므로 `permission`을 설정하지 않습니다. `runtime add --permission`은 `ask`, `auto`, `deny`를 받습니다.

## 스크립트 데모와 실제 Router

이것은 서로 다릅니다. 샘플 파일은 첫 번째 것뿐입니다.

### 스크립트 데모

`coordinator_runtime`은 설정하지 않은 채로 둡니다. 그러면 `cmdAcp`는 `launchCoordinator`를 호출하지 않습니다. Router는 이 프로세스의 `ScriptedRouter`입니다. `default_worker_runtime`이 가리키는 runtime을 spawn하고 모델은 호출하지 않습니다.

코드에서 그 이름의 기본값은 문자열 `worker`입니다. 그 이름은 내장이 아닙니다. 설정 파일이 없으면, 스크립트 brain이 spawn하기로 한 trigger는 `unknown runtime worker`로 실패합니다. 샘플은 `default_worker_runtime`을 `claude-code`로 둡니다. 이것은 내장입니다.

README의 체크아웃 단계는 다음과 같습니다.

```bash
npm install
npm run build
npm link
```


`bin/tigercat.js`는 `dist/cli.js`를 읽으므로, 명령을 시작하기 전에 `npm run build`가 필요합니다. `npm link`는 README가 `tigercat`을 `PATH`에 두는 방법입니다. 체크아웃에서 link 없이:

```bash
node bin/tigercat.js --help
node bin/tigercat.js runtime list
node bin/tigercat.js acp
```


샘플을 복사하는 것은 선택입니다. 그래도 모델은 시작하지 않습니다.

```bash
mkdir -p ~/.tigercat
cp examples/config.example.toml ~/.tigercat/config.toml
tigercat runtime list
tigercat acp
```


그때 `runtime list`는 내장 `claude-code`와 `codex`를 보여 줍니다. Router 명령은 보여 주지 않습니다. 샘플이 더하지 않기 때문입니다. `tigercat acp`는 포그라운드에 머물며 stdin과 stdout으로 줄바꿈으로 나뉜 JSON-RPC를 말합니다. `claude` 바이너리가 없고 `TIGERCAT_RUNTIME_LIVE`도 없으면, 스크립트 brain이 `claude-code`로 spawn한 worker는 dry-run agent를 씁니다. 그 경로는 API 키를 읽지 않습니다. 그래도 모델은 아닙니다.

### 실제 ACP Router

전제이며, 여기서는 제공하지 않습니다. 직접 설치하고 구성한 ACP agent 실행 파일입니다. 이 저장소는 그것을 넣지 않고, `router-acp`라는 프로그램도 없으며, DeepSeek나 다른 모델을 설치하는 방법도 적지 않습니다.

그 프로그램이 이미 머신에 있으면 `tigercat --help`에 이미 있는 명령으로 등록합니다. 각괄호는 자리표시이지, 그대로 복사할 명령이 아닙니다.

```bash
tigercat runtime add <name> --command <existing-acp-agent> --permission ask
```


그다음 실제로 불러오는 설정 파일에서 `coordinator_runtime`을 `<name>`으로 둡니다. `tigercat acp`는 그 명령을 spawn합니다. 명령을 찾지 못하면 시작은 `bad_runtime`으로 실패합니다. 자리표시를 `config.toml`에 쓰고 동작하는 Router로 다루지 마세요.

cc-connect나 다른 ACP 클라이언트는 `tigercat acp`의 부모입니다. 로그와 ACP 트래픽은 stdin과 stdout을 나눕니다. 비밀을 prompt로 파이프하지 마세요. README의 호스트 조각(`type = "acp"`, `cmd = "tigercat"`, `args = ["acp"]`)은 이 저장소가 읽는 파일이 아니며, Feishu 왕복도 실행하지 않았습니다. 이 페이지는 cc-connect 설치 단계를 더하지 않습니다.

## 시작

`tigercat acp`가 포그라운드 프로세스입니다. 데몬 명령은 없습니다.

`tigercat acp`는 `process.cwd()`를 작업 공간 루트로 씁니다. Worker 디렉터리는 그 트리 아래에 만듭니다. git 체크아웃 안에서는 `.tigercat/worktrees/<workerId>`이고, 그렇지 않으면 `.tigercat/workers/<workerId>`입니다.

모델을 끌어들이기 전에 내장을 확인하세요. `PATH`에 `claude`나 `codex`가 없고 `TIGERCAT_RUNTIME_LIVE`도 없으면, 다음은 API 키를 읽지 않습니다.

```bash
tigercat runtime test claude-code
tigercat runtime test codex
```


JSON 보고에서 `mode`는 `dry-run`이고 `vendorExecuted`는 false입니다. 실제 adapter 실행은 `tigercat --help`의 수동 명령입니다. 이 문서를 위한 테스트는 그것을 실행하지 않았습니다.

## 중지

stop 하위 명령은 없습니다.

깨끗한 경로는 ACP 클라이언트가 stdin을 닫는 것입니다. 그러면 `serveUpstream`이 반환하고, `engine.close()`가 살아 있는 각 worker handle에 종료를 요청하며, IPC 수신과 sqlite handle이 닫힙니다.

그 경로는 500ms 뒤에 `process.exit(0)`도 예약하고, 업스트림 MCP 클라이언트가 닫힐 때 다시 예약합니다. Worker 정리는 그 창 안에서의 최선입니다. 비울 것을 보장하지는 않습니다.

이 코드에는 SIGINT와 SIGTERM 처리기가 없습니다. POSIX에서 worker 프로세스는 detached로 뜨므로, TigerCat 프로세스만 죽이는 신호는 그들을 남겨 둡니다. 다음 시작은 저장된 pid를 봅니다. 명령줄이 그 runtime과 아직 맞는 고아 프로세스는 복구 전에 죽입니다.

## 재시작과 복구

재시작은 포그라운드 프로세스를 멈춘 다음, 같은 설정과 데이터베이스로 `tigercat acp`를 다시 실행하는 것입니다.

그다음 `Engine.start`는 다음을 합니다.

- 있는 Router 세션 행은 그대로 두거나, 하나 넣는다
- 진행 중인 Router 큐 행을 pending으로 되돌리고 `router_busy`를 `0`으로 둔다
- 종료 상태가 아닌 Worker마다 기록된 pid를 먼저 다룬다. 명령줄이 runtime과 아직 맞는 살아 있는 프로세스는 죽인다. 상태가 `running` 또는 `starting`이면 그 턴에 결과가 없다. Worker는 `lost`가 되고 `worker.lost`를 기록한다. `reason`은 `in_flight_turn`이고 `message`는 `in-flight turn was lost on restart`이다. 구독은 놓이며 다음 이벤트는 Router로 간다. `session/load`가 성공해도 그 Worker를 `idle`로 바꾸지 않는다. 턴이 이미 끝났고(`idle` 또는 `awaiting_input`) 아래의 `initialize` 신원 규칙이 `session/load`를 허용하고 불러오기가 성공하면, 새 프로세스에서 원래 ACP session id를 읽고 상태는 그대로 두며 Thread 구독은 남고 다음 이벤트는 그 Worker에게 직접 간다. 불러오기 도중의 `session/update` 재생은 새 `worker.update`로 저장하지 않고 전달하지도 않는다. session id가 없거나 `loadSession`을 알리지 않거나 내장 adapter 신원이 허용된 버전이 아니거나 `session/load`가 실패해도 `lost`로 표시하고 구독을 놓는다. `code`는 `lost`이다. `builtin_no_restore`의 `message`는 `built-in runtime does not restore sessions yet`이다. `in_flight_turn`의 `message`는 위와 같다. 다른 `reason`은 `no_session`, `load_unsupported`, `load_failed`, `session_mismatch`이고 그 `message`는 `worker session could not be restored after restart`이다

Thread와 이벤트 로그는 남습니다. worktree 디렉터리는 디스크에 남습니다. `removeWorkspace`는 있지만 이 경로에서는 호출하지 않습니다.

복구는 runtime 이름이 아니라 `initialize` 응답의 `agentInfo.name`, `agentInfo.version`, `agentCapabilities.loadSession`으로 판단합니다. `session/load`를 허용하는 목록은 설치된 adapter가 쓰는 신원과 같은 두 항목뿐입니다. `@agentclientprotocol/claude-agent-acp` 버전 `0.108.0`과 `@agentclientprotocol/codex-acp` 버전 `2.7.0`이며 `loadSession`이 true일 때입니다. `agentInfo.name`이 이 둘 중 하나인데 버전이 목록에 없으면 `session/load`를 보내지 않고 Worker는 `lost`, `reason`은 `builtin_no_restore`, 구독은 Router로 돌아갑니다. `loadSession`이 true가 아니면 `reason`은 `load_unsupported`이며 이름이 목록에 있는지는 따지지 않습니다. `agentInfo`가 없거나 `agentInfo.name`이 이 둘이 아니면 사용자 runtime입니다. `loadSession`을 알리면 불러오기를 시도합니다. 따라서 설정 이름이 `claude-code`여도 실제로는 목록의 adapter를 가리키면 복구하고, 다른 곳을 가리키면 그 프로세스 자신의 `initialize` 신원으로 판단합니다. `session/load` 요청을 보낸 뒤 응답이 올 때까지 받은 `session/update`는 새 `worker.update`로 쓰지 않고 전달이나 배송에도 넘기지 않습니다. 복구에 성공하면 `recovered`가 true이고 `nativeSession`이 `loaded`인 `worker.update`를 하나만 추가합니다. `running`이나 `starting`은 위의 `in_flight_turn`으로 남으며 신원이 목록에 있어도 불러오지 않습니다. 재시작은 `interrupted`를 쓰지 않습니다. `codex-acp` 2.7.0의 `session/load` 응답에는 `sessionId` 필드가 없고, 핸들은 요청한 session id를 유지하므로 이 경로에서는 `session_mismatch`가 나지 않습니다. 이 판단은 바꾸지 않습니다. 자동 테스트는 이 신원을 보고하는 stdio stub입니다. 이 저장소의 테스트는 실제 Claude Code나 Codex를 시작하지 않습니다. 이것은 M0을 통과했다는 뜻이 아닙니다.

`interrupted`는 명시적 interrupt를 위한 상태입니다. 재시작은 이 상태를 쓰지 않습니다. `interrupt`는 현재 턴을 취소하고 구독은 유지합니다. Worker를 `lost`로 표시하지 않습니다. `resume`은 이미 `lost` 또는 `interrupted`인 Worker를 받습니다. 호출자가 준 새 입력으로 원래 worktree에 새 ACP session을 엽니다. 이것은 `session/load`가 아닙니다.

일어나지 않는 일:

- 업스트림 TigerCat agent는 여전히 `loadSession: false`를 알립니다. `runtime test`는 여전히 `degraded: ["loadSession"]`을 보고합니다. 그 탐침은 `session/new`만 하고 `session/load`는 호출하지 않습니다.
- 죽은 프로세스를 `running`이나 `starting`으로 남겨 두지 않습니다. 상태가 이 둘이면 기록된 pid는 살아 있어야 합니다.
- 불러오기에 실패했을 때 조용히 새 ACP session을 열지 않습니다. 그것은 `resume`이 하는 일입니다.

일회 명령 `list`, `send`, `read`, `interrupt`, `wait`, `kill`, `subscribe`, `unsubscribe`, `spawn`은 같은 데이터베이스를 열고 스스로 `Engine.start`를 호출합니다. 종료 상태가 아닌 Worker가 남은 데이터베이스에 `tigercat list`를 실행하면, `session/load`가 되는 Worker는 복구하고 나머지는 `lost`로 표시합니다. 다른 `tigercat acp`가 아직 그들을 쥐고 있어도 같습니다. 실행 중인 프로세스의 데이터베이스에 이 명령을 가리키지 마세요. 읽기 전용 상태 명령은 없습니다.

## 로그

이벤트 페이로드와 CLI 오류 텍스트는 저장하거나 출력하기 전에 가립니다.

- runtime `env`에서 이름에 `key`, `token`, `secret`, `password`, `credential`이 들어 있는 정확한 값
- 부모 환경의 같은 종류의 변수로, 값이 8자 이상이고 따옴표나 중괄호가 없는 것
- `tigercat mcp --token`에 넘기는 로컬 IPC 토큰
- `Authorization` bearer/basic/digest 헤더, `x-api-key` / `api_key` 대입, 비밀처럼 보이는 이름의 `NAME=value`, 맞는 JSON 필드, `sk-` / `sk-ant-` / `sk-proj-` 토큰

실패한 핸드셰이크의 제공자 stderr는 이 지우기 뒤에만 `bad_runtime` 오류에 들어갑니다. 단위 테스트는 `fake-bearer-token-0001` 같은 고정된 가짜 문자열을 씁니다. 제공자를 호출하지 않습니다.

prompt 텍스트는 제출된 그대로 저장됩니다. `trigger.ingested`는 그 텍스트를 복사하지 않지만, trigger 행과 Router 큐는 복사합니다. 가리기는 prompt를 다시 쓰지 않습니다. 메시지에 붙인 키는 sqlite에 남고 Router에 넘어갈 수 있습니다. 키를 prompt에 붙이지 마세요.

한계이며, 실제 제공자에 대해서는 검증되지 않았습니다. 위의 어느 형태와도 맞지 않게 출력된 비밀, 4자보다 짧은 값(부모 환경은 8), 따옴표나 중괄호를 포함한 값은 여전히 나타날 수 있습니다. 가리기를 유일한 통제로 두지 마세요. 키를 prompt, 규칙 텍스트, `config.toml`에 넣지 마세요.

`runtime list`는 `env`를 출력하지 않습니다. 적어 두었다면 설정 파일에는 그대로 있습니다.

## 문제 해결

`runtime test` JSON이 `ok: false`이고 `mode: "dry-run"`이면, 실패한 것은 dry-run 프로세스이며 Claude Code나 Codex가 키를 거부한 것이 아닙니다. `mode: "adapter"`는 이 프로세스가 adapter를 실행했다는 뜻입니다. `vendorExecuted: false`는 벤더 바이너리를 실행하지 않았다는 뜻입니다.

`unknown runtime <name>`은 그 이름이 내장도 아니고, 불러온 설정 파일의 `command`도 아니라는 뜻입니다. `--config`와 `TIGERCAT_CONFIG`를 확인하세요.

`max concurrency <n> reached`는 설정의 `max_concurrency`입니다(기본 4). `starting` 또는 `running`인 Worker를 셉니다.

충돌 뒤 `tigercat list --json`은 스스로 복구를 실행합니다. 턴이 이미 끝났고 `session/load`가 성공한 Worker는 원래의 `idle` 또는 `awaiting_input`으로 남습니다. 아직 턴 중이던 Worker는 `lost`로 나옵니다. 그다음에 `tigercat acp`를 시작하거나, `acp`를 직접 시작해서 같은 복구를 하게 하세요. 원래 ACP session id가 남는 것은 턴이 끝났고 `session/load`가 성공했을 때뿐입니다. 실패하거나 턴이 진행 중이었다면 예전 id가 동작할 것이라고 기대하지 마세요.

두 `tigercat acp` 프로세스가 하나의 sqlite 파일을 가리켰다면 둘 다 멈추세요. 이 코드는 쓰는 쪽이 둘인 데이터베이스를 고치지 않습니다.

권한 질문은 무언가가 답할 때까지 Worker에 남습니다. `tigercat acp` 안에는 Worker의 `ask` 정책을 자동으로 답하는 것이 없습니다. 막힌 권한은 `worker.turn_end`에 도달하지 않는 Worker처럼 보입니다.

## 이 트리에 없는 것

- Router 실행 파일이 없고, 설치 단계도 없습니다. 다른 것을 설치하지 않았을 때 동작하는 Router는 프로세스 안의 스크립트 brain뿐입니다.
- DeepSeek Chat Completions Router는 구현되어 있습니다(`router.provider = "deepseek"`, 키는 `DEEPSEEK_API_KEY`). 실기 테스트는 하지 않았습니다. 기본은 여전히 스크립트 brain입니다.
- 기본 worker runtime 이름 `worker`는 내장이 아닙니다.
- 재시작은 `initialize`의 `agentInfo`로 `session/load`를 호출할지 정하고 runtime 이름으로 정하지 않습니다. 목록은 `@agentclientprotocol/claude-agent-acp` `0.108.0`과 `@agentclientprotocol/codex-acp` `2.7.0`뿐이며 `loadSession`이 true일 때입니다. 같은 이름의 다른 버전은 `builtin_no_restore`이며 `session/load`를 보내지 않습니다. `loadSession`이 true가 아니면 `load_unsupported`입니다. 그 밖의 신원은 `loadSession`을 알리면 불러오기를 시도합니다. 이름이 `claude-code`인 설정은 실제 adapter의 신원으로 판단합니다. `session/load` 도중의 기록 재생은 새 `worker.update`로 저장하지 않고 전달하지도 않습니다. `running`이나 `starting`은 `in_flight_turn`으로 남습니다. `codex-acp` 2.7.0의 불러오기 응답에는 `sessionId`가 없어 그 때문에 `session_mismatch`가 되지 않습니다. stdio stub은 목록 안의 복구, 버전 불일치, `loadSession`을 알리지 않는 경우, 불러오기 실패, 재생을 저장하지 않는 것을 다룹니다. 이 저장소의 테스트는 실제 Claude Code나 Codex를 시작하지 않습니다. 이것은 M0을 통과했다는 뜻이 아닙니다. SIGINT와 SIGTERM 처리기는 여전히 없습니다.
- `session.pid`는 worker 핸드셰이크가 반환된 뒤에 기록됩니다. 이 pull request는 그것을 바꾸지 않고, 대기도 더하지 않습니다. pid를 너무 일찍 읽는 Windows 테스트는 개발 중인 프로세스 시작 경합입니다.
- 데이터베이스마다 `node:sqlite` handle은 하나입니다. 두 번째 쓰는 쪽은 조율되지 않습니다.
- prompt 텍스트는 제출된 그대로 저장됩니다.
- 실제 DeepSeek, Claude Code, Codex, cc-connect, Feishu는 실행하지 않았습니다.
