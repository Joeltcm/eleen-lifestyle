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

## Auditoría integral y sincronización de reprogramaciones desde Google Calendar

Fecha: 2026-09-29 · base revisada: `main` en `7783a39`

### Corrección aplicada

- Al mover una sesión a otro día desde Google Calendar, la sincronización ya
  registra `session_reschedules(origin='moved')`, igual que moverla desde
  Eileen.
- Si la sesión ya estaba `completed` y había descontado un saldo, la misma
  sincronización devuelve una clase al saldo, desvincula `package_id` y
  `package_debited`, y registra el movimiento dentro de una transacción.
- Mover sólo la hora dentro del mismo día sigue siendo un ajuste de agenda, no
  una reprogramación contable.

### Auditoría de flujos

- Clientes/perfiles: ownership por `owner_id` revisado en rutas de expedientes,
  planes, InBody, documentos, condiciones, pesos y pausas.
- Facturación/saldos: revisados ciclos por corte, crédito, anticipado/no
  anticipado, familiares, concurrencia, vencidos, excedentes y sesiones sueltas.
- Agenda/asistencia: revisados horarios fijos indefinidos, bajas, pausas,
  estados de sesión, marcado tardío, reprogramaciones y cumplimiento.
- Seguridad: autenticación JWT, fuerza bruta, enlaces de acceso de un solo uso,
  ownership, almacenamiento firmado y escapado HTML revisados.

### Riesgos pendientes de la auditoría

- El portal de cliente devuelve `busySlots` con fecha, hora y duración de
  sesiones de otros clientes del mismo entrenador. Aunque no incluye nombres,
  expone disponibilidad/agenda de terceros; debe ocultarse o agregarse antes
  de considerarlo cerrado.
- No existe una prueba automatizada que simule la respuesta de Google Calendar
  y verifique el pull bidireccional completo; la ruta local de mover sesiones sí
  tiene cobertura. Conviene añadirla para proteger OAuth, conflictos, borrado y
  movimiento de sesiones cobradas.
- La suite quedó en `208/210`: las dos fallas son las pruebas preexistentes de
  `no_anticipado` en el borde de fecha, no causadas por este cambio. El resto de
  las suites pasó, incluyendo ciclos, familiares, concurrencia, asistencia,
  seguridad básica, portal y reprogramación local.

### Publicación

- Backend-only; no requiere bump de frontend.
- `npm run verify` ✅
- Suite backend: `208/210`; las dos fallas son las pruebas antiguas de
  `no_anticipado` con fechas fijas del 28-09-2026 ejecutadas el 29-09-2026.
- Commit publicado en `main`: `6a83dad`.
- Railway `/health` respondió `status: ok` y reportó Google Calendar
  configurado. La consulta del estado detallado de Railway no estuvo disponible
  temporalmente por un 503 de su OAuth CLI.

## Filtro de cliente en Asistencia

Rama: `feat/filtro-cliente-asistencia`

- Asistencia incorpora búsqueda por nombre de cliente junto al mes y al rango
  personalizado.
- La búsqueda filtra la tabla, las tarjetas de métricas y el resumen sin
  volver a consultar el backend; los filtros de estado siguen aplicando.
- Frontend actualizado de v208 a v209.

### Publicación

- `npm run verify` ✅
- `main` actualizado a `c9c6acc`.
- Frontend v209 publicado en Cloudflare Pages.
- Despliegue verificado: `https://13d950c0.eileen-lifestyle.pages.dev` y dominio
  principal sirviendo `version.json` v209, el filtro `Cliente` en Asistencia y
  la navegación móvil de seis columnas.
- Railway `/health` respondió `status: ok`.

## Filtro de cliente en Facturación y navegación móvil

Rama: `feat/filtro-cliente-facturacion-mobile`

- Facturas y cobros incorpora búsqueda por nombre de cliente, combinable con
  mes, año y origen; el resumen, importes y tabla respetan el filtro.
- Se añadió `Limpiar cliente` para volver a ver el período completo.
- En pantallas móviles la navegación inferior pasa de cinco a seis columnas.
  Antes Facturación saltaba a una segunda fila y su icono quedaba recortado en
  iPhone; ahora todos los destinos permanecen en una sola fila y el icono
  activo tiene mayor contraste.
- Frontend actualizado de v207 a v208.

### Publicación

- `npm run verify` ✅
- `main` actualizado a `d5e2e60`.
- Frontend v208 publicado en Cloudflare Pages.
- Despliegue verificado: `https://17fb9682.eileen-lifestyle.pages.dev` y dominio
  principal sirviendo `version.json` v208, el filtro de cliente y la navegación
  móvil de seis columnas.
- Railway `/health` respondió `status: ok`.

## Rango personalizado en Asistencia

Rama: `feat/rango-fechas-asistencia`

- Asistencia conserva el selector de mes y añade `Desde`/`Hasta` para consultar
  un período personalizado inclusivo.
- El backend valida fechas completas, exige ambas fechas y rechaza rangos
  invertidos; el mismo cálculo de pausas, pendientes, cancelaciones y
  cumplimiento se aplica al rango solicitado.
- `Mes actual` y `Limpiar` regresan al filtro mensual; los filtros de estado
  siguen funcionando sobre el resultado visible.
- Frontend actualizado de v206 a v207.

### Publicación

- `npm run verify` ✅
- Suite backend: 208/210; las 2 fallas son las pruebas preexistentes de
  `no_anticipado` dependientes del borde de fecha/harness, no del reporte de
  Asistencia.
- `main` actualizado a `02695ea`.
- Frontend v207 publicado en Cloudflare Pages.
- Despliegue verificado: `https://565dfbfb.eileen-lifestyle.pages.dev` y dominio
  principal sirviendo `version.json` v207, `app.js?v=207` y `styles.css?v=207`.
- Railway `/health` respondió `status: ok`.

## Colores para el estado del cliente

Rama: `feat/colores-estatus-asistencia`

- La etiqueta bajo el nombre conserva el texto `Activo`, `En pausa` o
  `Inactivo`.
- Se añadió identificación visual: verde para activos, ámbar para pausados y
  gris para inactivos.
- No cambia filtros, métricas ni datos; es una mejora de lectura de la tabla.
- Frontend actualizado de v205 a v206.

### Publicación

- `npm run verify` ✅
- `main` actualizado con `4799d98`.
- Frontend v206 publicado en Cloudflare Pages.
- Producción verificada: la hoja de estilos contiene las etiquetas verde,
  ámbar y gris para los estados.
- Railway `/health` respondió `status: ok`.

## Filtros de estado en Asistencia

Rama: `feat/filtros-estado-asistencia`

- Se reemplazó `Solo activos` por tres casillas independientes: `Activos`,
  `En pausa` e `Inactivos`.
- La vista por defecto muestra `Activos` y `En pausa`, para que expedientes
  como el de Juan de Diego sean visibles sin incluir inactivos operativos.
- `Inactivos` queda disponible bajo demanda.
- El filtro recalcula la tabla y todas sus métricas usando únicamente los
  estados seleccionados; no cambia el cálculo del backend.
- Frontend actualizado de v204 a v205.

### Publicación

- `npm run verify` ✅
- `main` actualizado con `6cd4d68`.
- Frontend v205 publicado en Cloudflare Pages.
- Producción verificada: `Activos` y `En pausa` aparecen seleccionados por
  defecto; `Inactivos` aparece disponible pero desmarcado.
- Railway `/health` respondió `status: ok`.

## Simplificación visual posterior — tabla de Asistencia

Rama: `fix/asistencia-sin-avisos`

- Se retiraron los desgloses repetidos debajo de `Agendadas` y `No cumplió`.
- Las tarjetas superiores conservan únicamente sus números principales.
- Se mantiene el aviso del resumen sobre clientes en pausa ocultos por
  `Solo activos`, porque ese dato sí evita que un expediente desaparezca sin
  explicación.
- No cambia ningún cálculo ni endpoint; solo se simplifica la presentación.
- Frontend actualizado de v203 a v204.

### Publicación

- `npm run verify` ✅
- `main` actualizado con `3eee63e`.
- Frontend v204 publicado en Cloudflare Pages.
- Producción verificada: sirve `app.js?v=204` sin los avisos retirados.
- La casilla `Solo activos` continúa marcada por defecto.
- Railway `/health` respondió `status: ok`.
