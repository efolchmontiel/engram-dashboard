# engram-dashboard-local

Interfaz web local para consultar y gestionar la memoria de [Engram](https://github.com/Gentleman-Programming/engram). El backend usa la librería estándar de Python y la API HTTP de Engram; el frontend es HTML, CSS y JavaScript sin compilación ni dependencias de paquetes.

La versión de referencia del motor declarada por el código es **Engram 3.7.0**. El dashboard escucha por defecto en `http://127.0.0.1:7438`. Está pensado para uso local de una persona: no incorpora autenticación de usuarios.

## Qué puedes hacer

- Consultar el resumen global de memorias, sesiones y proyectos, la actividad de las últimas 24 horas, 7 días y 30 días, y la distribución por tipo en un radar con leyenda interactiva.
- Explorar Memories de todos los proyectos o de uno concreto, buscar con el motor FTS de Engram y combinar filtros de tipo y sesión. El listado permite ordenar y avisa cuando la carga es parcial.
- Abrir sesiones con su timeline de observaciones, borrar las sesiones sin observaciones y ver proyectos con sus contadores y directorios asociados.
- Consultar los prompts recientes del ámbito en Prompts, con búsqueda visual por contenido y borrado permanente por fila.
- Consultar relaciones entre observaciones y la cola de revisión en Salud. Esta vista es de solo lectura.
- Leer el detalle de una memoria, copiar su ID o contenido, descargarla como Markdown o JSON y compartir su enlace local `#/memories/obs/<id>`.
- Editar título, tipo, contenido, ámbito y clave temática (dejarla vacía borra el campo), ocultar una observación con borrado soft o eliminarla físicamente, con confirmación en la interfaz.
- Eliminar un proyecto completo en cascada (soft u hard) desde Projects, con la elección de modo y los contadores reales del proyecto.
- Consultar la versión y configuración del motor en System, ver el diagnóstico `doctor` y descargar el export JSON de un proyecto generado por Engram.

El dashboard no crea observaciones, sesiones ni proyectos; tampoco juzga relaciones ni cambia estados de revisión. La creación y esas operaciones se realizan con las herramientas de Engram.

### Borrado desde la interfaz y la API del dashboard

La interfaz cubre hoy todas las operaciones de borrado del backend: soft de observaciones (drawer, «Ocultar») y, para toda acción irreversible, un modal común que genera un snapshot con `POST /api/snapshots` antes de habilitar la confirmación, muestra la ruta y el tamaño del archivo, exige tipear el id o el nombre exacto del proyecto y envía esa ruta en el parámetro `snapshot`:

| Acción en la interfaz | Ruta que usa |
| --- | --- |
| Drawer de memoria · «Ocultar (soft)» | `DELETE /api/observations/{id}?expected_project=P` |
| Drawer de memoria · «Borrar definitivamente (hard)» | `DELETE /api/observations/{id}?expected_project=P&hard=true&snapshot=RUTA` |
| Prompts · «Eliminar» por fila | `DELETE /api/prompts/{id}?snapshot=RUTA` |
| Sessions · «Eliminar» en sesiones con 0 observaciones | `DELETE /api/sessions/{id}?snapshot=RUTA` |
| Projects · «Eliminar proyecto» (soft o hard) | `DELETE /api/projects/{name}[?hard=true]&snapshot=RUTA` |

El resto de las rutas del backend quedan disponibles para la suite de pruebas y para uso directo:

| Ruta | Efecto |
| --- | --- |
| `DELETE /api/observations/{id}?expected_project=P` | Borrado soft: la observación deja de listarse y la fila queda en el store. |
| `DELETE /api/observations/{id}?expected_project=P&hard=true&snapshot=RUTA` | Borrado físico. También purga una observación ya soft-borrada. |
| `DELETE /api/prompts/{id}?snapshot=RUTA` | Borrado permanente del prompt. |
| `DELETE /api/sessions/{id}?snapshot=RUTA` | Borrado permanente de la sesión; el motor responde `409` si todavía tiene observaciones. |
| `DELETE /api/projects/{name}?snapshot=RUTA` | Borrado en cascada del proyecto ejecutando `engram delete project` con `ENGRAM_DATA_DIR` del dashboard; el nombre se valida contra el listado del motor. En ambos modos borra los prompts de forma permanente; con `hard=true` elimina también las sesiones. |
| `POST /api/snapshots` | Escribe el export global del motor en `<data_dir>/dashboard-snapshots/` y devuelve su ruta. |
| `GET /api/prompts?project=P` (o `all_projects=true`) | Lista los prompts recientes del ámbito. |

Todo borrado irreversible exige el parámetro `snapshot` con la ruta de un snapshot del propio directorio del dashboard, con menos de 10 minutos de antigüedad. El backend verifica esa ruta y la frescura antes de reenviar la orden: no depende de lo que muestre la interfaz. El borrado soft no requiere snapshot. La cascada de proyecto corre el CLI del motor (`engram delete project`), no una ruta HTTP del motor, y en su modo soft ya borra los prompts de forma permanente.

## Requisitos e instalación

- Python 3. Las pruebas de este candidato se ejecutan con Python 3.14.7; no se ha validado una versión mínima.
- Engram instalado, con la API correspondiente a 3.7.0 como referencia de compatibilidad. Para el arranque automático, su binario debe estar en el `PATH`, en `~/.local/bin/engram` o en la ruta indicada por `ENGRAM_BIN`.
- Un navegador moderno con JavaScript habilitado.
- Para las opciones de arranque automático: Linux con `systemd --user`. La integración con Omarchy es opcional.

Obtén una copia del proyecto y abre su directorio, que debe contener `server.py`, `run.sh` y `static/`. No necesitas instalar paquetes con `pip` o `npm`, crear un entorno virtual ni compilar el frontend.

## Ejecución

Desde el directorio del proyecto:

```sh
./run.sh
```

También puedes usar:

```sh
python3 server.py
```

Abre `http://127.0.0.1:7438`. El backend consulta `/health` en la API configurada. Si responde con HTTP 200, la reutiliza. Si no responde, intenta lanzar `engram serve` en el puerto de esa URL, espera a que esté disponible y aborta si no consigue arrancarlo.

Con la configuración predeterminada, la API está en `http://127.0.0.1:7437` y Engram utiliza `~/.engram` para sus datos. La UI no abre SQLite directamente. Las ediciones y los borrados sí cambian la memoria a través de la API del motor.

Al detener el dashboard con `Ctrl+C`, este termina el proceso de Engram que haya arrancado. Si reutilizó una API ya existente, la deja en ejecución. El dashboard no cambia tu configuración MCP.

## Configuración

El backend lee estas variables de entorno al arrancar:

| Variable | Valor predeterminado | Uso |
|---|---|---|
| `ENGRAM_DASH_HOST` | `127.0.0.1` | Dirección donde escucha el dashboard. Mantén loopback para uso local. |
| `ENGRAM_DASH_PORT` | `7438` | Puerto del dashboard. |
| `ENGRAM_PORT` | `7437` | Puerto usado para construir la URL predeterminada de la API. |
| `ENGRAM_API` | `http://127.0.0.1:<ENGRAM_PORT>` | URL base de una API de Engram de confianza, preferiblemente ya activa y local. |
| `ENGRAM_DATA_DIR` | `~/.engram` | Directorio de datos que hereda el proceso de Engram si el dashboard lo arranca. |
| `ENGRAM_BIN` | `engram` en `PATH`; después `~/.local/bin/engram` | Binario para lanzar `engram serve`. |
| `ENGRAM_HTTP_TOKEN` | Vacío | Token que el backend añade como cabecera Bearer a las peticiones que reenvía al motor. |
| `ENGRAM_DASH_DEBUG` | Sin definir | Cualquier valor no vacío activa el registro HTTP, que puede incluir consultas y nombres de proyectos. |

Por ejemplo, para cambiar solo el puerto del dashboard:

```sh
ENGRAM_DASH_PORT=7440 ./run.sh
```

Si reutilizas una API existente, `ENGRAM_DATA_DIR` no cambia sus datos ni confirma qué base utiliza. Las rutas que muestra System proceden de la configuración del dashboard; comprueba también la configuración del proceso de Engram.

El arranque automático extrae el puerto de `ENGRAM_API`, pero lanza un proceso **local**: no inicia servidores en otra máquina. Para una URL personalizada, prepara primero la API y comprueba que su `/health` responde con HTTP 200.

El frontend no recibe el token mediante la configuración ni lo incorpora a sus peticiones. El backend lo añade al comunicarse con Engram. Esto permite que un cliente con acceso al dashboard use las operaciones del proxy con las credenciales del backend; el token no autentica a los usuarios del panel. No lo pongas en URLs, archivos públicos o capturas, y configura `ENGRAM_API` únicamente hacia un destino de confianza.

## Compatibilidad y pruebas

`server.VERIFIED_ENGRAM_VERSION` declara `3.7.0`. La vista System y el indicador lateral comparan ese valor con la versión devuelta por `/health`. Una coincidencia identifica la versión de referencia; no es una prueba de funcionamiento de tu instalación. Si la versión difiere, la UI avisa y permite seguir consultando los datos disponibles.

Las superficies de salud pueden no estar disponibles en otro motor. Si falta la colección principal de relaciones, la vista muestra un aviso. La cola de revisión tiene una limitación: un error al cargarla puede mostrarse como ausencia de revisiones pendientes.

La suite de integración inicia un Engram real con `ENGRAM_DATA_DIR` temporal, datos de prueba y puertos locales efímeros. Puedes ejecutarla desde la raíz del proyecto:

```sh
env -u ENGRAM_HTTP_TOKEN PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_server
```

El comando elimina el token heredado para esta ejecución. Revisa también las demás variables y la configuración del binario que vayas a probar. Las pruebas comprueban rutas de lectura, búsquedas, agregados, errores, edición y borrado con `expected_project`, snapshots de export y los rechazos de los borrados irreversibles sin snapshot vigente; no sustituyen una revisión del navegador.

`ENGRAM_BIN` permite elegir un binario candidato y `ENGRAM_EXPECTED_VERSION` cambia la versión esperada por la suite. Esta también exige que esa expectativa coincida con `VERIFIED_ENGRAM_VERSION`: cambiar solo la variable no declara compatible un motor nuevo. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para el procedimiento local.

## Arranque automático con systemd, opcional

Para esta instalación, coloca la copia del proyecto en `~/.local/share/engram-dashboard-local`. Antes de copiar `deploy/engram-dashboard.service`, comprueba que sus rutas son:

```ini
WorkingDirectory=%h/.local/share/engram-dashboard-local
ExecStart=/usr/bin/python3 %h/.local/share/engram-dashboard-local/server.py
```

Si guardas el proyecto en otro directorio, adapta **ambas** líneas. Ajusta también el intérprete si Python no está en `/usr/bin/python3`. La unidad no descarga ni instala el proyecto o Engram.

Desde el checkout, estos comandos instalan la unidad de usuario y activan su arranque con la sesión:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/engram-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now engram-dashboard.service
```

Para comprobarla o detenerla:

```sh
systemctl --user status engram-dashboard.service
journalctl --user -u engram-dashboard.service
systemctl --user stop engram-dashboard.service
```

La unidad usa `Restart=on-failure`, espera 3 segundos entre reinicios y limita los intentos a 5 en 120 segundos. `WantedBy=default.target` la vincula a la sesión de usuario; estos pasos no habilitan lingering. Necesita acceso al directorio de datos porque el proceso de Engram puede escribir allí.

Evita arrancar otra instancia manual en el mismo puerto. Para dejar de iniciar el servicio con tu sesión:

```sh
systemctl --user disable --now engram-dashboard.service
```

## Acceso desde Omarchy, opcional

Si tu instalación de Omarchy dispone de `omarchy webapp install`, puedes crear un acceso usando el icono del proyecto. Desde el checkout, con el dashboard ya en ejecución:

```sh
omarchy webapp install Engram http://127.0.0.1:7438 "$PWD/icon.png"
```

Adapta la URL si cambiaste el puerto. El acceso abre el navegador en modo aplicación; no sustituye al backend ni lo arranca. Cerrar esa ventana deja el servidor en ejecución. Puedes retirar el acceso con:

```sh
omarchy webapp remove Engram
```

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl`/`⌘` + `K` | Abre Memories si hace falta y enfoca la búsqueda. |
| `Esc` | Cierra el detalle o el modal. |

## Arquitectura

```text
Navegador
  └─ estáticos y /api/* → server.py
                           └─ HTTP → API de Engram
                                       └─ datos gestionados por Engram
```

`server.py` sirve archivos estáticos enumerados y un proxy con rutas explícitas. Calcula los agregados de Overview con las respuestas del motor. Solo invoca el binario para arrancar `engram serve` cuando necesita una API; no consulta SQLite ni ejecuta comandos CLI para cada vista.

`static/` contiene la interfaz y los gráficos SVG, sin framework. Los recursos incluidos se cargan localmente y no incorporan telemetría. `tests/test_server.py` contiene las pruebas de integración con el motor.

## Seguridad

La dirección predeterminada es loopback, pero `ENGRAM_DASH_HOST` permite cambiarla. Usar `0.0.0.0` u otra interfaz, un proxy de red o un túnel puede dar acceso a memorias, rutas locales, exportaciones y operaciones de escritura a otras personas. El servidor no añade autenticación de usuarios ni TLS. Mantén privados tanto el puerto del dashboard como el de Engram.

La interfaz envía `expected_project` en PATCH y DELETE, y el backend lo reenvía al motor. Esa comprobación de propiedad no reemplaza el control de acceso. Ningún borrado del panel tiene una acción de deshacer: el soft deja la fila en el store sin mostrarla, y el borrado físico, el de prompts, el de sesiones y la cascada de proyecto son irreversibles: el motor no expone una papelera ni un restore por API. Por eso el backend exige un snapshot de export vigente antes de cualquiera de ellos y lo verifica él mismo; el modal de borrado irreversible repite esa exigencia del lado del cliente (snapshot antes de confirmar y nombre tipeado), pero es el backend quien valida la ruta y su frescura. Conserva además una copia de seguridad de Engram antes de modificar datos importantes.

Los archivos descargados, el portapapeles, las capturas y los registros pueden contener memoria privada. El export de proyecto conserva el formato y las colecciones que devuelve Engram; no equivale a una copia de seguridad completa de SQLite. Consulta [SECURITY.md](SECURITY.md) para los límites de confianza y la comunicación de problemas.

## Limitaciones

- Memories carga 1000 observaciones por defecto. La opción de ampliar la carga solicita hasta 50000; su nombre no garantiza que cubra un ámbito mayor. El backend no reenvía `offset` para observaciones y la interfaz pagina y aplica filtros de tipo/sesión sobre lo cargado.
- La búsqueda de Memories solicita hasta 200 resultados al motor. Los filtros locales se aplican a esos resultados.
- Overview es global aunque selecciones un proyecto en otra vista. Su actividad y distribución se calculan con hasta 20000 observaciones activas; los totales generales proceden de las estadísticas del motor. El panel indica la carga parcial.
- La serie diaria usa 30 fechas UTC hasta hoy, mientras que el contador de 30 días usa una ventana de 30 × 24 horas. Sus sumas pueden diferir en el borde inicial. Las fechas del detalle se muestran en la zona horaria del navegador.
- El radar agrupa los tipos que exceden los anillos disponibles; la leyenda y las barras mantienen el desglose.
- Sessions solicita las 200 sesiones más recientes del ámbito. El timeline de una sesión se construye con hasta 50000 observaciones de su proyecto.
- Salud carga relaciones por páginas de 100 y aplica el filtro por tipo sobre las páginas cargadas. La cola de revisión solicita hasta 100 elementos. Si una observación referenciada no está en el índice cargado, el panel informa de ello.
- El detalle muestra el contador de revisiones, pero no incluye una vista de versiones anteriores. El Markdown admite un subconjunto de encabezados, listas, negrita y código; no interpreta HTML del contenido.
- `doctor` utiliza el proyecto seleccionado; sin selección puede reportar un proyecto desconocido. No hay controles para administrar juicios o estados de revisión.
- Prompts lista los 200 prompts más recientes del ámbito, como Sessions hace con las sesiones; no filtra ni busca en el motor.
- Un snapshot es el export global del motor, no una copia del store SQLite: cubre observaciones, sesiones y prompts que el export incluya, y no reemplaza un backup del archivo de base de datos.

Los cambios pendientes de publicación se describen en [CHANGELOG.md](CHANGELOG.md).

## Licencia

El proyecto se distribuye bajo la licencia MIT, con atribución a `Engram Dashboard Local contributors`. Consulta el texto completo en el archivo `LICENSE` de la distribución. Conserva también los avisos de terceros que acompañen a sus componentes o recursos.
