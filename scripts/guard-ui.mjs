// Guardia del frontend (J-116). Corre antes de cada `npm run build`, de modo que NO se puede publicar una pantalla rota:
//   1. Sintaxis de todos los scripts.
//   2. Ningún identificador sin definir ni declarado dos veces (los scripts de la aplicación comparten el ámbito global del navegador, así que se revisan JUNTOS, en el orden de index.html).
//      Es exactamente lo que tumbó el portal de los clientes en la v286: se llamaba a `portalRoutineCard` sin que existiera.
//   3. Los marcadores de versión PWA coinciden (APP_VERSION, VERSION del service worker, version.json y los ?v= de index.html).
//   4. Todo recurso local que index.html carga existe.
// Para una emergencia: SKIP_UI_GUARD=1 npm run build (queda escrito en la salida).
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import globals from 'globals';

const raizDelRepo = resolve(fileURLToPath(import.meta.url), '..', '..');

// Lo que un script publica con `window.X = …` (p. ej. VideoCompressor, EXERCISE_CATALOG) existe para los demás.
const globalesPorWindow = fuente => Object.fromEntries([...fuente.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map(m => [m[1], 'writable']));

export async function revisarFrontend(raiz = raizDelRepo) {
  const leer = nombre => readFile(resolve(raiz, nombre), 'utf8');
  const problemas = [];
  const html = await leer('index.html');

  // Scripts locales en el orden en que el navegador los ejecuta.
  const scripts = [...html.matchAll(/<script[^>]+src="\.\/([^"?]+)(?:\?[^"]*)?"/g)].map(m => m[1]);
  const archivos = [...new Set(scripts)];

  // 4. Recursos locales
  const recursos = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)(?:\?[^"#]*)?"/g)].map(m => m[1]);
  for (const recurso of new Set(recursos)) {
    try { await access(resolve(raiz, recurso)); } catch { problemas.push(`index.html carga "${recurso}", que no existe`); }
  }

  // 3. Marcadores de versión
  const versiones = new Map();
  const app = await leer('app.js'); const sw = await leer('sw.js');
  versiones.set('app.js APP_VERSION', (app.match(/APP_VERSION\s*=\s*'(\d+)'/) || [])[1]);
  versiones.set('sw.js VERSION', (sw.match(/VERSION\s*=\s*'(\d+)'/) || [])[1]);
  versiones.set('version.json', String(JSON.parse(await leer('version.json')).version));
  for (const m of html.matchAll(/\?v=(\d+)/g)) versiones.set(`index.html ?v=${m[1]}`, m[1]);
  const distintas = new Set([...versiones.values()]);
  if (distintas.size !== 1) problemas.push(`Los marcadores de versión no coinciden: ${[...versiones.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // 1 y 2. Sintaxis + identificadores, con los scripts concatenados como los ve el navegador.
  const linter = new Linter({ configType: 'flat' });
  const tramos = []; let fuente = ''; let linea = 1;
  for (const archivo of archivos) {
    const texto = await leer(archivo);
    const lineas = texto.split('\n').length;
    tramos.push({ archivo, desde: linea, hasta: linea + lineas - 1 });
    fuente += `${texto}\n`; linea += lineas;
  }
  const donde = n => { const t = tramos.find(x => n >= x.desde && n <= x.hasta); return t ? `${t.archivo}:${n - t.desde + 1}` : `línea ${n}`; };
  const mensajes = linter.verify(fuente, [{
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, webkitAudioContext: 'readonly', ...globalesPorWindow(fuente) } },
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      'no-undef': 'error',
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-const-assign': 'error', 'no-dupe-else-if': 'error', 'no-unsafe-negation': 'error'
    }
  }], { filename: 'frontend-combinado.js' });
  for (const m of mensajes) problemas.push(`${donde(m.line)}  ${m.message}${m.ruleId ? `  (${m.ruleId})` : ''}`);

  // El service worker tiene su propio ámbito.
  const mensajesSw = linter.verify(sw, [{
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-redeclare': 'error' }
  }], { filename: 'sw.js' });
  for (const m of mensajesSw) problemas.push(`sw.js:${m.line}  ${m.message}`);

  return { problemas, archivos, version: [...distintas][0] };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('guard-ui.mjs')) {
  if (process.env.SKIP_UI_GUARD === '1') { console.warn('⚠ SKIP_UI_GUARD=1: se omite la guardia del frontend. Úsalo solo en una emergencia.'); process.exit(0); }
  const { problemas, archivos, version } = await revisarFrontend();
  if (problemas.length) {
    console.error(`\n✘ La guardia del frontend encontró ${problemas.length} problema${problemas.length === 1 ? '' : 's'}; no se construye ni se publica nada:\n`);
    for (const p of problemas) console.error(`  · ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log(`✔ Guardia del frontend: ${archivos.length} scripts sin identificadores sin definir ni duplicados; versión ${version} coherente en todos los marcadores.`);
}
