# Handoff — Auditoría de facturación, Fase 1 (para revisión de Codex)

Rama: **`fix/ciclo-corte-y-harness`** (en GitHub). Nada mergeado a `main`.
Commits:
- `9f3ff99` — unificar el ciclo de corte en `cicloDelCorte` + estabilizar el harness.
- `9a40730` — prueba explícita de las 4 rutas + limpieza de comentarios.

## Cómo reproducir (base limpia)
El harness crea una BD Postgres temporal por corrida (createdb → migraciones desde cero → servidor real como subproceso), así que cada ejecución es base limpia.

```
cd backend
git checkout fix/ciclo-corte-y-harness
npm run check
npm run build
PGHOST=localhost PGUSER=<user> PGPASSWORD= PGPORT=5432 npm test
```
Resultado esperado: `# tests 183 / # pass 183 / # fail 0`, reproducible sin importar la hora del sistema (ver más abajo).

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

## Checklist de pre-merge (lo que Codex pidió) — estado de la Fase 1
- [x] No quedan referencias a `venceMensualidadDesde` — `grep -rn venceMensualidadDesde src/ test/` → vacío.
- [x] Las 4 rutas producen el mismo rango — test explícito para plan/manual/confirmación y 6 casos worker↔manual que comparan `expires_on` y etiqueta/rango.
- [x] `183/183` sobre base limpia — BD temporal por corrida.
- [x] Reproducible sin importar la hora — TZ fija por conexión + fechas de negocio en Panamá.
- [x] Los commits de la Fase 1 solo tocan harness, ciclo y pruebas — `db.ts`, `server.ts`, `api.test.mjs`, `harness.mjs`.
- [x] Sin cambios de fases posteriores.

## Alcance real de la rama

Los commits de la Fase 1 son `9f3ff99` y `9a40730`; su diff conjunto está limitado a los cuatro archivos indicados arriba. La rama, sin embargo, está construida sobre cambios de facturación anteriores que todavía no están en `origin/main`. Por eso `git diff --stat origin/main...HEAD` muestra el diff acumulado completo, actualmente incluyendo también la migración de `payment_mode`, cambios de frontend, documentación y otros archivos previos.

Esto significa que un PR de esta rama contra `main` debe revisarse como un PR acumulado, no como un PR aislado de cuatro archivos. Para revisar solo la Fase 1, usar el rango `9f3ff99^..9a40730` o establecer como base una rama que ya contenga los commits anteriores.

## Pendiente (fases siguientes — NO tocado en esta rama)
Del análisis conjunto, siguen abiertos sobre `main` actual:
- **#6 Concurrencia:** sin advisory lock ni restricción única por cliente+ciclo en `session_packages`. El lock debe tomarse en TODAS las rutas que abren saldo (worker, reconciliación, confirmar pago, asignación de plan, `POST /packages`, `POST /invoices/:id/package`), en la misma transacción.
- **#8 Transiciones de sesión:** `recordSessionCompliance` no valida el estado de origen (una `cancelled` puede pasar a `completed`/`no_show` sin limpiar billing_credits/reposiciones/datos de cancelación). Definir la matriz de transiciones; usar el endpoint `reactivate` para orquestar la limpieza.
- **#9 Saldos vencidos:** una mensualidad vencida con saldo no se auto-expira (`expirarPaquetesVencidos` sólo toca `kind='package'`) y sigue sumando en `available_sessions`. Filtrar `expires_on >= current_date` en TODAS las consultas de saldo (`/api/clients` líneas ~713 y ~2871, `/api/packages`, dashboard, reportes).
- **#10 Fecha al editar saldo:** `String(pack.expires_on).slice(0,10)` en `PATCH /api/packages/:id` (~línea 1236, la llamada a `cobrarClasesYaDadas`) → usar `soloFecha()`.
- **#11 Regla de facturación pendiente:** `POST /api/invoices/:id/package` sólo rechaza anuladas; para `payment_mode='anticipado'` una factura local pendiente no debería abrir saldo `active` (regla explícita en backend, no sólo el flag `pago_pendiente`). Para `no_anticipado` sí (entrena a crédito).
- **Matriz `payment_mode`:** hoy hay 1 test (no_anticipado, dos ciclos). Falta cubrir anticipado × renovación/cancelación/reconciliación end-to-end.

## Contexto útil
- Documento de flujo (canónico): `docs/facturacion.md`.
- La auditoría NO se da por cerrada hasta validar los pendientes de arriba.
