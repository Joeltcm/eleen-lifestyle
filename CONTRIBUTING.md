# Colaboración: Eileen Lifestyle

Este repositorio permite que GPT, Claude y personas trabajen en paralelo mediante GitHub. Los agentes no se comunican directamente: el repositorio, los commits y los pull requests son la fuente de verdad.

## Inicio de cada tarea

```sh
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c <agente>/<cambio-breve>
npm ci
npm --prefix backend ci
```

Usa `codex/` para trabajo de Codex/GPT y `claude/` para trabajo de Claude. Nunca desarrolles directamente en `main` salvo una corrección urgente y pequeña ya revisada.

## Antes de editar

1. Revisa los commits y los pull requests abiertos.
2. Declara el alcance en el título o descripción del PR.
3. Evita tocar a la vez los mismos archivos de alto conflicto: `app.js`, `backend/src/server.ts`, migraciones y `sw.js`.
4. Si el cambio necesita uno de esos archivos, integra primero los cambios ya fusionados en `main`.

## Entrega de un cambio

1. Ejecuta `npm run verify`.
2. Para cambios de frontend, actualiza la versión PWA en `app.js`, `sw.js`, `index.html` y `version.json`.
3. Describe en el PR: alcance, archivos modificados, variables nuevas, migraciones y resultado de la verificación.
4. Fusiona mediante PR cuando sea posible. Antes de continuar con una nueva tarea, actualiza nuevamente desde `main`.

## Que un push no rompa nada

Hay cuatro redes de seguridad; todas se pueden ejecutar a mano:

1. **Guardia del frontend** (`npm run guard`, y se ejecuta sola dentro de `npm run build`): revisa sintaxis, que no se llame a funciones sin definir ni se declare dos veces lo mismo entre `app.js`, `zoho-migration.js` y compañía, que las versiones PWA coincidan (`APP_VERSION`, `VERSION` del service worker, `version.json` y los `?v=` de `index.html`) y que los recursos existan. **Si falla, no se construye ni se publica nada** (`npm run build && wrangler ...` se detiene). Solo en una emergencia: `SKIP_UI_GUARD=1 npm run build`.
2. **Pruebas que abren la aplicación de verdad** (`backend/test/ui-smoke.test.mjs`, parte de `npm test`): entran como entrenadora y como cliente, recorren las secciones, abren el editor de una rutina guardada y usan cambiar/mover/agregar/quitar y guardar, abren el diálogo de cancelar, el portal y la página pública del enlace; **cualquier error de JavaScript hace fallar la prueba**. Las pruebas de servidor en verde no bastan: esa fue la lección de la v286.
3. **CI de GitHub** (`.github/workflows/verify.yml`): ejecuta `npm run verify` y `npm test` en cada push y PR. Debe estar en verde: un CI siempre rojo no protege a nadie. Las pruebas del cobro anterior que ya fallaban están marcadas `todo` (siguen ejecutándose y reportándose, pero no ponen el CI en rojo) hasta que se retire ese código.
4. **Vigilancia de producción** (`.github/workflows/produccion.yml`, `node scripts/check-live.mjs`): cada 30 minutos y tras cada push a `main` baja lo publicado y le pasa la misma guardia, y consulta `/health`. Si algo se publica roto, GitHub avisa por correo al dueño del repositorio.

Antes de empujar: `npm run verify && npm test`. Antes de dar un cambio de pantalla por bueno: ábrelo en un navegador (Editar una rutina guardada y el portal de un cliente), no solo las pruebas.

Recomendado (lo configura quien administra el repositorio en GitHub → Settings → Branches): proteger `main` exigiendo el chequeo **verify** en verde. Eso obliga a fusionar mediante pull request (ya no se puede empujar directo a `main`).

## Despliegues

- Un push a `main` despliega la API de Railway.
- Cloudflare Pages publica el frontend desde `dist/`; el despliegue debe ejecutarse después de `npm run build`.
- Confirma que `GET /health` responda correctamente tras cambios de backend.
- No cambies ni muestres valores de Railway, Cloudflare, R2, DeepSeek, Zoho o Google. Solo registra el **nombre** de una variable y quién debe configurarla.

## Relevo entre agentes

Incluye al final del PR o del chat el bloque de [docs/agent-handoff.md](./docs/agent-handoff.md). Indica explícitamente qué quedó listo y qué requiere una acción humana en Railway, Cloudflare, Google Cloud o Zoho.
