// El harness no debe elegir nunca un puerto que `fetch` rechaza ("bad port"): el servidor arrancaría bien y la prueba esperaría 30 s en vano.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PUERTOS_PROHIBIDOS_POR_FETCH, puertoAleatorio } from './harness.mjs';

test('puertoAleatorio nunca devuelve un puerto prohibido, aunque el azar proponga uno', () => {
  const original = Math.random;
  try {
    // El azar recorre en orden los 4000 resultados posibles (cada llamada devuelve el siguiente), incluidos los prohibidos: la función debe saltárselos.
    let llamada = 0;
    Math.random = () => (llamada++ % 4000) / 4000;
    const vistos = new Set();
    for (let i = 0; i < 4000; i += 1) {
      const puerto = puertoAleatorio();
      assert.ok(puerto >= 4000 && puerto < 8000, `fuera de rango: ${puerto}`);
      assert.equal(PUERTOS_PROHIBIDOS_POR_FETCH.has(puerto), false, `puerto prohibido: ${puerto}`);
      vistos.add(puerto);
    }
    for (const prohibido of [4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]) assert.equal(vistos.has(prohibido), false);
    assert.ok(llamada > 4000, 'hubo reintentos al caer en puertos prohibidos');
    assert.ok(vistos.size > 3900, 'sigue habiendo variedad de puertos');
  } finally { Math.random = original; }
});

test('la lista corresponde al comportamiento real de fetch: 5060 se rechaza aunque haya servidor, un puerto normal no', async () => {
  const servidor = http.createServer((_q, r) => r.end('ok'));
  await new Promise((ok, fallo) => servidor.once('error', fallo).listen(0, '127.0.0.1', ok));
  const normal = servidor.address().port;
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${normal}/`)).text(), 'ok');
    await assert.rejects(fetch('http://127.0.0.1:5060/'), error => /bad port/i.test(error.cause?.message || error.message));
    assert.ok(PUERTOS_PROHIBIDOS_POR_FETCH.has(5060));
  } finally { servidor.closeAllConnections?.(); await new Promise(ok => servidor.close(ok)); }
});
