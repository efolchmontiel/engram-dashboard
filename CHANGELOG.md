# Changelog

## Unreleased

Este bloque describe las funcionalidades presentes en el código para una futura release. No asigna una versión ni una fecha de lanzamiento.

- Interfaz web local con backend Python basado en la librería estándar, frontend sin compilación y comunicación con Engram por su API HTTP. El arranque reutiliza una API disponible o inicia `engram serve` cuando hace falta.
- Overview global con totales, actividad de 24 horas/7 días/30 días, serie diaria UTC, distribución por tipo en radar SVG, leyenda enlazada y acceso a memorias por proyecto.
- Exploración de memorias por proyecto o en ámbito global, búsqueda FTS, filtros de tipo y sesión, orden configurable y avisos de carga parcial.
- Vistas de sesiones con timeline de observaciones y de proyectos con contadores y directorios asociados.
- Detalle de observación con Markdown acotado, resaltado de búsqueda, metadatos en hora local, enlace directo, copia y descarga Markdown/JSON.
- Edición y borrado soft de observaciones mediante la API del motor, con `expected_project`; confirmación de eliminación en la interfaz.
- Consulta de relaciones, sus estados de juicio y la cola de revisión, con aviso si falta la colección principal de relaciones. Estas vistas no modifican relaciones ni revisiones.
- Vista System con diagnóstico `doctor`, export JSON de proyecto y comparación de la versión detectada con la referencia declarada, Engram 3.2.1.
- Interfaz oscura con gráficos SVG, atajo de búsqueda y cierre de detalle mediante `Esc`, y estilos para movimiento reducido.
- Configuración mediante variables de entorno, unidad opcional de `systemd --user` y pruebas de integración con datos temporales.
