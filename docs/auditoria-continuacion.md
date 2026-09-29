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

- PR #2 integrada por fast-forward en `main`.
- Commit publicado en `main`: `a3f4be0`.
- Frontend v202 publicado en Cloudflare Pages.
- URL de despliegue: `https://9be8c2cc.eileen-lifestyle.pages.dev`.
- Producción verificada: la página sirve `app.js?v=202` y la casilla
  `attendance-only-active` aparece marcada.
- Railway respondió `/health` con `status: ok` y base de datos disponible.
- El check remoto de GitHub seguía en ejecución al integrar; `npm run verify`
  local estaba en verde. Claude debe revisar este punto cuando recupere
  disponibilidad.

### Puntos para la auditoría posterior

1. Confirmar que un usuario entra a Asistencia viendo solo clientes activos.
2. Confirmar que al desmarcar `Solo activos` aparecen también inactivos.
3. Confirmar que las métricas cambian al alternar el filtro y no conservan
   totales del conjunto anterior.
4. Confirmar que el cambio de versión invalida la caché sin afectar otras
   vistas.

## Corrección posterior — claridad del reporte de Asistencia

Rama: `fix/claridad-asistencia-pausas`

- Se reemplazó el desglose ambiguo `no-show · canceló` por
  **inasistencias · cancelaciones del cliente**.
- Cuando no existen sesiones futuras se muestra **Sin sesiones futuras**, en
  lugar de `0 futuras`.
- Cuando `Solo activos` está marcado, el resumen informa cuántos clientes en
  pausa quedaron fuera y cómo desactivar el filtro para revisarlos. Esto evita
  que un caso como Juan de Diego desaparezca sin explicación.
- Las pausas siguen fuera del cálculo de cumplimiento, conforme a la regla de
  negocio; no se cambió el cálculo del backend.
- Frontend actualizado de v202 a v203.

### Publicación

- `npm run verify` ✅
- `main` actualizado a `c5a7220`.
- Frontend v203 publicado en Cloudflare Pages.
- Despliegue verificado: `https://4911873b.eileen-lifestyle.pages.dev`.
- Producción sirve `app.js?v=203`, la casilla aparece marcada y el aviso de
  clientes en pausa está visible.
- Railway `/health` respondió `status: ok`.
