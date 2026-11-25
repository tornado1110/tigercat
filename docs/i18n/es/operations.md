<!-- i18n-source: docs/operations.md @ 43016f20a1a6551c9cc56c01a932d9b34db92d14 -->
> La versión en chino simplificado es la fuente autorizada. Esta traducción puede quedar rezagada, se hizo con ayuda automática y las correcciones son bienvenidas.

# Operar TigerCat

[简体中文](../../operations.md) | [English](../en/operations.md) | [日本語](../ja/operations.md) | [한국어](../ko/operations.md) | [Español](../es/operations.md)

Esta página es la guía de operación del proceso que hay hoy en este repositorio. No añade comandos. Si un comando no aparece en `tigercat --help`, no existe.

Nada de lo que hay aquí se ha ejecutado contra una cuenta real de DeepSeek, Claude Code, Codex, cc-connect o Feishu. Esas filas están marcadas como no verificadas. Las comprobaciones que ejecuta CI están marcadas como probadas.

## Qué está implementado

| Comportamiento | Estado |
| --- | --- |
| `tigercat acp` habla ACP por stdin/stdout | implementado; la conformidad hacia arriba es `npm run test:tck` donde ese harness puede ejecutarse |
| Perfiles integrados `claude-code` y `codex` | implementado; CI hace el handshake con `test/stub-agent.ts`, no con los binarios del proveedor |
| `runtime test` sin binario del proveedor | probado; agente de dry-run, `vendorExecuted: false`, no se lee ninguna clave de API |
| `runtime test` con `TIGERCAT_CLAUDE_BIN` / `TIGERCAT_CODEX_BIN` o `TIGERCAT_RUNTIME_LIVE=1` | implementado; no se ejecutó en CI ni para este documento |
| Router con script cuando `coordinator_runtime` no está definido | probado con el brain con script dentro del proceso |
| Proceso de Router ACP nombrado por `coordinator_runtime` | implementado (`launchCoordinator`); no se ejecutó contra un modelo real |
| Los Thread de sqlite, el registro de eventos y la cola del Router pendiente sobreviven a un proceso nuevo | implementado en `Engine.start` |
| Las sesiones ACP del Worker sobreviven a un reinicio | los perfiles integrados `claude-code` y `codex` no anuncian `loadSession`. Un reinicio sobre ellos marca el Worker como `lost`, registra un `worker.lost` y devuelve la suscripción al Router. El id de sesión ACP original y la suscripción se quedan solo cuando ese runtime anuncia `loadSession` y `session/load` tiene éxito. Esa ruta de éxito se probó solo con el stub stdio, no contra Claude Code o Codex reales |
| Los procesos worker huérfanos se recogen en el siguiente arranque | implementado. Un pid registrado cuya línea de comando todavía coincide con ese runtime se mata antes de la recuperación. Probado con el stub stdio. En Windows solo se mata cuando se puede leer la línea de comando y coincide |
| Feishu o DingTalk dentro de TigerCat | no implementado; esos canales se quedan en el host |
| Router de DeepSeek Chat Completions (`router.provider = "deepseek"`) | implementado; lee `DEEPSEEK_API_KEY`; no probado en vivo |

## Disposición

TigerCat es un proceso en primer plano. En este repositorio no hay `start`, `stop`, `restart` ni una unidad de servicio.

```bash
tigercat --help
tigercat --version
tigercat acp
tigercat acp --config /path/to/config.toml
```


Cuando se omite la opción, `TIGERCAT_CONFIG` es la misma sustitución que `--config`. El archivo predeterminado es `~/.tigercat/config.toml`. Si ese archivo no existe, se usan los valores integrados y no se escribe nada hasta `runtime add` o `runtime remove`.

La base de datos es `TIGERCAT_DB`, o `tigercat.sqlite` en el mismo directorio que la ruta de configuración. El valor predeterminado es `~/.tigercat/tigercat.sqlite`. Un proceso por base de datos. Este código abre `node:sqlite` directamente y no coordina a un segundo escritor.

[`examples/config.example.toml`](../../../examples/config.example.toml) es una demo con script. No nombra un ejecutable de Router. Copiarlo no te da un modelo. Mira más abajo [Demo con script y un Router real](#demo-con-script-y-un-router-real).

`runtime list` imprime el nombre, command, args, permission y si la fila es integrada. No imprime los valores de entorno.

## Credenciales

Con `router.provider = "deepseek"`, `tigercat acp` lee `DEEPSEEK_API_KEY` (o el nombre de entorno configurado) y sale antes de cualquier petición si esa variable falta. Esa llamada no se ha probado en vivo. Las credenciales del Worker siguen siendo las que el proceso hijo ya tiene.

El entorno del hijo es el entorno del padre más la tabla `env` de ese runtime. Una variable exportada en el shell que arranca `tigercat acp` es visible para el proceso Router y para cada Worker. Una entrada `env` añade una variable para ese runtime; no quita las variables heredadas del padre. No hay un aislamiento de secretos por runtime. Ese aislamiento no se ha verificado con procesos en vivo.

Mantén separados los tres conjuntos de credenciales:

1. **Router.** `router.provider = "deepseek"` llama a DeepSeek Chat Completions con la clave de `DEEPSEEK_API_KEY`. Esa ruta no se ha probado en vivo. No pongas la clave en `config.toml`. Omitir `router.provider` mantiene el brain con script, que no llama a un modelo. Un coordinator ACP sigue siendo un programa aparte que instalas y nombras con `coordinator_runtime`. No definas a la vez `router.provider` y `coordinator_runtime`.
2. **Workers (`claude-code`, `codex`).** Los dos vienen integrados con permiso `ask`. Claude Code usa un inicio de sesión `claude` que ya exista, o `ANTHROPIC_API_KEY`. Codex usa `CODEX_API_KEY` u `OPENAI_API_KEY`. Esas son variables de los programas del proveedor; TigerCat no las interpreta. `TIGERCAT_CLAUDE_BIN` se reenvía como `CLAUDE_CODE_EXECUTABLE`. `TIGERCAT_CODEX_BIN` se reenvía como `CODEX_PATH`. Para que una clave del Router no entre en un Worker, no la exportes en el entorno padre. Prefiere los archivos de inicio de sesión de cada producto antes que poner claves en `runtime add --env`.
3. **cc-connect y Feishu.** El host es dueño del canal. El registro de TigerCat es solo esto:

   ```toml
   type = "acp"
   cmd = "tigercat"
   args = ["acp"]
   ```


   No copies tokens de Feishu a la configuración de TigerCat ni a `runtime env`. `tigercat acp` registra cada prompt de arriba con `source` `acp`. La primera regla predeterminada admite `source = "acp"` como `respond`. Un id de hilo de Feishu se usa solo cuando el host define `_meta.thread_id`; el source sigue siendo `acp`. No se ha ejecutado un ida y vuelta con Feishu.

`runtime add --env K=V` escribe el valor en texto plano en `config.toml`. Ese archivo no es un almacén de secretos. Deja `env` vacío salvo que el valor sea una ruta que no es un secreto, como un binario del proveedor.

Los workers integrados son `ask` en el código. La muestra no añade una fila de runtime, así que no define `permission`. `runtime add --permission` acepta `ask`, `auto` o `deny`.

## Demo con script y un Router real

Son cosas distintas. El archivo de muestra es solo la primera.

### Demo con script

`coordinator_runtime` se queda sin definir. Entonces `cmdAcp` no llama a `launchCoordinator`. El Router es `ScriptedRouter` en este proceso. Hace spawn del runtime que nombra `default_worker_runtime` y no llama a un modelo.

El valor predeterminado de ese nombre en el código es la cadena `worker`. Ese nombre no es integrado. Sin archivo de configuración, un trigger que el brain con script decide hacer spawn falla con `unknown runtime worker`. La muestra pone `default_worker_runtime` en `claude-code`, que sí es integrado.

Los pasos de checkout del README son:

```bash
npm install
npm run build
npm link
```


`bin/tigercat.js` carga `dist/cli.js`, así que hace falta `npm run build` antes de que el comando pueda arrancar. `npm link` es lo que usa el README para poner `tigercat` en `PATH`. Desde el checkout, sin enlazar:

```bash
node bin/tigercat.js --help
node bin/tigercat.js runtime list
node bin/tigercat.js acp
```


Copiar la muestra es opcional. Sigue sin arrancar un modelo:

```bash
mkdir -p ~/.tigercat
cp examples/config.example.toml ~/.tigercat/config.toml
tigercat runtime list
tigercat acp
```


Entonces `runtime list` muestra los integrados `claude-code` y `codex`. No muestra un comando de Router, porque la muestra no añade uno. `tigercat acp` se queda en primer plano y habla JSON-RPC delimitado por saltos de línea en stdin y stdout. Sin un binario `claude` y sin `TIGERCAT_RUNTIME_LIVE`, un worker que el brain con script hace spawn como `claude-code` usa el agente de dry-run. Esa ruta no lee una clave de API. Sigue sin ser un modelo.

### Router ACP real

Requisito, que aquí no se proporciona: un ejecutable de agente ACP que hayas instalado y configurado tú. Este repositorio no lo incluye, no contiene un programa llamado `router-acp` y no documenta cómo instalar DeepSeek ni ningún otro modelo.

Cuando ese programa ya está en la máquina, regístralo con el comando que `tigercat --help` ya lista. Los ángulos son marcadores, no un comando para copiar:

```bash
tigercat runtime add <name> --command <existing-acp-agent> --permission ask
```


Luego pon `coordinator_runtime` en `<name>` en el archivo de configuración que de verdad cargas. `tigercat acp` hace spawn de ese comando. Si el comando no se encuentra, el arranque falla con `bad_runtime`. No escribas un marcador en `config.toml` y lo trates como un Router que funciona.

cc-connect, o cualquier otro cliente ACP, es el padre de `tigercat acp`. Los registros y el tráfico ACP comparten stdin y stdout. No envíes un secreto por una tubería al prompt. El fragmento del host en el README (`type = "acp"`, `cmd = "tigercat"`, `args = ["acp"]`) no es un archivo que este repositorio cargue, y no se ha ejecutado un ida y vuelta con Feishu. Esta página no añade pasos para instalar cc-connect.

## Arranque

`tigercat acp` es el proceso en primer plano. No hay un comando de demonio.

`tigercat acp` usa `process.cwd()` como raíz del espacio de trabajo. Los directorios de Worker se crean bajo ese árbol: `.tigercat/worktrees/<workerId>` dentro de un checkout de git, y si no `.tigercat/workers/<workerId>`.

Comprueba los integrados antes de meter un modelo. Sin `claude` ni `codex` en `PATH` y sin `TIGERCAT_RUNTIME_LIVE`, esto no lee una clave de API:

```bash
tigercat runtime test claude-code
tigercat runtime test codex
```


El informe JSON tiene `mode` `dry-run` y `vendorExecuted` false. Un arranque real del adapter es el comando manual de `tigercat --help`. Las pruebas de este documento no lo ejecutaron.

## Parada

No hay un subcomando de parada.

Una ruta limpia es que el cliente ACP cierre stdin. Entonces `serveUpstream` vuelve, `engine.close()` pide a cada handle de worker vivo que salga, y se cierran el listener de IPC y el handle de sqlite.

Esa ruta también programa `process.exit(0)` a los 500 ms, y otra vez cuando los clientes MCP de arriba se han cerrado. El desmontaje de los Worker es un mejor esfuerzo dentro de esa ventana. No es un vaciado garantizado.

SIGINT y SIGTERM no tienen manejador en este código. En POSIX, los procesos worker se lanzan detached, así que una señal que mate solo el proceso TigerCat puede dejarlos atrás. El siguiente arranque mira los pid guardados. Un huérfano cuya línea de comando todavía coincide con ese runtime se mata antes de la recuperación.

## Reinicio y recuperación

Reiniciar significa: parar el proceso en primer plano y luego ejecutar `tigercat acp` otra vez con la misma configuración y la misma base de datos.

Entonces `Engine.start`:

- deja en su sitio una fila de sesión del Router que ya exista, o inserta una
- devuelve a pending las filas de la cola del Router que estaban en curso y pone `router_busy` en `0`
- para cada Worker que no es terminal, trata primero el pid registrado. Un proceso vivo cuya línea de comando todavía coincide con el runtime se mata. Después, si ese runtime anuncia `loadSession` y `session/load` tiene éxito, se carga el id de sesión ACP original en un proceso nuevo, el Worker vuelve a `idle`, la suscripción del Thread se queda y el siguiente evento va directo a ese Worker. Si no hay id de sesión, el runtime no anuncia `loadSession`, o `session/load` falla, el Worker se marca `lost`, se sueltan las suscripciones y se registra un `worker.lost`. `code` es `lost`, `message` es `worker session could not be restored after restart`, y `reason` es `no_session`, `load_unsupported`, `load_failed` o `session_mismatch`

Los Thread y el registro de eventos permanecen. El directorio del worktree se queda en disco. `removeWorkspace` existe y no se llama en esta ruta.

Los perfiles integrados `claude-code` y `codex` no anuncian `loadSession`. Sobre ellos, el reinicio toma el camino `lost` y la suscripción vuelve al Router. Conservar la suscripción, como se dijo arriba, ocurre solo cuando el propio runtime anuncia `loadSession` y `session/load` tiene éxito. Esa ruta solo se ha comprobado con el stub stdio.

`interrupted` queda reservado para un interrupt explícito. El reinicio no escribe ese estado. `interrupt` cancela el turno actual y conserva las suscripciones; no marca el Worker como `lost`. `resume` acepta un Worker que ya está en `lost` o `interrupted`: abre una sesión ACP nueva en el worktree existente con la entrada nueva de quien llama. Eso no es `session/load`.

Lo que no ocurre:

- El agente TigerCat de arriba sigue anunciando `loadSession: false`. `runtime test` sigue informando `degraded: ["loadSession"]`, porque esa sonda solo hace `session/new` y no llama a `session/load`.
- Un proceso muerto no se deja como `running` o `starting`. Cuando el estado es uno de esos dos, el pid registrado tiene que estar vivo.
- Una carga fallida no abre en silencio una sesión ACP nueva. Eso es lo que hace `resume`.

Los comandos de una sola vez `list`, `send`, `read`, `interrupt`, `wait`, `kill`, `subscribe`, `unsubscribe` y `spawn` abren la misma base de datos y llaman ellos mismos a `Engine.start`. Ejecutar `tigercat list` contra una base de datos que todavía tiene Workers no terminales restaura los que `session/load` puede restaurar y marca el resto como `lost`, aunque otro `tigercat acp` todavía los tenga. No apuntes esos comandos a la base de datos de un proceso en marcha. No hay un comando de estado de solo lectura.

## Registros

Las cargas de los eventos y el texto de error de la CLI pasan por un borrado antes de guardarse o imprimirse:

- los valores exactos de `env` del runtime cuyo nombre contiene `key`, `token`, `secret`, `password` o `credential`
- el mismo tipo de variable del entorno padre, cuando el valor tiene al menos 8 caracteres y no tiene comillas ni llaves
- el token IPC de localhost que se pasa a `tigercat mcp --token`
- cabeceras `Authorization` bearer/basic/digest, asignaciones `x-api-key` / `api_key`, `NAME=value` para nombres que parecen secretos, los campos JSON que coinciden, y tokens `sk-` / `sk-ant-` / `sk-proj-`

El stderr del proveedor de un handshake fallido entra en el error `bad_runtime` solo después de ese borrado. Las pruebas unitarias usan cadenas falsas fijas, como `fake-bearer-token-0001`. No llaman a un proveedor.

El texto del prompt se guarda tal como se envió. `trigger.ingested` no copia ese texto, pero la fila del trigger y la cola del Router sí. El borrado no reescribe un prompt. Una clave pegada en un mensaje sigue en sqlite y puede entregarse al Router. No pegues claves en los prompts.

Límites, no verificados contra un proveedor en vivo: un secreto impreso con una forma que no coincide con nada de lo anterior, un valor de menos de 4 caracteres (8 para el entorno padre), o un valor que contiene comillas o llaves, todavía puede aparecer. No te fíes del borrado como único control. No pongas claves en prompts, en el texto de las reglas ni en `config.toml`.

`runtime list` no imprime `env`. El archivo de configuración sigue conteniéndolo si lo escribiste.

## Resolución de problemas

Un JSON de `runtime test` con `ok: false` y `mode: "dry-run"` significa que falló el proceso de dry-run, no que Claude Code o Codex rechazaran una clave. `mode: "adapter"` significa que este proceso lanzó el adapter. `vendorExecuted: false` significa que no se ejecutó el binario del proveedor.

`unknown runtime <name>` significa que el nombre no es integrado ni un `command` del archivo de configuración que se cargó. Revisa `--config` y `TIGERCAT_CONFIG`.

`max concurrency <n> reached` es `max_concurrency` en la configuración (el valor predeterminado es 4). Cuenta Workers en `starting` o `running`.

Después de una caída, `tigercat list --json` ejecuta él mismo la recuperación. Un Worker que se puede cargar vuelve a `idle`; uno que no se puede cargar aparece como `lost`. Arranca `tigercat acp` solo después de eso, o arranca `acp` directamente y deja que haga la misma recuperación. Cuando `session/load` tiene éxito, el id de sesión ACP original sigue ahí. Cuando falla, no esperes que el id antiguo funcione.

Si dos procesos `tigercat acp` apuntaban a un mismo archivo sqlite, para los dos. El código no repara una base de datos que usaron dos escritores.

Las peticiones de permiso se quedan en el Worker hasta que algo las responde. Nada en `tigercat acp` responde solo a una política `ask` del Worker. Un permiso atascado parece un Worker que nunca llega a `worker.turn_end`.

## Huecos en este árbol

- No hay un ejecutable de Router, ni pasos para instalar uno. El único Router que se ejecuta sin instalar nada más es el brain con script dentro del proceso.
- Un Router de DeepSeek Chat Completions está implementado (`router.provider = "deepseek"`, clave de `DEEPSEEK_API_KEY`). No se ha probado en vivo. El brain con script sigue siendo el predeterminado.
- El nombre predeterminado del runtime de worker, `worker`, no es integrado.
- Un reinicio intenta `session/load` hacia abajo. Los perfiles integrados `claude-code` y `codex` no anuncian `loadSession`, así que quedan en `lost` y la suscripción vuelve al Router. El stub stdio cubre una carga con éxito, un runtime que no anuncia `loadSession` y un `session/load` que falla. No se ha ejecutado contra Claude Code o Codex reales. SIGINT y SIGTERM siguen sin manejador.
- `session.pid` se escribe después de que vuelve el handshake del worker. Este pull request no cambia eso, y no añade una espera. Una prueba de Windows que lee el pid demasiado pronto es una carrera de arranque del proceso, para desarrollo.
- Un handle de `node:sqlite` por base de datos. Un segundo escritor no está coordinado.
- El texto del prompt se guarda tal como se envió.
- No se han ejecutado DeepSeek, Claude Code, Codex, cc-connect ni Feishu en vivo.
