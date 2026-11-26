<!-- i18n-source: README.md @ 089f7fd360e8aedd13d91b89e9bb7a6cce303899 -->
> La versión en chino simplificado es la fuente autorizada. Esta traducción puede quedar rezagada, se hizo con ayuda automática y las correcciones son bienvenidas.

# TigerCat

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Un enrutador Super-agent para agentes de código: un enrutador ACP residente que reparte el trabajo a Claude Code, Codex o cualquier agente ACP.

TigerCat se apoya en el [Agent Client Protocol](https://agentclientprotocol.com). Hacia arriba, **es** un agente ACP (`tigercat acp`), así que un host como cc-connect o Zed puede dirigirlo. Hacia abajo es un cliente ACP que arranca un Worker en cualquier runtime ACP que esté registrado. Feishu y DingTalk se quedan en esos hosts; TigerCat no implementa canales de mensajería.

No es una herramienta de subagentes. Un Router residente solo enruta y habla con la persona. Cada Worker se ocupa de una tarea, se suscribe a Threads y reporta al Router.

En modo plugin, Codex controla las herramientas nativas de shell, edición y escritura de archivos de la sesión actual de Codex. El servidor MCP de TigerCat registra sus propias herramientas y no puede inspeccionar ni quitar las herramientas nativas de Codex. Mientras shell, edición o escritura sigan en el conjunto efectivo de herramientas del Router, el proceso del plugin se niega a arrancar y no cae a un modo de permisos más laxo. Esto no es aislamiento de herramientas, y M0 no está superado. El Skill de TigerCat pide a la sesión principal que delegue la implementación en Workers. Las políticas de permisos de Worker limitan a los Workers que inicia TigerCat, y el uso directo de herramientas en la sesión principal sigue la configuración del host de Codex.

`server/cli.js plugin` en ese directorio es la entrada MCP, y su directorio de trabajo es la raíz del plugin. Cuando Codex, Claude Code u otro host lo arranca, el proceso se niega a arrancar, por el motivo de arriba. El manifiesto `.codex-plugin` solo sirve para que Codex descubra la instalación. El núcleo Worker/ACP no depende de un host concreto.

El contrato de coordinación incluye `runtimes`, `spawn`, `resume`, `list`, `send`, `read`, `interrupt`, `wait`, `kill`, `subscribe` y `unsubscribe`. Si hay un binding de Lark, el contrato también nombra `lark_status`, `lark_discover` y `lark_execute`. Esto no es la superficie de herramientas expuesta ahora. Para inspeccionar un repositorio, programar, probar, investigar o un trabajo sostenido, la sesión principal debe encargar un Worker sin esperar a que la persona diga «usa TigerCat». Las explicaciones, las aclaraciones y la charla se quedan en la sesión principal. Los efectos externos siguen necesitando confirmación. `spawn` debe llevar el `cwd` absoluto del proyecto de la persona. Cada `wait` dura como máximo 30 segundos. El directorio de arranque del plugin es el de la instalación y no identifica el proyecto. La capacidad real de programar del Worker sigue viniendo del runtime ACP elegido.

Cerrar la conexión MCP limpia los Workers. Cada proceso del plugin tiene un estado temporal propio, salvo que `TIGERCAT_PLUGIN_DB` conserve el historial, y solo un proceso del plugin puede usar esa base de datos. Si el reinicio llama a `session/load` depende del `agentInfo` que el adapter informa en `initialize`, no del nombre del runtime. Solo se restaura cuando `agentInfo.name` es `@agentclientprotocol/claude-agent-acp` y `agentInfo.version` es `0.108.0`, o cuando `agentInfo.name` es `@agentclientprotocol/codex-acp` y `agentInfo.version` es `2.7.0`, y `loadSession` es true. Esos nombres son el `agentInfo.name` que escriben los adapters fijados instalados. El historial repetido mientras `session/load` está en curso se descarta y no se guarda. TigerCat registra un `worker.update` con `recovered` true y `nativeSession` `loaded`. Las notificaciones de estado o metadatos que el adapter envía después de la respuesta de carga (por ejemplo listas de comandos, información de sesión o uso) se guardan como `worker.update` ordinarios. No traen texto de la conversación anterior. Feishu y el canal ACP de arriba reenvían solo `worker.turn_end` y `worker.error`, así que ninguna de estas filas se entrega fuera. El mismo nombre de adapter con otra versión no llama a `session/load`: el Worker queda `lost` (`worker.lost`, razón `builtin_no_restore`), la suscripción vuelve al Router y la tarea no se vuelve a ejecutar sola. Si `loadSession` no es true, la razón es `load_unsupported`. Cualquier otro `agentInfo.name` sigue intentando la carga cuando anuncia `loadSession`. Un runtime llamado `claude-code` que apunta a un adapter de la lista restaura; uno que apunta a otra parte se juzga por la identidad `initialize` de ese adapter. Un Worker en `running` o `starting` sigue en `lost` (razón `in_flight_turn`) y no se llama a `session/load`. La respuesta `session/load` de codex-acp 2.7.0 no trae `sessionId`, así que esa ruta no produce `session_mismatch`. `interrupted` queda reservado para un interrupt explícito, no para este reinicio. Esto no significa que M0 esté superado. Un `.plugin-lock` dejado por una salida anómala se quita solo después de confirmar que el proceso antiguo terminó. Esta versión no promete despertar una sesión de Codex, seguir tras una desconexión, ni entregar un resultado durable.

Este repositorio es un esqueleto de viabilidad de la semana 1. No es un M0 terminado. Siguen sin verificarse las sesiones reales de Claude Code / Codex, un ida y vuelta con Feishu, usar un modelo real como Router, y la prueba de que el harness de un proveedor no tiene shell ni herramientas de edición nativas. CI ejecuta los perfiles `claude-code` y `codex` a través del stub de stdio. Los comandos manuales para un binario real están más abajo. Que el catálogo MCP propio de TigerCat no incluya esas herramientas no dice nada sobre las herramientas que un agente posterior trae por su cuenta. La entrada entre canales y la de un PR compartido son M1, no de este esqueleto.

## Inicio rápido

Hace falta Node.js 22.13 o posterior.

```bash
npm install
npm run build
npm link

tigercat runtime list
tigercat runtime discover
tigercat runtime test claude-code
tigercat runtime test codex
```

`claude-code` y `codex` vienen integrados. `runtime test` ejecuta `initialize`, `session/new` y `session/prompt`.

Si no hay un binario `claude` o `codex`, y `TIGERCAT_RUNTIME_LIVE` no está definido, esa prueba hace el handshake con un agente local de dry-run. El informe contiene `mode: "dry-run"` y `vendorExecuted: false`. Claude Code y Codex no se inician, y no se lee ninguna clave de API.

Con el binario instalado, así se ejecuta de verdad:

```bash
tigercat runtime discover --json
tigercat runtime test claude-code
tigercat runtime test codex
```

`TIGERCAT_CLAUDE_BIN` se reenvía como `CLAUDE_CODE_EXECUTABLE`. `TIGERCAT_CODEX_BIN` se reenvía como `CODEX_PATH`. Claude Code usa un inicio de sesión `claude` que ya exista, o `ANTHROPIC_API_KEY`. Codex usa `CODEX_API_KEY` u `OPENAI_API_KEY`. En una máquina sin interfaz gráfica, define `NO_BROWSER=1` para que Codex no abra el inicio de sesión de ChatGPT.

Estos adapter también incluyen una CLI. Cuando el binario del proveedor no está en `PATH`, `TIGERCAT_RUNTIME_LIVE=1` arranca ese adapter. Eso descarga el paquete y habla con el proveedor, así que necesita credenciales:

```bash
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test claude-code
TIGERCAT_RUNTIME_LIVE=1 tigercat runtime test codex
```

| Runtime | Paquete | Versión | Ejecutable |
|---|---|---|---|
| `claude-code` | `@agentclientprotocol/claude-agent-acp` | 0.108.0 | `claude-agent-acp` |
| `codex` | `@agentclientprotocol/codex-acp` | 2.7.0 | `codex-acp` |

Estas versiones se fijaron desde el registro de npm el 2026-11-18. `claude-code` arranca con `CLAUDE_AGENT_ACP_PROTOCOL=v1`, para que la sesión se quede en el ciclo de vida v1 estable que implementa este cliente (`session/new`, `session/prompt`, `session/cancel`). Si ya instalaste el adapter, ese sustituye a `npx`:

```bash
TIGERCAT_CLAUDE_CODE_ACP=/usr/local/bin/claude-agent-acp tigercat runtime test claude-code
TIGERCAT_CODEX_ACP=/usr/local/bin/codex-acp tigercat runtime test codex
```

Un `runtime add` con el mismo nombre sustituye a uno integrado. Cualquiera de los dos nombres puede ser `coordinator_runtime`. La lista de herramientas del Router sigue siendo solo spawn, list, send, read, interrupt, wait, kill, subscribe y unsubscribe.

`coordinator_runtime` nombra un agente ACP que instalaste tú. Este repositorio no incluye ese programa. Deja el campo sin definir para conservar el brain con script; mira [docs/operations.md](docs/i18n/es/operations.md). El archivo de la política de admisión es `examples/rules.default.toml`, ahora en la versión `2026-11-19.1`. Cuando el mensaje entero es charla explícita (`thanks`, `lol`, `morning`, y las confirmaciones en japonés, coreano y español de ese archivo), el resultado es `ignore` y no hay ninguna llamada al Router. Si nadie está suscrito, lenguaje natural desconocido como `Morning all` o `coffee break` es `candidate`; una aclaración en un Thread que ya tiene suscripción es `respond` hacia ese Worker. `candidate` no se reescribe a `ignore`. El texto del disparador pasa por NFKC. Los literales de la regla se pliegan igual, y la sintaxis de regex que produzca ese pliegue se escapa, así que la puntuación de ancho completo sigue siendo literal. Una barra invertida antes de un carácter no ASCII entra en esa secuencia, de modo que `\＊` coincide con `*`. La comparación no distingue mayúsculas y conserva los acentos: un `adios` no listado no coincide con `adiós`. Un punto de código dentro de una clase de caracteres no puede plegarse a más de uno; si ocurre, `loadConfig` falla con el nombre de la regla y el servicio no arranca hasta corregirla. El japonés y el coreano coinciden por subcadena. El latín usa un límite de letra Unicode `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` (la regla lleva la bandera `u`; no `\b`). Una frase que también contiene una tarea no se ignora.

```bash
tigercat acp
```

## DeepSeek como Router

`router.provider = "deepseek"` sustituye el brain con script por DeepSeek Chat Completions (`POST {base_url}/chat/completions`, `Authorization: Bearer $DEEPSEEK_API_KEY`, modelo `deepseek-flash`, thinking desactivado). El Router solo puede llamar a `spawn`, `list`, `send`, `read`, `interrupt`, `wait`, `kill`, `subscribe` y `unsubscribe`. Si falta la clave, `tigercat acp` se detiene antes de cualquier petición. Un error del proveedor se devuelve en el prompt ACP como `Router failed: ...`. No hay dry-run ni una vuelta al script.

```toml
default_worker_runtime = "claude-code"

[router]
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
```

Estas llamadas se apoyan en la documentación y no se han probado en vivo desde este repositorio. Un error HTTP del proveedor informa solo el estado. El cuerpo de la respuesta se descarta.

Claude Code, según [Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code): `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN` con la clave de DeepSeek, y `ANTHROPIC_MODEL=deepseek-flash[1m]` (más las variables predeterminadas de opus/sonnet/haiku y de subagentes de esa página). La [Messages API](https://api-docs.deepseek.com/api/create-message) acepta `x-api-key` o `Authorization: Bearer` y el modelo `deepseek-flash`. Eso no es Chat Completions.

Codex, según [Integrate with Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex) y [Using the Responses API](https://api-docs.deepseek.com/guides/responses_api): Codex habla la Responses API. El bloque de proveedor documentado es `base_url = "https://api.deepseek.com/"`, `wire_api = "responses"`, `model = "deepseek-flash"`, un catálogo `~/.codex/models.json` y `experimental_bearer_token` con la clave de DeepSeek. Este repositorio no da por hecho que `CODEX_API_KEY` u `OPENAI_API_KEY` elijan ese proveedor.

`deepseek-flash` es el id de modelo en [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing). Las llamadas a herramientas usan `POST /chat/completions` ([Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion), [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)). Thinking está activado por defecto; este Router envía `{"thinking": {"type": "disabled"}}` para que `tool_choice` se quede en la ruta que no es thinking ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)).

`spawn` lanza el comando real del adapter. Si falta el binario o la clave, el fallo queda a la vista. El prompt ACP no espera al Worker: dejar `session/prompt` abierto dejaría a cc-connect ocupado y encolaría el siguiente mensaje de Feishu. Cuando el Worker termina más tarde, TigerCat ejecuta `cc-connect send --stdin` si `CC_SESSION_KEY` está definido (cc-connect lo inyecta al arrancar un agente ACP). Eso publica en el socket del demonio, que envía en la sesión de la plataforma. Un `session/update` después de que el prompt vuelve no es ese envío. Sin `CC_SESSION_KEY`, el prompt dice que el resultado no llegará a Feishu.

## cc-connect

Registra TigerCat como un agente ACP genérico. El canal de Feishu o DingTalk pertenece al host.

```toml
type = "acp"
cmd = "tigercat"
args = ["acp"]
```

Cuando el host conoce el tema o el pull request, pasa el id del Thread en `_meta.thread_id` del prompt. Si no hay uno, la sesión de arriba es por sí misma un Thread (`acp:<sessionId>`).

## Operación

El arranque, la parada y el reinicio en primer plano, la separación de credenciales y la configuración de la demo con script están en [docs/operations.md](docs/i18n/es/operations.md). [examples/config.example.toml](examples/config.example.toml) deja `coordinator_runtime` sin definir. No es un Router de modelo, y este repositorio no incluye uno. No hay un subcomando `start` ni `stop`. `runtime add --env` escribe texto plano en `config.toml`; no pongas claves de API ahí.

## Qué hace la semana 1

Los Trigger entran por el motor de reglas ordenado y después se enrutan así:

- `ignore` se descarta. No hay llamadas al Router.
- Un Thread que ya tiene un Worker suscrito recibe los Trigger posteriores directamente. No hay turno del Router.
- Todo lo demás se agrupa en el siguiente turno del Router. `candidate` solo se juzga ahí; un `respond` sin suscriptor hace spawn.
- `spawn` devuelve `{ "status": "started" }` de inmediato. Los resultados se empujan cuando el Router está libre, y se encolan en un solo lote cuando está ocupado. `wait` es opcional.
- Una frase de parada de las reglas cancela el turno actual (`session/cancel`) y **conserva** las suscripciones. Por eso «para, y haz X en su lugar» sigue llegando a ese Worker.
- `interrupt` cancela el turno actual y conserva las suscripciones. No marca el Worker como `lost`. `interrupted` queda reservado para ese interrupt explícito, no para un reinicio. `kill` o una caída sueltan todas las suscripciones y conservan el worktree. `session/load` depende del `agentInfo` de `initialize`, no del nombre del runtime. La lista solo tiene `@agentclientprotocol/claude-agent-acp` `0.108.0` y `@agentclientprotocol/codex-acp` `2.7.0`, y solo si `loadSession` es true. Esos `agentInfo.name` salen de los adapters fijados instalados. El historial repetido mientras `session/load` está en curso se descarta y no se guarda. TigerCat registra un `worker.update` con `recovered` true y `nativeSession` `loaded`. Las notificaciones de estado o metadatos que el adapter envía después de la respuesta de carga (por ejemplo listas de comandos, información de sesión o uso) se guardan como `worker.update` ordinarios. No traen texto de la conversación anterior. Feishu y el canal ACP de arriba reenvían solo `worker.turn_end` y `worker.error`, así que ninguna de estas filas se entrega fuera. El mismo nombre en otra versión no llama a `session/load` y queda `lost` (razón `builtin_no_restore`); la suscripción vuelve al Router y el worktree se conserva. Si `loadSession` no es true, la razón es `load_unsupported`. Cualquier otra identidad conserva el id de sesión ACP original y la suscripción cuando anunció `loadSession` y `session/load` tiene éxito. Un runtime llamado `claude-code` que apunta a un adapter de la lista restaura; uno que apunta a otra parte se juzga por esa identidad. Un Worker en `running` o `starting` queda `lost` (razón `in_flight_turn`) sin `session/load`. La respuesta de carga de codex-acp 2.7.0 no trae `sessionId`, así que no hay `session_mismatch`. Las pruebas automáticas usan un stub stdio que informa esas identidades y no arrancan Claude Code ni Codex reales. Esto no significa que M0 esté superado. Después de `lost`, ese Thread vuelve a pasar por el Router.

`worker.turn_end.awaitingInput` es una anotación que añade TigerCat, no un campo de ACP. El `stopReason` del agente se guarda tal como lo envió ACP (normalmente `end_turn`). TigerCat pone `awaitingInput` solo cuando esa razón es `end_turn` y el texto del Worker parece una pregunta o una petición de aclaración.

El estado vive en `node:sqlite`, detrás de una interfaz `Store`. El proceso solo conserva sockets y temporizadores. Un reinicio vuelve a cargar los Thread y cualquier cola del Router que aún no se haya entregado. El reinicio decide `session/load` por `agentInfo.name` y `agentInfo.version` de `initialize`, no por el nombre del runtime. La lista solo tiene `@agentclientprotocol/claude-agent-acp` `0.108.0` y `@agentclientprotocol/codex-acp` `2.7.0`, y solo si `loadSession` es true. El mismo nombre en otra versión queda `lost` (razón `builtin_no_restore`), se libera la suscripción y el Thread vuelve al Router. Un runtime de usuario cuyo `agentInfo.name` no es ninguno de esos dos conserva el id de sesión ACP original y la suscripción cuando `loadSession` es true y la carga tiene éxito. Un runtime configurado llamado `claude-code` se juzga por la identidad `initialize` de su adapter. El historial repetido mientras `session/load` está en curso se descarta y no se guarda. TigerCat registra un `worker.update` con `recovered` true y `nativeSession` `loaded`. Las notificaciones de estado o metadatos que el adapter envía después de la respuesta de carga (por ejemplo listas de comandos, información de sesión o uso) se guardan como `worker.update` ordinarios. No traen texto de la conversación anterior. Feishu y el canal ACP de arriba reenvían solo `worker.turn_end` y `worker.error`, así que ninguna de estas filas se entrega fuera. Un turno todavía en curso queda `lost` (razón `in_flight_turn`), no pasa a `idle` y no llama a `session/load`. La respuesta `session/load` de codex-acp 2.7.0 no trae `sessionId`, así que `session_mismatch` no se dispara por eso. Esto se comprobó con un stub stdio que informa esas identidades, no arrancando Claude Code o Codex reales en las pruebas de este repositorio, y no significa que M0 esté superado.

## Pruebas

```bash
npm test
```

`npm run test:tck` ejecuta [acp-tck](https://github.com/agentclientprotocol/acp-tck) `v0.4.0` contra `tigercat acp` (hace falta [uv](https://docs.astral.sh/uv/)). Cuando el harness termina, el script sale con su estado y no trata `os.killpg` como un pase. Un fallo MANDATORY es una salida distinta de cero en cualquier plataforma. Si falta `uvx`, el código de salida es 2; si falta `dist/cli.js`, es 1. En Windows, esa versión fijada llama a `os.killpg` en su propio teardown; cuando eso ocurre, el script además imprime esos id de requisito como **UNVERIFIED**, el paso sale con un estado distinto de cero y eso no es un pase. CI copia el VERDICT, los recuentos MANDATORY passed/failed/skipped, el total y cualquier línea UNVERIFIED al job summary. Los fixtures de replay usan el esquema JSONL del ingeniero de pruebas; el harness está en `test/harness/`. Los archivos de fixtures son de QA, y aquí no se editan para borrar diferencias de etiquetas.
