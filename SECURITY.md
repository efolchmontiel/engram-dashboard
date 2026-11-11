# Seguridad

Este dashboard está pensado para consultar y gestionar una instalación local de Engram desde un equipo de confianza. La configuración predeterminada escucha en `127.0.0.1:7438` y conecta con la API en `127.0.0.1:7437`. El servidor no incorpora autenticación de usuarios, autorización por usuario, TLS ni controles específicos de `Origin` o `Host` para el navegador.

## Superficie y límites de confianza

El navegador accede al frontend y a las rutas `/api/*` enumeradas en `server.py`. El backend reenvía esas operaciones a `ENGRAM_API`, sirve únicamente los archivos estáticos permitidos y calcula algunos agregados. Engram gestiona sus datos; el dashboard no accede directamente a SQLite.

Las escrituras expuestas son PATCH y DELETE de una observación, DELETE de prompts y de sesiones, `POST /api/snapshots` y DELETE de un proyecto. La UI envía `expected_project`, que el backend exige y reenvía al motor. Un DELETE de observación sin `hard=true` sigue siendo soft; con `hard=true` el backend exige además un `snapshot` válido antes de reenviar la orden. El borrado de prompts y de sesiones es permanente en el motor, que también responde `409` cuando la sesión todavía tiene observaciones. La interfaz destructiva es una comodidad, no la protección: la exigen el backend y el motor, que validan el snapshot vigente y, en la cascada, el nombre del proyecto contra el listado del motor antes de ejecutar nada. Un cliente que omita el modal y llame a las rutas directamente pasa por las mismas comprobaciones; la UI no puede eludirlas ni relajarlas.

El borrado en cascada de un proyecto no es una ruta del motor: el backend ejecuta `engram delete project <nombre>[ --hard]` como proceso propio, con el `ENGRAM_DATA_DIR` del dashboard y sin shell. El nombre se valida contra el listado de proyectos que devuelve el motor antes de ejecutar nada; un nombre desconocido o malformado no llega al CLI. La cascada borra los prompts de forma permanente también en su modo soft, por lo que exige un `snapshot` vigente en ambos modos.

El `snapshot` es el export global del motor escrito por el backend en `<data_dir>/dashboard-snapshots/` (o en `ENGRAM_DASH_SNAPSHOT_DIR`). El backend comprueba que la ruta esté dentro de ese directorio, que el archivo exista, que tenga menos de 10 minutos y que su contenido parezca un export; no confía en un valor enviado por la interfaz. El motor conserva la responsabilidad de validar el proyecto, el contenido y las credenciales que exija su API. Las vistas de relaciones y revisión son de solo lectura.

Un snapshot contiene memoria exportada en claro y merece la misma protección que el store: no lo muevas a un directorio sincronizado, compartido o versionado, y bórralo cuando ya no lo necesites. Tampoco es una copia de seguridad del archivo SQLite.

El contenido de memorias, proyectos y respuestas del motor debe tratarse como no confiable. El render del detalle escapa HTML antes de aplicar un subconjunto de Markdown. Esta medida protege esa presentación concreta; no convierte las exportaciones, los textos copiados o todos los futuros usos del contenido en datos seguros para ejecutar.

## Acceso local y credenciales

`ENGRAM_DASH_HOST` es configurable. Escuchar en `0.0.0.0`, otra interfaz accesible, un proxy o un túnel puede exponer lecturas y escrituras. El panel también muestra nombres de proyectos, directorios y rutas de datos. Mantén privados los puertos del dashboard y del motor; loopback no distingue entre los procesos o usuarios que puedan alcanzarlo desde el equipo.

Si defines `ENGRAM_HTTP_TOKEN`, el backend lo añade como cabecera Bearer a las peticiones del proxy, incluidas las lecturas. Los estáticos y las respuestas propias de configuración no lo incorporan, y el navegador no lo necesita para acceder al panel. Por tanto, un cliente que alcance el dashboard puede utilizar las operaciones expuestas con las credenciales del backend. El token no es una barrera de acceso al dashboard.

Configura `ENGRAM_API` solo hacia un motor de confianza: ese destino recibe el token y las peticiones con contenido de memoria. El proxy devuelve cuerpos y errores de la API; una API ajena o comprometida puede devolver información sensible. No introduzcas credenciales en la URL ni guardes tokens en archivos versionados.

El proceso de Engram iniciado por el dashboard hereda su entorno y funciona con los permisos del usuario. Revisa la procedencia del binario y protege el acceso al equipo y a su directorio de datos.

## Manejo de datos

Conserva una copia de seguridad de Engram antes de editar o eliminar información importante. El borrado soft oculta la observación en los listados activos; no es una garantía de eliminación de la información ni ofrece una acción de deshacer en el dashboard.

Trata las descargas Markdown/JSON, los exports de proyecto, el portapapeles, las capturas y los registros como datos privados. El contenido del export lo determina Engram y puede diferir de lo visible en una lista activa. El modo `ENGRAM_DASH_DEBUG` registra peticiones y puede revelar términos de búsqueda o nombres de proyectos. El navegador guarda el proyecto seleccionado en `localStorage`.

## Comunicar un problema

Este documento no establece un correo privado ni una plataforma de reporte. Si el problema permite acceder a datos, ejecutar contenido o alterar memorias sin el consentimiento esperado, evita publicar una reproducción explotable o información real en un canal público.

Contacta con quien te haya proporcionado o mantenga tu copia usando un canal privado que ya tengas verificado. Si no dispones de uno, solicita primero una vía privada compartiendo solo una descripción general del problema. No adjuntes todavía el exploit, datos de memoria o credenciales.

Una vez acordado el canal, facilita:

- El commit de la copia afectada y las versiones de Python y Engram.
- La configuración relevante, con tokens, rutas personales y nombres sensibles sustituidos.
- El impacto observado y una reproducción mínima con datos sintéticos.
- Los registros estrictamente necesarios, revisados para excluir secretos.

Si has expuesto el dashboard por error, retira primero ese acceso o detén la instancia afectada. Conserva la evidencia mínima necesaria, revisa qué datos pudieron quedar accesibles y cambia cualquier credencial que haya podido divulgarse. Acuerda con la persona que reciba el informe cómo verificar y comunicar la corrección; no hay un plazo de respuesta ni cobertura de versiones prometidos en este documento.
