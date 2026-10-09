# Seguridad

Este dashboard está pensado para consultar y gestionar una instalación local de Engram desde un equipo de confianza. La configuración predeterminada escucha en `127.0.0.1:7438` y conecta con la API en `127.0.0.1:7437`. El servidor no incorpora autenticación de usuarios, autorización por usuario, TLS ni controles específicos de `Origin` o `Host` para el navegador.

## Superficie y límites de confianza

El navegador accede al frontend y a las rutas `/api/*` enumeradas en `server.py`. El backend reenvía esas operaciones a `ENGRAM_API`, sirve únicamente los archivos estáticos permitidos y calcula algunos agregados. Engram gestiona sus datos; el dashboard no accede directamente a SQLite.

Las únicas escrituras expuestas son PATCH y DELETE de una observación. La UI envía `expected_project`, que el proxy reenvía al motor. DELETE no añade una petición de borrado físico. El motor conserva la responsabilidad de validar el proyecto, el contenido y las credenciales que exija su API. Las vistas de relaciones y revisión son de solo lectura.

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
