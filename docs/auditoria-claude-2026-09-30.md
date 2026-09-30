# Handoff para auditoría de Claude — cambios del 29 y 30 de septiembre de 2026

Fecha de preparación: 2026-09-30  
Repositorio: Joeltcm/eleen-lifestyle  
Rama local de trabajo: feature/flujo-cobro-y-perfil  
Base funcional: PRs #2 a #7 integradas en main

Este documento concentra lo avanzado mientras Claude no estuvo disponible. El
registro histórico más amplio está en docs/auditoria-continuacion.md. Este
handoff añade el delta final, el estado real de pruebas y los puntos que no
deben darse por cerrados sin auditoría.

## Resumen ejecutivo

Se trabajó en cuatro áreas relacionadas:

1. Asistencia: filtros por estado, cliente, rango de fechas y corte;
   navegación por períodos; métricas calculadas sobre las sesiones visibles;
   estados de cancelación y reprogramación más claros.
2. Agenda y cumplimiento: mover una clase por día u hora, desde Eileen o
   Google Calendar, la registra como reprogramada; si ya estaba cumplida,
   devuelve el débito y conserva el resultado final.
3. Facturación y saldos: confirmación de pago con aplicación automática,
   pagos parciales editables, clientes que entrenan aunque paguen tarde,
   familiares, crédito por clase para Julio y corrección retroactiva de la
   factura de septiembre.
4. Portal del cliente: nombre actualizado desde el expediente, consulta por
   mes/corte, historial de pagos, cumplimiento, cancelaciones,
   reprogramaciones, mejoras visuales y adaptación móvil.

## Cambios funcionales realizados

### 1. Asistencia y consulta de cumplimiento

- La vista inicia con Activos y En pausa seleccionados; Inactivos queda
  disponible bajo demanda.
- Se añadió búsqueda por cliente. Las tarjetas, el resumen y la tabla usan el
  mismo conjunto filtrado.
- Se añadió rango personalizado inclusivo Desde/Hasta, con validación de fechas
  completas y rechazo de rangos invertidos.
- Al seleccionar un cliente se puede activar Solo corte vigente. El corte usa
  billing_cutoff_day del expediente, no el día 1 ni una resta fija de días.
- El reporte permite corte anterior, corte actual y regreso al mes. El botón
  de corte es reversible; volver al mes limpia la navegación del ciclo.
- Las fechas exactas del período aparecen destacadas para evitar confundir mes
  calendario con ciclo de facturación.
- Se retiraron avisos redundantes de las tarjetas; las cifras principales
  permanecen en la tabla.
- La tabla conserva el estado bajo el nombre con color: verde Activo, ámbar
  En pausa, gris Inactivo.
- Se cambió la terminología operativa: Canceló cliente y No asistió; se retiró
  el estado ambiguo No cumplió de la presentación.
- Cancelaciones de Eileen no penalizan el cumplimiento del cliente. Pausas y
  sesiones congeladas quedan fuera de la métrica.
- Una sesión reprogramada cuenta una sola vez. Si termina completed, suma a
  cumplidas; si termina cancelada por el cliente sin reprogramación, se pierde,
  se descuenta y afecta el porcentaje.
- Las excedentes de mensualidad no desbordan al ciclo siguiente y se excluyen
  del cumplimiento. La capacidad del ciclo suma todos los saldos mensuales,
  incluidos los familiares.

Commits relacionados: 86c08d6, 6980cd5, c5a7220, 3eee63e, 6cd4d68,
4799d98, 02695ea, bf1baa4, fe88b96, 24f46af, 9f23755, 7e7ad4e,
0a32fea, 0adb03c.

### 2. Reprogramación desde agenda y Google Calendar

- Cambiar la fecha o sólo la hora crea un registro en session_reschedules.
- La sincronización de Google Calendar registra el origen moved y aplica la
  misma semántica que el movimiento realizado desde Eileen.
- Una sesión completed que se mueve revierte package_debited y su vínculo al
  saldo dentro de la transacción; el nuevo horario se cobrará sólo cuando
  corresponda.
- Mover una sesión no borra su resultado final: completed sigue cumplida y
  cancelled sigue cancelada.
- El caso esperado reprogramada + cumplió aumenta cumplimiento; el caso
  reprogramada + canceló se pierde, se descuenta y afecta el porcentaje.

Archivos principales: backend/src/google-calendar.ts,
backend/src/server.ts y backend/test/api.test.mjs.

Commits relacionados: 6a83dad, 786280d, 7e7ad4e.

### 3. Flujo de cobros y saldos

- Confirmar un cobro local aplica automáticamente la cobertura de la
  mensualidad o activa el paquete correspondiente.
- La operación es idempotente: confirmar o procesar dos veces no crea otro
  saldo ni regala clases.
- Los pagos parciales conservan el saldo pendiente y pueden corregirse desde
  Editar pago; corregir de completo a parcial no revoca las clases ya
  disponibles.
- Pagar tarde o no haber pagado todavía no bloquea al cliente: el saldo se
  abre y las clases pueden descontarse; la deuda se informa en facturación y
  en el portal.
- La cobertura familiar mantiene separado el expediente del pagador y el del
  beneficiario; la capacidad y el débito pertenecen a quien entrena.
- Se conserva la reutilización del saldo de plan con origin_invoice_id nulo
  cuando llega el cobro del mismo ciclo. Dos coberturas familiares legítimas
  del mismo ciclo no se colapsan.
- Se conserva el anclaje por día de corte, incluyendo 28/30/31 y febrero, y
  la regla no_anticipado: el cliente entrena a crédito y el cobro salda el
  ciclo que cierra.
- Se retiró de la interfaz operativa la pestaña Control de paquetes y se dejó
  el expediente del cliente como lugar para consultar saldos y estado de
  cuenta.
- Se ocultaron los botones/etiquetas Cobertura aplicada y Revisar aplicación
  para cobros automáticos propios: la aplicación ya es parte de la
  confirmación y no debe sugerir una segunda acción a Eileen. Se conservan
  acciones manuales para históricos de Zoho o cobros manuales que todavía lo
  requieran.

Commits relacionados: 23a3a25, 9991675, b9eb13f, c2cf888, de89d6d,
2e3d7d0, 94426bd, 10d8ec1, cb2d5c7.

### 4. Julio — mensualidad a crédito por clase

El caso de Julio se implementó como payment_mode = no_anticipado:

- mínimo mensual: 10 clases por $275;
- valor unitario de excedente: $27.50;
- la factura cobra el mínimo más las clases elegibles que excedan las 10;
- las clases elegibles son las del ciclo (corte anterior, corte actual] y
  pueden ser completed, no_show o canceladas por el cliente sin
  reprogramación;
- no se cuentan dos veces sesiones reprogramadas;
- la migración backend/migrations/048_credito_por_clase.sql recalcula de forma
  retroactiva las facturas locales existentes, incluida septiembre;
- no modifica facturas de Zoho: source_system IS NULL es condición de la
  corrección;
- el monto, line_items, concepto, balance y estado se recalculan juntos.

La prueba reproducible crea 12 clases en el ciclo actual, crea una factura de
$275 y verifica que la generación la corrija a $330: 10 clases mínimas más
2 excedentes, con concepto explicativo.

Commit principal: 10d8ec1 — migración, lógica de servidor y pruebas.

### 5. Portal del cliente

- El nombre se refresca desde el expediente real al iniciar sesión; corrige el
  caso de Francolini, Riccardo mostrado como Riccardo Francolini.
- Se puede consultar el mes calendario o un corte destacado, navegar a cortes
  anteriores y volver al mes.
- Las tarjetas de clases, saldo pendiente, deuda y próximas sesiones se
  recalculan para el período seleccionado.
- El historial de Pagos muestra todos los cobros del cliente, no sólo el
  período actualmente seleccionado.
- La gráfica de cumplimiento muestra realizadas/medibles y porcentaje, no sólo
  un 100% aislado.
- Se muestran cancelaciones del cliente con cantidad y porcentaje,
  reprogramaciones e inasistencias por período.
- Pagos pendientes y saldo pendiente tienen una señal visual más clara, sin
  impedir que el cliente siga entrenando.
- Rutinas, Agenda, Pagos e Informes comparten la jerarquía visual de Progreso.
- Pagos e Informes se convierten en fichas legibles en móvil; la agenda
  conserva desplazamiento horizontal sólo donde es necesario.

Commits relacionados: ede4d9a, 2277606, 03ce457, 8405c51, de89d6d,
61d903a, 2e3d7d0, 97d7961.

## PRs integradas

| PR | Título | Merge |
|---|---|---|
| #2 | Filtro activos asistencia | 2026-09-29 |
| #3 | Cobro automático aplicado | 2026-09-30 |
| #4 | Optimizar experiencia móvil del portal | 2026-09-30 |
| #5 | Facturación retroactiva de clientes a crédito | 2026-09-30 |
| #6 | Ocultar controles de cobertura automática | 2026-09-30 |
| #7 | Actualizar versión PWA a 223 | 2026-09-30 |

Enlaces: github.com/Joeltcm/eleen-lifestyle/pull/2, /pull/3, /pull/4,
/pull/5, /pull/6 y /pull/7.

## Verificación realizada

### Checks que pasan

- npm run verify pasó:
  - sintaxis JavaScript;
  - build del frontend;
  - tsc --noEmit del backend;
  - build TypeScript del backend.
- La suite ejecutada con PostgreSQL local temporal terminó en 216/216 tests
  pasando, 68 suites, 0 cancelados y 0 omitidos.
- El fallo familiar quedó resuelto en la prueba, no enmascarado: la sesión se
  crea a las 00:01 del día de corte, dentro del ciclo que acaba de abrirse y
  después de la hora actual. La prueba además verifica que la respuesta sea
  completed + debited antes de comprobar que Beatris queda con 11 y Eduardo
  con 12.
- Se añadió una prueba de privacidad del portal: los horarios ocupados de
  terceros siguen visibles como intervalos para evitar conflictos, pero el
  payload no contiene id, client_id ni full_name de terceros.
- Sin PostgreSQL local, el sandbox no pudo abrir 127.0.0.1:5432; por eso la
  primera ejecución no es un resultado de código y se repitió con permiso
  local.

### Producción

- Cloudflare Pages: eileen-lifestyle.pages.dev responde HTML con
  styles.css?v=223 y app.js?v=223.
- Despliegue de producción verificado:
  2721d2d4-4e0d-412b-947d-fd1e3d460f60.
- Service Worker publicado en versión 223.
- La inconsistencia de versión se corrigió localmente: app.js, index.html,
  sw.js y version.json quedaron alineados en v224. La producción que se
  verificó antes de esta auditoría sigue en v223 hasta publicar este delta.
- Railway /health respondió correctamente:
  - API disponible;
  - base de datos disponible;
  - document storage listo;
  - InBody configurado;
  - Web Push configurado;
  - Google Calendar configurado.

## Puntos que Claude debe auditar mañana

### Segunda pasada de auditoría — 2026-09-30

- Facturación/saldos: la suite cubre confirmación automática, pago parcial,
  pagos tardíos sin bloqueo, reutilización de saldo de plan, familiares,
  no_anticipado, cortes 28/30/31, excedentes y reconciliación idempotente;
  todo pasa.
- Agenda/cumplimiento: cubre completar, no-show, cancelación de cliente,
  cancelación de Eileen, pausa, reprogramación por fecha y por hora, y
  devolución del débito al mover una sesión ya realizada; todo pasa.
- Portal: cubre nombre desde expediente, saldo pendiente, historial de pagos,
  periodos/cortes, métricas y minimización de horarios de terceros; todo pasa
  en la suite.
- PWA: la fuente local de versión quedó consistente en v224. No se publicó
  desde esta auditoría; por eso la verificación visual en producción y la
  sustitución de la caché quedan para el despliegue autorizado.

### Prioridad alta

1. Probar en producción con un cobro automático pendiente y confirmado que ya no
   aparece Cobertura aplicada, sin romper la edición de pagos parciales ni los
   cobros manuales/Zoho.
2. Validar el cálculo retroactivo de Julio en septiembre contra datos reales:
   sesiones elegibles, corte 31, mínimo 10, excedentes a $27.50, monto,
   balance y estado de factura.
3. Revisar Riccardo Francolini con corte 15 en mes y corte: tarjetas, fechas,
   porcentaje, cancelaciones y reprogramaciones no deben quedar en cero por
   un rango mal traducido.

### Riesgos ya identificados y todavía abiertos

- El portal conserva busySlots de terceros con fecha, hora y duración porque el
  cliente necesita evitar reprogramar encima de otra clase; el contrato ya no
  expone identidad ni identificadores y tiene prueba automatizada. Claude debe
  validar que esa mínima información siga siendo aceptable para el negocio.
- Falta una prueba automatizada que simule el movimiento real recibido desde
  Google Calendar y cubra OAuth/sincronización, conflictos, borrado y sesiones
  ya cobradas.
- Confirmar que la migración 048 sea segura al ejecutarse más de una vez y que
  no toque Zoho ni pagos ya aplicados.
- Confirmar que la reconciliación diaria no descuente una clase excedente ni
  la pase al siguiente ciclo.
- Revisar PWA en una pestaña ya abierta/incógnito: hacer una recarga una vez
  para que el Service Worker 224 reemplace la caché anterior.

## Reglas de negocio que no deben romperse

- El cliente puede entrenar aunque pague tarde o todavía no haya pagado.
- Un pago pendiente genera aviso de morosidad, pero no suspende el descuento de
  clases ni el entrenamiento.
- El día de corte viene del expediente del cliente.
- Julio conserva septiembre como ciclo relevante y cierra el último día del
  mes.
- Las clases individuales no requieren corte ni saldo: sólo registran cobro.
- Las cancelaciones de Eileen no penalizan al cliente.
- Una cancelación del cliente sin reprogramación sí es pérdida y descuento.
- Una reprogramación cumplida conserva cumplimiento; una reprogramación que
  termina cancelada por el cliente cuenta como perdida.
- Las clases excedentes no se facturan al ciclo siguiente ni cuentan en
  cumplimiento.
- Dos saldos familiares legítimos del mismo ciclo pueden coexistir.
- No borrar ni alterar datos de Zoho al aplicar correcciones locales.

## Archivos y cambios locales a preservar

### Delta de esta auditoría

- backend/test/api.test.mjs: la prueba familiar ahora usa una fecha de negocio
  reproducible dentro del ciclo vigente, y comprueba explícitamente que el
  marcado devuelve `billing.action = debited`.
- backend/test/api.test.mjs: se agregó la prueba de que el portal muestra
  ocupación de terceros sin identidad.
- backend/src/server.ts: se documentó el contrato de minimización del payload
  `busySlots`; la ocupación se conserva porque es necesaria para elegir un
  horario libre.
- app.js, index.html, sw.js y version.json: se alineó la versión local de la
  PWA en 224 para que no haya discrepancia entre aplicación, caché y detector
  de actualizaciones.
- Verificación final: `npm run verify` y `npm test` pasan; la suite termina en
  216/216.
- Este delta todavía no está publicado en Cloudflare/Railway. La producción
  permanece en la versión previamente verificada hasta que se autorice el
  despliegue.

Los siguientes elementos no forman parte de este handoff y ya existían como
archivos locales no relacionados; no deben borrarse ni incluirse por accidente:

- backend/migrations/003_progress_photo_metadata.sql
- graphify-out/
- worktrees/
