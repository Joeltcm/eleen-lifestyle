import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
const files = ['index.html', 'refresh.html', 'version.json', '_headers', 'styles.css', 'zoho-migration.css', 'exercise-catalog.js', 'video-compressor.js', 'app.js', 'zoho-migration.js', 'recurring-billing.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'favicon.ico'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(output, file));
await cp(resolve(root, 'assets'), resolve(output, 'assets'), { recursive: true });
console.log(`Eileen Lifestyle frontend built in ${output}`);
