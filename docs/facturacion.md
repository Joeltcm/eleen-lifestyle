# Auditoría de facturación y control de paquetes

Cómo se emiten los cobros, cómo se abren y renuevan los saldos de sesiones, y cómo
se descuentan las clases. Mapeado contra la implementación real del backend
(`backend/src/server.ts`), por **nombre de función** para que las referencias no se
rompan al mover líneas.

**Stack:** Fastify 5 + PostgreSQL · **Unidad:** ciclo de corte · **Ventana de emisión:** 7 días · **Worker:** cada 60 min.

Funciones clave: `generateRecurringInvoices`, `cobrarClasesYaDadas`, `recordSessionCompliance`,
`saveNativeInvoicePayment`, `abrirCobertura`, `asentarMensualidad`, `recurringBillingStatus`.
Constantes: `BILLING_GENERATION_DAYS_AHEAD=7`, `BILLING_INTERVAL_MINUTES=60`, `DIAS_USO_PAQUETE=42`, `DIAS_RENOVACION_PAQUETE=28`.

---

## 1. Principio: ciclos de corte, no meses de calendario

La regla que gobierna todo el resto. Fijarla mal desalinea cobros, saldos y descuentos.

`clients.billing_cutoff_day` (el **día de corte**, en la ficha) es la única fuente de
verdad. El ciclo es el intervalo **[corte, próximo corte)**: el día de corte es el
**primer día** del ciclo nuevo, así que el descuento de una clase empieza **el mismo
día del corte**, no al siguiente. Casi todo ciclo pisa dos meses de calendario.

> **Convención.** Un cliente de corte 15 corre **15→15** (p. ej. 15-09 → 15-10), nunca
> 01→01. Las tarjetas "Cobrado/Facturado en el mes" son por mes de calendario y sólo
> aproximan; la vista **Corte actual** es el lente correcto.

---

## 2. Modelo de datos

| Tabla | Campos clave para facturación |
|---|---|
| **clients** | `billing_cutoff_day`, `billing_model` (monthly/package/single), `standard_price`, `plan_id`, `payment_mode` (anticipado/no_anticipado), `billing_responsible_client_id` (quién paga), `monthly_session_target`, `status` |
| **memberships** | `amount`, `renewal_day`, `status` (active/paused). Su existencia activa habilita la emisión recurrente; un `ends_on` vencido la bloquea. |
| **service_plans** | `price`, `sessions_included`, `validity_days`, `billing_model` |
| **invoices** (cobros) | `due_on`, `billing_period`, `status` (pending/confirmed/void), `auto_generated`, `source_system` (zoho_invoice…), `billed_for_client_id`, `package_id` |
| **session_packages** (saldos) | `total_sessions` / `used_sessions`, `expires_on`, `kind` (monthly/package/makeup), `purchased_on`, `origin_invoice_id`, `status` (active/exhausted/expired/pending/cancelled) |
| **sessions** | `status` (scheduled/completed/cancelled/no_show), `package_id` + `package_debited`, `cancellation_kind` (rescheduled/not_rescheduled), `cancelled_by` (client/trainer), `cancellation_resolution` |
| **invoice_coverage** | Cobertura familiar: `client_id`, `invoice_id`, `billing_period`, `amount` |
| **billing_credits** | Descuentos por clase cancelada por la entrenadora; `applied_invoice_id` al aplicarse al próximo cobro |

---

## 3. Emisión de cobros — `generateRecurringInvoices()`

Worker + botón "Generar cobros pendientes". Emite el cobro cuando el corte se acerca.

1. **Universo de candidatos.** Clientes con `status='active'`, `billing_model='monthly'`,
   `standard_price>0`. El cobro va a nombre de `billing_responsible_client_id` o de sí
   mismo. `due_on = make_date(año, mes, min(corte, último día del mes))`.
2. **Ventana de emisión.** Se emite sólo si `due_on ∈ [hoy, hoy+7]`
   (`BILLING_GENERATION_DAYS_AHEAD=7`). Ni antes de tiempo ni hacia atrás: un mes
   cerrado es historial.
3. **Membresía activa.** Debe existir membresía activa con `starts_on ≤ due_on` y
   (`ends_on` nulo o ≥ período). Una membresía con `ends_on` vencido **excluye al
   cliente silenciosamente**.
4. **Anti-duplicado por factura.** No emite si ya existe una factura del mismo período
   —comparado por `date_trunc('month', COALESCE(billing_period, issued_on, due_on))`—
   que sea automática, de Zoho, mensual, o de monto igual al precio.
5. **Anti-doble por cobertura familiar.** No emite si el cliente ya está cubierto por el
   cobro de otro (familiar) del mismo ciclo. **Se compara por el mes del cobro origen de
   la cobertura** (`date_trunc('month', ci.due_on)`), no por su etiqueta `billing_period`
   — el fix del bug de corte tardío 25–28.
6. **Bloqueo por Zoho.** Si hay una `integration_connections` de Zoho activa y no
   `'completed'`, no se emite nada (la migración manda).
7. **Inserción.** `INSERT` con `auto_generated=true`, `status='pending'`, concepto con el
   nombre de quien entrena si la paga otro.
   `ON CONFLICT (client_id, billing_period, billed_for_client_id) WHERE auto_generated DO NOTHING`.

> ⚠️ **A verificar.** El worker de arranque (15 s tras bootear) no siempre completó la
> emisión de todos los clientes en una corrida (se observó con Julio). El botón "Generar
> cobros pendientes" y el worker de cada 60 min lo cubren, pero conviene revisar por qué
> la corrida de arranque no termina.

---

## 4. Apertura y renovación del saldo

Segundo bloque de `generateRecurringInvoices()`: el loop `pendientes`. Convierte cada
cobro en un saldo de sesiones del ciclo.

- **Selección:** cobros mensuales no anulados, `package_id` nulo, `due_on ≥ hoy`, sin un
  saldo mensual que venza *más allá* del corte (`expires_on > due_on`, estricto). Uno por
  persona (`DISTINCT ON (entrena)`).
- **Sesiones del saldo:** `monthly_session_target` de la ficha → `sessions_included` del
  plan → total del último saldo.
- **Anclaje al corte:** `expires_on` sale de `cicloDelCorte(due_on, billing_cutoff_day)`;
  etiqueta = rango corte→corte. **Nace `active`** — el cliente entrena aunque no haya pagado.
- **Reconciliación:** `cobrarClasesYaDadas()` descuenta retroactivamente las clases del
  ciclo ya consumidas (ver §6).

> 🔴 **Bug corregido — no reintroducir.** Antes el saldo se anclaba al `billing_period`
> (1° de mes), así que un corte 15 corría 01→01 y las clases caían en el saldo del mes
> calendario equivocado. Ahora **se ancla a `due_on`** (el día de corte). No volver a usar
> `billing_period` para el vencimiento del saldo.

---

## 5. Modalidad de pago — `clients.payment_mode`

La diferencia real no es sólo una alerta: cambia a qué ciclo se enlaza el cobro.

- **`anticipado` (por defecto).** Paga por adelantado. El cobro **abre y enlaza** el saldo
  del ciclo nuevo (prepago). Un saldo activo por ciclo. Flujo sin cambios.
- **`no_anticipado` (Julio).** Entrena a crédito, paga al final en su corte. El saldo del
  ciclo nuevo nace **sin cobro enlazado**; el cobro del corte se enlaza al saldo que
  **vence en `due_on`** (el ciclo que cierra), que muestra "pago pendiente". Siempre puede
  entrenar.

> **Consecuencia esperada.** En no_anticipado hay un desfase de un ciclo entre saldo y
> cobro. Cuando ya se generó la factura (hasta 7 días antes del corte), coexisten dos
> filas: el ciclo que cierra (pendiente) y el nuevo (activo). La vista **Corte actual**
> muestra sólo el ciclo en curso.

---

## 6. Descuento de clases

Tres caminos descuentan (o devuelven) una clase del saldo. Todos respetan la misma regla
de qué consume.

### ¿Qué consume una clase?

| Evento | ¿Consume cupo? | Regla |
|---|---|---|
| Clase **completada** | **Sí** | Descuenta del saldo activo que cubre esa fecha |
| Cliente **cancela sin reagendar** | **Sí** | Entrena a crédito: la clase contratada se consume igual (`resolution='debit'`) |
| Cliente **pide reagendar** | No | Conserva la clase para la nueva cita (`cancellation_kind='rescheduled'`) |
| Cancela **la entrenadora** | No | Se compensa al cliente: reposición, descuento o nada — nunca se le cobra la falta |

### Los tres caminos

1. **Al completar — `recordSessionCompliance()`.** Si no estaba debitada, busca el saldo
   activo con `used<total` que cubra la fecha de la clase (`expires_on ≥ día de la clase`),
   **ordenado por `expires_on` ascendente** (el que caduca antes). Descuenta 1. Sin saldo,
   completa sin descontar y la reconciliación lo recoge. Volver a *scheduled*/*no_show*
   devuelve la clase.
2. **Al cancelar — endpoint de cancelación.** Cliente sin reagendar → busca el saldo activo
   que cubre la fecha y descuenta. Editar la cancelación (`PATCH /sessions/:id/cancellation`)
   revierte el débito previo y recalcula según la nueva resolución.
3. **Reconciliación — `cobrarClasesYaDadas()`.** Al abrir un saldo y en el worker diario.
   Recupera las clases del ciclo consumidas sin debitar — **completadas + canceladas-perdidas
   del cliente** (`not_rescheduled`, `cancelled_by='client'`) — en la ventana
   `(expires−1 mes, expires]` y hasta el cupo. Existe porque la clase se marca temprano y el
   saldo puede abrirse después.

---

## 7. Confirmar pago y cobertura familiar

`saveNativeInvoicePayment()` / `POST /invoices/:id/confirm` — registra el pago y, si toca,
abre el saldo.

Al confirmar el pago de un cobro **mensual, sin `package_id`, pendiente**, se abre cobertura
(`abrirCobertura()`) para el cliente y sus dependientes (`billing_responsible_client_id`). El
saldo y las sesiones son de quien entrena; el cobro, a nombre de quien paga.

> **El candado anti-duplicado.** No abre un segundo saldo si el cliente ya tiene un saldo
> mensual activo que venza *más allá* del pago (`expires_on > paidOn`) cuyo `origin_invoice_id`
> sea **nulo**, **este mismo cobro**, o **un cobro automático**. Así un cobro manual registrado
> aparte no duplica el saldo que ya abrió la generación (el bug de Sally/Julieta). El saldo de
> *otro* cobro manual (clases pagadas aparte) sí puede convivir con la mensualidad familiar.

`asentarMensualidad()` — al crear o confirmar un cobro mensual, fija `standard_price` y la
membresía (crea una si no hay activa).

---

## 8. Control de paquetes (la vista)

`GET /api/packages` devuelve los saldos no cancelados con banderas calculadas. La UI filtra
al ciclo en curso.

### Estados del saldo

| Estado | Significa |
|---|---|
| `pending` | Saldo sin activar (no suma disponibles ni descuenta). Los automáticos y de Zoho nacen *active*, no aquí. |
| `active` | Vigente y usable; descuenta clases |
| `exhausted` | `used ≥ total` |
| `expired` | Sólo lo marca `expirarPaquetesVencidos`, y **sólo para `kind='package'`** |

### Banderas calculadas

- `pago_pendiente` — existe una factura pendiente ligada (`origin_invoice_id = saldo` o
  `package_id = saldo`). Enciende el tag amarillo "Pendiente de pago".
- `vencido_con_saldo` — `expires_on < hoy` con `used < total` (clases perdidas).
- `renovacion_pendiente` — `kind='package'`, activo, `purchased_on + 28 días ≤ hoy`.

> **Una fila, no un duplicado.** Un cliente puede tener legítimamente dos saldos mensuales a
> la vez (el ciclo anterior agotado + el nuevo pendiente/activo), sobre todo cerca del corte.
> La vista muestra sólo el del ciclo en curso — en pantalla se ve **una fila**. El endpoint de
> diagnóstico sí los devuelve todos.

---

## 9. Workers y horarios

Todos arrancan con un `setTimeout` tras bootear y repiten con `setInterval`. Corren para todos
los dueños.

| Worker | Primera | Cada | Qué hace |
|---|---|---|---|
| `generateRecurringInvoices` | 15 s | 60 min | Emite cobros y abre/renueva saldos del ciclo |
| `reconciliarSaldos` | 30 s | 24 h | Descuenta clases del ciclo consumidas sin debitar (dadas + canceladas-perdidas) |
| `expirarPaquetesVencidos` | 25 s | 24 h | Marca *expired* — sólo `kind='package'` |
| `extenderRecurrencias` | 20 s | 6 h | Extiende recurrencias de agenda |
| `dispatchReminders` | 10 s | configurable | Recordatorios push (sesión y pago) |

---

## 10. Puntos a verificar en la auditoría

Bordes conocidos donde el comportamiento puede sorprender. No son todos bugs; son cosas a
confirmar contra la realidad del negocio.

1. ✅ **Vencido con saldo visible, pero no disponible.** Las mensualidades vencidas no se
   auto-expiran (`expirarPaquetesVencidos` sigue tocando sólo `kind='package'`), pero las
   consultas de clientes, agenda y frontend ya excluyen `expires_on < current_date` de
   `available_sessions`. `/api/packages` las conserva visibles con `vencido_con_saldo` para
   poder gestionarlas.
2. ⚠️ **Worker de arranque incompleto.** La corrida de generación al bootear no siempre emite a
   todos (observado con Julio; se resolvió con el botón manual). Vale confirmar que una sola
   corrida completa a todos los clientes elegibles.
3. ⚠️ **Cortes 1–4 y el borde de mes.** El anclaje por `due_on` es correcto para cortes 15/25/28.
   Para corte 1–4, un cobro emitido a fin del mes anterior podría cruzar de mes calendario. Hoy
   esos clientes son individuales sin cobertura (riesgo bajo), pero conviene tenerlo presente.
4. ⚠️ **Dos filas en no_anticipado.** El saldo del ciclo nuevo se abre con el cobro (hasta 7 días
   antes del corte), así que hay dos saldos hasta que llega el corte. Decisión abierta: abrirlo
   recién *en* el corte para ver una sola fila.
5. ✅ **Bug de fecha 2001 corregido en el flujo auditado.** `PATCH /api/packages/:id` usa
   `soloFecha()` al reconciliar el vencimiento; mantener la misma regla en cualquier código
   nuevo que pase fechas devueltas como `Date` por postgres.js.
6. 🔴 **Seguridad — auditoría aparte.** Este documento cubre la lógica de facturación, no la
   superficie de seguridad. Los hallazgos de seguridad (reset de admin con `SETUP_TOKEN`, JWT sin
   revocación, datos de salud a un tercero, XSS en el grid) están en su propia auditoría y siguen
   sin corregir.
