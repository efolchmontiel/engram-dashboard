# Changelog

## Unreleased

Este bloque describe las funcionalidades presentes en el código para una futura release. No asigna una versión ni una fecha de lanzamiento.

- Interfaz web local con backend Python basado en la librería estándar, frontend sin compilación y comunicación con Engram por su API HTTP. El arranque reutiliza una API disponible o inicia `engram serve` cuando hace falta.
- Overview global con totales, actividad de 24 horas/7 días/30 días, serie diaria UTC, distribución por tipo en radar SVG, leyenda enlazada y acceso a memorias por proyecto.
- Exploración de memorias por proyecto o en ámbito global, búsqueda FTS, filtros de tipo y sesión, orden configurable y avisos de carga parcial.
- Vistas de sesiones con timeline de observaciones y de proyectos con contadores y directorios asociados.
- Detalle de observación con Markdown acotado, resaltado de búsqueda, metadatos en hora local, enlace directo, copia y descarga Markdown/JSON.
- Edición y borrado soft de observaciones mediante la API del motor, con `expected_project`; confirmación de eliminación en la interfaz.
- Borrado físico de observaciones (`hard=true`), borrado permanente de prompts y de sesiones sin observaciones, listado de prompts recientes por ámbito, y borrado en cascada de un proyecto vía el CLI del motor (`engram delete project[, --hard]`), todo expuesto en el backend sobre el motor; los borrados irreversibles, incluida la cascada en ambos modos, exigen un snapshot vigente.
- Snapshots de seguridad: `POST /api/snapshots` escribe el export global del motor en `<data_dir>/dashboard-snapshots/` y todo borrado irreversible exige uno vigente (≤10 minutos) del propio directorio, verificado por el backend y no por la interfaz.
- Consulta de relaciones, sus estados de juicio y la cola de revisión, con aviso si falta la colección principal de relaciones. Estas vistas no modifican relaciones ni revisiones.
- Vista System con diagnóstico `doctor`, export JSON de proyecto y comparación de la versión detectada con la referencia declarada, Engram 3.7.0.
- Interfaz oscura con gráficos SVG, atajo de búsqueda y cierre de detalle mediante `Esc`, y estilos para movimiento reducido.
- Configuración mediante variables de entorno, unidad opcional de `systemd --user` y pruebas de integración con datos temporales.
