import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('el expediente llama Plan de facturación a la sección declarativa', async () => {
  const source = await readFile(new URL('../../app.js', import.meta.url), 'utf8');
  assert.match(source, /Plan de facturación/i);
  assert.doesNotMatch(source, /COBRO DECLARATIVO/);
});
