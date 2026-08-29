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

## Despliegues

- Un push a `main` despliega la API de Railway.
- Cloudflare Pages publica el frontend desde `dist/`; el despliegue debe ejecutarse después de `npm run build`.
- Confirma que `GET /health` responda correctamente tras cambios de backend.
- No cambies ni muestres valores de Railway, Cloudflare, R2, DeepSeek, Zoho o Google. Solo registra el **nombre** de una variable y quién debe configurarla.

## Relevo entre agentes

Incluye al final del PR o del chat el bloque de [docs/agent-handoff.md](./docs/agent-handoff.md). Indica explícitamente qué quedó listo y qué requiere una acción humana en Railway, Cloudflare, Google Cloud o Zoho.
