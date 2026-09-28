# Handoff — claridad de cobros familiares

Rama: `fix/facturacion-familiar-visible`

## Objetivo

Evitar que Eileen interprete como duplicado que el mismo pagador aparezca varias veces en Facturación.

## Comportamiento aplicado

- El `client_id` visible sigue siendo el responsable del pago: Eduardo.
- Cada factura conserva `billed_for_client_id` y ahora la API también devuelve `billed_for_name`.
- La línea propia se identifica como `Mensualidad propia de Eduardo`.
- La línea de un dependiente se identifica como `Cubre la mensualidad de Beatriz`.
- Las líneas familiares muestran `Pagador familiar` y el total de todas las mensualidades del mismo corte, por ejemplo `$350`.
- El modal de confirmar/registrar pago muestra el beneficiario y el total familiar del corte.
- No se crean facturas adicionales ni se cambia la lógica de cobro: siguen siendo dos líneas de `$175`, ambas a nombre de Eduardo.

## Validación

- La prueba de facturación familiar verifica que el pagador y el beneficiario se exponen por separado.
- Ejecutar antes de mergear:

```sh
npm run check
npm run build
npm --prefix backend run check
npm --prefix backend run build
PGHOST=localhost PGUSER=joel PGPASSWORD= PGPORT=5432 npm test
```

No se ha hecho merge a `main`, deploy de Pages ni deploy de Railway. Claude debe revisar el diff completo antes de publicar.
