import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from './db.js';

const directory = resolve(process.cwd(), 'migrations');
const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
for (const file of files) {
  const existing = await sql`SELECT name FROM schema_migrations WHERE name = ${file}`;
  if (existing.length) continue;
  const migration = await readFile(resolve(directory, file), 'utf8');
  await sql.begin(async transaction => {
    await transaction.unsafe(migration);
    await transaction`INSERT INTO schema_migrations (name) VALUES (${file})`;
  });
  console.log(`Applied ${file}`);
}

await sql.end();

