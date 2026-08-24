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
- Google Calendar conectado mediante OAuth, con sincronización automática y manual de sesiones.
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

## Variables de integraciones en Railway

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`, creado con permisos `Workers AI Read` y `Workers AI Edit`
- `CLOUDFLARE_VISION_MODEL` es opcional; usa `@cf/google/gemma-4-26b-a4b-it` por defecto
- `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` habilitan Google Calendar.
- `GOOGLE_REDIRECT_URI` debe coincidir exactamente con el URI autorizado en Google Cloud; por defecto usa `https://api-production-b417f.up.railway.app/api/integrations/google-calendar/callback`.
- `INBODY_AI_DAILY_LIMIT` limita el consumo diario de toda la aplicación; el valor recomendado y predeterminado es `4`

Los documentos se guardan primero en R2. Antes de llamar a Workers AI, la API reserva atómicamente la cuota diaria en PostgreSQL; una imagen consume una unidad y un PDF reserva dos. Las páginas sin métricas comparables se conservan sin enviarse a IA. La aplicación omite identificadores personales en la respuesta estructurada, comprueba rangos y relaciones matemáticas, y no genera diagnósticos médicos.

### Preparar Google Calendar

1. Habilita Google Calendar API en el proyecto de Google Cloud.
2. Configura la pantalla de consentimiento OAuth. Para validar la conexión inicialmente puedes usar el estado **Testing** y agregar la cuenta de la entrenadora como usuario de prueba; los tokens de Calendar emitidos en ese estado expiran a los 7 días. Antes del uso continuo, cambia el estado de publicación a **In production** para evitar una reconexión semanal.
3. Crea un cliente OAuth de tipo `Web application`.
4. Registra exactamente `https://api-production-b417f.up.railway.app/api/integrations/google-calendar/callback` como URI de redirección autorizado.
5. Guarda el Client ID y Client Secret en Railway como `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
6. En Agenda, pulsa **Conectar calendario** y acepta el permiso para gestionar eventos.

## Próximas integraciones necesarias

1. Generación fiscal mediante un PAC autorizado cuando el negocio lo requiera.
