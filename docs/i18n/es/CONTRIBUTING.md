<!-- i18n-source: CONTRIBUTING.md @ ea10d77c5aa02683c50f6f599b25c729839abc7c -->
> La versión en chino simplificado es la fuente autorizada. Esta traducción puede quedar rezagada, se hizo con ayuda automática y las correcciones son bienvenidas.

# Contribuir a TigerCat

[简体中文](../../../CONTRIBUTING.md) | [English](../en/CONTRIBUTING.md) | [日本語](../ja/CONTRIBUTING.md) | [한국어](../ko/CONTRIBUTING.md) | [Español](../es/CONTRIBUTING.md)

Gracias por ayudar con TigerCat. Este documento explica cómo preparar un checkout, cómo hay que escribir los mensajes de commit y cómo abrir un pull request.

## Entorno de desarrollo

TigerCat se ejecuta en Node.js 22.13 o posterior (mira `engines` en `package.json`). Si el repositorio contiene un archivo `.nvmrc`, úsalo para elegir esa versión de Node.

```bash
git clone https://github.com/tornado1110/tigercat.git
cd tigercat
npm ci
```

Antes de abrir un pull request, ejecuta:

```bash
npm run lint
npm run typecheck
npm test
```

Ejecuta también `npm run build` cuando cambies código que el build compila.

Lo que cubren esos comandos está en [TESTING.md](../../../TESTING.md). Las pruebas de extremo a extremo con un agente real no se ejecutan en CI, porque necesitan claves de API de pago. Ese documento describe qué ejecuta CI en su lugar. No pongas claves de API en el repositorio ni en un pull request.

## Mensajes de commit

Los mensajes de commit deben seguir [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). [Release Please](../../../RELEASING.md) los lee para mantener `CHANGELOG.md` y para abrir el pull request de la publicación. Un commit que no sigue el convenio no entra en el changelog y no sube la versión.

Usa esta forma:

```text
<type>[optional scope][!]: <short summary>

[optional body]

[optional footer]
```

El resumen es un imperativo en inglés, en minúsculas, y no lleva punto al final.

| Tipo | Cuándo usarlo | Subida de versión |
| --- | --- | --- |
| `feat` | Una capacidad visible para quien lo usa | minor (de `0.1.0` a `0.2.0`) |
| `fix` | Una corrección de defecto | patch (de `0.1.0` a `0.1.1`) |
| `feat!` o un pie `BREAKING CHANGE:` | Un cambio que rompe compatibilidad | minor mientras la versión sea `0.x`; major desde `1.0.0` |
| `docs`, `test`, `chore`, `ci`, `refactor`, `perf`, `build` | Todo lo demás | ninguna, salvo que el commit esté marcado como ruptura |

Ejemplos:

```text
feat: route a stalled task to another ACP runtime

fix(client): retry a worker session that closed before the first event

docs: describe the permission ask default
```

Mientras el paquete siga en `0.x`, un cambio que rompe compatibilidad sube la versión minor, en lugar de saltar a `1.0.0`. Aun así, dilo en el pie:

```text
feat!: drop the legacy session id field

BREAKING CHANGE: session ids from 0.1 are not accepted.
```

## Pull request

1. Crea la rama desde el `main` más reciente.
2. Mantén el cambio concentrado. Un pull request, un propósito.
3. Usa Conventional Commits en cada commit. Si el pull request se fusiona con squash, el título tiene que ser un Conventional Commit, porque ese título se convierte en el commit de `main`.
4. Ejecuta `npm run lint`, `npm run typecheck` y `npm test`. Rellena la plantilla del pull request, incluido cómo lo probaste.
5. No hagas commit de secretos, tokens, archivos `.env` ni de registros que los contengan.
6. Espera la revisión. No fusiones tu propio pull request, salvo que seas mantenedor y las reglas del repositorio lo permitan.

Los mantenedores fusionan los pull request de publicación que abre Release Please. Quien contribuye no publica en npm. Mira [RELEASING.md](../../../RELEASING.md).

## Seguridad

Informa de las vulnerabilidades en privado, como describe [SECURITY.md](SECURITY.md). No abras un issue público para un informe de seguridad, y no pegues un secreto en un issue, un pull request o una discussion.

## Código de conducta

Este proyecto sigue el [Contributor Covenant](../../../CODE_OF_CONDUCT.md). Al participar, aceptas ese código.

## Traducciones

El chino simplificado es la única fuente autorizada de estos documentos. Un cambio de documentación se escribe primero en chino. Las traducciones van después. Mira cuáles se han quedado atrás con:

```bash
npm run docs:i18n-check
```

La primera línea de cada traducción es una marca de origen. Anota la ruta en el repositorio del archivo chino y el hash blob de git de ese archivo: los 40 caracteres de `git rev-parse HEAD:<path>`, el mismo valor que da `git hash-object` cuando los saltos de línea son LF:

```html
<!-- i18n-source: <path> @ <blob> -->
```

No anotes un SHA de commit. Este repositorio solo se fusiona con rebase, así que los SHA de commit cambian al fusionar, y la longitud de un `%h` corto varía.

El comando convierte CRLF a LF e indica qué traducciones tienen un blob de origen desactualizado. También comprueba los cambios con respecto a HEAD. Si cambia el blob de origen pero el cuerpo de la traducción sigue igual, o si el cuerpo coincide con el original, el comando devuelve un código distinto de cero. Añade `-- --base <revision>` para comparar cambios ya confirmados con una revisión anterior. En los PR, CI compara con la rama de destino.

Se agradecen los pull request de revisión de hablantes nativos. El japonés, el coreano y el español se elaboraron con ayuda automática y todavía no los ha revisado una persona nativa.
