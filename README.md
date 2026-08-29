# Eileen Lifestyle

PWA privada para la gestión de entrenamiento personal.

## Infraestructura

- Frontend PWA preparado para Cloudflare Pages (`npm run build` genera `dist/`).
- API TypeScript/Fastify desplegada en Railway.
- PostgreSQL privado en Railway con migraciones automáticas.
- API de producción: `https://api-production-b417f.up.railway.app`
- PWA de producción: `https://eileen-lifestyle.pages.dev`

## Incluye

- Panel operativo con indicadores de clientes, sesiones, progreso y cobros.
- Expedientes de cliente con histórico de composición corporal.
- Importación de reportes InBody 580 en JPG, PNG o WebP, con extracción visual mediante DeepSeek Vision, validaciones numéricas y revisión antes de confirmar el historial.
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

Después abre la URL que indique el servidor en un navegador. Para ejecutar la API localmente, configura `backend/.env` a partir de `backend/.env.example` y usa `npm --prefix backend run dev`.

## Trabajo compartido entre agentes

Consulta [CONTRIBUTING.md](./CONTRIBUTING.md) antes de cambiar el proyecto con GPT, Claude u otra persona. Resume el relevo técnico usando la plantilla en [docs/agent-handoff.md](./docs/agent-handoff.md).

## Variables de integraciones en Railway

- `INBODY_ANALYSIS_PROVIDER=deepseek`
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp` es opcional.
- `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` habilitan Google Calendar.
- `GOOGLE_REDIRECT_URI` debe coincidir exactamente con el URI autorizado en Google Cloud; por defecto usa `https://api-production-b417f.up.railway.app/api/integrations/google-calendar/callback`.

Los documentos se guardan primero en R2. La aplicación omite identificadores personales en la respuesta estructurada, comprueba rangos y relaciones matemáticas, y no genera diagnósticos médicos. El consumo de DeepSeek se administra desde la cuenta de DeepSeek; no hay un límite diario impuesto por la app.

### Preparar Google Calendar

1. Habilita Google Calendar API en el proyecto de Google Cloud.
2. Configura la pantalla de consentimiento OAuth. Para validar la conexión inicialmente puedes usar el estado **Testing** y agregar la cuenta de la entrenadora como usuario de prueba; los tokens de Calendar emitidos en ese estado expiran a los 7 días. Antes del uso continuo, cambia el estado de publicación a **In production** para evitar una reconexión semanal.
3. Crea un cliente OAuth de tipo `Web application`.
4. Registra exactamente `https://api-production-b417f.up.railway.app/api/integrations/google-calendar/callback` como URI de redirección autorizado.
5. Guarda el Client ID y Client Secret en Railway como `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
6. En Agenda, pulsa **Conectar calendario** y acepta el permiso para gestionar eventos.

## Próximas integraciones necesarias

1. Generación fiscal mediante un PAC autorizado cuando el negocio lo requiera.
