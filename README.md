# Eleen Lifestyle

Primera base de la PWA para la gestión de entrenamiento personal.

## Infraestructura

- Frontend PWA preparado para Cloudflare Pages (`npm run build` genera `dist/`).
- API TypeScript/Fastify desplegada en Railway.
- PostgreSQL privado en Railway con migraciones automáticas.
- API de producción: `https://api-production-b417f.up.railway.app`

## Incluye

- Panel operativo con indicadores de clientes, sesiones, progreso y cobros.
- Expedientes de cliente con histórico de composición corporal.
- Visualización de las métricas del formato InBody 580 compartido.
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

## Próximas integraciones necesarias

1. Autenticación y base de datos segura para cada entrenadora/cliente.
2. Servicio OCR/IA para importar automáticamente los reportes InBody 580 desde PDF o imágenes.
3. Integración OAuth con Google Calendar.
4. Generación de recibos/facturas y almacenamiento de comprobantes.
