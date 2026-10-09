import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve('src/contract-templates');
const target = resolve('dist/contract-templates');
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
