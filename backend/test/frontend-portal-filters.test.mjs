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
  assert.match(app, /PORTAL_MAX_CUT_HISTORY = 12/);
  assert.match(app, /from: cycle\.inicio/);
  assert.match(app, /labelFrom: addDaysIso\(cycle\.inicio, 1\)/);
  assert.match(app, /portalDateInPeriod\(value, period\)/);
  assert.match(app, /Corte anterior/);
  assert.match(app, /fechaHoraPanama\(item\.starts_at, false\)/);
  assert.match(app, /horaPanama\(item\.starts_at\)/);
  assert.match(app, /portalCutOffset > -PORTAL_MAX_CUT_HISTORY/);
});

test('el portal sube todos sus marcadores a la versión 260', async () => {
  const [app, sw, version, html] = await Promise.all(['app.js', 'sw.js', 'version.json', 'index.html'].map(leer));
  assert.equal(/const APP_VERSION = '(\d+)'/.exec(app)[1], '260');
  assert.equal(/const VERSION = '(\d+)'/.exec(sw)[1], '260');
  assert.equal(JSON.parse(version).version, '260');
  const marcas = [...html.matchAll(/\?v=(\d+)/g)].map(match => match[1]);
  assert.equal(marcas.length, 7);
  assert.ok(marcas.every(value => value === '260'));
});
