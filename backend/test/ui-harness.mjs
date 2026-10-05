// Abre la aplicación REAL (index.html + sus scripts) en jsdom, conectada al API de pruebas. Sirve para que una prueba pueda hacer lo que hace una persona: iniciar sesión, abrir el editor de una rutina,
// tocar botones y ver el resultado. Un error de JavaScript en cualquier momento queda registrado en `pagina.errores` y las pruebas lo exigen vacío (J-116).
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const raiz = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const ORIGEN = 'http://localhost:8788';
const API_PRODUCCION = 'https://api-production-b417f.up.railway.app';

class CargadorLocal extends ResourceLoader {
  fetch(url) {
    if (url.startsWith(`${ORIGEN}/`)) {
      const archivo = decodeURIComponent(url.slice(ORIGEN.length + 1).split('?')[0].split('#')[0]) || 'index.html';
      return readFile(resolve(raiz, archivo)).catch(() => Buffer.from(''));
    }
    return Promise.resolve(Buffer.from(''));   // fuentes y demás recursos externos: vacíos
  }
}

export const esperar = async (condicion, { ms = 6000, cada = 40, mensaje = 'condición' } = {}) => {
  const limite = Date.now() + ms;
  for (;;) {
    let valor; try { valor = await condicion(); } catch { valor = false; }
    if (valor) return valor;
    if (Date.now() > limite) throw new Error(`Se agotó la espera: ${mensaje}`);
    await new Promise(r => setTimeout(r, cada));
  }
};

export async function abrirPantalla({ baseApi, token = null, hash = '', ancho = 430 }) {
  const errores = [];
  const pendientes = new Set();   // peticiones en vuelo: al cerrar se espera a que terminen para que ningún código de la página siga corriendo con la ventana ya cerrada
  const consola = new VirtualConsole();
  consola.on('jsdomError', e => errores.push(`jsdom: ${e.message}${e.detail?.message ? ` — ${e.detail.message}` : ''}`));
  consola.on('error', (...args) => errores.push(`console.error: ${args.map(String).join(' ').slice(0, 300)}`));
  const html = await readFile(resolve(raiz, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: `${ORIGEN}/${hash}`, runScripts: 'dangerously', resources: new CargadorLocal(), pretendToBeVisual: true, virtualConsole: consola,
    beforeParse(window) {
      Object.defineProperty(window, 'innerWidth', { value: ancho, configurable: true });
      window.fetch = (entrada, opciones) => {
        const promesa = fetch(String(entrada).replace(API_PRODUCCION, baseApi), opciones);
        pendientes.add(promesa); promesa.finally(() => pendientes.delete(promesa)).catch(() => {});
        return promesa;
      };
      if (token) window.localStorage.setItem('eileen-lifestyle-session', token);
      // Lo que jsdom no trae y la aplicación usa:
      window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
      window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      window.scrollTo = () => {}; window.Element.prototype.scrollIntoView = function () {};
      window.confirm = () => true; window.alert = () => {}; window.prompt = () => null;
      window.navigator.clipboard = { writeText: async () => {} };
      window.addEventListener('error', e => errores.push(`error: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
      window.addEventListener('unhandledrejection', e => errores.push(`promesa rechazada: ${e.reason?.message || e.reason}`));
    }
  });
  const { window } = dom; const { document } = window;
  // Atajos para actuar como una persona.
  const q = (selector, raizNodo = document) => raizNodo.querySelector(selector);
  const qa = (selector, raizNodo = document) => [...raizNodo.querySelectorAll(selector)];
  const clic = nodo => { if (!nodo) throw new Error('No existe el elemento al que se quiere dar clic'); nodo.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const cambiar = (nodo, valor) => { nodo.value = valor; nodo.dispatchEvent(new window.Event('input', { bubbles: true })); nodo.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const evaluar = codigo => window.eval(codigo);
  const quieta = (ms = 150) => new Promise(r => setTimeout(r, ms));
  const cerrar = async () => {
    for (let vuelta = 0; vuelta < 30; vuelta += 1) { await Promise.allSettled([...pendientes]); await quieta(60); if (!pendientes.size) break; }
    window.close();
  };
  return { dom, window, document, errores, q, qa, clic, cambiar, evaluar, quieta, cerrar };
}
