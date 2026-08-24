# Eileen Lifestyle

Primera base de la PWA para la gestión de entrenamiento personal.

## Infraestructura

- Frontend PWA preparado para Cloudflare Pages (`npm run build` genera `dist/`).
- API TypeScript/Fastify desplegada en Railway.
- PostgreSQL privado en Railway con migraciones automáticas.
- API de producción: `https://api-production-b417f.up.railway.app`
- PWA de producción: `https://eileen-lifestyle.pages.dev`

## Incluye

- Panel operativo con indicadores de clientes, sesiones, progreso y cobros.
- Expedientes de cliente con histórico de composición corporal.
- Importación automática de reportes InBody 580 en JPG, PNG, WebP o PDF.
- Extracción visual con Workers AI, validaciones numéricas y revisión rápida antes de confirmar el historial.
- Agenda semanal preparada para enlazar Google Calendar.
- Agenda operativa con creación y control de asistencia.
- Descuento automático de sesiones al completar una cita de un cliente con paquete.
- Creación de rutinas con ejercicios y asignación de cliente.
- Mensualidades y paquetes de sesiones en USD.
- Registro de cobros con confirmación por efectivo, Yappy, transferencia, tarjeta u otro medio.
- Manifest y service worker para instalación como PWA.

## Ejecutar localmente

Sirve esta carpeta con cualquier servidor web estático. Por ejemplo:

```sh
npx serve .
```

Después abre la URL que indique el servidor en un navegador. La información de esta primera base se conserva localmente en el navegador.

## Variables del análisis InBody en Railway

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`, creado con permisos `Workers AI Read` y `Workers AI Edit`
- `CLOUDFLARE_VISION_MODEL` es opcional; usa `@cf/google/gemma-4-26b-a4b-it` por defecto

Los documentos se guardan primero en R2. La aplicación omite identificadores personales en la respuesta estructurada, comprueba rangos y relaciones matemáticas, y no genera diagnósticos médicos.

## Próximas integraciones necesarias

1. Integración OAuth con Google Calendar.
2. Generación fiscal mediante un PAC autorizado cuando el negocio lo requiera.
