# Handoff — aplicación de cobros por línea y acciones según plan

Rama: `fix/facturacion-aplicacion-familiar`

## Problemas corregidos

1. Un cobro familiar automático de `$175` correspondía a una sola mensualidad,
   pero la pantalla lo repartía entre Eduardo y Beatriz como `$87.50 + $87.50`.
2. Las acciones `Aplicar a mensualidades` y `Aplicar a paquete` aparecían para
   clientes a los que no correspondía cada modalidad.

## Comportamiento nuevo

- Las facturas automáticas con `billed_for_client_id` explícito solo se pueden
  aplicar a esa persona y por el importe completo de la línea.
- El formulario muestra quién recibe la línea y avisa que no se reparte entre
  otras personas.
- Los cobros familiares históricos agregados, sin una línea individual nueva,
  conservan el reparto manual entre varias personas.
- `monthly` muestra únicamente `Aplicar a mensualidades`.
- `package` muestra únicamente `Aplicar a paquete`.
- `single` y facturas ya ligadas a un saldo no muestran ninguna de esas dos
  acciones.
- El backend aplica las mismas restricciones aunque alguien intente llamar la
  API directamente.
- Al abrir un paquete, el saldo queda ligado al beneficiario de la línea, no
  necesariamente al pagador.

## Validación

- `npm run verify` ✅
- Suite completa: **197/197** ✅
- Se añadió prueba para impedir que una línea individual de `$175` se divida
  entre dos personas.
- Se añadió prueba para impedir aplicar como paquete una factura mensual.

## Alcance de publicación

No se ha hecho merge ni deploy de esta rama. Claude debe revisar el diff antes
de publicar. Es un cambio de backend y frontend; después de aprobarlo requiere
merge a `main`, deploy de Railway y publicar el frontend en Cloudflare Pages.

