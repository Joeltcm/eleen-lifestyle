import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const leer = ruta => readFile(new URL(`../../${ruta}`, import.meta.url), 'utf8');

test('Mis informes reutiliza los filtros de período del portal', async () => {
  const app = await leer('app.js');
  const html = await leer('index.html');
  assert.match(html, /id="portal-reports-list"/);
  assert.match(app, /function portalPeriodControlsMarkup\(prefix = 'portal-report-period'\)/);
  assert.match(app, /portalPeriodControlsMarkup\(\)\}\$\{portalAttendanceReport\(\)\}/);
  for (const suffix of ['month', 'cutoff', 'previous', 'current', 'next']) {
    assert.match(app, new RegExp(`id="\\$\\{prefix\\}-${suffix}"`));
  }
  assert.match(app, /bindPortalPeriodControls\('portal-report-period'\)/);
  assert.match(app, /portalPeriodMode === 'cutoff' \? 'Volver al mes' : 'Ver corte actual'/);
  assert.match(app, /input type="month" id="\$\{prefix\}-month"[^>]*\$\{cutoff \? ' disabled' : ''\}/);
});

test('los filtros de informes conservan el corte anterior y excluyen el día de inicio', async () => {
  const app = await leer('app.js');
  assert.match(app, /sessionsFromExclusive: cycle\.inicio/);
  assert.match(app, /period\.sessionsFromExclusive \? date > period\.sessionsFromExclusive && date <= period\.to/);
  assert.match(app, /portalCutOffset -= 1|movePortalPeriod\(-1\)/);
});

test('el portal sube todos sus marcadores a la versión 257', async () => {
  const [app, sw, version, html] = await Promise.all(['app.js', 'sw.js', 'version.json', 'index.html'].map(leer));
  assert.equal(/const APP_VERSION = '(\d+)'/.exec(app)[1], '257');
  assert.equal(/const VERSION = '(\d+)'/.exec(sw)[1], '257');
  assert.equal(JSON.parse(version).version, '257');
  const marcas = [...html.matchAll(/\?v=(\d+)/g)].map(match => match[1]);
  assert.equal(marcas.length, 7);
  assert.ok(marcas.every(value => value === '257'));
});
