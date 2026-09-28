# Handoff — Auditoría de facturación y flujo, para revisión de Codex/Claude

Rama: **`fix/ciclo-corte-y-harness-review`** (en GitHub). Nada mergeado a `main`.
Commits:
- `9f3ff99` — unificar el ciclo de corte en `cicloDelCorte` + estabilizar el harness.
- `9a40730` — prueba explícita de las 4 rutas + limpieza de comentarios.
- `f162274` — documentar el alcance real de la rama y preparar la revisión acumulada.
- pendiente de commit — correcciones de integridad, concurrencia, saldos vencidos, estados de sesión y modalidad de pago descritas abajo.

## Cómo reproducir (base limpia)
El harness crea una BD Postgres temporal por corrida (createdb → migraciones desde cero → servidor real como subproceso), así que cada ejecución es base limpia.

```
cd backend
git checkout fix/ciclo-corte-y-harness-review
npm run check
npm run build
PGHOST=localhost PGUSER=<user> PGPASSWORD= PGPORT=5432 npm test
```
Resultado verificado: `# tests 188 / # pass 188 / # fail 0`, reproducible sin importar la hora del sistema (ver más abajo).

## Qué hace la Fase 1 (aislada, aditiva)

### 1. Ciclo de corte: una sola fuente de verdad
- **Problema (confirmado):** el worker (`generateRecurringInvoices`) y `POST /api/packages` usaban `venceMensualidadDesde(due_on)`, que suma un mes **sin clampar** y desbordaba en cortes 30/31 hacia meses cortos: corte 31 en enero vencía el **3 de marzo** en vez del **28 de febrero**, y no coincidía con asignación de plan, cobertura ni confirmación de pago.
- **Fix:** ambos usan ahora `cicloDelCorte(due_on, billing_cutoff_day)` (usa `corteAnterior`/`corteSiguiente`, que clampan con `Math.min(dia, últimoDíaDelMes)`). Se **eliminó** `venceMensualidadDesde`.
- Funciones relevantes en `backend/src/server.ts`: `cicloDelCorte`, `corteAnterior`, `corteSiguiente`, `inicio_ciclo` (SQL, usada por asignación de plan).

### 2. Harness reproducible (independiente de la hora)
- `backend/src/db.ts`: `connection: { TimeZone: 'America/Panama' }` en el cliente postgres.js → se aplica a **cada conexión del pool** (verificado: `current_setting('timezone')` = America/Panama por conexión). Alinea `current_date`/`now()` con la lógica de Panamá de la app (antes salía en UTC en Railway y cerca de medianoche caía en otro día).
- `backend/test/harness.mjs`: `TZ=America/Panama` en el subproceso del servidor.
- `backend/test/api.test.mjs`: helpers `hoyPa`/`enDiasPa`/`mesActualPa` construyen las fechas de **negocio** en Panamá; los **instantes** de sesión (`starts_at`) siguen en `toISOString()` (son un momento, no una fecha de calendario).
- Antes del fix, a las ~01:00 UTC (tarde en Panamá) fallaban 3 pruebas por el desfase UTC/Panamá; ahora pasan a esa misma hora.

### 3. Pruebas de borde de corte (criterio de cierre)
- 6 casos parametrizados (cortes 15/28/30/31 + restaurar marzo + cambio de año) que comparan **worker vs paquete manual** → mismo `expires_on` clampado.
- 1 test **"las 4 rutas usan el mismo ciclo de corte"**: verifica que **asignación de plan, paquete manual y confirmación de pago** dan inicio/expires/etiqueta idénticos para corte 31. Por transitividad vía el paquete manual, las 4 rutas comparten la fuente de verdad. Confirma también que `inicio_ciclo` (plan) y `cicloDelCorte` (manual/cobertura) concuerdan.

## Checklist de pre-merge — estado actual
- [x] No quedan referencias a `venceMensualidadDesde` — `grep -rn venceMensualidadDesde src/ test/` → vacío.
- [x] Las 4 rutas producen el mismo rango — test explícito para plan/manual/confirmación y 6 casos worker↔manual que comparan `expires_on` y etiqueta/rango.
- [x] `188/188` sobre base limpia — BD temporal por corrida; incluye las regresiones nuevas de esta rama.
- [x] Reproducible sin importar la hora — TZ fija por conexión + fechas de negocio en Panamá.
- [x] Los commits de la Fase 1 solo tocan harness, ciclo y pruebas — `db.ts`, `server.ts`, `api.test.mjs`, `harness.mjs`.
- [x] Las correcciones posteriores están cubiertas por pruebas y no modifican `main`.

## Alcance real de la rama

Los commits de la Fase 1 son `9f3ff99` y `9a40730`; su diff conjunto está limitado a los cuatro archivos indicados arriba. La rama, sin embargo, está construida sobre cambios de facturación anteriores que todavía no están en `origin/main`. Por eso `git diff --stat origin/main...HEAD` muestra el diff acumulado completo, actualmente incluyendo también la migración de `payment_mode`, cambios de frontend, documentación y otros archivos previos.

Esto significa que un PR de esta rama contra `main` debe revisarse como un PR acumulado, no como un PR aislado de cuatro archivos. Para revisar solo la Fase 1, usar el rango `9f3ff99^..9a40730` o establecer como base una rama que ya contenga los commits anteriores.

## Correcciones implementadas en esta rama

- **#6 Concurrencia:** `pg_advisory_xact_lock` por cliente en las rutas que abren o
  reconcilian saldos; `cobrarClasesYaDadas` bloquea el saldo y las sesiones, y sólo
  incrementa por filas realmente reclamadas. Hay prueba de dos generaciones simultáneas.
- **#8 Transiciones de sesión:** una sesión `cancelled` no puede pasar directamente a
  `completed`/`no_show`; debe reactivarse primero. Hay regresión de `409`.
- **#9 Saldos vencidos:** clientes y agenda ya excluyen saldos mensuales vencidos de
  `available_sessions`, mientras `/api/packages` los conserva visibles con
  `vencido_con_saldo` para gestionarlos. El frontend tampoco los usa como saldo del mes.
- **#10 Fecha al editar saldo:** la reconciliación usa `soloFecha()` y se ejecuta dentro
  de la misma transacción que la edición.
- **#11 Regla de facturación pendiente:** una mensualidad local `anticipado` pendiente no
  puede abrir manualmente un paquete activo; `no_anticipado` conserva el flujo a crédito.
- **Matriz `payment_mode`:** hay pruebas del flujo `no_anticipado` de dos ciclos, rechazo
  de mensualidad anticipada pendiente y persistencia del cambio de modalidad. La matriz
  completa de renovación/cancelación/reconciliación por modalidad sigue siendo una
  recomendación de cobertura adicional, no un supuesto de que ya esté exhaustivamente
  probada.

## Pendientes para la revisión de mañana

- Revisar con Claude la matriz completa de `payment_mode` y decidir si se requieren casos
  separados para cancelación y reconciliación en cada modalidad.
- Revisar el worker de arranque y los cortes 1–4, que no quedaron alterados por esta rama.
- Los hallazgos de seguridad de la auditoría inicial (reset con `SETUP_TOKEN`, revocación
  de JWT, datos de salud a terceros y XSS en el grid) siguen fuera de esta rama y requieren
  una auditoría/revisión separada antes de considerar el sistema completamente cerrado.

## Contexto útil
- Documento de flujo (canónico): `docs/facturacion.md`.
- Esta rama no está mergeada a `main`; debe revisarse antes de abrir/mergear cambios.
