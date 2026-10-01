import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBillingEngine } from '../dist/billing-engine.js';

test('por defecto el generador viejo escribe y el nuevo está apagado', () => {
  const e = resolveBillingEngine();
  assert.equal(e.state, 'legacy');
  assert.equal(e.legacyWrites, true);
  assert.equal(e.newWrites, false);
  assert.equal(e.conflict, false);
});

test('shadow: el viejo escribe y el nuevo solo calcula', () => {
  const e = resolveBillingEngine({ legacy: 'on', next: 'shadow' });
  assert.equal(e.state, 'shadow');
  assert.deepEqual([e.legacyWrites, e.newWrites, e.newComputes], [true, false, true]);
});

test('maintenance: ninguno escribe, con o sin cálculo del nuevo', () => {
  const off = resolveBillingEngine({ legacy: 'off', next: 'off' });
  assert.equal(off.state, 'maintenance');
  assert.deepEqual([off.legacyWrites, off.newWrites, off.newComputes], [false, false, false]);
  const sombra = resolveBillingEngine({ legacy: 'off', next: 'shadow' });
  assert.equal(sombra.state, 'maintenance');
  assert.deepEqual([sombra.legacyWrites, sombra.newWrites, sombra.newComputes], [false, false, true]);
});

test('new: solo escribe el nuevo', () => {
  const e = resolveBillingEngine({ legacy: 'off', next: 'on' });
  assert.equal(e.state, 'new');
  assert.deepEqual([e.legacyWrites, e.newWrites], [false, true]);
});

test('con los dos activos nunca escriben ambos: se apagan y se marca el conflicto', () => {
  const e = resolveBillingEngine({ legacy: 'on', next: 'on' });
  assert.equal(e.conflict, true);
  assert.equal(e.state, 'maintenance');
  assert.deepEqual([e.legacyWrites, e.newWrites], [false, false]);
});

test('ninguna combinación permite que los dos generadores escriban a la vez', () => {
  for (const legacy of ['on', 'off', undefined, 'basura']) {
    for (const next of ['off', 'shadow', 'on', undefined, 'basura']) {
      const e = resolveBillingEngine({ legacy, next });
      assert.equal(e.legacyWrites && e.newWrites, false, `${legacy}/${next}`);
    }
  }
});
