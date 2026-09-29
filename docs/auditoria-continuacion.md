# Registro de cambios para auditoría de Claude

Actualizado: 2026-09-29

Este documento registra los cambios funcionales que se integren mientras Claude
no esté disponible. Debe revisarse antes de cualquier siguiente modificación
de facturación, agenda o cumplimiento.

## PR #2 — filtro de clientes activos en Asistencia

Rama: `feature/filtro-activos-asistencia`

### Objetivo

El reporte mensual de **Asistencia** mostraba también clientes inactivos,
aunque el uso operativo diario debe concentrarse en clientes con expediente
activo. Se agrega un filtro reversible y se deja activado por defecto.

### Cambios importantes

- `app.js`
  - El estado inicial `attendanceOnlyActive` es `true`.
  - El reporte filtra por `status === 'active'` al cargar.
  - La casilla permite desactivar el filtro y consultar todos los clientes.
  - Los totales, sesiones medidas y porcentaje de cumplimiento se recalculan
    sobre el conjunto visible; no se muestran totales de inactivos como si
    fueran parte del corte operativo.
- `index.html`
  - Se añadió la casilla `Solo activos`, marcada inicialmente.
- `styles.css`
  - Se ajustó la presentación del control para que conviva con el selector de
    mes.
- `sw.js`, `version.json` y referencias versionadas de `index.html`
  - Frontend actualizado a versión `202` para invalidar la caché de la PWA.

### Commits

- `86c08d6` — filtro de Asistencia por clientes activos.
- `6980cd5` — activar el filtro por defecto y actualizar a v202.

### Verificación

- `npm run verify` ✅
- `git diff --check` ✅
- No se modificó el backend ni la base de datos.
- No se agregaron migraciones.

### Estado de publicación

- PR #2 creada en GitHub.
- Este registro se incluye para revisión posterior de Claude.
- Pendiente de integrar a `main` y publicar frontend; producción no debe
  considerarse actualizada hasta confirmar ambos pasos.

### Puntos para la auditoría posterior

1. Confirmar que un usuario entra a Asistencia viendo solo clientes activos.
2. Confirmar que al desmarcar `Solo activos` aparecen también inactivos.
3. Confirmar que las métricas cambian al alternar el filtro y no conservan
   totales del conjunto anterior.
4. Confirmar que el cambio de versión invalida la caché sin afectar otras
   vistas.
