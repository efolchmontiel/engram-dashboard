# Contribuir

Trabaja desde una copia local del proyecto. El backend usa la librería estándar de Python y el frontend se sirve tal como está, sin un paso de compilación. Los requisitos y la configuración de ejecución están en [README.md](README.md).

## Preparar el cambio

Antes de editar, revisa el estado de Git y crea una rama local para tu trabajo. Mantén el cambio acotado y describe qué comportamiento quieres corregir o añadir. No incluyas bases de datos, exportaciones reales, tokens, capturas privadas, rutas personales o registros de tus agentes.

La distribución principal del código es:

| Archivo o directorio | Responsabilidad |
|---|---|
| `server.py` | Configuración, proxy HTTP, agregados y arranque de la API. |
| `static/` | Vistas, navegación, estilos y gráficos de la interfaz. |
| `tests/test_server.py` | Contrato HTTP y operaciones contra un motor efímero. |
| `deploy/engram-dashboard.service` | Unidad opcional para una sesión de usuario. |

## Pruebas aisladas

La suite necesita un binario real de Engram. Su fixture crea un directorio temporal de datos por clase, selecciona puertos libres en `127.0.0.1`, inicia su propia API y crea datos sintéticos mediante HTTP. Las pruebas de edición y borrado crean sus propias observaciones. Al completar normalmente cada clase, el fixture cierra sus servidores y retira el directorio temporal.

Desde la raíz del checkout:

```sh
env -u ENGRAM_HTTP_TOKEN PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_server
```

El fixture sustituye `ENGRAM_DATA_DIR` para el proceso de Engram y configura una URL local propia; no usa la API de tu dashboard habitual. Aun así, revisa el binario y las demás variables heredadas antes de ejecutar pruebas. No añadas casos que contacten una API real del usuario o lean su base de datos.

Para seleccionar un binario candidato, establece `ENGRAM_BIN` con su ruta. `ENGRAM_EXPECTED_VERSION` permite cambiar la expectativa de versión, pero existe una prueba que la compara con `server.VERIFIED_ENGRAM_VERSION`. Si pruebas otra versión sin actualizar esa declaración, espera que esa comprobación falle: es una protección frente a declarar compatibilidad por accidente.

Al adoptar una nueva versión del motor, revisa el contrato HTTP, la constante del backend y la expectativa predeterminada de los tests, ejecuta la suite con esa versión y actualiza la documentación. Conserva en la descripción del cambio el comando, la versión utilizada, los resultados y cualquier fallo. No conviertas un resultado histórico en una validación del cambio actual.

## Revisar la interfaz

La suite HTTP no verifica el comportamiento visual ni el teclado. Para cambios en `static/`, utiliza un entorno con datos sintéticos y una API separada. Configura `ENGRAM_API` hacia esa API y usa un puerto libre para el dashboard; comprueba su `/health` antes de abrir la UI para evitar reutilizar datos de trabajo.

Revisa las vistas afectadas, los estados vacíos y de error, la búsqueda y el ámbito de proyecto. Si tocas el detalle o los diálogos, comprueba `Esc`, navegación con tabulador y devolución del foco. Si cambias los gráficos, revisa la carga parcial, la ausencia de datos y la preferencia de movimiento reducido. Una captura de revisión debe usar solo datos sintéticos.

## Mantener los límites

- Consume la API de Engram mediante las rutas explícitas del backend. No abras ni modifiques SQLite desde el dashboard.
- Conserva `expected_project` en las ediciones y borrados. El motor debe seguir validando la propiedad y aplicando sus restricciones.
- Mantén las credenciales en el backend y los datos de memoria como contenido no confiable. No introduzcas HTML ejecutable en el render del detalle.
- Distingue una API caída, una superficie ausente y una colección vacía.
- Evita dependencias nuevas para funciones que ya resuelve el proyecto o la librería estándar.

Actualiza el README y añade al bloque `Unreleased` de [CHANGELOG.md](CHANGELOG.md) solo los cambios observables que hayas implementado. Revisa el diff y los archivos nuevos para excluir información privada. Las incidencias de seguridad siguen [SECURITY.md](SECURITY.md).

Entrega un diff o commits locales con el problema, el cambio y las comprobaciones realizadas. Acuerda el destino de la contribución con quien reciba el trabajo; esta guía no presupone un remoto, un sistema de pull requests o un pipeline de CI.

## Revisión y merge

Ningún cambio entra a `main` sin pasar por un pull request. La rama `main` está protegida:
exige PR, revisión aprobada del maintainer declarado en `.github/CODEOWNERS`, prohíbe el push
directo, el force push y el borrado de la rama. Un agente o colaborador puede abrir el PR y
actualizarlo, pero el merge lo decide el maintainer: que el PR esté en verde y sea mergeable no
es autorización para mergearlo.

## Licencia y procedencia

El proyecto usa la licencia MIT, con atribución a `Engram Dashboard Local contributors` en `LICENSE`. Prepara las contribuciones para esa distribución. Si incorporas código o recursos de terceros, indica su procedencia y licencia y conserva los avisos correspondientes; no sustituyas esos avisos por la atribución colectiva del proyecto.
