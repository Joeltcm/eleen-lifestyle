// R2 simulado en una carpeta: se carga con NODE_OPTIONS=--import. Registra cada operación en ops.log (una línea JSON).
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const dir = process.env.FAKE_R2_DIR;
const registrar = (op, key) => appendFileSync(join(dir, '..', 'ops.log'), JSON.stringify({ op, key }) + '\n');
S3Client.prototype.send = async function (command) {
  const i = command.input; const ruta = join(dir, ...String(i.Key || '').split('/'));
  if (command instanceof GetObjectCommand) {
    registrar('get', i.Key);
    const bytes = await readFile(ruta).catch(() => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; });
    return { Body: { transformToByteArray: async () => new Uint8Array(bytes) }, ContentType: 'video/mp4' };
  }
  if (command instanceof PutObjectCommand) { registrar('put', i.Key); await mkdir(dirname(ruta), { recursive: true }); await writeFile(ruta, i.Body); return {}; }
  if (command instanceof DeleteObjectCommand) { registrar('delete', i.Key); await rm(ruta, { force: true }); return {}; }
  if (command instanceof HeadObjectCommand) { registrar('head', i.Key); const s = await stat(ruta); return { ContentLength: s.size, ContentType: 'video/mp4' }; }
  if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: false };
  throw new Error('operación no simulada: ' + command.constructor.name);
};
