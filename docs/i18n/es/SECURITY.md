<!-- i18n-source: SECURITY.md @ 023e9ea6731ad9ceead7895dbe7c0765d2646630 -->
> La versión en chino simplificado es la fuente autorizada. Esta traducción puede quedar rezagada, se hizo con ayuda automática y las correcciones son bienvenidas.

# Política de seguridad

[简体中文](../../../SECURITY.md) | [English](../en/SECURITY.md) | [日本語](../ja/SECURITY.md) | [한국어](../ko/SECURITY.md) | [Español](../es/SECURITY.md)

## Informar de una vulnerabilidad

Informa en privado de las vulnerabilidades de seguridad con [GitHub Private Vulnerability Reporting](https://github.com/tornado1110/tigercat/security/advisories/new).

No abras un issue, una discussion ni un pull request públicos para una vulnerabilidad sospechosa. Antes de cualquier texto público, da a quienes mantienen el proyecto tiempo para confirmarla y corregirla.

No publiques secretos en issues, pull requests, commits, registros ni discussions. Eso incluye claves de API, tokens, contraseñas, cookies de sesión y endpoints privados. Si un secreto ya se ha filtrado, revócalo primero y después informa de esa exposición por el canal privado de arriba.

## Versiones con soporte

TigerCat todavía no ha llegado a 1.0. Las correcciones de seguridad entran solo en la publicación más reciente.

## Modelo de seguridad

TigerCat coordina worker agents. No es un lugar donde guardar credenciales, y no edita un checkout por sí mismo.

1. Las claves de API y los tokens se proporcionan por variables de entorno, o por la autenticación propia de ese runtime. No se hace commit de ellos. El texto de error y las cargas de los eventos se borran antes de imprimirse o guardarse; los patrones y los casos que no cubren están en [docs/operations.md](operations.md). `config.toml` no es un almacén de secretos.
2. Las credenciales no deben entrar en el contexto de un modelo: ni en el prompt del coordinator, ni en el prompt del worker, ni en resultados de herramientas, ni en resúmenes de eventos.
3. Las peticiones de permiso de un Worker tienen `ask` por defecto. TigerCat no las aprueba automáticamente por defecto.
4. El coordinator no puede modificar el código directamente. Solo reparte el trabajo a worker agents.
