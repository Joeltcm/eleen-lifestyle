import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
const files = ['index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg', 'icon-512.png', 'apple-touch-icon.png'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(output, file));
await cp(resolve(root, 'assets'), resolve(output, 'assets'), { recursive: true });
console.log(`Eleen Lifestyle frontend built in ${output}`);
