import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Guardia (J-116): una pantalla con identificadores sin definir, scripts duplicados o marcadores de versión desparejados NO se construye, y por lo tanto no se publica. Es lo que habría evitado
// que la v286 dejara sin portal a todos los clientes. SKIP_UI_GUARD=1 la omite (solo emergencias).
if (process.env.SKIP_UI_GUARD === '1') {
  console.warn('⚠ SKIP_UI_GUARD=1: se omite la guardia del frontend. Úsalo solo en una emergencia.');
} else {
  let revisarFrontend;
  try { ({ revisarFrontend } = await import('./guard-ui.mjs')); }
  catch (error) { console.error(`✘ No se pudo cargar la guardia del frontend (${error.message}). Ejecuta "npm install" en la raíz y vuelve a intentarlo.`); process.exit(1); }
  const { problemas, archivos, version } = await revisarFrontend();
  if (problemas.length) {
    console.error(`\n✘ La guardia del frontend encontró ${problemas.length} problema${problemas.length === 1 ? '' : 's'}; no se construye ni se publica nada:\n`);
    for (const problema of problemas) console.error(`  · ${problema}`);
    console.error('');
    process.exit(1);
  }
  console.log(`✔ Guardia del frontend: ${archivos.length} scripts sin identificadores sin definir ni duplicados; versión ${version} coherente.`);
}

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
const files = ['index.html', 'refresh.html', 'version.json', '_headers', 'styles.css', 'zoho-migration.css', 'exercise-catalog.js', 'video-compressor.js', 'app.js', 'zoho-migration.js', 'recurring-billing.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'favicon.ico'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(output, file));
await cp(resolve(root, 'assets'), resolve(output, 'assets'), { recursive: true });
console.log(`Eileen Lifestyle frontend built in ${output}`);
