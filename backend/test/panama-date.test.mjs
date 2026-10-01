import test from 'node:test';
import assert from 'node:assert/strict';
import { fechaDeNegocioPanama, fechaPanamaDiasAtras } from '../dist/panama-date.js';

test('la fecha de negocio conserva el día de Panamá a las 20:00 y 23:59', () => {
  assert.equal(fechaDeNegocioPanama(new Date('2026-09-30T20:00:00-05:00')), '2026-09-30');
  assert.equal(fechaDeNegocioPanama(new Date('2026-09-30T21:00:00-05:00')), '2026-09-30');
  assert.equal(fechaDeNegocioPanama(new Date('2026-09-30T23:59:00-05:00')), '2026-09-30');
  assert.equal(fechaDeNegocioPanama(new Date('2026-10-01T00:01:00-05:00')), '2026-10-01');
});

test('el rango histórico resta días calendario de Panamá', () => {
  assert.equal(fechaPanamaDiasAtras(180, new Date('2026-09-30T23:59:00-05:00')), '2026-04-03');
});
