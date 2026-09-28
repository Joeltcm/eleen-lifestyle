# Handoff — agenda al finalizar contrato y descuento prematuro

Rama: `fix/agenda-inactivo-y-debito-julieta`

## Cambios

- Al pasar un cliente a `inactive`, se conserva el expediente y el historial.
- Se detienen sus `session_recurrences` activas.
- Se eliminan únicamente sus sesiones futuras con estado `scheduled`, después de intentar retirar sus eventos de Google Calendar.
- Las sesiones pasadas, completadas, `no_show` o canceladas no se borran.
- Un cliente inactivo sigue sin poder recibir sesiones sueltas, por lote o recurrentes.
- Una sesión futura ya no puede marcarse como `completed` ni `no_show` desde cumplimiento ni desde `/api/sessions/:id/complete`.
- El registro diario rechaza fechas futuras para no crear una sesión completada por una ruta alternativa.
- La agenda activa continúa permitiendo programar sesiones sin limitarse al número contratado; los horarios recurrentes siguen extendiéndose por horizonte y solo se detienen al desactivar al cliente.

## Caso Julieta

El corte por sí solo no descuenta una clase. El descuento solo puede venir de una sesión `completed`, `no_show`, una cancelación del cliente sin reprogramación, una edición manual del saldo o datos históricos de reconciliación/migración.

La corrección evita el caso más probable: una sesión futura marcada prematuramente. No se modificó el saldo de Julieta en producción porque aún hay que identificar la fila que generó el `used_sessions = 1`; resetearlo por nombre sin confirmar el origen podría ocultar una clase legítimamente consumida. La revisión de Claude debe verificar ese expediente y, si corresponde, hacer una corrección de datos explícita y trazable.

## Pruebas

- `npm run check`
- `npm run build`
- `PGHOST=localhost PGUSER=joel PGPASSWORD= PGPORT=5432 npm test`
- Resultado: **195/195**, base temporal limpia por corrida.

Las regresiones cubren: marcar `completed` y `no_show` antes de la fecha, registro diario futuro, baja con sesiones sueltas y recurrentes futuras, conservación del historial y bloqueo de nueva agenda tras la baja.

No se hizo merge a `main` ni despliegue.
