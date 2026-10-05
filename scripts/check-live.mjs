// Revisa la aplicación PUBLICADA (J-116): baja los archivos que sirve Cloudflare y les pasa la misma guardia que se aplica antes de construir, y comprueba que el API esté sano.
// Detecta una publicación rota minutos después (p. ej. la v286, que dejó sin portal a los clientes). Uso: `node scripts/check-live.mjs [urlDelFrontend] [urlDelApi]`.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { revisarFrontend } from './guard-ui.mjs';

const frontend = (process.argv[2] || 'https://eileen-lifestyle.pages.dev').replace(/\/$/, '');
const api = (process.argv[3] || 'https://api-production-b417f.up.railway.app').replace(/\/$/, '');
const problemas = [];
const descargar = async ruta => {
  const respuesta = await fetch(`${frontend}/${ruta}`, { headers: { 'Cache-Control': 'no-cache' } });
  if (!respuesta.ok) throw new Error(`${ruta} respondió ${respuesta.status}`);
  return Buffer.from(await respuesta.arrayBuffer());
};

const carpeta = await mkdtemp(join(tmpdir(), 'eileen-live-'));
try {
  const html = (await descargar('index.html')).toString('utf8');
  const archivos = new Set(['index.html', 'sw.js', 'version.json']);
  for (const m of html.matchAll(/(?:src|href)="\.\/([^"?#]+)(?:\?[^"#]*)?"/g)) archivos.add(m[1]);
  for (const ruta of archivos) {
    try { const contenido = ruta === 'index.html' ? Buffer.from(html) : await descargar(ruta); await mkdir(dirname(join(carpeta, ruta)), { recursive: true }); await writeFile(join(carpeta, ruta), contenido); }
    catch (error) { problemas.push(`No se pudo descargar ${ruta}: ${error.message}`); }
  }
  if (!problemas.length) problemas.push(...(await revisarFrontend(carpeta)).problemas);
} catch (error) { problemas.push(`El frontend no responde: ${error.message}`); }
finally { await rm(carpeta, { recursive: true, force: true }); }

try {
  const salud = await (await fetch(`${api}/health`)).json();
  if (salud.status !== 'ok') problemas.push(`El API responde pero no está sano: ${JSON.stringify(salud).slice(0, 200)}`);
} catch (error) { problemas.push(`El API no responde: ${error.message}`); }

if (problemas.length) { console.error(`✘ Producción tiene ${problemas.length} problema${problemas.length === 1 ? '' : 's'}:\n${problemas.map(p => `  · ${p}`).join('\n')}`); process.exit(1); }
console.log(`✔ Producción sana: ${frontend} pasa la guardia del frontend y ${api}/health responde ok.`);
