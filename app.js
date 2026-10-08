const APP_VERSION = '298';
const markPwaVersion = () => document.querySelectorAll('.topbar-actions').forEach(actions => {
  if (actions.querySelector('[data-pwa-version]')) return;
  const indicator = document.createElement('span');
  indicator.className = 'pwa-version';
  indicator.dataset.pwaVersion = '';
  indicator.setAttribute('aria-label', 'Versión de la aplicación');
  indicator.textContent = `PWA v${APP_VERSION}`;
  indicator.title = `Versión de la PWA: ${APP_VERSION}`;
  actions.prepend(indicator);
});
function exerciseIdentitiesForVersion(exercises = []) {
  return exercises.map(exercise => {
    const catalogId = String(exercise?.catalogId ?? '').trim();
    if (catalogId) return `catalog:${catalogId}`;
    return `name:${String(exercise?.name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`;
  });
}
function exerciseSetKeyForVersion(exercises = []) { return [...exerciseIdentitiesForVersion(exercises)].sort(); }
function sameExerciseSetForVersion(left = [], right = []) {
  const a = exerciseSetKeyForVersion(left); const b = exerciseSetKeyForVersion(right);
  return a.length === b.length && a.every((identity, index) => identity === b[index]);
}
window.exerciseIdentitiesForVersion = exerciseIdentitiesForVersion;
window.exerciseSetKeyForVersion = exerciseSetKeyForVersion;
window.sameExerciseSetForVersion = sameExerciseSetForVersion;
markPwaVersion();
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const today = new Date();
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const panamaDateTimeIso = (date, time) => new Date(`${date}T${time}:00-05:00`).toISOString();
const panamaDateTimeParts = value => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
const API_BASE = 'https://api-production-b417f.up.railway.app';
const authKey = 'eileen-lifestyle-session';
const legacyAuthKey = 'eleen-lifestyle-session';
// El catálogo vive en la base de datos y se carga con el resto de los datos.
// exercise-catalog.js queda como respaldo para que el constructor de rutinas
// siga sirviendo de algo si la API no responde.
let exerciseCatalog = [];
const legacySectionBySlug = { 'Tren inferior': 'tren_inferior', 'Empuje': 'tren_superior', 'Tirón': 'tren_superior', 'Core': 'core', 'Acondicionamiento': 'hit' };
const fallbackCatalog = (window.EXERCISE_CATALOG || []).map(exercise => ({
  ...exercise, section: legacySectionBySlug[exercise.category] || 'hit', pattern: exercise.category, hasVideo: false
}));
// "Total body" no es una sección del catálogo: es la ausencia de filtro, y por
// eso muestra todos los ejercicios.
const exerciseSectionLabels = { total_body: 'Total body', tren_superior: 'Tren superior', tren_inferior: 'Tren inferior', core: 'Core', cardio: 'Cardio', hit: 'HIT' };
const exerciseSectionOrder = ['total_body', 'tren_superior', 'tren_inferior', 'core', 'cardio', 'hit'];
let authToken = localStorage.getItem(authKey) || localStorage.getItem(legacyAuthKey);
if (authToken && !localStorage.getItem(authKey)) {
  localStorage.setItem(authKey, authToken);
  localStorage.removeItem(legacyAuthKey);
}
let currentUser = null;
let data = { travel: [], clients: [], invoices: [], packages: [], sessions: [], routines: [], plans: [], compliance: { compliancePercent: 0, activities: 0, clients: [] }, notifications: [], googleCalendar: { configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } } };
let portalData = null;
let portalPeriodMode = 'month';
let portalPeriodMonth = dateKey(today).slice(0, 7);
let portalCutOffset = 0;
const portalRoutineTimers = new Map();
const portalRoutineCountdowns = new Map();
const portalRoutineTimerStorage = routineId => `eileen-routine-timer:${routineId}:${dateKey(today)}`;
const formatRoutineElapsed = seconds => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
function routineTimerState(routineId, elapsedSeconds = 0) {
  if (portalRoutineTimers.has(routineId)) return portalRoutineTimers.get(routineId);
  try {
    const saved = JSON.parse(localStorage.getItem(portalRoutineTimerStorage(routineId)) || 'null');
    if (saved && (saved.startedAt === null || Number.isFinite(Number(saved.startedAt)))) {
      const state = { startedAt: saved.startedAt === null ? null : Number(saved.startedAt), elapsedBefore: Number(saved.elapsedBefore || elapsedSeconds), paused: Boolean(saved.paused) };
      portalRoutineTimers.set(routineId, state);
      if (!state.paused && state.startedAt) state.interval = window.setInterval(() => paintRoutineTimer(routineId, elapsedSeconds), 1000);
      paintRoutineTimer(routineId, elapsedSeconds);
      return state;
    }
  } catch {}
  return null;
}
function routineElapsed(routineId, elapsedSeconds = 0) {
  const state = routineTimerState(routineId, elapsedSeconds);
  return state ? state.elapsedBefore + (state.paused || !state.startedAt ? 0 : Math.floor((Date.now() - state.startedAt) / 1000)) : Number(elapsedSeconds || 0);
}
function paintRoutineTimer(routineId, elapsedSeconds = 0) {
  const clock = document.querySelector(`[data-portal-routine-card="${routineId}"] .routine-timer-clock`);
  if (clock) clock.textContent = formatRoutineElapsed(routineElapsed(routineId, elapsedSeconds));
}
function startRoutineTimer(routineId, elapsedSeconds = 0) {
  const existing = routineTimerState(routineId, elapsedSeconds);
  if (existing && !existing.paused) return;
  if (existing?.paused) return resumeRoutineTimer(routineId, elapsedSeconds);
  const state = { startedAt: Date.now(), elapsedBefore: Number(elapsedSeconds || 0) };
  portalRoutineTimers.set(routineId, state);
  localStorage.setItem(portalRoutineTimerStorage(routineId), JSON.stringify(state));
  state.interval = window.setInterval(() => paintRoutineTimer(routineId, elapsedSeconds), 1000);
  paintRoutineTimer(routineId, elapsedSeconds);
  void api('/api/portal/routine-activity', { method: 'POST', body: { routineId, completedOn: dateKey(today), kind: 'started' } }).catch(() => {});
}
function persistRoutineTimer(routineId, state) {
  localStorage.setItem(portalRoutineTimerStorage(routineId), JSON.stringify({ startedAt: state.startedAt, elapsedBefore: state.elapsedBefore, paused: Boolean(state.paused) }));
}
function pauseRoutineTimer(routineId, elapsedSeconds = 0) {
  const state = routineTimerState(routineId, elapsedSeconds); if (!state || state.paused) return routineElapsed(routineId, elapsedSeconds);
  const elapsed = routineElapsed(routineId, elapsedSeconds);
  if (state.interval) window.clearInterval(state.interval);
  state.startedAt = null; state.elapsedBefore = elapsed; state.paused = true; delete state.interval; persistRoutineTimer(routineId, state);
  void api('/api/portal/routine-activity', { method: 'POST', body: { routineId, completedOn: dateKey(today), kind: 'paused', elapsedSeconds: elapsed } }).catch(() => {});
  paintRoutineTimer(routineId, elapsedSeconds); return elapsed;
}
function resumeRoutineTimer(routineId, elapsedSeconds = 0) {
  const state = routineTimerState(routineId, elapsedSeconds); if (!state) return startRoutineTimer(routineId, elapsedSeconds);
  if (!state.paused) return;
  state.startedAt = Date.now(); state.paused = false; persistRoutineTimer(routineId, state);
  state.interval = window.setInterval(() => paintRoutineTimer(routineId, elapsedSeconds), 1000); paintRoutineTimer(routineId, elapsedSeconds);
  void api('/api/portal/routine-activity', { method: 'POST', body: { routineId, completedOn: dateKey(today), kind: 'resumed', elapsedSeconds: state.elapsedBefore } }).catch(() => {});
}
function stopRoutineTimer(routineId, elapsedSeconds = 0) {
  const state = routineTimerState(routineId, elapsedSeconds);
  const elapsed = routineElapsed(routineId, elapsedSeconds);
  if (state?.interval) window.clearInterval(state.interval);
  portalRoutineTimers.delete(routineId);
  localStorage.removeItem(portalRoutineTimerStorage(routineId));
  return elapsed;
}
// Cuenta regresiva 3-2-1 antes de arrancar el cronómetro de la tarjeta; devuelve false si ya había una en marcha.
async function runRoutineCountdown(card, routineId, elapsedSeconds = 0) {
  if (portalRoutineCountdowns.has(routineId)) return false;
  portalRoutineCountdowns.set(routineId, true);
  const cuenta = card.querySelector('.routine-countdown');
  const cuentaNumero = card.querySelector('.routine-countdown strong');
  if (cuenta) cuenta.hidden = false;
  try {
    for (let n = 3; n >= 1; n -= 1) {
      if (cuentaNumero) cuentaNumero.textContent = String(n);
      await new Promise(resolver => setTimeout(resolver, 1000));
    }
    if (cuentaNumero) {
      cuentaNumero.textContent = '¡Vamos!';
      await new Promise(resolver => setTimeout(resolver, 350));
    }
    startRoutineTimer(routineId, elapsedSeconds);
    return true;
  } finally {
    portalRoutineCountdowns.delete(routineId);
    if (cuenta) cuenta.hidden = true;
    paintRoutineTimer(routineId, elapsedSeconds);
  }
}
// Aviso al terminar todos los ejercicios de la rutina.
function showRoutineCelebration(titulo, completados, total, segundos) {
  document.querySelector('.routine-celebration')?.remove();
  const overlay = document.createElement('div'); overlay.className = 'routine-celebration';
  overlay.innerHTML = '<div class="routine-celebration-card" role="dialog" aria-live="polite"><div class="routine-celebration-emoji">🎉 💪 ✨</div><h2>¡Excelente trabajo!</h2><p></p><strong></strong><button type="button" class="primary">Continuar</button></div>';
  const card = overlay.querySelector('.routine-celebration-card');
  card.querySelector('p').textContent = titulo;
  card.querySelector('strong').textContent = `${completados} de ${total} ejercicios · ${formatRoutineElapsed(segundos)}`;
  const cerrar = () => overlay.remove();
  overlay.querySelector('button').addEventListener('click', cerrar);
  overlay.addEventListener('click', event => { if (event.target === overlay) cerrar(); });
  document.body.append(overlay);
  window.setTimeout(cerrar, 9000);
}
let compliancePeriod = 'week';
let billingMonth = String(today.getMonth() + 1);
let billingYear = String(today.getFullYear());
let billingSource = 'all';
let billingClientFilter = '';
let billingReturnState = null;
let billingVisibleInvoices = 100;
let billingAnalytics = null;
let billingAnalyticsLoadingYear = null;
let billingAnalyticsRequest = 0;
let attendanceMonth = dateKey(today).slice(0, 7);
let attendanceFrom = '';
let attendanceTo = '';
let attendanceClientFilter = '';
let attendanceReport = null;
let attendanceReportLoading = false;
let attendanceReportRequest = 0;
let attendanceStatusFilters = { active: true, paused: true, inactive: false };
let attendanceCurrentCutOnly = false;
let attendanceCutOffset = 0;
let calendarMode = 'week';
let calendarCursor = new Date(today);
calendarCursor.setHours(12, 0, 0, 0);
let calendarSyncTimer = null;
let calendarSyncRunning = false;
const save = () => {};
const toast = (message, error = false) => {
  const element = document.createElement('div'); element.className = `toast${error ? ' error' : ''}`; element.textContent = message;
  document.body.append(element); setTimeout(() => element.remove(), 3200);
};
// Aviso sonoro dentro de la app (J-102): un acorde corto de tres notas. Los navegadores solo dejan sonar audio después de un toque del usuario, por eso el contexto se
// desbloquea con la primera interacción. Fuera de la app (pantalla bloqueada o app cerrada) suena el tono propio de la notificación push del teléfono.
let audioAviso = null;
const desbloquearAudio = () => {
  try {
    audioAviso = audioAviso || new (window.AudioContext || window.webkitAudioContext)();
    if (audioAviso.state === 'suspended') audioAviso.resume();
  } catch { /* sin audio disponible */ }
};
['pointerdown', 'touchstart', 'keydown'].forEach(evento => window.addEventListener(evento, desbloquearAudio, { passive: true }));
function sonarAviso() {
  desbloquearAudio();
  if (!audioAviso || audioAviso.state !== 'running') return false;
  const t0 = audioAviso.currentTime;
  [[880, 0], [1174.66, 0.2], [1567.98, 0.4]].forEach(([frecuencia, retraso]) => {
    const oscilador = audioAviso.createOscillator(); const volumen = audioAviso.createGain();
    oscilador.type = 'sine'; oscilador.frequency.value = frecuencia;
    volumen.gain.setValueAtTime(0.0001, t0 + retraso);
    volumen.gain.exponentialRampToValueAtTime(0.4, t0 + retraso + 0.03);
    volumen.gain.exponentialRampToValueAtTime(0.0001, t0 + retraso + 0.5);
    oscilador.connect(volumen); volumen.connect(audioAviso.destination);
    oscilador.start(t0 + retraso); oscilador.stop(t0 + retraso + 0.55);
  });
  return true;
}
// Rutinas cumplidas por los clientes mientras la app está abierta: cada una se avisa una sola vez (toast + sonido). La primera lectura solo memoriza lo que ya había.
const rutinasAvisadasClave = 'eileen-rutinas-avisadas';
let rutinasAvisadasIniciado = false;
async function vigilarRutinasCumplidas() {
  if (!authToken || currentUser?.role === 'client' || document.hidden) return;
  try {
    const avisos = (await api('/api/notifications')).filter(item => item.type === 'routine');
    const clave = item => `${item.title}|${item.scheduledFor}`;
    let vistos = []; try { vistos = JSON.parse(localStorage.getItem(rutinasAvisadasClave) || '[]'); } catch { vistos = []; }
    const nuevos = avisos.filter(item => !vistos.includes(clave(item)));
    if (nuevos.length && rutinasAvisadasIniciado) {
      sonarAviso();
      nuevos.forEach(item => toast(`${item.title} · ${item.body}`));
      loadData().then(renderAll).catch(() => {});
    }
    rutinasAvisadasIniciado = true;
    localStorage.setItem(rutinasAvisadasClave, JSON.stringify(avisos.map(clave).slice(0, 60)));
  } catch { /* se reintenta en el siguiente ciclo */ }
}
setInterval(vigilarRutinasCumplidas, 45_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) vigilarRutinasCumplidas(); });
async function showPendingBrowserNotification(notifications) {
  if (!notifications.length || !('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  try {
    const preferences = await api('/api/notification-preferences'); if (!preferences.browser_enabled) return;
    const reminder = notifications[0]; const reminderKey = `${reminder.type}:${reminder.title}:${reminder.scheduledFor}`;
    if (localStorage.getItem('eileen-last-reminder') === reminderKey) return;
    const registration = await navigator.serviceWorker.ready; await registration.showNotification(reminder.title, { body: reminder.body, icon: './icon-192.png', badge: './favicon-32.png', data: { url: window.location.href } });
    localStorage.setItem('eileen-last-reminder', reminderKey);
  } catch {}
}
const urlBase64ToUint8Array = value => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
};
async function ensurePushSubscription() {
  if (!('serviceWorker' in navigator)) throw new Error('Este navegador no admite notificaciones en segundo plano');
  const registration = await navigator.serviceWorker.ready;
  if (!registration.pushManager) throw new Error('En iPhone, instala la PWA en la pantalla de inicio para activar notificaciones');
  const pushConfig = await api('/api/push/config');
  if (!pushConfig.configured || !pushConfig.publicKey) throw new Error('Las notificaciones push todavía no están disponibles');
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushConfig.publicKey)
    });
  }
  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys?.auth) throw new Error('No se pudo registrar este dispositivo');
  await api('/api/push/subscriptions', { method: 'POST', body: { endpoint: serialized.endpoint, keys: serialized.keys } });
  return registration;
}
// Peticiones que cambian datos y están en vuelo, por si llega otra idéntica.
//
// Tocar dos veces un botón creaba dos cosas. Se puede tapar deshabilitando cada
// botón, pero eso hay que acordarse de hacerlo en cada sitio y basta olvidarlo
// una vez. Aquí se ataja en el único punto por el que pasan todas: si ya hay
// una petición idéntica esperando respuesta, se devuelve esa misma en vez de
// mandar otra. El segundo toque recibe el resultado del primero.
//
// Sólo mientras dura la petición: guardar dos gastos iguales a propósito, uno
// después de otro, sigue funcionando.
// Confirmar antes de guardar, sólo donde el error cuesta caro: dinero y
// expedientes. El aviso resume lo que va a quedar registrado, porque un
// "¿Seguro?" sin contenido no evita ningún error: se acepta sin leerlo.
//
// PENDIENTE: extenderlo al resto de formularios. Joel lo pidió para todo y de
// momento está sólo en cobros y expedientes.
function confirmarGuardado(resumen) {
  return window.confirm(`${resumen}\n\n¿Lo guardo así?`);
}

const peticionesEnVuelo = new Map();

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isPassThroughBody = options.body instanceof FormData || (typeof Blob !== 'undefined' && options.body instanceof Blob);
  if (authToken && options.auth !== false) headers.Authorization = `Bearer ${authToken}`;
  if (options.body !== undefined && !isPassThroughBody) headers['Content-Type'] = 'application/json';

  const metodo = options.method || 'GET';
  // Las subidas de archivo quedan fuera: su cuerpo no se puede comparar y cada
  // una es distinta de todas formas.
  const clave = metodo !== 'GET' && !isPassThroughBody
    ? `${metodo} ${path} ${JSON.stringify(options.body ?? null)}`
    : null;
  if (clave && peticionesEnVuelo.has(clave)) return peticionesEnVuelo.get(clave);

  const enCurso = (async () => {
    const response = await fetch(`${API_BASE}${path}`, { method: metodo, headers, body: options.body === undefined || isPassThroughBody ? options.body : JSON.stringify(options.body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && options.auth !== false) { localStorage.removeItem(authKey); authToken = null; }
      const error = new Error(payload.error || payload.message || 'No fue posible completar la solicitud');
      error.status = response.status;
      error.code = payload.code;
      error.repeats = payload.repeats;
      error.clientCount = payload.clientCount;
      throw error;
    }
    return payload;
  })();

  if (clave) {
    peticionesEnVuelo.set(clave, enCurso);
    enCurso.catch(() => {}).finally(() => peticionesEnVuelo.delete(clave));
  }
  return enCurso;
}

const repeatKindLabel = { assignment: 'asignación', link: 'enlace', offer: 'rutina ofrecida en lugar de una clase', travel_link: 'enlace de viaje', new_version: 'nueva versión' };
function detalleEnvioRepetido(error) {
  const repeats = Array.isArray(error?.repeats) ? error.repeats : [];
  return repeats.slice(0, 3).map(item => {
    const fecha = item.sentAt ? fechaHoraPanama(item.sentAt) : 'recientemente';
    const tipo = item.sameRoutine ? 'la misma rutina' : 'otra rutina con los mismos ejercicios';
    const dias = Number(item.daysAgo) === 0 ? 'hoy' : `hace ${item.daysAgo} día${item.daysAgo === 1 ? '' : 's'}`;
    return `<li><b>${tipo}</b><small>${fecha} · ${escapeHtml(repeatKindLabel[item.kind] || 'envío')} · ${dias}</small></li>`;
  }).join('') + (repeats.length > 3 ? `<li><small>y ${repeats.length - 3} envío${repeats.length - 3 === 1 ? '' : 's'} más</small></li>` : '');
}
function confirmarEnvioRepetido(error) {
  return new Promise(resolve => {
    // Tiene que ser un <dialog> abierto con showModal(): el aviso sale mientras el editor de la rutina (otro <dialog> modal) está abierto, y un <div> añadido al body queda DETRÁS
    // de ese diálogo en la capa superior del navegador (los clics los recibe el editor, no el aviso, aunque el z-index sea enorme). Un segundo showModal() se apila encima.
    const dialogo = document.createElement('dialog');
    dialogo.className = 'routine-repeat-host';
    dialogo.setAttribute('aria-labelledby', 'routine-repeat-title');
    dialogo.innerHTML = `<div class="routine-repeat-dialog">
      <p class="eyebrow">REVISAR ENVÍO</p><h2 id="routine-repeat-title">Rutina enviada recientemente</h2>
      <p>Esta clienta recibió recientemente una rutina igual o con los mismos ejercicios.</p>
      <ul class="routine-repeat-list">${detalleEnvioRepetido(error)}</ul>
      <p class="section-note">Puedes cancelar para revisar la rutina o enviarla de todos modos.</p>
      <div class="routine-repeat-actions"><button type="button" class="secondary" data-repeat-cancel autofocus>Cancelar</button><button type="button" class="primary" data-repeat-confirm>Enviar de todos modos</button></div>
    </div>`;
    document.body.append(dialogo);
    let respuesta = false;
    // Escape, el botón y cualquier otra forma de cerrar terminan en 'close': sin confirmar explícitamente la respuesta es siempre "no".
    dialogo.addEventListener('close', () => { dialogo.remove(); resolve(respuesta); });
    dialogo.querySelector('[data-repeat-cancel]').onclick = () => dialogo.close();
    dialogo.querySelector('[data-repeat-confirm]').onclick = () => { respuesta = true; dialogo.close(); };
    dialogo.showModal();
    dialogo.querySelector('[data-repeat-cancel]').focus();
  });
}
function confirmarNuevaVersion(clientCount = 0) {
  return new Promise(resolve => {
    const dialogo = document.createElement('dialog'); dialogo.className = 'routine-version-host';
    dialogo.innerHTML = `<div class="routine-repeat-dialog"><p class="eyebrow">NUEVA VERSIÓN</p><h2>La rutina ya está en uso</h2><p>Esta rutina ya se envió a <b>${Math.max(1, Number(clientCount) || 0)} cliente${Number(clientCount) === 1 ? '' : 's'}</b>. Al guardar se creará una versión nueva que recibirán automáticamente; la anterior queda en el historial.</p><p class="section-note">Los cambios de ejercicios se aplicarán a la nueva versión. La fecha límite y el avance ya registrado se conservan.</p><div class="routine-repeat-actions"><button type="button" class="secondary" data-version-cancel autofocus>Cancelar</button><button type="button" class="primary" data-version-confirm>Crear versión y guardar</button></div></div>`;
    document.body.append(dialogo); let confirmada = false;
    dialogo.addEventListener('close', () => { dialogo.remove(); resolve(confirmada); });
    dialogo.querySelector('[data-version-cancel]').onclick = () => dialogo.close();
    dialogo.querySelector('[data-version-confirm]').onclick = () => { confirmada = true; dialogo.close(); };
    dialogo.addEventListener('cancel', event => { event.preventDefault(); dialogo.close(); });
    dialogo.showModal(); dialogo.querySelector('[data-version-cancel]').focus();
  });
}
async function apiConAvisoDeRepetido(path, options = {}) {
  try {
    return await api(path, options);
  } catch (error) {
    if (error.code !== 'repeat_recent') throw error;
    if (!await confirmarEnvioRepetido(error)) return null;
    return api(path, { ...options, body: { ...(options.body || {}), confirmRepeat: true } });
  }
}

// Cualquier formulario queda bloqueado mientras se guarda, sin depender de que
// cada manejador se acuerde de hacerlo. El botón dice qué está pasando, que es
// lo que evita el segundo toque en primer lugar.
document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.classList.contains('loading-state')) return;
  const boton = form.querySelector('button:not([type="button"])');
  const textoOriginal = boton?.textContent;
  form.classList.add('loading-state');
  if (boton) boton.textContent = 'Guardando…';
  // Se libera pase lo que pase: si la petición falla, el formulario debe poder
  // reintentarse.
  setTimeout(() => {
    form.classList.remove('loading-state');
    if (boton && textoOriginal) boton.textContent = textoOriginal;
  }, 4000);
}, true);
const setsLabel = sets => `${sets} serie${Number(sets) === 1 ? '' : 's'}`;
// Equivalencia entre los dos sistemas. En Panamá se usan los dos: las
// mancuernas del gimnasio suelen venir en libras y los discos en kilos, así que
// quien anota "20 lb" y quien anota "9 kg" están hablando de lo mismo y
// conviene verlo sin hacer la cuenta a mano.
const LIBRAS_POR_KILO = 2.20462;
function equivalenciaPeso(texto) {
  const limpio = String(texto || '').trim();
  if (!limpio) return '';
  // Se acepta coma o punto decimal, y la unidad pegada o separada.
  const encontrado = limpio.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilos?|k|lb|lbs|libras?)\b/i);
  if (!encontrado) return '';
  const cantidad = Number(encontrado[1].replace(',', '.'));
  if (!Number.isFinite(cantidad) || cantidad <= 0) return '';
  const unidad = encontrado[2].toLowerCase();
  const enKilos = /^k/.test(unidad);
  const convertido = enKilos ? cantidad * LIBRAS_POR_KILO : cantidad / LIBRAS_POR_KILO;
  // Un decimal basta: nadie ajusta la carga a la centésima de kilo.
  const redondeado = Math.round(convertido * 10) / 10;
  return `≈ ${redondeado} ${enKilos ? 'lb' : 'kg'}`;
}

const exerciseLabel = exercise => typeof exercise === 'string' ? exercise : [exercise.block && `B${exercise.block}`, exercise.name, !exercise.block && exercise.sets && setsLabel(exercise.sets), exercise.reps, exercise.weight].filter(Boolean).join(' · ');
const sessionFromApi = item => {
  const starts = panamaDateTimeParts(item.starts_at);
  return {
    id: item.id, clientId: item.client_id, client: item.full_name, routineId: item.routine_id,
    date: starts.date, time: starts.time, durationMinutes: Number(item.duration_minutes || 60),
    routine: item.routine_title || 'Evaluación / seguimiento', mode: item.mode, status: item.status,
    completionPercent: Number(item.completion_percent || 0), notes: item.notes || '',
    packageId: item.package_id || '', packageLabel: item.charged_package_label || '',
    packageUsed: item.charged_package_used == null ? null : Number(item.charged_package_used),
    packageTotal: item.charged_package_total == null ? null : Number(item.charged_package_total),
    cancelledBy: item.cancelled_by || '', cancellationKind: item.cancellation_kind || '', cancellationResolution: item.cancellation_resolution || '', creditCharge: Boolean(item.credit_charge), pausedHold: Boolean(item.paused_hold),
    googleSynced: Boolean(item.google_event_id), googleEventLink: item.google_event_link || '',
    googleSyncError: item.google_sync_error || '',
    routineOfferStatus: item.routine_offer_status || '', routineOfferExpired: Boolean(item.routine_offer_expired), routineOfferOrigin: item.routine_offer_origin || '', cancelledTravelId: item.cancelled_travel_id || '', cancellationReason: item.cancellation_reason || '', routineOfferDuration: item.routine_offer_duration_seconds ? Number(item.routine_offer_duration_seconds) : null
  };
};
async function refreshSessions() {
  data.sessions = (await api('/api/sessions')).map(sessionFromApi);
}
async function refreshGoogleCalendarState() {
  data.googleCalendar = await api('/api/integrations/google-calendar/status').catch(() => ({ configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } }));
}
async function loadData() {
  const [clients, invoices, packages, sessions, routines, plans, compliance, notifications, googleCalendar, catalog, allInbody, travel] = await Promise.all([
    api('/api/clients'), api('/api/invoices'), api('/api/packages'), api('/api/sessions'), api('/api/routines'),
    api('/api/plans'),
    api(`/api/compliance/summary?period=${compliancePeriod}`).catch(() => ({ compliancePercent: 0, activities: 0, clients: [] })),
    api('/api/notifications').catch(() => []),
    api('/api/integrations/google-calendar/status').catch(() => ({ configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } })),
    // El catálogo iba en un segundo viaje, después de esperar a los otros
    // nueve: un viaje de ida y vuelta entero por nada.
    api('/api/exercises').catch(() => null),
    api('/api/inbody').catch(() => []),
    api('/api/travel').catch(() => [])
  ]);
  data.travel = Array.isArray(travel) ? travel : [];
  exerciseCatalog = catalog ? catalog.map(exercise => ({
    id: exercise.id, slug: exercise.slug, name: exercise.name, english: exercise.english || '',
    section: exercise.section, pattern: exercise.pattern || '', level: exercise.level,
    machine: exercise.machine || 'No aplica', freeWeight: exercise.free_weight || 'No aplica',
    cues: exercise.cues || '', usesWeight: Boolean(exercise.uses_weight), hasVideo: Boolean(exercise.has_video),
    videoCount: Number(exercise.video_count || (exercise.has_video ? 1 : 0)),
    videoDurationSeconds: exercise.video_duration_seconds ? Number(exercise.video_duration_seconds) : null
  })) : fallbackCatalog;
  const assessmentsByClient = new Map();
  (Array.isArray(allInbody) ? allInbody : []).forEach(item => {
    if (!assessmentsByClient.has(item.client_id)) assessmentsByClient.set(item.client_id, []);
    assessmentsByClient.get(item.client_id).push(item);
  });
  data.clients = clients.map((client, index) => {
    const clientAssessments = assessmentsByClient.get(client.id) || [];
    const readyAssessments = clientAssessments.filter(item => item.extraction_status === 'ready');
    // El delta se calcula sobre el historial ya filtrado a 'ready'. El campo
    // changes que manda la API compara contra la medición inmediatamente
    // anterior aunque esté en revisión, y entonces no cuadraría con las filas
    // que la pantalla muestra.
    const history = readyAssessments.map((item, position, all) => {
      const previous = all[position - 1];
      const reading = {
        id: item.id, documentId: item.document_id || null,
        date: String(item.tested_at).slice(0, 10), weight: Number(item.values.weightKg), smm: Number(item.values.skeletalMuscleMassKg),
        fat: Number(item.values.bodyFatMassKg), pbf: Number(item.values.percentBodyFat), score: Number(item.values.inBodyScore), values: item.values || {}
      };
      if (!previous) return { ...reading, delta: null, previousDate: null };
      const delta = {};
      for (const [key, source] of [['weight', 'weightKg'], ['smm', 'skeletalMuscleMassKg'], ['fat', 'bodyFatMassKg'], ['pbf', 'percentBodyFat'], ['score', 'inBodyScore']]) {
        const current = Number(item.values[source]); const before = Number(previous.values[source]);
        if (Number.isFinite(current) && Number.isFinite(before)) delta[key] = Number((current - before).toFixed(2));
      }
      return { ...reading, delta, previousDate: String(previous.tested_at).slice(0, 10) };
    });
    const latest = history.at(-1);
    const inbodyReviews = clientAssessments.filter(item => item.extraction_status === 'review');
    return { id: client.id, name: client.full_name, goal: client.goal || 'Sin meta definida', billingModel: client.billing_model, plan: Number(client.standard_price), catalogPlan: client.plan_catalog_price == null ? null : Number(client.plan_catalog_price), planId: client.plan_id, planName: client.plan_name, cutoffDay: Number(client.billing_cutoff_day || 1), sessionsIncluded: Number(client.sessions_included || 0), creditSessionPrice: client.payment_mode === 'no_anticipado' ? Number(client.credit_session_price || 25) : null, reprogramaciones: Number(client.reprogramaciones_ciclo || 0), canceladas: Number(client.canceladas_ciclo || 0), canceladasPorElla: Number(client.canceladas_por_ella_ciclo || 0), creditoPendiente: Number(client.credito_pendiente || 0), deudaPendiente: Number(client.deuda_pendiente || 0), validityDays: Number(client.validity_days || 0), email: client.email || '', phone: client.phone || '', notes: client.notes || '', monthlySessionTarget: client.monthly_session_target ?? null, paymentMode: client.payment_mode || 'anticipado', paysForMeId: client.billing_responsible_client_id || null, portalActive: Boolean(client.portal_user_id), pauseId: client.active_pause_id || null, pauseStartedOn: client.pause_started_on || null, pauseReason: client.pause_reason || '', status: { active: 'Activo', paused: 'En pausa', inactive: 'Inactivo' }[client.status] || 'Inactivo', statusRaw: client.status, inbodyReviews, inbody: latest ? { ...latest, history } : null };
  });
  data.invoices = invoices.map(item => ({ id: item.id, clientId: item.client_id, client: item.full_name, billedForSpecified: Boolean(item.auto_generated && item.billed_for_client_id != null), billedForClientId: item.billed_for_client_id || item.client_id, billedFor: item.billed_for_name || item.full_name, packageId: item.package_id || null, coverageApplied: Number(item.coverage_applied || 0), lineItems: Array.isArray(item.line_items) ? item.line_items : [], concept: item.concept, amount: Number(item.amount), paidAmount: Number(item.paid_amount || 0), balance: Number(item.balance_amount ?? (item.source_system ? item.balance : item.status === 'pending' ? item.amount : 0)), due: dateOnly(item.due_on), issued: dateOnly(item.issued_on || item.due_on), billingPeriod: item.billing_period ? dateOnly(item.billing_period) : dateOnly(item.due_on), paidOn: item.confirmed_at ? String(item.confirmed_at).slice(0, 10) : '', method: item.payment_method || 'pending', reference: item.payment_reference, status: item.status, source: item.source_system || 'eileen', invoiceNumber: item.invoice_number || '', externalStatus: item.external_status || '', autoGenerated: item.auto_generated || false, creditInvoice: Boolean(item.credit_invoice), coverageStart: item.coverage_start ? dateOnly(item.coverage_start) : '' }));
  data.packages = packages.map(item => ({ id: item.id, clientId: item.client_id, client: item.full_name, label: item.label, kind: item.kind, total: item.total_sessions, used: item.used_sessions, amount: Number(item.amount), expiresOn: item.expires_on || '', status: item.status === 'active' ? 'confirmed' : item.status === 'pending' ? 'pending' : 'expired', originInvoiceId: item.origin_invoice_id || null, originNumber: item.origin_invoice_number || '', originConcept: item.origin_concept || '', originSource: item.origin_source || '', originStatus: item.origin_status || '', originDate: item.origin_date ? dateOnly(item.origin_date) : '', renovacionPendiente: item.renovacion_pendiente || false, vencidoConSaldo: item.vencido_con_saldo || false, pagoPendiente: item.pago_pendiente || false, purchasedOn: item.purchased_on ? dateOnly(item.purchased_on) : '' }));
  data.sessions = sessions.map(sessionFromApi);
  data.routines = routines.map(item => ({ id: item.id, title: item.title, description: item.description || '', clients: (item.assigned_client_ids || []).length, assignedClientIds: item.assigned_client_ids || [], sessions: item.sessions_per_week, dueOn: item.due_on || null, exercises: item.exercises || [], version: Number(item.version || 1), rootRoutineId: item.root_routine_id || item.id, archivedAt: item.archived_at || null, deliveryCount: Number(item.deliveries_count || 0), deliveryClients: Number(item.delivery_clients_count || 0), lastSentAt: item.last_sent_at || null, lastCompletedAt: item.last_completed_at || null }));
  data.plans = plans.map(item => ({ id: item.id, name: item.name, description: item.description || '', billingModel: item.billing_model, price: Number(item.price), sessionsIncluded: Number(item.sessions_included || 0), validityDays: Number(item.validity_days || 0), zone: item.zone || '', specialFor: item.special_for || '', active: item.active }));
  data.compliance = compliance; data.notifications = notifications; data.googleCalendar = googleCalendar; billingAnalytics = null; billingAnalyticsLoadingYear = null; billingAnalyticsRequest += 1; showPendingBrowserNotification(notifications);
}
const initials = name => name.split(' ').slice(0, 2).map(word => word[0]).join('').toUpperCase();
const modalidadPlan = modelo => modelo === 'package' ? 'Paquete' : modelo === 'single' ? 'Sesión suelta' : 'Mensualidad';
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const viewTitles = { dashboard: 'Buenos días', clients: 'Clientes', calendar: 'Agenda', routines: 'Rutinas', attendance: 'Asistencia', billing: 'Facturación' };
const viewIds = new Set(Object.keys(viewTitles));
const viewFromHash = () => {
  const id = window.location.hash.slice(1);
  return viewIds.has(id) ? id : 'dashboard';
};
const view = id => {
  document.querySelectorAll('.view').forEach(item => item.classList.toggle('active', item.id === id));
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item.dataset.view === id));
  document.getElementById('page-title').textContent = viewTitles[id];
  window.scrollTo(0, 0);
};
const navigate = (id, { replace = false } = {}) => {
  const target = viewIds.has(id) ? id : 'dashboard';
  view(target);
  if (target === 'attendance') loadAttendanceReport();
  if (target === 'billing' && document.querySelector('#billing .subtab.active')?.dataset.subtab === 'facturas-nuevo') newBillingInvoices();
  const hash = `#${target}`;
  if (window.location.hash !== hash) window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
};
const monthInvoices = () => data.invoices.filter(invoice => { const date = new Date(`${invoice.issued || invoice.due}T12:00:00`); return date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear(); });
// Las automáticas pertenecen al ciclo de billing_period, aunque se hayan
// emitido el día anterior. Así una mensualidad con corte día 1 aparece en
// septiembre y no escondida dentro del listado de agosto.
const invoicePeriodDate = invoice => new Date(`${(invoice.autoGenerated && invoice.billingPeriod) || invoice.issued || invoice.due}T12:00:00`);
const billingPeriodInvoices = () => data.invoices.filter(invoice => {
  const date = invoicePeriodDate(invoice);
  const matchesYear = billingYear === 'all' || date.getFullYear() === Number(billingYear);
  const matchesMonth = billingMonth === 'all' || date.getMonth() + 1 === Number(billingMonth);
  const matchesSource = billingSource === 'all' || (billingSource === 'eileen' ? invoice.source !== 'zoho_invoice' : invoice.source === billingSource);
  const clientNeedle = billingClientFilter.trim().toLocaleLowerCase('es');
  const invoicePeople = `${invoice.client || ''} ${invoice.billedFor || ''}`.toLocaleLowerCase('es');
  const matchesClient = !clientNeedle || invoicePeople.includes(clientNeedle);
  return matchesYear && matchesMonth && matchesSource && matchesClient;
}).sort((a, b) => invoicePeriodDate(b) - invoicePeriodDate(a));
const remainingSessions = pack => Math.max(0, pack.total - pack.used);
// El saldo de una mensualidad no se veía en ninguna parte: la ficha sólo
// enseñaba sesiones disponibles cuando el modelo era paquete, de cuando las
// mensualidades no llevaban saldo. Ahora lo llevan, y sin esto la entrenadora
// no tiene dónde mirar cuántas clases le quedan al cliente en el mes.
// El avance del mes junto al del período. El panel de cumplimiento mide lo que
// ya pasó —una clase dada esta semana es 1 de 1, 100%—, y esa es la medida
// correcta: castigar hoy por clases que aún se pueden dar sería injusto. Pero
// la pregunta que la entrenadora le hace al panel es "¿cuántas le quedan?", y
// esa vivía sólo en Control de paquetes.
const avanceDelMes = clientId => {
  // Quien entrena a crédito (Julio) paga por clase dada: no tiene un saldo de sesiones que mostrar, aunque conserve una mensualidad vieja del sistema anterior.
  if ((data.clients || []).some(c => c.id === clientId && c.paymentMode === 'no_anticipado')) return '';
  const pack = data.packages.find(item => item.clientId === clientId && item.status === 'confirmed' && item.kind === 'monthly');
  if (!pack) return '';
  return ` · Saldo del ciclo: ${pack.used} de ${pack.total} sesiones usadas`;
};
// Movimientos del ciclo, en la ficha. Un cliente que mueve la clase cuatro
// veces al mes y otro que la pierde cuatro veces no son el mismo problema, y
// hasta ahora los dos se veían igual: como una agenda con huecos.
const movimientosDelCiclo = client => {
  const partes = [];
  if (client.reprogramaciones) partes.push(`${client.reprogramaciones} reprogramación${client.reprogramaciones === 1 ? '' : 'es'} pedida${client.reprogramaciones === 1 ? '' : 's'} en el ciclo`);
  if (client.canceladas) partes.push(`${client.canceladas} perdida${client.canceladas === 1 ? '' : 's'}`);
  if (client.canceladasPorElla) partes.push(`${client.canceladasPorElla} cancelada${client.canceladasPorElla === 1 ? '' : 's'} por ti`);
  // El crédito pendiente va aparte del "este mes": no caduca con el ciclo,
  // sigue debiéndose hasta que baje un cobro.
  // Ya no se dan descuentos en dinero por clases canceladas (acuerdos de mensualidad/paquete fijo): no se muestra un "descuento pendiente" que nada va a aplicar.
  const credito = '';
  return `${partes.length ? `<small class="ciclo-movimientos">Este mes: ${partes.join(' · ')}</small>` : ''}${credito}`;
};
// Colocar una reposición en un hueco libre.
//
// La entrenadora tiene una semana para reponer, y hasta ahora la única forma
// de encontrar sitio era ir probando horas a ver cuál no chocaba. Esto le
// enseña lo que le queda libre en esos días, deducido de su propia agenda:
// desde su clase más temprana hasta el final de la más tardía.
async function colocarReposicion(client) {
  const pack = data.packages.find(item => item.clientId === client.id && item.status === 'confirmed' && item.kind === 'makeup' && remainingSessions(item) > 0);
  if (!pack) { toast('Este cliente no tiene clases por reponer'); return; }
  const hasta = String(pack.expiresOn).slice(0, 10);
  const desde = dateKey(today);
  let datos;
  try { datos = await api(`/api/availability?from=${desde}&to=${hasta}&durationMinutes=60`); }
  catch (error) { toast(error.message, true); return; }

  const box = document.createElement('div');
  const dias = datos.dias.filter(dia => dia.libres.length);
  box.innerHTML = `
    <p class="eyebrow">REPOSICIÓN</p>
    <h2>Colocar la clase</h2>
    <p class="form-summary"><b>${escapeHtml(client.name)}</b><br>${remainingSessions(pack)} por reponer · vencen el ${formatoDiaCorto(pack.expiresOn)}</p>
    <p class="section-note">Huecos libres entre las ${datos.abre} y las ${datos.cierra}, que es tu franja según la agenda de los últimos dos meses.</p>
    ${dias.length ? dias.map(dia => `
      <div class="huecos-dia">
        <b>${escapeHtml(formatoDiaLargo(dia.date))}</b>
        <div class="huecos-lista">${dia.libres.map(hora => `<button type="button" class="secondary" data-hueco="${dia.date}" data-hora="${hora}">${hora}</button>`).join('')}</div>
      </div>`).join('') : '<p class="empty">No queda ningún hueco libre en esos días. Habría que mover algo primero.</p>'}`;
  openModal(box, true);

  box.querySelectorAll('[data-hueco]').forEach(boton => {
    boton.onclick = async () => {
      const { hueco, hora } = boton.dataset;
      if (!confirmarGuardado(`Reponer la clase de ${client.name}\n${formatoDiaLargo(hueco)} a las ${hora}`)) return;
      box.querySelectorAll('[data-hueco]').forEach(b => { b.disabled = true; });
      try {
        await api('/api/sessions', { method: 'POST', body: {
          clientId: client.id, startsAt: panamaDateTimeIso(hueco, hora),
          durationMinutes: 60, mode: 'Presencial', notes: 'Reposición del mes anterior'
        } });
        await loadData(); renderAll(); modal.close();
        toast('Reposición agendada');
      } catch (error) {
        toast(error.message, true);
        box.querySelectorAll('[data-hueco]').forEach(b => { b.disabled = false; });
      }
    };
  });
}

const formatoDiaLargo = fecha => new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Panama' })
  .format(new Date(`${String(fecha).slice(0, 10)}T12:00:00-05:00`));

const saldoDelMes = client => {
  const pack = data.packages.find(item => item.clientId === client.id && item.status === 'confirmed' && item.kind === 'monthly' && !item.vencidoConSaldo);
  // La reposición se nombra aparte: son clases que el cliente ya pagó el mes
  // pasado y que sólo valen esta semana. Sumarlas al total las escondería justo
  // cuando hay que darles prioridad.
  const reposicion = data.packages.find(item => item.clientId === client.id && item.status === 'confirmed' && item.kind === 'makeup' && remainingSessions(item) > 0);
  const extra = reposicion
    ? `${remainingSessions(reposicion)} por reponer${reposicion.expiresOn ? ` hasta el ${formatoDiaCorto(reposicion.expiresOn)}` : ''} · `
    : '';
  if (!pack) return extra;
  const vence = pack.expiresOn ? ` · vence ${formatoDiaCorto(pack.expiresOn)}` : '';
  // El saldo se renueva pague o no —no se le cierra la puerta a nadie por un
  // pago que entra tarde—, pero queda dicho junto a las clases, que es donde
  // se mira, y no sólo enterrado en cuentas por cobrar.
  const sinPagar = client.deudaPendiente > 0 ? ' · pago pendiente' : '';
  return `${extra}${remainingSessions(pack)} de ${pack.total} sesiones${vence}${sinPagar} · `;
};
const formatoDiaCorto = fecha => new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short', timeZone: 'America/Panama' }).format(new Date(`${String(fecha).slice(0, 10)}T12:00:00-05:00`));
const clientPackage = name => data.packages.find(pack => pack.client === name && pack.status === 'confirmed' && remainingSessions(pack) > 0) || data.packages.find(pack => pack.client === name && pack.status === 'pending') || data.packages.find(pack => pack.client === name && pack.status !== 'expired');
const mondayFor = date => { const monday = new Date(date); monday.setDate(date.getDate() - ((date.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0); return monday; };
const addDays = (date, amount) => { const next = new Date(date); next.setDate(next.getDate() + amount); return next; };
const sessionsBetween = (start, end) => data.sessions.filter(session => session.date >= dateKey(start) && session.date < dateKey(end)).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
const calendarRange = () => {
  let start;
  if (calendarMode === 'day') start = new Date(calendarCursor);
  else if (calendarMode === 'week') start = mondayFor(calendarCursor);
  else start = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1, 12);
  start.setHours(0, 0, 0, 0);
  const end = calendarMode === 'day' ? addDays(start, 1) : calendarMode === 'week' ? addDays(start, 7) : new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start, end };
};
const capitalized = value => value.charAt(0).toUpperCase() + value.slice(1);
const calendarPeriodLabelSemana = lunes => {
  const domingo = addDays(lunes, 6);
  return lunes.getMonth() === domingo.getMonth()
    ? `${lunes.getDate()}–${domingo.getDate()} de ${new Intl.DateTimeFormat('es-PA', { month: 'long' }).format(domingo)}`
    : `${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short' }).format(lunes)} – ${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short' }).format(domingo)}`;
};
const calendarPeriodLabel = ({ start, end }) => {
  if (calendarMode === 'day') return capitalized(new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }).format(start));
  if (calendarMode === 'month') return capitalized(new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(start));
  const last = addDays(end, -1);
  if (start.getMonth() === last.getMonth()) return `${start.getDate()}–${last.getDate()} de ${new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(last)}`;
  return `${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short' }).format(start)} – ${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short', year: 'numeric' }).format(last)}`;
};
const sessionsThisWeek = () => { const start = mondayFor(today); const end = new Date(start); end.setDate(start.getDate() + 7); return data.sessions.filter(session => { const date = new Date(`${session.date}T12:00:00`); return date >= start && date < end; }); };
// "En pausa" es del cliente, no de la sesión. La verdad la lleva el estado del
// cliente —lo mismo que muestra la vista de Clientes—, no la bandera por sesión
// paused_hold, que puede no haber alcanzado a una sesión suelta. Sólo aplica a
// sesiones aún por delante: una clase ya dada conserva su "Realizada".
const sesionEnPausa = session => session.status === 'scheduled'
  && (session.pausedHold || (data.clients || []).some(c => c.id === session.clientId && c.statusRaw === 'paused'));
// Cliente de viaje (J-107): el viaje no pausa el plan; sus clases de esos días salen en azul con ✈ y piden la rutina confirmada ese día.
const viajeDelCliente = (clientId, fecha) => (data.travel || []).find(item => item.client_id === clientId && item.starts_on <= fecha && (!item.ends_on || item.ends_on >= fecha));
const sesionDeViaje = session => session.status === 'scheduled' && !sesionEnPausa(session) && Boolean(viajeDelCliente(session.clientId, session.date));
const sessionStateLabel = session => sesionEnPausa(session) ? 'Reservado (En Pausa)' : sesionDeViaje(session) ? '✈ De viaje' : session.status === 'cancelled' && session.cancelledTravelId ? '✈ Cancelada (viaje)' : session.status === 'completed' ? 'Realizada' : session.status === 'no_show' ? 'No asistió' : session.status === 'cancelled' ? 'Cancelada' : 'Programada';
// La clase visual: una sesión congelada por pausa manda sobre su status, para
// que no tome prestado el verde de "programada" en el calendario.
const estadoSesion = session => sesionEnPausa(session) ? 'pausa' : sesionDeViaje(session) ? 'viaje' : session.status;
// El resultado se elige, no se deduce de una casilla. Con la casilla, quitar
// una marca puesta por error dejaba la sesión como incumplida —y le bajaba el
// cumplimiento al cliente por una clase que ni siquiera había llegado—. Los
// tres estados son distintos y ninguno es el "no" del otro.
const sessionComplianceForm = session => {
  const cumplio = session.status === 'completed';
  // Tres decisiones y ninguna más (J-101): sin estado, cumplió o cancelar. el "no asistió" no se usa. Cancelar abre el diálogo de cancelación (quién cancela, si reprograma).
  return `<form class="session-compliance" data-session-compliance="${session.id}"><div class="outcome-group" role="radiogroup" aria-label="Estado de la clase"><label class="outcome-btn outcome-none"><input type="radio" name="outcome" value="scheduled" ${cumplio ? '' : 'checked'} /><span>Sin estado</span></label><label class="outcome-btn outcome-done"><input type="radio" name="outcome" value="completed" ${cumplio ? 'checked' : ''} /><span>Cumplió</span></label><button type="button" class="outcome-btn outcome-cancel" data-cancel-session="${session.id}">Cancelar</button></div><label class="completion-percent"><input name="completionPercent" type="number" min="0" max="100" ${cumplio ? '' : 'disabled'} value="${cumplio ? session.completionPercent || 100 : 0}" /><span>%</span></label><button class="secondary" title="Guardar cumplimiento">Guardar</button></form>`;
};
function renderDashboard() {
  const confirmed = monthInvoices().filter(item => item.status === 'confirmed').reduce((sum, item) => sum + item.amount, 0);
  const pending = data.invoices.filter(item => item.status === 'pending').reduce((sum, item) => sum + item.balance, 0);
  const weekSessions = sessionsThisWeek();
  const completedThisWeek = weekSessions.filter(session => session.completionPercent > 0).length;
  document.getElementById('active-clients').textContent = data.clients.filter(client => client.status === 'Activo').length;
  document.getElementById('client-trend').textContent = `${data.clients.length} expedientes registrados`;
  document.getElementById('week-sessions').textContent = `${data.compliance.activities} actividades registradas`;
  document.getElementById('week-adherence').textContent = `${data.compliance.compliancePercent}%`;
  document.getElementById('hero-adherence').textContent = data.compliance.compliancePercent;
  document.getElementById('hero-session-count').textContent = weekSessions.length;
  document.getElementById('hero-completed-count').textContent = completedThisWeek;
  document.getElementById('month-collected').textContent = money.format(confirmed);
  document.getElementById('pending-amount').textContent = money.format(pending);
  document.getElementById('pending-count').textContent = `${data.invoices.filter(item => item.status === 'pending').length} factura pendiente`;
  const monitored = data.clients.filter(client => client.inbody);
  document.getElementById('progress-list').innerHTML = monitored.length ? monitored.map(client => {
    const history = client.inbody.history;
    const previous = history.length > 1 ? history[history.length - 2] : history[0];
    const muscleDelta = (client.inbody.smm - previous.smm).toFixed(1);
    const fatDelta = (client.inbody.fat - previous.fat).toFixed(1);
    return `<div class="progress-item"><span class="initials">${escapeHtml(initials(client.name))}</span><div><b>${escapeHtml(client.name)}</b><small>${escapeHtml(client.goal)} · InBody ${client.inbody.date}</small></div><span class="delta ${Number(fatDelta) > 0 ? 'warn' : ''}">Músculo ${muscleDelta > 0 ? '+' : ''}${muscleDelta} kg<br>Grasa ${fatDelta > 0 ? '+' : ''}${fatDelta} kg</span></div>`;
  }).join('') : '<p class="empty">Aún no hay evaluaciones InBody.</p>';
  const todaySessions = data.sessions.filter(session => session.date === dateKey(today)).sort((a, b) => a.time.localeCompare(b.time));
  document.getElementById('today-sessions').innerHTML = todaySessions.length ? todaySessions.map(session => `<div class="agenda-item"><span class="agenda-time">${session.time}</span><div><b>${escapeHtml(session.client)}</b><span>${escapeHtml(session.routine)} · ${escapeHtml(session.mode.toLowerCase())}</span></div><span class="session-state ${estadoSesion(session)}">${sessionStateLabel(session)}</span></div>`).join('') : '<p class="empty">No hay sesiones para hoy.</p>';
  const clientesActivos = new Set(data.clients.filter(client => client.statusRaw === 'active').map(client => client.id));
  const noInbody = data.clients.filter(client => !client.inbody && clientesActivos.has(client.id)).map(client => `<div class="alert-item"><b>${escapeHtml(client.name)}</b><span>Sin evaluación InBody registrada.</span></div>`).join('');
  const cobrosPendientes = data.invoices.filter(item => item.status === 'pending' && item.source !== 'zoho_invoice' && clientesActivos.has(item.clientId)).length;
  document.getElementById('alerts').innerHTML = `${noInbody || '<div class="alert-item"><b>Todo al día</b><span>No hay alertas de seguimiento.</span></div>'}<div class="alert-item"><b>${cobrosPendientes} ${cobrosPendientes === 1 ? 'cobro pendiente' : 'cobros pendientes'}</b><span>Revisa pagos y comprobantes.</span></div>`;
  document.getElementById('compliance-list').innerHTML = data.compliance.clients.length ? data.compliance.clients.map(client => `<div class="compliance-row"><span class="initials">${escapeHtml(initials(client.name))}</span><div><b>${escapeHtml(client.name)}</b><small>${client.completed} de ${client.activities} clases${client.missed ? ` · ${client.missed} perdida${client.missed === 1 ? '' : 's'}` : ''}${avanceDelMes(client.clientId)}</small><span class="compliance-track"><i style="width:${client.compliancePercent}%"></i></span></div><strong>${client.compliancePercent}%</strong></div>`).join('') : '<p class="empty">Aún no hay clases vencidas en este período.</p>';
  const notificationCount = document.getElementById('notification-count'); notificationCount.textContent = data.notifications.length; notificationCount.hidden = !data.notifications.length;
}
// Los inactivos aparte y al final. Mezclados alfabéticamente obligaban a leer
// la etiqueta de cada tarjeta para saber a quién se entrena hoy, y quien deja
// de entrenar no debería competir por la atención con quien sigue viniendo.
const ESTADOS_CLIENTE = [
  { clave: 'active', titulo: 'Activos' },
  { clave: 'paused', titulo: 'En pausa' },
  { clave: 'inactive', titulo: 'Inactivos' }
];
function renderClients(filter = '') {
  const buscado = filter.toLowerCase();
  const estadoElegido = document.getElementById('client-status-filter')?.value || '';
  const clients = data.clients.filter(client =>
    client.name.toLowerCase().includes(buscado)
    && (!estadoElegido || client.statusRaw === estadoElegido));

  const tarjeta = client => {
    const pack = clientPackage(client.name);
    // Modalidad "no anticipado": entrena a crédito. El saldo se abre igual, pero
    // mientras su cobro no esté pagado se avisa para no confundir clases dadas a
    // crédito con clases ya cobradas. Es la única diferencia frente a anticipado.
    const alertaCredito = client.paymentMode === 'no_anticipado' && client.deudaPendiente > 0
      ? `<p class="alerta-credito">Entrena a crédito · pago pendiente ${money.format(client.deudaPendiente)}</p>`
      : '';
    const commercial = client.billingModel === 'package'
      ? `<span class="commercial-label package-label">Paquete</span><b>${pack?.status === 'pending' ? 'Pago pendiente' : `${pack ? remainingSessions(pack) : client.sessionsIncluded || 0} sesiones disponibles`}</b><small>${escapeHtml(client.planName || 'Plan por sesiones')} · ${money.format(client.plan)}</small>`
      : client.billingModel === 'single'
      ? `<span class="commercial-label single-label">Sesión suelta</span><b>${escapeHtml(client.planName || 'Sesiones individuales')} · ${money.format(client.plan)}</b><small>Por sesión, sin corte mensual</small>`
      : `<span class="commercial-label">Mensualidad</span><b>${escapeHtml(client.planName || 'Mensualidad')} · ${money.format(client.plan)}</b><small>${client.catalogPlan != null && Math.abs(client.plan - client.catalogPlan) > 0.009 ? `Precio propio · catálogo ${money.format(client.catalogPlan)} · ` : ''}${saldoDelMes(client)}Corte día ${client.cutoffDay}</small>`;
    return `<article class="client-card"><header><span class="initials">${escapeHtml(initials(client.name))}</span><div><h3>${escapeHtml(client.name)}</h3><small>${escapeHtml(client.goal)}</small></div><span class="status estado-${client.statusRaw}">${client.status}</span></header><p>${client.inbody ? `Último InBody: ${client.inbody.date}` : 'Aún no se ha cargado un InBody.'}${client.portalActive ? ' · Portal activo' : ''}</p>${etiquetaViaje(client.id)}<div class="commercial-summary">${commercial}</div>${alertaCredito}${movimientosDelCiclo(client)}${data.packages.some(item => item.clientId === client.id && item.status === 'confirmed' && item.kind === 'makeup' && remainingSessions(item) > 0) ? `<button class="secondary wide-button" data-colocar-reposicion="${client.id}" style="margin-top:9px">Colocar reposición</button>` : ''}<div class="mini-data">${client.inbody ? `<div><b>${client.inbody.weight} kg</b><span>Peso</span></div><div><b>${client.inbody.smm} kg</b><span>Músculo</span></div><div><b>${client.inbody.pbf}%</b><span>Grasa</span></div>` : `<div><b>—</b><span>Evaluación pendiente</span></div>`}</div><div class="client-actions"><button class="secondary" data-client="${client.id}">Ver expediente</button><button class="secondary" data-edit-client="${client.id}">Editar</button><button class="secondary" data-inbody="${client.id}">+ InBody</button></div></article>`;
  };

  const grupos = ESTADOS_CLIENTE
    .map(estado => ({ ...estado, gente: clients.filter(c => c.statusRaw === estado.clave) }))
    .filter(grupo => grupo.gente.length);
  // Con un solo grupo el encabezado sobra: no separa nada de nada.
  const conEncabezados = grupos.length > 1;
  document.getElementById('client-grid').innerHTML = grupos.length
    ? grupos.map(grupo => `${conEncabezados ? `<h3 class="grupo-clientes">${grupo.titulo} <span>${grupo.gente.length}</span></h3>` : ''}${grupo.gente.map(tarjeta).join('')}`).join('')
    : '<p class="empty">No se encontraron clientes.</p>';
}
function renderGoogleCalendar() {
  const integration = data.googleCalendar || {};
  const status = document.getElementById('google-calendar-status');
  const copy = document.getElementById('google-calendar-copy');
  const connect = document.getElementById('google-calendar-connect');
  const disconnect = document.getElementById('google-calendar-disconnect');
  const card = document.getElementById('google-calendar-card');
  const counts = integration.sessions || { synced: 0, pending: 0, failed: 0 };
  card.classList.toggle('connected', Boolean(integration.connected));
  card.classList.toggle('integration-error', integration.connection?.status === 'error');
  status.className = `integration-status ${integration.connected ? integration.connection?.status === 'error' ? 'error' : 'connected' : ''}`;
  if (!integration.configured) {
    status.textContent = 'Configuración pendiente';
    copy.textContent = 'Pulsa el botón para volver a comprobar las credenciales OAuth de Google.';
    connect.textContent = 'Comprobar conexión'; connect.disabled = false; disconnect.hidden = true;
  } else if (!integration.connected) {
    status.textContent = 'Sin conectar';
    copy.textContent = 'Autoriza el calendario principal para mantener los horarios sincronizados en ambas direcciones.';
    connect.textContent = 'Conectar calendario'; connect.disabled = false; disconnect.hidden = true;
  } else {
    status.textContent = integration.connection?.status === 'error' ? 'Requiere atención' : 'Conectado';
    const lastSync = integration.connection?.last_sync_at ? ` · última sincronización ${new Intl.DateTimeFormat('es-PA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(integration.connection.last_sync_at))}` : '';
    copy.textContent = integration.connection?.last_error || `Sincronización bidireccional activa · ${counts.synced} sesión${counts.synced !== 1 ? 'es' : ''}${counts.pending ? ` · ${counts.pending} pendiente${counts.pending !== 1 ? 's' : ''}` : ''}${lastSync}`;
    connect.textContent = 'Sincronizar ahora'; connect.disabled = false; disconnect.hidden = false;
  }
}
// Mover una clase de día desde el propio calendario.
//
// En pantalla grande se arrastra, como en Google. En móvil se toca la clase y
// después el día: arrastrar en una rejilla de siete columnas, con el dedo
// tapando justo lo que se mueve, no acierta nunca. Los dos caminos terminan en
// el mismo sitio, proponiendo la hora.
function proponerHoraLibre(fecha, horaOriginal, duracion, ignorarId) {
  // Se propone la misma hora: es lo que espera quien mueve una clase de día.
  // Si ese hueco ya está ocupado, se busca el más cercano libre en pasos de
  // media hora, para no proponer de entrada algo que ya choca.
  if (!choquesEn(fecha, horaOriginal, duracion, ignorarId).length) return horaOriginal;
  const base = minutosDelDia(horaOriginal);
  for (let salto = 30; salto <= 240; salto += 30) {
    for (const candidato of [base + salto, base - salto]) {
      if (candidato < 5 * 60 || candidato + duracion > 22 * 60) continue;
      const hora = `${String(Math.floor(candidato / 60)).padStart(2, '0')}:${String(candidato % 60).padStart(2, '0')}`;
      if (!choquesEn(fecha, hora, duracion, ignorarId).length) return hora;
    }
  }
  return horaOriginal;
}

function moverSesionA(sesion, fechaDestino) {
  if (!sesion || !fechaDestino) return;
  const propuesta = proponerHoraLibre(fechaDestino, sesion.time, sesion.durationMinutes, sesion.id);
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="mover-sesion-form">
      <p class="eyebrow">REPROGRAMAR</p>
      <h2>Mover la clase</h2>
      <p class="form-summary"><b>${escapeHtml(sesion.client)}</b><br>${sesion.date} · ${sesion.time} → <b>${fechaDestino}</b></p>
      <label>Hora<input name="time" type="time" required value="${propuesta}" /></label>
      <p class="section-note">${propuesta === sesion.time
        ? 'Se propone la misma hora. Cámbiala si acordaron otra.'
        : `A las ${sesion.time} ese día ya hay alguien, así que se propone el hueco libre más cercano.`}</p>
      <p class="conflict-warn" id="mover-choque" hidden></p>
      <p class="section-note">Cuenta como reprogramación del mes y se actualiza en Google Calendar.</p>
      <button class="primary wide-button">Mover la clase</button>
    </form>`;
  openModal(box);
  const form = document.getElementById('mover-sesion-form');
  const aviso = document.getElementById('mover-choque');
  const revisar = () => {
    const texto = textoDeChoques([fechaDestino], form.elements.time.value, sesion.durationMinutes, sesion.id);
    aviso.innerHTML = texto;
    aviso.hidden = !texto;
  };
  form.elements.time.addEventListener('input', revisar);
  form.elements.time.addEventListener('change', revisar);
  revisar();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const hora = form.elements.time.value;
    if (!confirmarGuardado(`Mover a ${escapeHtml(sesion.client)}\n${sesion.date} ${sesion.time} → ${fechaDestino} ${hora}`)) return;
    try {
      event.target.classList.add('loading-state');
      await api(`/api/sessions/${sesion.id}`, { method: 'PATCH', body: {
        startsAt: panamaDateTimeIso(fechaDestino, hora),
        durationMinutes: sesion.durationMinutes, mode: sesion.mode, notes: sesion.notes || undefined
      } });
      sesionAMover = null;
      await loadData(); renderAll(); modal.close();
      toast('Clase movida · cuenta como reprogramación');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

// La clase que la entrenadora tiene "en la mano" mientras elige el día nuevo.
// En móvil no se arrastra: se toca la clase, se toca el día, y listo. Arrastrar
// en una rejilla de siete columnas con el dedo encima de lo que mueves no
// acierta nunca.
let sesionAMover = null;

function renderCalendar() {
  const grid = document.getElementById('week-calendar');
  const range = calendarRange();
  const visibleSessions = sessionsBetween(range.start, range.end);
  document.getElementById('calendar-period').textContent = calendarPeriodLabel(range);
  const cartel = document.getElementById('calendar-mover-aviso');
  if (cartel) {
    const enMano = sesionAMover ? data.sessions.find(item => item.id === sesionAMover) : null;
    cartel.innerHTML = enMano
      ? `Moviendo la clase de <b>${escapeHtml(enMano.client)}</b> del ${enMano.date} · ${enMano.time}. Toca el día nuevo. <button type="button" class="secondary" id="calendar-mover-cancelar">Dejarlo</button>`
      : '';
    cartel.hidden = !enMano;
  }
  document.querySelectorAll('[data-calendar-mode]').forEach(button => {
    const active = button.dataset.calendarMode === calendarMode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  if (calendarMode === 'day') {
    const key = dateKey(range.start);
    const sessions = visibleSessions.filter(session => session.date === key);
    grid.className = 'calendar-grid calendar-day';
    grid.innerHTML = `<div class="day-focus"><span>${new Intl.DateTimeFormat('es-PA', { weekday: 'long' }).format(range.start)}</span><strong>${range.start.getDate()}</strong><small>${capitalized(new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(range.start))}</small></div><div class="day-timeline">${sessions.length ? sessions.map(session => `<article class="day-session ${estadoSesion(session)}"><time>${session.time}</time><div><b>${escapeHtml(session.client)}</b><span>${escapeHtml(session.routine)}</span><small>${escapeHtml(session.mode)}</small></div><span class="session-state ${estadoSesion(session)}">${sessionStateLabel(session)}</span></article>`).join('') : '<div class="calendar-empty"><b>Día disponible</b><span>No hay sesiones programadas.</span><button class="secondary" data-action="new-session">+ Agendar sesión</button></div>'}</div>`;
  } else if (calendarMode === 'week') {
    const names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    grid.className = 'calendar-grid calendar-week';
    grid.innerHTML = names.map((name, index) => {
      const date = addDays(range.start, index); const key = dateKey(date);
      const sessions = visibleSessions.filter(session => session.date === key);
      return `<button type="button" class="day-col ${key === dateKey(today) ? 'today' : ''} ${key === dateKey(calendarCursor) ? 'selected' : ''}" data-calendar-date="${key}"><span class="day-name">${name}</span><span class="day-num">${date.getDate()}</span>${sessions.map(session => `<span class="session-chip ${estadoSesion(session)} ${sesionAMover === session.id ? 'moviendo' : ''}" data-mover-sesion="${session.id}" draggable="${session.status === 'scheduled' && !sesionEnPausa(session)}"><b>${session.time}</b> ${sesionEnPausa(session) ? '⏸ ' : ''}${sesionDeViaje(session) ? '✈ ' : ''}${session.client.split(' ')[0]}</span>`).join('')}</button>`;
    }).join('');
    requestAnimationFrame(() => {
      const selected = grid.querySelector('.selected');
      if (selected && grid.scrollWidth > grid.clientWidth) grid.scrollLeft = selected.offsetLeft - (grid.clientWidth - selected.clientWidth) / 2;
    });
  } else {
    const monthStart = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1, 12);
    const monthEnd = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 0, 12);
    const gridStart = mondayFor(monthStart); const gridEnd = addDays(mondayFor(monthEnd), 7);
    const cells = Math.round((gridEnd - gridStart) / 86400000);
    const names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    grid.className = 'calendar-grid calendar-month';
    grid.innerHTML = `${names.map(name => `<span class="month-weekday">${name}</span>`).join('')}${Array.from({ length: cells }, (_, index) => {
      const date = addDays(gridStart, index); const key = dateKey(date);
      const sessions = data.sessions.filter(session => session.date === key).sort((a, b) => a.time.localeCompare(b.time));
      return `<button type="button" class="month-day ${date.getMonth() !== calendarCursor.getMonth() ? 'outside' : ''} ${key === dateKey(today) ? 'today' : ''}" data-calendar-date="${key}"><span class="month-day-number">${date.getDate()}</span><span class="month-events">${sessions.slice(0, 2).map(session => `<span class="month-event ${estadoSesion(session)}"><i></i><b>${session.time}</b> ${sesionEnPausa(session) ? '⏸ ' : ''}${sesionDeViaje(session) ? '✈ ' : ''}${session.client.split(' ')[0]}</span>`).join('')}${sessions.length > 2 ? `<small>+${sessions.length - 2} más</small>` : ''}</span></button>`;
    }).join('')}`;
  }
  // Después de las ramas: cada una reescribe grid.className entero, así que
  // marcarlo antes se perdía sin dejar rastro.
  grid.classList.toggle('eligiendo-dia', Boolean(sesionAMover));
  // La lista enseña un solo día. Toda la semana de golpe, aun plegada, sigue
  // siendo una pared: la entrenadora trabaja el día que tiene delante, y para
  // marcar asistencia no necesita ver el jueves. El día se elige en la tira de
  // arriba y es el mismo que señala el calendario, para que no haya dos ideas
  // distintas de "el día seleccionado".
  const diaElegido = dateKey(calendarCursor);
  const semanaDe = mondayFor(calendarCursor);
  const delDia = data.sessions.filter(session => session.date === diaElegido)
    .sort((a, b) => a.time.localeCompare(b.time));
  const titulo = new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${diaElegido}T12:00:00`));
  document.getElementById('session-control-title').textContent = capitalized(titulo);
  const sinMarcar = delDia.filter(session => session.status === 'scheduled').length;
  document.getElementById('session-control-copy').textContent = delDia.length
    ? `${delDia.length} ${delDia.length === 1 ? 'clase' : 'clases'}${sinMarcar ? ` · ${sinMarcar} sin marcar` : ' · todas marcadas'}`
    : 'Sin clases este día';

  const tira = document.getElementById('session-day-picker');
  if (tira) {
    const nombres = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    // Las flechas van en su propia línea: metidas junto a los siete días, cada
    // chip quedaba en 30 px y el pulgar no acierta. Así llegan a 44.
    tira.innerHTML = `
      <div class="tira-semana">
        <button type="button" class="secondary" data-session-week="-1" aria-label="Semana anterior">‹</button>
        <b>${escapeHtml(calendarPeriodLabelSemana(semanaDe))}</b>
        <button type="button" class="secondary" data-session-week="1" aria-label="Semana siguiente">›</button>
      </div>
      <div class="dia-tira">${nombres.map((nombre, indice) => {
        const fecha = addDays(semanaDe, indice);
        const clave = dateKey(fecha);
        const cuantas = data.sessions.filter(session => session.date === clave).length;
        return `<button type="button" class="dia-chip ${clave === diaElegido ? 'activo' : ''} ${clave === dateKey(today) ? 'hoy' : ''}" data-session-day="${clave}">
          <span>${nombre}</span><b>${fecha.getDate()}</b><small>${cuantas || '–'}</small>
        </button>`;
      }).join('')}</div>`;
  }

  document.getElementById('session-list').innerHTML = delDia.length
    ? delDia.map(session => `<details class="session-row">
        <summary>
          <b class="sesion-hora">${session.time}</b>
          <span class="sesion-quien">${escapeHtml(session.client)}<small>${escapeHtml(session.routine)} · ${session.durationMinutes} min</small></span>
          <span class="session-state ${estadoSesion(session)}">${sessionStateLabel(session)}</span>
        </summary>
        ${data.googleCalendar.connected ? `<small class="google-session-state ${session.googleSyncError ? 'error' : session.googleSynced ? 'synced' : ''}">${session.googleSyncError ? 'Google pendiente' : session.googleSynced ? 'Google Calendar ✓' : 'Por sincronizar'}</small>` : ''}
        ${session.packageLabel && session.packageId ? `<small class="session-charge">Descontada de «${escapeHtml(session.packageLabel)}»${session.packageUsed != null && session.packageTotal != null ? ` · quedan ${Math.max(0, session.packageTotal - session.packageUsed)}` : ''}</small>` : ''}
        ${session.cancellationReason ? `<small class="session-charge session-viaje-razon">${session.cancelledTravelId ? '✈ ' : ''}${escapeHtml(session.cancellationReason)}</small>` : ''}
        ${session.routineOfferStatus === 'expired' ? `<small class="session-charge session-routine-offer">Rutina ofrecida por su cancelación y no cumplida el día de la clase · la clase se dio por perdida</small>` : session.routineOfferStatus === 'offered' && session.routineOfferExpired ? `<small class="session-charge session-routine-offer">La rutina ofrecida venció (solo valía este día) sin cumplirse · cierra la clase como corresponda</small>` : session.routineOfferStatus === 'offered' ? `<small class="session-charge session-routine-offer">Rutina ofrecida en lugar de la clase · vale solo este día${session.routineOfferOrigin === 'client' ? ' · si no la cumple, la clase se da por perdida' : ''} · esperando que ${escapeHtml(session.client.split(' ')[0])} la cumpla</small>` : session.routineOfferStatus === 'completed' ? `<small class="session-charge session-routine-done">Cumplió la rutina en lugar de la clase${session.routineOfferDuration ? ` · ${Math.max(1, Math.round(session.routineOfferDuration / 60))} min` : ''}</small>` : ''}
        ${session.creditCharge ? '<small class="session-charge">Cancelación cobrada · crédito por sesión</small>' : session.status === 'cancelled' && session.cancellationKind === 'not_rescheduled' && session.cancelledBy === 'client' && data.clients.find(c => c.id === session.clientId)?.paymentMode === 'no_anticipado' ? '<small class="session-charge">Cancelación del cliente · sin cobro</small>' : ''}
        ${session.status === 'cancelled'
          ? `<div class="session-management"><button type="button" class="secondary" data-reactivar-sesion="${session.id}">Reactivar</button><button type="button" class="secondary" data-edit-cancellation="${session.id}">Editar cancelación</button><button type="button" class="secondary" data-purge-session="${session.id}">Quitar de la agenda</button></div>`
          : `<div class="session-management"><button type="button" class="secondary edit-session" data-edit-session="${session.id}">Editar horario</button><button type="button" class="secondary" data-purge-session="${session.id}">Eliminar</button>${session.status === 'scheduled' && !session.routineOfferStatus && !sesionEnPausa(session) ? `<button type="button" class="secondary proponer-rutina-fila" data-proponer-rutina="${session.id}">Proponer rutina</button>` : ''}${session.routineOfferStatus === 'offered' && !session.routineOfferExpired ? `<button type="button" class="secondary" data-retirar-rutina="${session.id}">Retirar la rutina ofrecida</button>` : ''}${sessionComplianceForm(session)}</div>`}
      </details>`).join('')
    : '<p class="empty">No hay clases este día.</p>';
}
const routineVideoCount = routine => (routine.exercises || []).filter(exercise => {
  const entry = exerciseCatalog.find(item => item.id === exercise.catalogId || item.slug === exercise.catalogId);
  return entry?.hasVideo;
}).length;

function renderRoutines() {
  document.getElementById('routine-grid').innerHTML = data.routines.map(routine => {
    const asignados = (routine.assignedClientIds || []).map(id => data.clients.find(client => client.id === id)?.name).filter(Boolean);
    const uso = routine.deliveryCount ? `Enviada a ${routine.deliveryClients} cliente${routine.deliveryClients === 1 ? '' : 's'} · última ${fechaHoraPanama(routine.lastSentAt, false)}` : 'Aún no se ha enviado';
    return `<article class="routine-card"><span class="routine-icon">⌁</span><h3>${escapeHtml(routine.title)}</h3><p class="routine-descripcion">${escapeHtml(routine.description)}</p>${routine.exercises.length ? `<div class="exercise-preview">${routine.exercises.slice(0, 4).map(exercise => `<span>${exerciseLabel(exercise)}</span>`).join('')}${routine.exercises.length > 4 ? `<span class="exercise-more">+${routine.exercises.length - 4} más</span>` : ''}</div>` : ''}<footer><span class="routine-usage">${uso}</span><br>${routine.clients} cliente${routine.clients !== 1 ? 's' : ''} asignado${routine.clients !== 1 ? 's' : ''}${asignados.length ? `<br><span>Para: ${escapeHtml(asignados.join(', '))}</span>` : ''} · ${routine.sessions} ${routine.sessions === 1 ? 'sesión' : 'sesiones'} / semana · ${routine.exercises.length} ejercicio${routine.exercises.length !== 1 ? 's' : ''} · ${routineVideoCount(routine)} con video${routine.dueOn ? `<br><span class="routine-due${dateOnly(routine.dueOn) < new Date().toISOString().slice(0, 10) ? ' overdue' : ''}">Fecha límite: ${fechaCorta(routine.dueOn)}</span>` : ''}</footer><div class="client-actions">${routine.assignedClientIds?.[0] ? `<button class="secondary" data-share-routine="${routine.id}">Enviar enlace</button>` : ''}<button class="secondary" data-open-routine="${routine.id}">Ver rutina</button><button class="secondary" data-edit-routine="${routine.id}">Editar</button><button class="secondary" data-duplicate-routine="${routine.id}">Reutilizar</button><button class="secondary" data-delete-routine="${routine.id}">Eliminar</button></div></article>`;
  }).join('');
}
function renderBillingInsights() {
  const chart = document.getElementById('billing-line-chart');
  const ranking = document.getElementById('top-payers-list');
  document.getElementById('billing-chart-year').textContent = billingYear === 'all' ? 'Histórico' : billingYear;
  document.getElementById('top-payers-summary').textContent = billingYear === 'all' ? 'Selecciona un año para comparar' : `Pagos recibidos en ${billingYear}`;
  if (billingYear === 'all') {
    chart.innerHTML = '<p class="empty">Selecciona un año específico para ver la tendencia mensual.</p>';
    ranking.innerHTML = '<p class="empty">Selecciona un año específico para ver el ranking anual.</p>';
    document.getElementById('billing-chart-summary').textContent = 'Evolución mensual en USD';
    return;
  }
  if (!billingAnalytics || String(billingAnalytics.year) !== billingYear) {
    chart.innerHTML = '<p class="empty">Calculando tendencia anual…</p>';
    ranking.innerHTML = '<p class="empty">Calculando ranking…</p>';
    return;
  }
  const months = billingAnalytics.months || [];
  const values = months.map(month => Number(month.amount || 0));
  const maxValue = Math.max(...values, 1);
  const left = 54; const top = 18; const plotWidth = 650; const plotHeight = 176;
  const points = values.map((value, index) => ({ x: left + (index * plotWidth / 11), y: top + plotHeight - (value / maxValue * plotHeight), value }));
  const line = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${left},${top + plotHeight} ${line} ${left + plotWidth},${top + plotHeight}`;
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const compactMoney = value => new Intl.NumberFormat('es-PA', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const grid = [0, .5, 1].map(ratio => {
    const y = top + plotHeight - ratio * plotHeight;
    return `<g><line x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}" /><text x="${left - 8}" y="${y + 4}" text-anchor="end">${compactMoney(maxValue * ratio)}</text></g>`;
  }).join('');
  const labels = monthNames.map((name, index) => `<text x="${points[index].x}" y="${top + plotHeight + 27}" text-anchor="middle">${name}</text>`).join('');
  const dots = points.map((point, index) => `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${monthNames[index]}: ${money.format(point.value)}</title></circle>`).join('');
  chart.innerHTML = `<svg viewBox="0 0 720 235" role="img" aria-label="Cobrado mensual de ${billingYear}"><g class="billing-chart-grid">${grid}${labels}</g><polygon class="billing-chart-area" points="${area}"/><polyline class="billing-chart-line" points="${line}"/>${dots}</svg>`;
  document.getElementById('billing-chart-summary').textContent = `${money.format(Number(billingAnalytics.totalBilled || 0))} cobrado en ${billingYear}`;
  const topClients = billingAnalytics.topClients || [];
  const topAmount = Math.max(...topClients.map(client => Number(client.amount || 0)), 1);
  ranking.innerHTML = topClients.length ? topClients.map((client, index) => `<div class="top-payer"><span class="top-payer-rank">${index + 1}</span><div class="top-payer-person"><b>${escapeHtml(client.name)}</b><small>${client.paymentCount} pago${client.paymentCount === 1 ? '' : 's'} confirmado${client.paymentCount === 1 ? '' : 's'}</small><i><span style="width:${Math.max(4, Number(client.amount || 0) / topAmount * 100)}%"></span></i></div><strong>${money.format(Number(client.amount || 0))}</strong></div>`).join('') : '<p class="empty">No hay pagos confirmados en este año.</p>';
}
async function ensureBillingAnalytics() {
  const year = billingYear;
  if (year === 'all') return renderBillingInsights();
  if (billingAnalytics && String(billingAnalytics.year) === year) return renderBillingInsights();
  renderBillingInsights();
  if (billingAnalyticsLoadingYear === year) return;
  billingAnalyticsLoadingYear = year;
  const requestId = ++billingAnalyticsRequest;
  try {
    const result = await api(`/api/billing/analytics?year=${year}`);
    if (requestId !== billingAnalyticsRequest || billingYear !== year) return;
    billingAnalytics = result; renderBillingInsights();
  } catch (error) {
    if (requestId !== billingAnalyticsRequest || billingYear !== year) return;
    document.getElementById('billing-line-chart').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    document.getElementById('top-payers-list').innerHTML = '<p class="empty">No se pudo cargar el ranking.</p>';
  } finally { if (requestId === billingAnalyticsRequest) billingAnalyticsLoadingYear = null; }
}

// En una mensualidad familiar, clientId es siempre quien paga. billedForClientId
// identifica a la persona cuya mensualidad está cubriendo esa línea: así se
// pueden mostrar dos cobros a nombre de Eduardo sin que el de Beatriz parezca
// duplicado o quede como una deuda a nombre de ella.
const esCobroFamiliar = invoice => invoice.billedForClientId !== invoice.clientId
  || data.clients.some(client => client.paysForMeId === invoice.clientId);
const detalleCobroFamiliar = invoice => {
  if (!esCobroFamiliar(invoice)) return '';
  return invoice.billedForClientId !== invoice.clientId
    ? `Cubre la mensualidad de ${invoice.billedFor}`
    : `Mensualidad propia de ${invoice.billedFor}`;
};
const clienteDeLaLinea = invoice => data.clients.find(client => client.id === invoice.billedForClientId)
  || data.clients.find(client => client.id === invoice.clientId);
const puedeAplicarMensualidad = invoice => invoice.status !== 'void'
  && !invoice.packageId && clienteDeLaLinea(invoice)?.billingModel === 'monthly';
const puedeAplicarPaquete = invoice => invoice.status !== 'void'
  && !invoice.packageId && clienteDeLaLinea(invoice)?.billingModel === 'package';
const facturaTieneSaldo = (invoice, kind) => {
  if (kind === 'monthly' && invoice.coverageApplied > 0) return true;
  return data.packages.some(pack => pack.originInvoiceId === invoice.id && pack.kind === kind);
};
const totalFamiliarDelCorte = invoice => {
  if (!esCobroFamiliar(invoice) || !invoice.autoGenerated) return null;
  const grupo = data.invoices.filter(otro => otro.clientId === invoice.clientId
    && otro.autoGenerated && otro.billingPeriod === invoice.billingPeriod && otro.status !== 'void');
  return grupo.length > 1 ? grupo.reduce((total, otro) => total + otro.amount, 0) : null;
};
function renderBilling() {
  const yearSelect = document.getElementById('billing-year');
  const availableYears = [...new Set([today.getFullYear(), ...data.invoices.map(invoice => invoicePeriodDate(invoice).getFullYear()).filter(Number.isFinite)])].sort((a, b) => b - a);
  yearSelect.replaceChildren(new Option('Todos los años', 'all'), ...availableYears.map(year => new Option(String(year), String(year))));
  if (billingYear !== 'all' && !availableYears.includes(Number(billingYear))) billingYear = String(availableYears[0]);
  yearSelect.value = billingYear;
  document.getElementById('billing-month').value = billingMonth;
  document.getElementById('billing-month').disabled = billingYear === 'all';
  document.getElementById('billing-source').value = billingSource;
  const clientFilter = document.getElementById('billing-client-filter');
  if (clientFilter && clientFilter.value !== billingClientFilter) clientFilter.value = billingClientFilter;
  const billingBack = document.getElementById('billing-back-from-zoho');
  if (billingBack) billingBack.hidden = billingSource !== 'zoho_invoice';
  const periodInvoices = billingPeriodInvoices();
  const visibleInvoices = periodInvoices.slice(0, billingVisibleInvoices);
  const billed = periodInvoices.filter(item => item.status !== 'void').reduce((sum, item) => sum + item.amount, 0);
  const pending = periodInvoices.filter(item => item.status === 'pending').reduce((sum, item) => sum + Number(item.balance ?? item.amount ?? 0), 0);
  // Cobrado del período = lo pagado de las facturas del período, para que cuadre:
  // facturado = cobrado + por cobrar. (La gráfica anual mide otra cosa: dinero
  // recibido por fecha de pago, que puede cruzar meses.)
  const collected = periodInvoices.filter(item => item.status !== 'void').reduce((sum, item) => sum + Number(item.paidAmount || 0), 0);
  const periodTitle = billingYear === 'all'
    ? 'Histórico completo'
    : billingMonth === 'all'
    ? `Año ${billingYear}`
    : new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(new Date(Number(billingYear), Number(billingMonth) - 1, 1));
  document.getElementById('billing-period-title').textContent = periodTitle.charAt(0).toUpperCase() + periodTitle.slice(1);
  document.getElementById('billed-period-label').textContent = billingYear === 'all' ? 'Facturado en el histórico' : billingMonth === 'all' ? 'Facturado en el año' : 'Facturado en el mes';
  const sourceName = billingSource === 'zoho_invoice' ? 'Zoho Invoice' : billingSource === 'eileen' ? 'Eileen' : 'todos los orígenes';
  const clientFilterNote = billingClientFilter.trim() ? ` · Cliente: ${billingClientFilter.trim()}` : '';
  document.getElementById('billing-table-summary').textContent = `${periodInvoices.length} factura${periodInvoices.length !== 1 ? 's' : ''} de ${sourceName}${clientFilterNote} · Mostrando ${Math.min(visibleInvoices.length, periodInvoices.length)}`;
  document.getElementById('month-billed').textContent = money.format(billed);
  const collectedTile = document.getElementById('billing-collected');
  if (collectedTile) collectedTile.textContent = money.format(collected);
  const collectedLbl = document.getElementById('collected-period-label');
  if (collectedLbl) collectedLbl.textContent = billingYear === 'all' ? 'Cobrado en el histórico' : billingMonth === 'all' ? 'Cobrado en el año' : 'Cobrado en el mes';
  document.getElementById('active-memberships').textContent = data.clients.filter(client => client.billingModel === 'monthly' && client.status === 'Activo').length;
  document.getElementById('active-packages').textContent = data.packages.filter(pack => pack.status === 'confirmed' && remainingSessions(pack) > 0).length;
  document.getElementById('billing-pending').textContent = money.format(pending);
  const planZoneFilter = document.getElementById('plan-zone-filter');
  const planSessionsFilter = document.getElementById('plan-sessions-filter');
  const planZones = ['Costa del Este', 'Paitilla', 'San Francisco', 'La Cresta'];
  if (planZoneFilter) {
    const current = planZoneFilter.value;
    planZoneFilter.replaceChildren(new Option('Todas las zonas', ''), ...planZones.map(zone => new Option(zone, zone)), ...data.plans.filter(plan => plan.zone && !planZones.includes(plan.zone)).map(plan => new Option(plan.zone, plan.zone)));
    planZoneFilter.value = [...planZoneFilter.options].some(option => option.value === current) ? current : '';
  }
  if (planSessionsFilter) {
    const current = planSessionsFilter.value;
    const sessions = [...new Set(data.plans.map(plan => plan.sessionsIncluded).filter(Number))].sort((a, b) => a - b);
    planSessionsFilter.replaceChildren(new Option('Todas las cantidades', ''), ...sessions.map(count => new Option(`${count} sesiones`, String(count))));
    planSessionsFilter.value = sessions.some(count => String(count) === current) ? current : '';
  }
  if (planZoneFilter) planZoneFilter.onchange = renderBilling;
  if (planSessionsFilter) planSessionsFilter.onchange = renderBilling;
  const visiblePlans = data.plans.filter(plan => (!planZoneFilter?.value || plan.zone === planZoneFilter.value) && (!planSessionsFilter?.value || String(plan.sessionsIncluded) === planSessionsFilter.value));
  document.getElementById('plan-grid').innerHTML = visiblePlans.length ? visiblePlans.map(plan => `<article class="plan-card ${plan.active ? '' : 'inactive'}"><div><span class="commercial-label ${plan.billingModel === 'package' ? 'package-label' : ''}${plan.billingModel === 'single' ? ' single-label' : ''}">${modalidadPlan(plan.billingModel)}</span>${plan.zone ? `<span class="plan-zone">${escapeHtml(plan.zone)}</span>` : ''}${plan.specialFor ? `<span class="plan-special">Tarifa especial · ${escapeHtml(plan.specialFor)}</span>` : ''}<h4>${escapeHtml(plan.name)}</h4><p>${escapeHtml(plan.description || (plan.billingModel === 'package' ? `${plan.sessionsIncluded} sesiones · ${plan.validityDays} días` : plan.billingModel === 'single' ? 'Se cobra por sesión' : `${plan.sessionsIncluded} sesiones / mes`))}</p></div><div class="plan-price"><strong>${money.format(plan.price)}</strong><small>${plan.active ? 'Disponible' : 'Inactivo'}</small></div><button class="text-button" data-edit-plan="${plan.id}">Editar</button></article>`).join('') : '<p class="empty">No hay tarifas con estos filtros.</p>';
  document.getElementById('invoice-table').innerHTML = visibleInvoices.length ? visibleInvoices.map(invoice => {
    const parcial = invoice.status === 'pending' && invoice.paidAmount > 0 && invoice.balance > 0;
    const label = invoice.status === 'confirmed' ? 'Confirmado' : invoice.status === 'void' ? 'Anulada' : parcial ? 'Pago parcial' : 'Pago pendiente';
    const detalleFamiliar = detalleCobroFamiliar(invoice);
    const totalFamiliar = totalFamiliarDelCorte(invoice);
    const notaFamiliar = detalleFamiliar ? `<br><small class="invoice-family-note">${escapeHtml(detalleFamiliar)}</small>` : '';
    const notaTotal = totalFamiliar ? `<br><small class="invoice-family-total">Total familiar del corte: ${money.format(totalFamiliar)}</small>` : '';
    const concept = invoice.invoiceNumber ? `<small>${invoice.source === 'zoho_invoice' ? 'Zoho' : 'Eileen'} · ${escapeHtml(invoice.invoiceNumber)}</small><br>${escapeHtml(invoice.concept)}${notaFamiliar}` : `${escapeHtml(invoice.concept)}${notaFamiliar}`;
    const local = invoice.source !== 'zoho_invoice';
    const notaPagador = esCobroFamiliar(invoice) ? `<br><small class="invoice-payer-note">Pagador familiar${notaTotal}</small>` : '';
    const origen = invoice.source === 'zoho_invoice' ? '<span class="inv-tag inv-zoho">Zoho</span>' : invoice.autoGenerated ? '<span class="inv-tag inv-auto">Automática</span>' : '<span class="inv-tag inv-manual">Manual</span>';
    const mensualidadAplicada = facturaTieneSaldo(invoice, 'monthly');
    const paqueteAplicado = facturaTieneSaldo(invoice, 'package') || Boolean(invoice.packageId);
    const coberturaAutomatica = (invoice.autoGenerated || invoice.creditInvoice) && invoice.source !== 'zoho_invoice';
    // La confirmación del pago abre la cobertura automáticamente en los cobros
    // propios. No mostramos un segundo paso ni una etiqueta de “aplicada” que
    // sugiera que Eileen debe volver a intervenir. Zoho y cobros manuales sin
    // vínculo conservan la acción manual cuando todavía hace falta.
    const aplicarMensualidad = puedeAplicarMensualidad(invoice) && !coberturaAutomatica
      ? mensualidadAplicada ? '' : `<button class="secondary session-use" data-apply-coverage="${invoice.id}">Aplicar a mensualidades</button>`
      : '';
    const paqueteVinculadoAutomaticamente = Boolean(invoice.packageId);
    const aplicarPaquete = paqueteAplicado || paqueteVinculadoAutomaticamente
      ? ''
      : puedeAplicarPaquete(invoice) ? `<button class="secondary session-use" data-apply-package="${invoice.id}">Aplicar a paquete</button>` : '';
    const recalcularFactura = invoice.creditInvoice && local && invoice.status !== 'void'
      ? `<button class="secondary session-use" data-recalculate-invoice="${invoice.id}">Recalcular factura</button>` : '';
    return `<tr><td data-label="Cliente"><b>${escapeHtml(invoice.client)}</b>${notaPagador}</td><td data-label="Concepto">${origen}<br>${concept}</td><td data-label="Vence">${fechaCorta(invoice.due)}</td><td data-label="Método">${invoice.method === 'pending' ? '—' : escapeHtml(invoice.method)}</td><td data-label="Monto">${money.format(invoice.amount)}${invoice.balance > 0 && invoice.balance !== invoice.amount ? `<br><small>Saldo ${money.format(invoice.balance)}</small>` : ''}</td><td data-label="Estado"><span class="payment-status ${invoice.status}">${label}</span></td><td data-label="Acciones"><div class="invoice-actions"><button class="secondary session-use" data-invoice-pdf="${invoice.id}" data-invoice-number="${escapeHtml(invoice.invoiceNumber || invoice.id.slice(0, 8))}">Ver PDF</button>${recalcularFactura}${aplicarMensualidad}${aplicarPaquete}${invoice.status === 'pending' && local ? `<button class="secondary session-use" data-confirm-invoice="${invoice.id}">${parcial ? 'Registrar saldo' : 'Confirmar pago'}</button><button class="secondary session-use" data-edit-invoice="${invoice.id}">Editar</button><button class="secondary session-use" data-delete-invoice="${invoice.id}">Anular</button><button class="secondary session-use" data-purge-invoice="${invoice.id}">Borrar</button>` : ''}${invoice.status === 'void' && local ? `<button class="secondary session-use" data-purge-invoice="${invoice.id}">Borrar definitivamente</button>` : ''}${invoice.status === 'confirmed' && local ? `<button class="secondary session-use" data-edit-payment="${invoice.id}">Editar pago</button><button class="secondary session-use" data-purge-invoice="${invoice.id}">Borrar definitivamente</button>` : ''}</div></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">No hay facturas con estos filtros.</td></tr>';
  const loadMore = document.getElementById('billing-load-more'); loadMore.hidden = visibleInvoices.length >= periodInvoices.length; loadMore.textContent = `Mostrar más facturas (${periodInvoices.length - visibleInvoices.length} restantes)`;
  void ensureBillingAnalytics();
}
function attendanceClientMatches() {
  const needle = attendanceClientFilter.trim().toLocaleLowerCase('es');
  return data.clients.filter(client => !needle || String(client.name || '').toLocaleLowerCase('es').includes(needle));
}
function attendanceCutClient() {
  const matches = attendanceClientMatches();
  return matches.length === 1 ? matches[0] : null;
}
function attendancePeriodKey() {
  const cutoffClient = attendanceCurrentCutOnly ? attendanceCutClient() : null;
  if (cutoffClient) return `cutoff:${cutoffClient.id}:${attendanceCutOffset}`;
  return attendanceFrom && attendanceTo
    ? `range:${attendanceFrom}:${attendanceTo}`
    : `month:${attendanceMonth}`;
}
function attendanceCutPosition() {
  return attendanceCutOffset ? `Corte anterior · ${attendanceCutOffset}` : 'Corte vigente';
}
function renderAttendanceReport() {
  const monthInput = document.getElementById('attendance-month');
  const fromInput = document.getElementById('attendance-from');
  const toInput = document.getElementById('attendance-to');
  const clientFilterInput = document.getElementById('attendance-client-filter');
  const currentCutInput = document.getElementById('attendance-current-cut');
  const target = document.getElementById('attendance-table');
  const totals = document.getElementById('attendance-totals');
  const summary = document.getElementById('attendance-summary');
  const periodHighlight = document.getElementById('attendance-period-highlight');
  const periodKind = document.getElementById('attendance-period-kind');
  const periodDates = document.getElementById('attendance-period-dates');
  const periodDetail = document.getElementById('attendance-period-detail');
  const cutNav = document.getElementById('attendance-cut-nav');
  const cutPosition = document.getElementById('attendance-cut-position');
  const cutNext = document.getElementById('attendance-cut-next');
  if (!monthInput || !fromInput || !toInput || !clientFilterInput || !currentCutInput || !target || !totals || !summary) return;
  monthInput.value = attendanceMonth;
  fromInput.value = attendanceFrom;
  toInput.value = attendanceTo;
  if (clientFilterInput.value !== attendanceClientFilter) clientFilterInput.value = attendanceClientFilter;
  const cutClient = attendanceCutClient();
  currentCutInput.checked = attendanceCurrentCutOnly;
  currentCutInput.disabled = !cutClient;
  document.querySelectorAll('[data-attendance-status]').forEach(input => {
    input.checked = Boolean(attendanceStatusFilters[input.value]);
  });
  const requestedPeriodKey = attendancePeriodKey();
  if (!attendanceReport || attendanceReport.periodKey !== requestedPeriodKey) {
    if (periodHighlight) periodHighlight.hidden = true;
    if (cutNav) cutNav.hidden = true;
    summary.textContent = attendanceReportLoading ? 'Calculando…' : 'Selecciona un mes o aplica un rango para consultar la agenda.';
    totals.innerHTML = '';
    target.innerHTML = `<tr><td colspan="9" class="empty">${attendanceReportLoading ? 'Cargando agenda y cumplimiento…' : 'No hay datos cargados para este período.'}</td></tr>`;
    return;
  }
  const clientNeedle = attendanceClientFilter.trim().toLocaleLowerCase('es');
  const clients = attendanceReport.clients.filter(client => Boolean(attendanceStatusFilters[client.status])
    && (!clientNeedle || String(client.name || '').toLocaleLowerCase('es').includes(clientNeedle)));
  const sum = key => clients.reduce((total, client) => total + Number(client[key] || 0), 0);
  const medibles = sum('medibles');
  const weightedCompliance = clients.reduce((total, client) => (
    total + (client.compliancePercent === null ? 0 : client.compliancePercent * client.medibles)
  ), 0);
  const t = {
    agendadas: sum('agendadas'),
    futuras: sum('futuras'),
    completadas: sum('completadas'),
    noShow: sum('noShow'),
    canceladasCliente: sum('canceladasCliente'),
    pausadas: sum('pausadas'),
    medibles,
    compliancePercent: medibles ? Math.round(weightedCompliance / medibles) : null
  };
  const pausedHidden = attendanceStatusFilters.paused ? 0 : attendanceReport.clients.filter(client => client.status === 'paused').length;
  const pausedNote = pausedHidden
    ? ` · ${pausedHidden} ${pausedHidden === 1 ? 'cliente en pausa oculto' : 'clientes en pausa ocultos'}; activa “En pausa” para verlo${pausedHidden === 1 ? '' : 's'}`
    : '';
  const periodLabel = attendanceReport.period?.from === attendanceReport.period?.to
    ? fechaCorta(attendanceReport.period.from)
    : `${fechaCorta(attendanceReport.period?.from)} al ${fechaCorta(attendanceReport.period?.to)}`;
  const clientNote = clientNeedle ? ` · Cliente: ${attendanceClientFilter.trim()}` : '';
  const cutNote = attendanceCurrentCutOnly && cutClient ? ` · ${attendanceCutPosition()} (día ${cutClient.cutoffDay})` : '';
  summary.textContent = `${periodLabel} · ${clients.length} clientes · ${t.agendadas} clases en el calendario · ${t.medibles} sesiones medidas${clientNote}${cutNote}${pausedNote}`;
  if (periodHighlight) {
    periodHighlight.hidden = false;
    if (periodKind) periodKind.textContent = attendanceCurrentCutOnly ? attendanceCutPosition() : attendanceFrom && attendanceTo ? 'Rango personalizado' : 'Mes consultado';
    if (periodDates) periodDates.textContent = periodLabel;
    if (periodDetail) periodDetail.textContent = attendanceCurrentCutOnly && cutClient
      ? `${cutClient.name} · día de corte ${cutClient.cutoffDay} · datos del expediente`
      : 'Las métricas se calculan con las sesiones del período seleccionado';
    if (cutNav) cutNav.hidden = !attendanceCurrentCutOnly || !cutClient;
    if (cutPosition) cutPosition.textContent = attendanceCutPosition();
    if (cutNext) cutNext.disabled = attendanceCutOffset === 0;
  }
  const tile = (label, value, note = '') => `<article><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</article>`;
  totals.innerHTML = [
    tile('Clases agendadas', t.agendadas),
    tile('Cumplidas', t.completadas),
    tile('Cancelaciones cliente', t.canceladasCliente, t.noShow ? `${t.noShow} no asistió` : ''),
    tile('Cumplimiento', t.compliancePercent === null ? '—' : `${t.compliancePercent}%`, `${t.medibles} sesiones medidas`),
    tile('Pausadas', t.pausadas, 'fuera de la métrica')
  ].join('');
  const estado = client => {
    if (client.status === 'active') return { label: 'Activo', className: 'active' };
    if (client.status === 'paused') return { label: 'En pausa', className: 'paused' };
    return { label: 'Inactivo', className: 'inactive' };
  };
  target.innerHTML = clients.map(client => {
    const compliance = client.compliancePercent === null ? '—' : `${client.compliancePercent}%`;
    const estadoCliente = estado(client);
    return `<tr><td data-label="Cliente"><b>${escapeHtml(client.name)}</b><br><small class="attendance-client-status attendance-status-${estadoCliente.className}">${estadoCliente.label}</small></td>
      <td data-label="Agendadas"><b>${client.agendadas}</b></td>
      <td data-label="Cumplió">${client.completadas}</td>
      <td data-label="Canceló cliente">${client.canceladasCliente}</td>
      <td data-label="Reprogramadas">${client.reprogramadas}</td>
      <td data-label="Pausa">${client.pausadas}</td>
      <td data-label="Canceló Eileen">${client.canceladasEntrenadora}</td>
      <td data-label="Medibles">${client.medibles}</td>
      <td data-label="Cumplimiento"><strong class="attendance-percent">${compliance}</strong></td></tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No hay clientes en el expediente.</td></tr>';
}
async function loadAttendanceReport() {
  const cutoffClient = attendanceCurrentCutOnly ? attendanceCutClient() : null;
  if (attendanceCurrentCutOnly && !cutoffClient) {
    attendanceCurrentCutOnly = false;
    attendanceCutOffset = 0;
  }
  const periodKey = attendancePeriodKey();
  const query = cutoffClient
    ? `cutoffClientId=${encodeURIComponent(cutoffClient.id)}&cutoffOffset=${attendanceCutOffset}`
    : attendanceFrom && attendanceTo
      ? `from=${encodeURIComponent(attendanceFrom)}&to=${encodeURIComponent(attendanceTo)}`
      : `month=${encodeURIComponent(attendanceMonth)}`;
  const requestId = ++attendanceReportRequest;
  attendanceReportLoading = true;
  renderAttendanceReport();
  try {
    const report = await api(`/api/attendance/monthly?${query}`);
    if (requestId !== attendanceReportRequest) return;
    const currentPeriodKey = attendancePeriodKey();
    if (currentPeriodKey !== periodKey) return;
    attendanceReport = report;
    renderAttendanceReport();
  } catch (error) {
    if (requestId !== attendanceReportRequest) return;
    const target = document.getElementById('attendance-table');
    if (target) target.innerHTML = `<tr><td colspan="10" class="empty">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    if (requestId === attendanceReportRequest) { attendanceReportLoading = false; renderAttendanceReport(); }
  }
}
function renderAll() { renderDashboard(); renderClients(); renderGoogleCalendar(); renderCalendar(); renderRoutines(); renderBilling(); renderAttendanceReport(); if (document.getElementById('billing')?.classList.contains('active') && document.querySelector('#billing .subtab.active')?.dataset.subtab === 'facturas-nuevo') newBillingInvoices(); }
const modal = document.getElementById('modal');
function openModal(content, wide = false) { modal.classList.toggle('modal-wide', wide); document.getElementById('modal-content').replaceChildren(content); if (!modal.open) modal.showModal(); }
function formFromTemplate(id) { return document.getElementById(id).content.cloneNode(true); }
async function protectedBlob(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { localStorage.removeItem(authKey); authToken = null; }
    throw new Error(payload.error || 'No fue posible generar el documento');
  }
  return response.blob();
}
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function previewProtectedPdf(path, title, fileName) {
  const loading = document.createElement('div'); loading.className = 'pdf-loading'; loading.innerHTML = `<p class="eyebrow">DOCUMENTO PDF</p><h2>${escapeHtml(title)}</h2><p>Preparando una vista privada…</p>`; openModal(loading, true);
  try {
    // La URL lleva el NOMBRE del archivo (p. ej. factura-FAC-0031.pdf): así el visor del navegador, "Abrir PDF" y "Descargar" lo guardan con ese nombre y no con un código.
    const { id: ticket } = await api('/api/pdf-tickets', { method: 'POST', body: { path } });
    const url = `${API_BASE}/api/pdf-ticket/${ticket}/${encodeURIComponent(fileName)}`; const content = document.createElement('div'); content.className = 'pdf-preview';
    content.innerHTML = `<div class="pdf-preview-head"><div><p class="eyebrow">DOCUMENTO PDF</p><h2>${escapeHtml(title)}</h2></div><div class="pdf-actions"><a class="secondary" href="${url}" target="_blank" rel="noopener">Abrir PDF</a><a class="primary" href="${url}?download=1" download="${escapeHtml(fileName)}">Descargar</a></div></div><iframe src="${url}" title="${escapeHtml(title)}"></iframe><p class="pdf-mobile-note">Si la vista no aparece en iPhone o iPad, toca “Abrir PDF”.</p>`;
    openModal(content, true);
  } catch (error) { modal.close(); toast(error.message, true); }
}
const selectedReportDates = () => {
  if (billingYear === 'all') {
    const available = data.invoices.map(invoicePeriodDate).filter(value => !Number.isNaN(value.getTime())).sort((a, b) => a - b);
    return { from: available.length ? dateKey(available[0]) : `${today.getFullYear()}-01-01`, to: dateKey(today) };
  }
  const year = Number(billingYear);
  const month = billingMonth === 'all' || billingYear === 'all' ? null : Number(billingMonth);
  return month
    ? { from: dateKey(new Date(year, month - 1, 1, 12)), to: dateKey(new Date(year, month, 0, 12)) }
    : { from: `${year}-01-01`, to: `${year}-12-31` };
};
// Lo pendiente de cobro, a la vista. El diálogo sólo ofrecía generar un PDF:
// para saber quién debe había que exportar un reporte y abrirlo.
function listaPorCobrar() {
  const pendientes = data.invoices
    .filter(factura => factura.status === 'pending')
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  if (!pendientes.length) return '<p class="empty">No hay facturas pendientes de cobro.</p>';
  const hoy = dateKey(today);
  const total = pendientes.reduce((suma, factura) => suma + Number(factura.balance || factura.amount), 0);
  return `<p class="section-note">${pendientes.length} factura${pendientes.length === 1 ? '' : 's'} sin cobrar · ${money.format(total)}</p>
    <div class="gasto-lista">${pendientes.map(factura => {
      const vencida = String(factura.due) < hoy;
      return `<article class="gasto-item">
        <div><b>${escapeHtml(factura.client)}</b><small>${escapeHtml(factura.concept)} · vence ${factura.due}${vencida ? ' · <span class="por-cobrar-vencida">vencida</span>' : ''}</small></div>
        <span class="gasto-monto">${money.format(factura.balance || factura.amount)}</span>
      </article>`;
    }).join('')}</div>`;
}

// Informe mensual: cobros, gastos y resumen de un mes, filtrable por categoría
// de gasto, para ver en pantalla y descargar en CSV (Excel) o PDF (imprimir).
function renderInforme(d) {
  const r = d.resumen;
  const metric = (label, val) => `<article><span>${label}</span><strong>${money.format(Number(val) || 0)}</strong></article>`;
  const filaCobro = c => `<tr><td>${fechaCorta(dateOnly(c.fecha))}</td><td>${escapeHtml(c.cliente || '')}</td><td>${escapeHtml(c.concepto || '')}</td><td>${escapeHtml(c.metodo || '')}</td><td>${money.format(Number(c.monto))}</td></tr>`;
  const filaGasto = g => `<tr><td>${fechaCorta(dateOnly(g.fecha))}</td><td>${escapeHtml(g.descripcion || '')}</td><td>${escapeHtml(g.categoria || '')}</td><td>${g.ambito === 'negocio' ? 'Negocio' : 'Personal'}</td><td>${money.format(Number(g.monto))}</td></tr>`;
  const cobros = d.cobros.length ? `<div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Fecha</th><th>Cliente</th><th>Concepto</th><th>Método</th><th>Monto</th></tr></thead><tbody>${d.cobros.map(filaCobro).join('')}</tbody></table></div>` : '<p class="empty">Sin cobros este mes.</p>';
  const gastos = d.gastos.length ? `<div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Ámbito</th><th>Monto</th></tr></thead><tbody>${d.gastos.map(filaGasto).join('')}</tbody></table></div>` : '<p class="empty">Sin gastos este mes.</p>';
  return `<div class="metrics" style="grid-template-columns:repeat(3,1fr)">${metric('Ingresos', r.ingresos)}${metric('Gastos', r.gastos)}${metric('Margen', r.margen)}</div>
    <p class="eyebrow" style="margin-top:18px">COBROS RECIBIDOS · ${d.cobros.length}</p>${cobros}
    <p class="eyebrow" style="margin-top:18px">GASTOS · ${d.gastos.length} · Negocio ${money.format(Number(r.negocio) || 0)} · Personal ${money.format(Number(r.personal) || 0)}</p>${gastos}`;
}
async function descargarInforme(formato, box) {
  const mes = box.querySelector('#informe-mes').value;
  const cat = box.querySelector('#informe-cat').value;
  if (!mes) return;
  const url = `${API_BASE}/api/finance/monthly.${formato}?month=${mes}${cat ? `&categoryId=${cat}` : ''}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!resp.ok) throw new Error('No se pudo generar el informe');
    const blobUrl = URL.createObjectURL(await resp.blob());
    const link = document.createElement('a'); link.href = blobUrl; link.download = `informe-${mes}.${formato}`; link.click();
    URL.revokeObjectURL(blobUrl);
  } catch (error) { toast(error.message, true); }
}
async function informeMensual() {
  const box = document.createElement('div');
  const mesActual = dateKey(today).slice(0, 7);
  box.innerHTML = `<p class="eyebrow">FINANZAS</p><h2>Informe mensual</h2>
    <div class="form-row">
      <label>Mes<input type="month" id="informe-mes" value="${mesActual}" /></label>
      <label>Categoría de gasto<select id="informe-cat"><option value="">Todas</option></select></label>
    </div>
    <div id="informe-body"><p class="empty">Cargando…</p></div>
    <div class="detail-actions"><button type="button" class="secondary" id="informe-csv">Descargar CSV</button><button type="button" class="secondary" id="informe-pdf">Descargar PDF</button></div>`;
  openModal(box, true);
  api('/api/expense-categories').then(cats => {
    const sel = box.querySelector('#informe-cat');
    (cats || []).filter(c => !c.archived).forEach(c => sel.add(new Option(c.name, c.id)));
  }).catch(() => {});
  const cargar = async () => {
    const mes = box.querySelector('#informe-mes').value;
    const cat = box.querySelector('#informe-cat').value;
    const body = box.querySelector('#informe-body');
    if (!mes) { body.innerHTML = '<p class="empty">Elige un mes.</p>'; return; }
    body.innerHTML = '<p class="empty">Cargando…</p>';
    try { body.innerHTML = renderInforme(await api(`/api/finance/monthly?month=${mes}${cat ? `&categoryId=${cat}` : ''}`)); }
    catch (error) { body.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
  };
  box.querySelector('#informe-mes').addEventListener('change', cargar);
  box.querySelector('#informe-cat').addEventListener('change', cargar);
  box.querySelector('#informe-csv').onclick = () => descargarInforme('csv', box);
  box.querySelector('#informe-pdf').onclick = () => descargarInforme('pdf', box);
  cargar();
}

function financialReportDialog(kind) {
  const isStatement = kind === 'account-statement'; const dates = selectedReportDates(); const box = document.createElement('div');
  if (isStatement && !data.clients.length) { toast('Agrega un cliente antes de crear un estado de cuenta', true); return; }
  box.innerHTML = `<form id="financial-report-form"><p class="eyebrow">REPORTES FINANCIEROS</p><h2>${isStatement ? 'Estado de cuenta' : 'Cuentas por cobrar'}</h2><p class="report-form-copy">${isStatement ? 'Selecciona el cliente y período que deseas compartir.' : 'Obtén el detalle de saldos vigentes y su antigüedad a una fecha de corte.'}</p>${isStatement ? `<label>Cliente<select name="clientId" required>${data.clients.map(client => `<option value="${client.id}">${escapeHtml(client.name)}</option>`).join('')}</select></label><div class="form-row"><label>Desde<input name="from" type="date" value="${dates.from}" required /></label><label>Hasta<input name="to" type="date" value="${dates.to}" required /></label></div>` : `${listaPorCobrar()}<label>Fecha de corte<input name="asOf" type="date" value="${dateKey(today)}" required /></label>`}<div class="report-format-actions"><button class="primary" type="submit" data-format="pdf">Previsualizar PDF</button><button class="secondary" type="submit" data-format="csv">Exportar CSV</button></div></form>`;
  openModal(box);
  document.getElementById('financial-report-form').addEventListener('submit', async event => {
    event.preventDefault(); const format = event.submitter?.dataset.format || 'pdf'; const values = new FormData(event.currentTarget); const query = new URLSearchParams();
    if (isStatement) { query.set('clientId', values.get('clientId')); query.set('from', values.get('from')); query.set('to', values.get('to')); }
    else query.set('asOf', values.get('asOf'));
    const base = isStatement ? 'account-statement' : 'accounts-receivable'; const path = `/api/reports/${base}.${format}?${query}`;
    const datedName = isStatement ? `estado-de-cuenta-${values.get('from')}-${values.get('to')}` : `cuentas-por-cobrar-${values.get('asOf')}`;
    try {
      if (format === 'pdf') await previewProtectedPdf(path, isStatement ? 'Estado de cuenta' : 'Cuentas por cobrar', `${datedName}.pdf`);
      else { event.submitter.disabled = true; downloadBlob(await protectedBlob(path), `${datedName}.csv`); modal.close(); toast('Reporte CSV exportado'); }
    } catch (error) { toast(error.message, true); if (event.submitter) event.submitter.disabled = false; }
  });
}
function newClient() {
  const availablePlans = data.plans.filter(plan => plan.active);
  if (!availablePlans.length) { navigate('billing'); toast('Crea un plan comercial antes de agregar clientes', true); return; }
  const content = formFromTemplate('new-client-template'); openModal(content);
  const planSelect = document.getElementById('client-plan'); availablePlans.forEach(plan => planSelect.add(new Option(`${plan.name} · ${money.format(plan.price)}${plan.billingModel === 'package' ? ` · ${plan.sessionsIncluded} sesiones` : plan.billingModel === 'single' ? ' por sesión' : '/mes'}`, plan.id)));
  document.getElementById('client-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const selectedPlan = data.plans.find(plan => plan.id === form.get('planId'));
    if (!confirmarGuardado(`Nuevo expediente: ${form.get('name')}\nPlan ${selectedPlan?.name || 'sin plan'} · corte día ${form.get('cutoffDay')}`)) return;
    try {
      event.target.classList.add('loading-state');
      await api('/api/clients', { method: 'POST', body: { fullName: form.get('name'), goal: form.get('goal'), planId: form.get('planId'), cutoffDay: Number(form.get('cutoffDay')), billingModel: selectedPlan?.billingModel || 'monthly', standardPrice: selectedPlan?.price || 0, packageSessions: selectedPlan?.sessionsIncluded || undefined, email: form.get('email') } });
      await loadData(); renderAll(); modal.close(); navigate('clients'); toast('Cliente creado y sincronizado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function editClient(client) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="edit-client-form"><p class="eyebrow">CONTACTO Y EXPEDIENTE</p><h2>Editar cliente</h2><label>Nombre completo<input name="fullName" required value="${escapeHtml(client.name)}" /></label><label>Correo electrónico<input name="email" type="email" value="${escapeHtml(client.email)}" /></label><label>Teléfono<input name="phone" value="${escapeHtml(client.phone)}" /></label><label>Meta principal<input name="goal" value="${escapeHtml(client.goal)}" /></label><label>Sesiones esperadas al mes<input name="monthlySessionTarget" type="number" min="1" max="31" value="${client.monthlySessionTarget ?? ''}" placeholder="Sin meta pactada" /><small>Cambiarlo aplica desde el próximo corte; el saldo del ciclo en curso no se modifica.</small></label><label>Quién paga<select name="billingResponsibleClientId" id="client-payer"><option value="">Paga por sí mismo</option></select><small>Plan familiar: el saldo de sesiones y los cobros van a nombre de quien paga. El progreso y la asistencia siguen siendo de cada uno.</small></label><p class="section-note">Meta contra la cual se mide el cumplimiento mensual. Déjala vacía para derivarla del paquete o de la rutina activa.</p><label>Notas privadas<textarea name="notes" rows="3">${escapeHtml(client.notes)}</textarea></label>${client.billingModel === 'monthly' ? `<label>Monto mensual de este cliente<input name="standardPrice" type="number" min="0.01" max="100000" step="0.01" value="${client.plan > 0 ? client.plan.toFixed(2) : ''}" placeholder="Sin monto propio" /><small>Precio propio del expediente. Déjalo vacío para conservar el valor actual. Sólo se valida y aplica cuando lo modificas.</small></label>` : ''}<label>Plan comercial<select name="planId" id="edit-client-plan"></select><small>Cambiarlo actualiza su precio, su membresía y su meta de sesiones.</small></label><label>Día de corte<input name="cutoffDay" type="number" min="1" max="31" required value="${client.cutoffDay}" /><small>El día del mes en que se le cobra la mensualidad.</small></label><label>Modalidad de pago<select name="paymentMode"><option value="anticipado"${client.paymentMode !== 'no_anticipado' ? ' selected' : ''}>Anticipado (paga por adelantado)</option><option value="no_anticipado"${client.paymentMode === 'no_anticipado' ? ' selected' : ''}>No anticipado (entrena y paga al final)</option></select><small>No anticipado: cobra sólo las sesiones impartidas a la tarifa pactada. El cliente puede entrenar aunque la factura esté pendiente.</small></label>${client.paymentMode === 'no_anticipado' ? `<label>Tarifa por sesión a crédito<input name="creditSessionPrice" type="number" min="0.01" step="0.01" value="${client.creditSessionPrice || 25}" /><small>Se usa para clientes no anticipados, como Julio. Las cancelaciones cobrables aparecen detalladas en la factura.</small></label>` : ''}<label>Estado<select name="status">${[['active', 'Activo'], ['paused', 'En pausa'], ['inactive', 'Inactivo']].map(([valor, texto]) => `<option value="${valor}"${client.statusRaw === valor ? ' selected' : ''}>${texto}</option>`).join('')}</select><small>Un cliente inactivo conserva su expediente, su historial y sus cobros, pero desaparece de la agenda y de los listados del día a día.</small></label><section class="declarative-billing"><p class="eyebrow">PLAN DE FACTURACIÓN</p><p class="section-note">Preparado para el sistema nuevo; hoy la facturación automática sigue usando el monto mensual del cliente.</p><div id="client-billing-subscriptions-editor"><p class="empty">Cargando conceptos a facturar…</p></div><button type="button" class="secondary wide-button" id="add-billing-subscription">Agregar concepto a facturar</button></section><button class="primary wide-button">Guardar cambios</button>
    <button type="button" class="secondary wide-button" id="borrar-expediente">Eliminar expediente</button>
    <p class="section-note">Para expedientes duplicados o creados por error. Se lleva su historial, mediciones, documentos y cobros. Si simplemente dejó de entrenar, ponlo Inactivo.</p></form>`;
  openModal(box);
  // Sólo pueden ser pagadores quienes no dependen de otro: encadenar dejaría el
  // saldo en un tercero imposible de rastrear.
  const planSel = document.getElementById('edit-client-plan');
  planSel.add(new Option('Sin plan asignado', ''));
  data.plans
    .filter(p => p.active || p.id === client.planId)
    .forEach(p => planSel.add(new Option(
      `${p.name} · ${money.format(p.price)}${p.billingModel === 'package' ? ` · ${p.sessionsIncluded} sesiones` : p.billingModel === 'single' ? ' por sesión' : '/mes'}${p.active ? '' : ' · inactivo'}`,
      p.id)));
  planSel.value = client.planId || '';
  loadBillingSubscriptionsEditor(client);
  document.getElementById('add-billing-subscription').onclick = () => billingSubscriptionDialog(client);

  document.getElementById('borrar-expediente').onclick = async () => {
    // Doble confirmación y escribiendo el nombre: borra InBody, documentos,
    // fotos y cobros de una persona, y no hay papelera donde recuperarlo.
    const escrito = prompt(`Se eliminará el expediente de ${client.name} con todo su historial: mediciones de InBody, documentos, fotos, sesiones y cobros. No se puede deshacer.\n\nEscribe el nombre completo para confirmar:`);
    if (escrito === null) return;
    if (escrito.trim().toLowerCase() !== client.name.trim().toLowerCase()) return toast('El nombre no coincide. No se borró nada.', true);
    try {
      await api(`/api/clients/${client.id}`, { method: 'DELETE' });
      await loadData(); renderAll(); modal.close(); toast('Expediente eliminado');
    } catch (error) { toast(error.message, true); }
  };
  const pagadores = document.getElementById('client-payer');
  data.clients.filter(item => item.id !== client.id && !item.paysForMeId)
    .forEach(item => pagadores.add(new Option(item.name, item.id)));
  if (client.paysForMeId) pagadores.value = client.paysForMeId;
  document.getElementById('edit-client-form').addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(event.target);
    const planElegido = values.get('planId') || '';
    // Se llama a /plan únicamente cuando cambia el plan comercial. Guardar de
    // nuevo el expediente no debe recrear saldos ni resetear un precio propio.
    const cambiaDePlan = planElegido && planElegido !== (client.planId || '');
    const datos = Object.fromEntries(values);
    // Un mensual con precio actual 0 muestra el campo vacío. Omitirlo significa
    // "no cambiar el monto", no un valor inválido ni un intento de membresía.
    if (datos.standardPrice === '') delete datos.standardPrice;
    // El plan no va en el PATCH general: tiene su propio endpoint porque
    // cambiarlo arrastra precio, membresía, saldo de sesiones y meta de
    // cumplimiento. Aquí sólo se decide si hay que llamarlo.
    delete datos.planId;
    // El precio propio se edita por separado del plan. Si además se cambia el
    // plan, deja que /plan aplique el precio inicial del nuevo catálogo; no
    // arrastres silenciosamente el monto del plan anterior.
    if (cambiaDePlan) delete datos.standardPrice;
    try {
      event.target.classList.add('loading-state');
      await api(`/api/clients/${client.id}`, { method: 'PATCH', body: datos });
      if (cambiaDePlan) {
        await api(`/api/clients/${client.id}/plan`, { method: 'PATCH', body: {
          planId: planElegido, cutoffDay: Number(values.get('cutoffDay')) || client.cutoffDay
        } });
      }
      await loadData(); renderAll(); modal.close();
      toast(cambiaDePlan ? 'Cliente actualizado y plan cambiado' : 'Cliente actualizado');
    }
    catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
async function deleteResource(path, label, success) {
  if (!window.confirm(`${label}\n\nEsta acción no se puede deshacer.`)) return;
  try { await api(path, { method: 'DELETE' }); await loadData(); renderAll(); modal.close(); toast(success); }
  catch (error) { toast(error.message, true); }
}
function planEditor(plan = null) {
  const content = formFromTemplate('plan-template'); openModal(content);
  const form = document.getElementById('plan-form'); const model = document.getElementById('plan-billing-model'); const packageFields = document.getElementById('plan-package-fields');
  // Las sesiones se piden en las dos modalidades: en mensualidad son las del
  // mes y alimentan el cumplimiento; en paquete son el total contratado. Sólo
  // la vigencia en días sigue siendo cosa del paquete.
  const togglePackage = () => {
    const esPaquete = model.value === 'package';
    const esSuelta = model.value === 'single';
    packageFields.hidden = !esPaquete;
    // En sesiones individuales no hay número que declarar: se cobra una cada
    // vez que ocurre. Pedirlo obligaría a inventar una cifra que después
    // mediría un cumplimiento que nadie pactó.
    const etiqueta = document.getElementById('plan-sessions-label');
    etiqueta.hidden = esSuelta;
    etiqueta.querySelector('input').required = !esSuelta;
    etiqueta.childNodes[0].nodeValue = esPaquete ? 'Sesiones incluidas' : 'Sesiones por mes';
    document.getElementById('plan-sessions-hint').textContent = esPaquete
      ? 'Total del paquete. Se reparte entre los meses de vigencia para medir el cumplimiento.'
      : 'Es la meta contra la que se mide el cumplimiento del cliente.';
    document.getElementById('plan-price-label').childNodes[0].nodeValue = esSuelta ? 'Precio por sesión (USD)' : 'Precio (USD)';
  };
  model.addEventListener('change', togglePackage);
  if (plan) {
    document.getElementById('plan-form-title').textContent = 'Editar tarifa';
    form.elements.name.value = plan.name; form.elements.description.value = plan.description; form.elements.billingModel.value = plan.billingModel; form.elements.price.value = plan.price;
    form.elements.sessionsIncluded.value = plan.sessionsIncluded || ''; form.elements.validityDays.value = plan.validityDays || 30; form.elements.zone.value = plan.zone || ''; form.elements.specialFor.value = plan.specialFor || ''; form.elements.active.checked = plan.active;
  }
  togglePackage();
  form.addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(event.target); const billingModel = values.get('billingModel');
    try {
      event.target.classList.add('loading-state');
      await api(plan ? `/api/plans/${plan.id}` : '/api/plans', { method: plan ? 'PATCH' : 'POST', body: { name: values.get('name'), description: values.get('description'), billingModel, price: Number(values.get('price')), sessionsIncluded: billingModel === 'single' ? undefined : Number(values.get('sessionsIncluded')), validityDays: billingModel === 'package' ? Number(values.get('validityDays')) : undefined, zone: values.get('zone'), specialFor: values.get('specialFor'), active: Boolean(values.get('active')) } });
      await loadData(); renderAll(); modal.close(); toast(plan ? 'Plan actualizado' : 'Plan creado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
  if (plan) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary wide-button'; remove.textContent = 'Desactivar plan';
    remove.addEventListener('click', () => deleteResource(`/api/plans/${plan.id}`, `¿Desactivar “${plan.name}”? Ya no estará disponible para nuevos clientes.`, 'Plan desactivado'));
    form.append(remove);
    // Desactivar lo esconde de los clientes nuevos pero lo deja en la lista
    // para siempre. Un plan creado por error no tiene por qué quedarse ahí.
    const borrar = document.createElement('button'); borrar.type = 'button'; borrar.className = 'secondary wide-button'; borrar.textContent = 'Borrar definitivamente';
    borrar.addEventListener('click', async () => {
      if (!confirm(`¿Borrar “${plan.name}” para siempre?\n\nSólo se puede si ningún cliente lo tiene asignado. Esto no deja rastro.`)) return;
      try {
        await api(`/api/plans/${plan.id}/permanent`, { method: 'DELETE' });
        await loadData(); renderAll(); modal.close(); toast('Plan borrado');
      } catch (error) { toast(error.message, true); }
    });
    form.append(borrar);
  }
}
function clientPlanEditor(client) {
  const box = document.createElement('div'); const availablePlans = data.plans.filter(plan => plan.active || plan.id === client.planId);
  // "Clase suelta" no necesita un plan creado: pasa al cliente a modelo suelta
  // directo (se cobra por sesión, sin bolsa ni mensualidad).
  const sueltaSel = client.billingModel === 'single' && !client.planId ? ' selected' : '';
  box.innerHTML = `<form id="client-plan-form"><p class="eyebrow">CONDICIONES COMERCIALES</p><h2>Plan y día de corte</h2><p class="form-summary">${escapeHtml(client.name)}</p><label>Plan<select name="planId" required>${availablePlans.map(plan => `<option value="${plan.id}" ${plan.id === client.planId ? 'selected' : ''}>${escapeHtml(plan.name)} · ${money.format(plan.price)}</option>`).join('')}<option value="__single__"${sueltaSel}>Clase suelta · se cobra por sesión</option></select></label><label id="ref-price-label"${sueltaSel ? '' : ' hidden'}>Precio de referencia (USD)<input name="referencePrice" type="number" min="0" step="0.01" value="${sueltaSel ? client.plan : ''}" /><small>Prellena cada cobro; lo editas al cobrar (montos variables, cobros de grupo por separado). Déjalo en 0 si siempre varía.</small></label><label>Día de corte<input name="cutoffDay" type="number" min="1" max="31" value="${client.cutoffDay}" required /><small>Para meses cortos, el recordatorio se ajusta al último día disponible.</small></label><button class="primary wide-button">Guardar condiciones</button></form>`;
  openModal(box);
  // El precio de referencia sólo aplica a clase suelta: aparece al elegirla.
  const planSelect = box.querySelector('[name="planId"]');
  const refLabel = box.querySelector('#ref-price-label');
  const toggleRef = () => { const suelta = planSelect.value === '__single__'; refLabel.hidden = !suelta; refLabel.querySelector('input').disabled = !suelta; };
  planSelect.addEventListener('change', toggleRef); toggleRef();
  document.getElementById('client-plan-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    const eleccion = form.get('planId');
    const body = eleccion === '__single__'
      ? { model: 'single', cutoffDay: Number(form.get('cutoffDay')), referencePrice: Number(form.get('referencePrice')) || 0 }
      : { planId: eleccion, cutoffDay: Number(form.get('cutoffDay')) };
    try { event.target.classList.add('loading-state'); await api(`/api/clients/${client.id}/plan`, { method: 'PATCH', body }); await loadData(); renderAll(); modal.close(); toast('Plan del cliente actualizado'); }
    catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
// La entrenadora genera el enlace y lo comparte; el cliente define su propia
// contraseña. Antes ella tenía que inventarla y comunicarla, y cada olvido la
// obligaba a repetir el trámite a mano.
async function portalAccessLink(client) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">ACCESO AL PORTAL</p><h2>Enlace para ${escapeHtml(client.name)}</h2>
    <div id="access-link-body"><p class="empty">Generando enlace…</p></div>`;
  openModal(box);
  try {
    const enlace = await api(`/api/clients/${client.id}/access-link`, { method: 'POST' });
    const target = document.getElementById('access-link-body');
    if (!target || !modal.open) return;
    target.innerHTML = `<p style="color:#6f7b75;margin-top:-8px">${enlace.firstTime ? 'Primer acceso' : 'Recuperación de acceso'} · para <b>${escapeHtml(enlace.email)}</b></p>
      <div class="access-link"><code id="access-link-url">${escapeHtml(enlace.url)}</code></div>
      <button class="primary wide-button" id="access-link-copy">Copiar enlace</button>
      <p class="section-note">Pásaselo por WhatsApp o como prefieras. Al abrirlo, ${escapeHtml(client.name)} define su propia contraseña y entra directo.<br><br>
        Vence en ${enlace.expiresInHours} horas y sirve <b>una sola vez</b>. Generar uno nuevo anula el anterior. Tú nunca llegas a ver su contraseña.</p>`;
    document.getElementById('access-link-copy').onclick = async event => {
      try {
        await navigator.clipboard.writeText(enlace.url);
        event.target.textContent = 'Enlace copiado ✓';
      } catch {
        // Sin permiso de portapapeles —común en iOS fuera de un gesto directo—
        // se selecciona el texto para que pueda copiarlo a mano.
        const rango = document.createRange(); rango.selectNodeContents(document.getElementById('access-link-url'));
        const seleccion = window.getSelection(); seleccion.removeAllRanges(); seleccion.addRange(rango);
        event.target.textContent = 'Selecciónalo y cópialo';
      }
    };
  } catch (error) {
    const target = document.getElementById('access-link-body');
    if (target) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function portalAccessEditor(client) {
  const box = document.createElement('div'); box.innerHTML = `<form id="portal-access-form"><p class="eyebrow">PORTAL PRIVADO</p><h2>${client.portalActive ? 'Actualizar acceso' : 'Activar acceso'}</h2><p class="form-summary">${escapeHtml(client.name)}</p><label>Correo del cliente<input name="email" type="email" required value="${escapeHtml(client.email)}" /></label><label>Contraseña inicial<input name="password" type="password" minlength="10" required autocomplete="new-password" /><small>Mínimo 10 caracteres. El cliente podrá iniciar sesión desde la misma PWA.</small></label><button class="primary wide-button">${client.portalActive ? 'Actualizar credenciales' : 'Crear acceso al portal'}</button></form>`;
  openModal(box);
  document.getElementById('portal-access-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try { event.target.classList.add('loading-state'); await api(`/api/clients/${client.id}/portal-access`, { method: 'POST', body: { email: form.get('email'), password: form.get('password') } }); await loadData(); renderAll(); modal.close(); toast('Acceso del cliente configurado'); }
    catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
async function exportCompliance(period = compliancePeriod) {
  try {
    const response = await fetch(`${API_BASE}/api/compliance/report.csv?period=${period}`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'No fue posible generar el reporte'); }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `cumplimiento-${period}.csv`; link.click(); URL.revokeObjectURL(url); toast('Reporte de cumplimiento exportado');
  } catch (error) { toast(error.message, true); }
}
async function notificationCenter(isPortal = false) {
  const [notifications, preferences] = await Promise.all([api('/api/notifications'), api('/api/notification-preferences')]);
  const box = document.createElement('div'); box.innerHTML = `<form id="notification-form"><p class="eyebrow">RECORDATORIOS</p><h2>Notificaciones</h2><div class="notification-list">${notifications.length ? notifications.map(item => `<div class="notification-item ${item.type}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.body)}</span>${item.type === 'travel' && !isPortal ? `<div class="notification-actions"><button type="button" class="secondary outcome-btn outcome-done outcome-solid" data-viaje-aviso="${item.travelId}" data-viaje-cliente="${item.clientId}">Preparar rutina de viaje</button></div>` : ''}${item.type === 'pending' && !isPortal ? `<div class="notification-actions"><button type="button" class="secondary outcome-btn outcome-done outcome-solid" data-marcar="completed" data-sesion="${item.sessionId}">Cumplió</button><button type="button" class="secondary outcome-btn outcome-cancel" data-marcar="cancel" data-sesion="${item.sessionId}">Cancelar clase</button></div>` : ''}</div>`).join('') : '<p class="empty">No hay recordatorios pendientes.</p>'}</div><div class="notification-settings"><label class="checkbox-line"><input name="inAppEnabled" type="checkbox" ${preferences.in_app_enabled ? 'checked' : ''} /> Mostrar dentro de la aplicación</label><label class="checkbox-line"><input name="browserEnabled" type="checkbox" ${preferences.browser_enabled ? 'checked' : ''} /> Notificaciones push en este dispositivo</label><p class="section-note">Hay que activarlas en cada teléfono o computadora por separado. En iPhone sólo funcionan con la aplicación instalada en la pantalla de inicio.</p>${preferences.browser_enabled ? '<button type="button" class="secondary wide-button" id="push-test">Enviar notificación de prueba</button>' : ''}<div class="form-row"><label>Avisar sesión con horas de anticipación<input name="sessionReminderHours" type="number" min="1" max="168" value="${preferences.session_reminder_hours}" /></label><label>Avisar pago con días de anticipación<input name="paymentReminderDays" type="number" min="0" max="30" value="${preferences.payment_reminder_days}" /></label></div></div><button class="primary wide-button">Guardar preferencias</button></form>`;
  openModal(box, true);
  // Resolver desde el propio aviso. Mandarla a buscar la sesión en la agenda
  // para marcar lo que el aviso ya le está preguntando es pedirle que haga dos
  // veces el mismo camino, y por eso se quedaban sin marcar.
  box.querySelectorAll('[data-viaje-aviso]').forEach(boton => {
    boton.onclick = async () => {
      const clienteViaje = data.clients.find(item => item.id === boton.dataset.viajeCliente);
      const viaje = (data.travel || []).find(item => item.id === boton.dataset.viajeAviso);
      if (!clienteViaje || !viaje) { toast('No se encontró el viaje', true); return; }
      modal.close(); prepararRutinaDeViaje(clienteViaje, viaje);
    };
  });
  box.querySelectorAll('[data-marcar]').forEach(boton => {
    boton.onclick = async () => {
      const fila = boton.closest('.notification-item');
      fila.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        let resumen = 'Guardado';
        if (boton.dataset.marcar === 'cancel') {
          await api(`/api/sessions/${boton.dataset.sesion}?rescheduled=false`, { method: 'DELETE' });
        } else {
          const resultado = await api(`/api/sessions/${boton.dataset.sesion}/compliance`, { method: 'PATCH', body: {
            outcome: boton.dataset.marcar, completionPercent: boton.dataset.marcar === 'completed' ? 100 : 0
          } });
          resumen = mensajeDeSaldo(resultado, boton.dataset.marcar === 'completed' ? 'Cumplió' : 'No asistió');
        }
        await loadData(); renderAll();
        fila.remove();
        const quedan = box.querySelectorAll('.notification-item.pending').length;
        toast(`${resumen} · ${quedan ? `quedan ${quedan} por marcar` : 'no queda ninguna por marcar'}`);
      } catch (error) {
        toast(error.message, true);
        fila.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    };
  });
  box.querySelectorAll('[data-read-notification]').forEach(boton => {
    boton.onclick = async () => {
      boton.disabled = true;
      try { await api(`/api/notifications/${boton.dataset.readNotification}/read`, { method: 'POST' }); boton.closest('.notification-item')?.remove(); await loadData(); renderAll(); }
      catch (error) { boton.disabled = false; toast(error.message, true); }
    };
  });
  // La prueba recorre el circuito completo desde el servidor. El aviso que sale
  // al guardar lo dibuja el propio navegador y no demuestra que el push llegue.
  document.getElementById('push-test')?.addEventListener('click', async event => {
    const boton = event.currentTarget; const texto = boton.textContent;
    boton.disabled = true; boton.textContent = 'Enviando…';
    try {
      const r = await api('/api/push/test', { method: 'POST' });
      toast(`Enviada a ${r.dispositivos} dispositivo${r.dispositivos === 1 ? '' : 's'}. Debería aparecer en unos segundos.`);
    } catch (error) { toast(error.message, true); }
    boton.disabled = false; boton.textContent = texto;
  });
  document.getElementById('notification-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); let browserEnabled = Boolean(form.get('browserEnabled'));
    try {
      let registration;
      if (browserEnabled) {
        if (!('Notification' in window)) throw new Error('Este navegador no admite notificaciones');
        if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') throw new Error('Debes permitir las notificaciones para recibir recordatorios');
        registration = await ensurePushSubscription();
      }
      await api('/api/notification-preferences', { method: 'PATCH', body: { inAppEnabled: Boolean(form.get('inAppEnabled')), browserEnabled, sessionReminderHours: Number(form.get('sessionReminderHours')), paymentReminderDays: Number(form.get('paymentReminderDays')) } });
      modal.close(); toast(browserEnabled ? 'Recordatorios push activados' : 'Preferencias guardadas');
      if (browserEnabled && registration) await registration.showNotification('Eileen Lifestyle', { body: 'Las notificaciones quedaron activadas en este dispositivo.', icon: './icon-192.png', badge: './favicon-32.png', data: { url: window.location.href } });
    }
    catch (error) { toast(error.message, true); }
  });
}
async function googleCalendarAction() {
  const button = document.getElementById('google-calendar-connect');
  const original = button.textContent;
  try {
    button.disabled = true;
    button.textContent = 'Comprobando…';
    data.googleCalendar = await api('/api/integrations/google-calendar/status');
    renderGoogleCalendar();
    if (!data.googleCalendar.configured) throw new Error('Las credenciales OAuth de Google todavía no están disponibles en Railway');
    button.disabled = true;
    if (data.googleCalendar.connected) {
      button.textContent = 'Sincronizando…';
      const result = await api('/api/integrations/google-calendar/sync', { method: 'POST' });
      await Promise.all([refreshSessions(), refreshGoogleCalendarState()]);
      renderDashboard(); renderGoogleCalendar(); renderCalendar();
      const incoming = Number(result.updatedFromGoogle || 0);
      const outgoing = Number(result.synced || 0);
      const message = result.alreadyRunning ? 'La sincronización ya estaba en curso'
        : result.failed ? `${outgoing} enviadas; ${result.failed} requieren revisión`
          : incoming || outgoing ? `${incoming} cambio${incoming === 1 ? '' : 's'} recibido${incoming === 1 ? '' : 's'} de Google · ${outgoing} enviado${outgoing === 1 ? '' : 's'}`
            : 'Calendarios al día';
      toast(message, Boolean(result.failed));
    } else {
      button.textContent = 'Abriendo Google…';
      const result = await api('/api/integrations/google-calendar/authorize');
      window.location.assign(result.authorizationUrl);
    }
  } catch (error) {
    toast(error.message, true); button.disabled = false; button.textContent = original;
  }
}
async function synchronizeCalendarSilently() {
  if (calendarSyncRunning || document.visibilityState !== 'visible' || !authToken || currentUser?.role === 'client' || !data.googleCalendar.connected) return;
  calendarSyncRunning = true;
  try {
    const result = await api('/api/integrations/google-calendar/sync', { method: 'POST' });
    await Promise.all([refreshSessions(), refreshGoogleCalendarState()]);
    renderDashboard(); renderGoogleCalendar(); renderCalendar();
    if (Number(result.updatedFromGoogle || 0) > 0) toast(`${result.updatedFromGoogle} horario${Number(result.updatedFromGoogle) === 1 ? '' : 's'} actualizado${Number(result.updatedFromGoogle) === 1 ? '' : 's'} desde Google`);
  } catch (error) {
    console.warn('No fue posible actualizar Google Calendar en segundo plano', error);
  } finally { calendarSyncRunning = false; }
}
function stopCalendarSynchronization() {
  if (calendarSyncTimer) clearInterval(calendarSyncTimer);
  calendarSyncTimer = null; calendarSyncRunning = false;
}
function startCalendarSynchronization() {
  stopCalendarSynchronization();
  if (currentUser?.role === 'client') return;
  // El temporizador arranca aunque Google no esté conectado en este momento:
  // synchronizeCalendarSilently ya comprueba la conexión en cada vuelta. Antes
  // se salía aquí, así que si la conexión estaba caída al abrir la aplicación
  // —por ejemplo con la API de Google todavía sin habilitar— no volvía a
  // sincronizar sola hasta recargar la página.
  calendarSyncTimer = setInterval(() => void synchronizeCalendarSilently(), 75_000);
}

// Al volver a la pestaña se sincroniza en el acto. Mover un evento en Google y
// tener que esperar setenta y cinco segundos a que aparezca se siente roto,
// aunque acabe llegando. Se limita a una vez cada veinte segundos para que
// alternar entre pestañas no dispare una llamada por cada cambio de foco.
let ultimaSincronizacionVisible = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - ultimaSincronizacionVisible < 20_000) return;
  ultimaSincronizacionVisible = Date.now();
  void synchronizeCalendarSilently();
});
async function disconnectGoogleCalendar() {
  if (!window.confirm('Se detendrá la sincronización. Los eventos que ya existen en Google Calendar se conservarán.')) return;
  const button = document.getElementById('google-calendar-disconnect');
  try {
    button.disabled = true; button.textContent = 'Desconectando…';
    await api('/api/integrations/google-calendar/disconnect', { method: 'POST' });
    data.googleCalendar = await api('/api/integrations/google-calendar/status');
    data.sessions.forEach(session => { session.googleSynced = false; session.googleEventLink = ''; session.googleSyncError = ''; });
    stopCalendarSynchronization(); renderGoogleCalendar(); renderCalendar(); toast('Google Calendar desconectado');
  } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = 'Desconectar'; }
}
function showGoogleCalendarReturn() {
  const url = new URL(window.location.href); const result = url.searchParams.get('google');
  if (!result) return;
  if (result === 'connected') toast('Google Calendar conectado y sesiones sincronizadas');
  else if (result === 'partial') toast('Google Calendar se conectó; algunas sesiones requieren otra sincronización', true);
  else if (result === 'denied') toast('La autorización de Google fue cancelada', true);
  else if (result === 'start') toast('Inicia la conexión desde Agenda → Conectar calendario', true);
  else toast('No fue posible completar la conexión con Google Calendar', true);
  url.searchParams.delete('google');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function newInvoice() {
  const content = formFromTemplate('new-invoice-template'); openModal(content);
  const selection = document.getElementById('invoice-client'); data.clients.forEach(client => selection.add(new Option(client.name, client.id)));
  const concept = document.getElementById('invoice-concept'); const packageFields = document.getElementById('invoice-package-fields');
  // La mensualidad también tiene tope de sesiones, así que el campo aparece
  // para las dos. Dejarlo en 0 mantiene el comportamiento anterior: cobro sin
  // saldo, sin descuento y sin nada que vencer.
  const conSesiones = () => ['Paquete de sesiones', 'Mensualidad'].includes(concept.value);
  const togglePackage = () => {
    packageFields.hidden = !conSesiones();
    // Ocultar no basta: un campo escondido sigue validándose, y el navegador
    // bloquea el envío sin decir dónde —"an invalid form control is not
    // focusable"— si el número de sesiones queda en 0 con min=1. Deshabilitado
    // no valida y tampoco viaja en el formulario.
    packageFields.querySelectorAll('input').forEach(campo => { campo.disabled = packageFields.hidden; });
    const rotulo = packageFields.querySelector('label');
    if (rotulo) rotulo.childNodes[0].nodeValue = concept.value === 'Mensualidad' ? 'Sesiones incluidas al mes' : 'Sesiones incluidas';
    const nota = document.getElementById('invoice-sessions-note');
    if (nota) nota.textContent = concept.value === 'Mensualidad'
      ? 'Se descuentan al completar cada sesión. Déjalo en 0 si esta mensualidad no limita sesiones.'
      : 'Se descuentan al completar cada sesión.';
    // En una mensualidad las dos fechas son la misma —el corte cierra el mes y
    // caducan sus sesiones—, y pedirlas dos veces sólo invita a que se
    // contradigan. En un paquete sí son distintas: puede pagarse hoy y valer
    // dos meses, así que ahí se sigue preguntando.
    // La clase suelta se cobra y se da en el mismo momento: se registra aquí,
    // con el porcentaje que la entrenadora observó, en vez de obligarla a
    // agendarla aparte y volver a marcarla.
    const suelta = document.getElementById('invoice-single-fields');
    if (suelta) {
      const esSuelta = concept.value === 'Sesión individual';
      suelta.hidden = !esSuelta;
      suelta.querySelectorAll('input').forEach(campo => { campo.disabled = !esSuelta; });
      if (esSuelta && !suelta.querySelector('[name="claseDia"]').value) {
        suelta.querySelector('[name="claseDia"]').value = dateKey(today);
        suelta.querySelector('[name="claseHora"]').value = panamaDateTimeParts(new Date()).time;
      }
    }
    const esMensual = concept.value === 'Mensualidad';
    const etiquetaCaduca = document.getElementById('package-expires-label');
    if (etiquetaCaduca) etiquetaCaduca.hidden = esMensual;
    const pistaVence = document.getElementById('invoice-due-hint');
    // Se busca el campo aquí y no se usa la constante de abajo: togglePackage
    // corre antes de que esa constante exista y explotaría en la zona muerta.
    const sesionesCampo = document.querySelector('#invoice-form [name="sessions"]');
    if (pistaVence) pistaVence.textContent = esMensual && Number(sesionesCampo?.value) > 0
      ? 'Es también el día en que caducan las sesiones del mes.'
      : '';
  };
  // Si el cliente ya tiene saldo, decirlo antes de cobrar otro. Un cobro extra
  // no reemplaza al que ya está: se suma. Sin verlo aquí, la única forma de
  // saber con cuántas clases acaba el cliente era ir a Control de paquetes,
  // hacer la cuenta de cabeza y volver.
  const avisoSaldo = document.createElement('p');
  avisoSaldo.className = 'conflict-warn';
  avisoSaldo.hidden = true;
  concept.closest('label').after(avisoSaldo);

  const revisarSaldoExistente = () => {
    const cliente = data.clients.find(item => item.id === selection.value);
    const suyos = cliente
      ? data.packages.filter(pack => pack.clientId === cliente.id && pack.status === 'confirmed' && remainingSessions(pack) > 0)
      : [];
    if (!cliente || !suyos.length || !conSesiones()) { avisoSaldo.hidden = true; return; }
    const disponibles = suyos.reduce((total, pack) => total + remainingSessions(pack), 0);
    const detalle = suyos.map(pack => `${pack.kind === 'monthly' ? 'mensualidad' : 'paquete'} de ${pack.total} (${remainingSessions(pack)} disponible${remainingSessions(pack) === 1 ? '' : 's'}${pack.expiresOn ? `, vence ${formatoDiaCorto(pack.expiresOn)}` : ', sin vencimiento'})`).join(' · ');
    const nuevas = Number(sessionsInput?.value) || 0;
    avisoSaldo.innerHTML = `<b>${escapeHtml(cliente.name)} ya tiene saldo:</b> ${escapeHtml(detalle)}.<br>${nuevas
      ? `Estas ${nuevas} <b>se suman</b>: quedaría con <b>${disponibles + nuevas} sesiones disponibles</b>.`
      : 'Este cobro no añade sesiones al saldo que ya tiene.'}`;
    avisoSaldo.hidden = false;
  };

  // La casilla "La clase ya se dio" CREA una clase nueva a la hora indicada. Si la persona ya tiene clase ese día (la de su horario fijo), crear otra la deja doble
  // (J-101: Sara, Susie y Reina quedaron con dos clases realizadas el mismo día). Se avisa y la casilla se desmarca; la clase que ya existe se marca en la agenda.
  const casillaClase = document.getElementById('invoice-register-class');
  const avisoClase = document.createElement('p');
  avisoClase.className = 'conflict-warn';
  avisoClase.hidden = true;
  casillaClase?.closest('label').after(avisoClase);
  let desmarcadaPorAviso = false;
  const claseDelDia = () => {
    const dia = document.querySelector('#invoice-form [name="claseDia"]')?.value;
    return data.sessions.find(s => s.clientId === selection.value && s.date === dia && s.status !== 'cancelled');
  };
  const revisarClaseDelDia = () => {
    const existente = concept.value === 'Sesión individual' ? claseDelDia() : null;
    avisoClase.hidden = !existente;
    // Si la casilla la desmarcó este aviso y el choque ya no existe (otro cliente u otro día), se vuelve a su valor normal: marcada.
    if (!existente && desmarcadaPorAviso && casillaClase) { casillaClase.checked = true; desmarcadaPorAviso = false; }
    if (existente) {
      desmarcadaPorAviso = desmarcadaPorAviso || casillaClase?.checked === true;
      avisoClase.innerHTML = `<b>Ya tiene una clase ese día a las ${existente.time}</b> (${existente.status === 'completed' ? 'realizada' : existente.status === 'no_show' ? 'no cumplió' : 'programada'}). Registrar otra la deja doble. Si es la misma, márcala en la agenda y deja esta casilla sin marcar; si de verdad dio dos, vuelve a marcarla.`;
      if (casillaClase) casillaClase.checked = false;
    }
  };
  ['claseDia', 'claseHora'].forEach(nombre => document.querySelector(`#invoice-form [name="${nombre}"]`)?.addEventListener('change', revisarClaseDelDia));
  selection.addEventListener('change', () => setTimeout(revisarClaseDelDia, 0));
  concept.addEventListener('change', () => { togglePackage(); revisarSaldoExistente(); revisarClaseDelDia(); }); togglePackage(); revisarClaseDelDia();
  const amountInput = document.querySelector('#invoice-form [name="amount"]'); const dueInput = document.querySelector('#invoice-form [name="due"]'); const sessionsInput = document.querySelector('#invoice-form [name="sessions"]');
  const fillClientPlan = () => { const client = data.clients.find(item => item.id === selection.value); if (!client) return; amountInput.value = client.plan; concept.value = client.billingModel === 'package' ? 'Paquete de sesiones' : client.billingModel === 'single' ? 'Sesión individual' : 'Mensualidad'; sessionsInput.value = client.packageSessions || client.sessionsIncluded || 0;
    // La fecha se propone a partir de la vigencia del plan, pero queda escrita
    // y editable: antes el aviso decía "un mes después" y el servidor guardaba
    // sin vencimiento, así que se creaban paquetes que no caducaban nunca
    // creyendo lo contrario.
    const vence = document.getElementById('package-expires');
    const pista = document.getElementById('package-expires-hint');
    if (vence) {
      if (client.billingModel === 'package' && client.validityDays) {
        const fin = new Date(today); fin.setDate(fin.getDate() + Number(client.validityDays));
        vence.value = dateKey(fin);
        pista.textContent = `${client.validityDays} días de vigencia según su plan. Cámbiala si acordaron otra cosa.`;
      } else {
        vence.value = '';
        pista.textContent = 'Su plan no fija vigencia. Sin fecha, el saldo no caduca.';
      }
    }
    togglePackage(); revisarSaldoExistente(); };
  dueInput.value = dateKey(today); selection.addEventListener('change', fillClientPlan); fillClientPlan();
  sessionsInput?.addEventListener('input', revisarSaldoExistente);
  sessionsInput?.addEventListener('input', togglePackage);
  revisarSaldoExistente();

  // La fecha del pago sólo tiene sentido si hay pago. Se propone hoy, pero se
  // puede corregir: el dinero entra un día y a veces se registra otro, y
  // fecharlo cuando se teclea descuadra el mes en el que se cobró.
  const metodo = document.querySelector('#invoice-form [name="method"]');
  const etiquetaPago = document.getElementById('invoice-paid-on-label');
  const pagoInput = etiquetaPago?.querySelector('input');
  const togglePagado = () => {
    if (!etiquetaPago) return;
    const hayPago = metodo.value !== 'pending';
    etiquetaPago.hidden = !hayPago;
    if (hayPago && !pagoInput.value) pagoInput.value = dateKey(today);
  };
  metodo?.addEventListener('change', togglePagado);
  togglePagado();
  document.getElementById('invoice-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const method = form.get('method');
    const cliente = data.clients.find(c => c.id === form.get('client'));
    // Alerta anti-duplicado: si el cliente ya tiene un cobro AUTOMÁTICO pendiente,
    // crear uno manual le duplica el saldo. Mejor registrar el pago en esa
    // factura automática. Se avisa y se deja decidir.
    const cobroAuto = data.invoices.find(i => i.clientId === form.get('client') && i.autoGenerated && i.status === 'pending');
    if (cobroAuto && !confirm(`⚠️ ${cliente?.name || 'Este cliente'} ya tiene un cobro AUTOMÁTICO pendiente:\n"${cobroAuto.concept}" · vence ${fechaCorta(cobroAuto.due)}.\n\nCrear un cobro manual puede DUPLICARLE el saldo en Control de paquetes.\n\nLo recomendable: cancela esto, ve a la lista de Cobros y registra el pago sobre esa factura automática.\n\n¿Crear el cobro manual de todas formas?`)) return;
    if (form.get('concept') === 'Sesión individual' && form.get('registrarClase')) {
      const yaTiene = data.sessions.find(s => s.clientId === form.get('client') && s.date === form.get('claseDia') && s.status !== 'cancelled');
      if (yaTiene && !confirm(`⚠️ ${cliente?.name || 'Este cliente'} ya tiene una clase el ${fechaCorta(form.get('claseDia'))} a las ${yaTiene.time}.\n\nRegistrar "La clase ya se dio" crea OTRA clase ese día y la deja doble.\n\nAceptar = crear la segunda clase igualmente.\nCancelar = volver y desmarcar la casilla.`)) return;
    }
    const cobrado = method !== 'pending' ? `\nPagado el ${form.get('paidOn') || dateKey(today)} · ${method}` : '';
    const claseDada = form.get('concept') === 'Sesión individual' && form.get('registrarClase')
      ? `\nClase del ${form.get('claseDia')} a las ${form.get('claseHora')} · ${form.get('claseCumplimiento')}% de cumplimiento` : '';
    if (!confirmarGuardado(`Cobro de ${money.format(Number(form.get('amount')) || 0)} a ${cliente?.name || 'cliente'}\n${form.get('concept')} · vence ${form.get('due') || 'hoy'}${cobrado}${claseDada}`)) return;
    try {
      event.target.classList.add('loading-state');
      let invoice;
      const concepto = form.get('concept');
      const sesiones = Number(form.get('sessions')) || 0;
      // Con sesiones se crea un saldo que se descuenta y vence; sin ellas, la
      // mensualidad sigue siendo un cobro simple como hasta ahora.
      if (concepto === 'Paquete de sesiones' || (concepto === 'Mensualidad' && sesiones > 0)) {
        const pack = await api('/api/packages', { method: 'POST', body: { clientId: form.get('client'), totalSessions: sesiones, amount: Number(form.get('amount')), kind: concepto === 'Mensualidad' ? 'monthly' : 'package',
          dueOn: form.get('due') || undefined,
          // En la mensualidad la caducidad es el propio vencimiento; en el
          // paquete, la fecha que se haya puesto aparte.
          expiresOn: (concepto === 'Mensualidad' ? form.get('due') : form.get('expiresOn')) || undefined } });
        invoice = { id: pack.invoice_id };
      } else {
        invoice = await api('/api/invoices', { method: 'POST', body: { clientId: form.get('client'), concept: concepto, amount: Number(form.get('amount')), dueOn: form.get('due') } });
      }
      if (invoice && method !== 'pending') await api(`/api/invoices/${invoice.id}/confirm`, { method: 'POST', body: { method, reference: form.get('reference') || undefined, paidOn: form.get('paidOn') || dateKey(today) } });
      // La sesión se crea ya marcada, en una sola llamada: en dos, si la
      // segunda fallaba quedaba una clase programada que nadie pidió.
      if (concepto === 'Sesión individual' && form.get('registrarClase')) {
        await api('/api/sessions', { method: 'POST', body: {
          clientId: form.get('client'),
          startsAt: panamaDateTimeIso(form.get('claseDia') || dateKey(today), form.get('claseHora') || '08:00'),
          durationMinutes: 60, mode: 'Presencial', notes: 'Clase individual',
          completionPercent: Number(form.get('claseCumplimiento') ?? 100)
        } });
      }
      await loadData(); renderAll(); modal.close(); navigate('billing'); toast('Cobro registrado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
// Horarios fijos: verlos y detenerlos. Un horario indefinido sin un sitio
// visible donde pararlo sería una trampa —seguiría llenando la agenda de
// alguien que ya no entrena—, así que esto no es opcional.
// Tres letras, no una: 'M' vale igual para martes y para miércoles, y el
// horario de Beatris se guardó sin el martes por eso mismo.
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
// Cancelar preguntando si se reprograma. No es un detalle de formulario: una
// clase movida a otro día no debe penalizar al cliente, y una que simplemente
// no se dio, sí. Antes ninguna de las dos contaba, así que cancelar salía
// gratis y quien cancelaba media agenda seguía apareciendo al 100%.
// Rutina en lugar de la clase (J-102). Se pide la propuesta a la IA (que solo puede elegir ejercicios del catálogo y ya sabe lesiones y rutinas recientes del cliente),
// se abre el editor de rutinas con el borrador para que Eileen lo revise, y al guardarla se liga a la clase. El cliente la verá en el portal con la demostración en video de
// cada ejercicio del catálogo y un cronómetro; al cumplirla, su clase pasa a realizada.
// Guía corta de cómo se comportan las cancelaciones (J-106). Es texto fijo: refleja lo que hace el servidor al cancelar, no lo decide.
function guiaDeCancelaciones() {
  const caja = document.createElement('div');
  caja.className = 'guia-cancelaciones';
  caja.innerHTML = `<p class="eyebrow">AGENDA</p><h2>Cómo funcionan las cancelaciones</h2>
    <p class="section-note">Se cancela desde la clase: ábrela en la agenda y toca el botón rojo <b>Cancelar</b>.</p>
    <h3>Cancela el cliente <small>todo es opcional</small></h3>
    <ul>
      <li><b>Se reprogramará a otro día.</b> No afecta su cumplimiento; suma a sus reprogramaciones del mes. La clase nueva descuenta cuando se dé.</li>
      <li><b>Proponer rutina.</b> La clase no se cancela. Si la cumple <u>ese mismo día</u>, cuenta como clase dada. Si no, pasado el día la clase se da por perdida.</li>
      <li><b>Cancelar sin reprogramar ni rutina.</b> Cuenta como incumplida y <b>se le descuenta automáticamente una clase</b> de su plan.</li>
      <li><b>A crédito (Julio):</b> no hay descuento de clase. Tú decides si la cancelación se cobra ($25) o no; en ambos casos cuenta como incumplida. Una clase cancelada sola (por viaje o por una rutina no cumplida) queda sin cobro; si quieres cobrarla, ábrela y usa <b>Editar cancelación</b> antes de que salga su factura (último día del mes, desde las 21:00).</li>
      <li><b>A crédito y rutina cumplida:</b> la rutina que cumple en lugar de la clase —por cancelación suya, tuya o por viaje— <b>se cobra como clase dada</b>.</li>
    </ul>
    <h3>Cancelas tú</h3>
    <ul>
      <li><b>Marcar para reprogramar.</b> No toca su cumplimiento ni su saldo; la clase nueva descuenta cuando se dé.</li>
      <li><b>Proponer rutina.</b> La clase no se cancela. Si la cumple ese día, cuenta como clase dada. Si no, queda pendiente y no pierde nada: tú decides.</li>
      <li><b>Cancelar sin reprogramar ni rutina.</b> No descuenta clase ni dinero y no afecta su cumplimiento. Puedes reponerla después.</li>
    </ul>
    <h3>Cliente de viaje <small>marcado en su expediente</small></h3>
    <ul>
      <li>Viajar <b>no pausa su plan ni su cobro</b>. Sus clases de esos días salen en azul con ✈.</li>
      <li>Para que cada clase cuente, debe <b>confirmar la rutina que le enviaste por enlace el día de esa clase</b>. Si la confirma, la clase cuenta como dada.</li>
      <li>Si no hay acción —no se le envió rutina, no quiso recibirla o no la confirmó—, esa clase <b>se cancela sola al terminar el día</b>: cancelación del cliente (cuenta como incumplida y se le descuenta una clase; a crédito, sin cobro automático).</li>
      <li>La cancelación queda <b>justificada con el viaje</b>: se ve en la clase y en el expediente (Viajes). Un viaje que justificó cancelaciones no se puede quitar, se conserva como registro.</li>
      <li>Solo se cancelan clases de días desde que registraste el viaje; no las anteriores.</li>
    </ul>
    <h3>Siempre</h3>
    <ul>
      <li>La rutina propuesta <b>solo vale el día de la clase</b> (hora de Panamá).</li>
      <li>"Descontar" es una clase menos en su mensualidad o paquete, no dinero. No hay descuentos en dólares por cancelar.</li>
      <li><b>Eliminar</b> no es cancelar: borra una clase agendada por error sin contar como incumplida.</li>
      <li>Una clase cuya hora ya pasó y sigue sin resolverse aparece en <b>Falta marcar</b> (campana).</li>
    </ul>`;
  openModal(caja, true);
}
// "Proponer rutina" directo desde la clase (J-110), sin pasar por Cancelar. En un día de viaje va directo a la rutina de viaje; si no, se pregunta por qué se propone, que es lo que
// decide qué pasa si el cliente no la cumple.
function proponerRutinaDesdeAgenda(sesion) {
  if (!sesion) return;
  const cliente = data.clients.find(item => item.id === sesion.clientId);
  if (!cliente) return;
  const viaje = viajeDelCliente(sesion.clientId, sesion.date);
  if (viaje && sesion.status === 'scheduled') { prepararRutinaDeViaje(cliente, viaje); return; }
  const esCredito = cliente.paymentMode === 'no_anticipado';
  const caja = document.createElement('div');
  caja.innerHTML = `<p class="eyebrow">AGENDA</p><h2>Proponer rutina</h2>
    <p class="form-summary"><b>${escapeHtml(sesion.client)}</b><br>${sesion.date} · ${sesion.time} · ${sesion.durationMinutes} min</p>
    <p style="color:#6f7b75">¿Por qué le propones una rutina en lugar de la clase?</p>
    <button class="secondary wide-button" id="propuesta-eileen">No puedo atender la clase</button>
    <p class="section-note">La clase NO se cancela. Si el cliente cumple la rutina ese día, cuenta como su clase; si no, no pierde nada y tú decides cómo cerrarla.</p>
    <button class="secondary wide-button" id="propuesta-cliente">El cliente no puede venir</button>
    <p class="section-note">Si cumple la rutina ese día, cuenta como su clase; si no, la clase se cancela sola (cancelación del cliente${esCredito ? '' : ' y se le descuenta una clase'}).</p>
    ${esCredito ? `<p class="aviso-reprogramar">Como entrena a crédito, si cumple la rutina <b>se cobra como clase dada (${money.format(Number(cliente.creditSessionPrice || 25))})</b>.</p>` : ''}`;
  openModal(caja, true);
  caja.querySelector('#propuesta-eileen').onclick = () => ofrecerRutinaEnLugarDeClase(sesion, 'trainer');
  caja.querySelector('#propuesta-cliente').onclick = () => ofrecerRutinaEnLugarDeClase(sesion, 'client');
}

// ── Bloques o circuitos (J-113) ────────────────────────────────────────────────────────────────
// Cada ejercicio puede llevar `block` (1, 2, 3…) y `rounds` (rondas del bloque, iguales para todo el bloque). En un bloque se hacen sus ejercicios seguidos y se repite el bloque `rounds` veces,
// así que `sets` = `rounds`. Sin `block`, el ejercicio va suelto con sus series. Al editar, agregar o quitar uno no mueve los demás: sólo se compactan los números de bloque y se conserva el orden que dejó Eileen.
function normalizarBloques(lista) {
  const numeros = new Map(); const rondas = new Map();
  if (!lista.some(item => Number(item.block) > 0)) { lista.forEach(item => { delete item.block; delete item.rounds; }); return; }
  for (const item of lista) {
    const original = Number(item.block) || 0;
    if (!original) { delete item.block; delete item.rounds; continue; }
    if (!numeros.has(original)) numeros.set(original, numeros.size + 1);
    const nuevo = numeros.get(original);
    if (!rondas.has(nuevo)) rondas.set(nuevo, Number(item.rounds) || 3);
    item.block = nuevo; item.rounds = rondas.get(nuevo); item.sets = item.rounds;
  }
}
const textoRondas = rondas => `${rondas} ${Number(rondas) === 1 ? 'ronda' : 'rondas'}`;

// Un ejercicio admite que se le fije un peso si el catálogo lo marca "Lleva peso" o si usa máquina o peso libre (una plancha o la caminadora no lo piden).
const admitePeso = ejercicio => Boolean(ejercicio) && Boolean(ejercicio.usesWeight
  || (ejercicio.freeWeight && !/^no aplica/i.test(ejercicio.freeWeight))
  || (ejercicio.machine && !/^no aplica/i.test(ejercicio.machine)));

// ── Especificación breve de la rutina (J-111) ──────────────────────────────────────────────────
// Eileen sabe con qué cuenta el cliente, así que antes de generar con IA escribe UNA línea: "rutina de 45 min de espalda, tríceps y pierna; tiene mancuernas y bandas". La IA la toma como
// autoridad (duración, grupos y equipo). Es opcional: vacía, se genera una rutina general.
const campoEspecificacion = (ejemplo = 'Ej. Rutina de 45 min: espalda, tríceps y pierna. Tiene disponible: mancuernas y bandas') =>
  `<label>Especificación breve <small>(opcional)</small><textarea name="especificacion" rows="3" maxlength="300" placeholder="${escapeHtml(ejemplo)}"></textarea></label>
   <p class="section-note">En una línea: la duración, qué trabajar y con qué cuenta el cliente. Si lo dejas vacío, se genera una rutina general.</p>`;
const textoEspecificacion = formulario => String(new FormData(formulario).get('especificacion') || '').trim();
const descripcionConEspecificacion = (base, texto) => (texto ? `${base} Indicación de la entrenadora, que manda sobre lo demás: ${texto}` : base).slice(0, 600);

function ofrecerRutinaEnLugarDeClase(sesion, origen = 'trainer') {
  const cliente = data.clients.find(item => item.id === sesion.clientId);
  const nombre = cliente?.name?.split(' ')[0] || 'el cliente';
  const caja = document.createElement('div');
  const resumen = `<p class="eyebrow">AGENDA</p><h2>Proponer rutina</h2><p class="form-summary"><b>${escapeHtml(sesion.client)}</b><br>${sesion.date} · ${sesion.time} · ${sesion.durationMinutes} min</p>`;
  openModal(caja, true);
  const enviarAlEditor = propuesta => { modal.close(); newRoutine(null, false, { ...propuesta, clientId: sesion.clientId, ofertaSesionId: sesion.id, ofertaCliente: sesion.client, ofertaOrigen: origen, ofertaDuracion: sesion.durationMinutes }); };
  const manual = () => enviarAlEditor({ title: `Rutina para ${nombre}`, description: '', sessionsPerWeek: 1, exercises: [], rationale: '', avoided: [], descartados: [] });
  const pedirEspecificacion = () => {
    caja.innerHTML = `${resumen}<form id="oferta-especificaciones">${campoEspecificacion()}
      <button class="primary wide-button">Generar con IA</button><button type="button" class="secondary wide-button" id="oferta-sin-ia">Armarla yo, sin IA</button></form>`;
    caja.querySelector('#oferta-sin-ia').onclick = manual;
    caja.querySelector('#oferta-especificaciones').addEventListener('submit', evento => { evento.preventDefault(); generar(textoEspecificacion(evento.target)); });
  };
  const generar = async texto => {
    caja.innerHTML = `${resumen}<p class="section-note" role="status">Generando la rutina con tu catálogo de ejercicios… puede tardar unos segundos.</p>`;
    try {
      enviarAlEditor(await api('/api/routines/suggest', { method: 'POST', body: {
        description: descripcionConEspecificacion(`Rutina para que ${nombre} la haga por su cuenta en lugar de su clase de ${sesion.durationMinutes} min, con lo que tenga a mano.`, texto),
        clientId: sesion.clientId, forClient: true, durationMinutes: sesion.durationMinutes
      } }));
    } catch (error) {
      caja.innerHTML = `${resumen}<p class="conflict-warn">${escapeHtml(error.message)}</p>
        <button class="primary wide-button" id="rutina-reintentar">Cambiar la especificación y reintentar</button>
        <button class="secondary wide-button" id="rutina-manual">Armarla yo, sin IA</button>`;
      caja.querySelector('#rutina-reintentar').onclick = pedirEspecificacion;
      caja.querySelector('#rutina-manual').onclick = manual;
    }
  };
  pedirEspecificacion();
}

function cancelSessionDialog(sesion) {
  if (!sesion) return;
  const cliente = data.clients.find(c => c.id === sesion.clientId);
  const box = document.createElement('div');

  // Dos preguntas y no cuatro botones: quién cancela y qué se hace. La
  // primera decide a quién se le apunta la falta —hasta ahora una clase que
  // cancelaba la entrenadora le bajaba el cumplimiento al cliente— y sólo
  // entonces tiene sentido la segunda.
  const cabecera = `<p class="eyebrow">AGENDA</p><h2>Cancelar sesión</h2>
    <p class="form-summary"><b>${escapeHtml(sesion.client)}</b><br>${sesion.date} · ${sesion.time}</p>`;

  const porClase = cliente && cliente.sessionsIncluded > 0 ? cliente.plan / cliente.sessionsIncluded : 0;
  const esCredito = cliente?.paymentMode === 'no_anticipado';
  const tarifaCredito = Number(cliente?.creditSessionPrice || 25);

  const preguntarQuien = () => {
    const historial = cliente && (cliente.reprogramaciones || cliente.canceladas)
      ? `<p class="conflict-warn">Este mes lleva ${[
          cliente.reprogramaciones ? `<b>${cliente.reprogramaciones}</b> reprogramación${cliente.reprogramaciones === 1 ? '' : 'es'} pedida${cliente.reprogramaciones === 1 ? '' : 's'}` : null,
          cliente.canceladas ? `<b>${cliente.canceladas}</b> perdida${cliente.canceladas === 1 ? '' : 's'}` : null
        ].filter(Boolean).join(' y ')}.</p>` : '';
    box.innerHTML = `${cabecera}${historial}
      <p style="color:#6f7b75">¿Quién cancela?</p>
      <button class="secondary wide-button" id="cancela-cliente">La cancela el cliente</button>
      <p class="section-note">Cuenta en su historial del mes y puede afectar su cumplimiento.</p>
      <button class="secondary wide-button" id="cancela-entrenadora">La cancelo yo</button>
      <p class="section-note">No toca su cumplimiento ni su contador, y no descuenta clase ni dinero: se reprograma o se cancela sin más.</p>
      <p class="section-note">Si la agendaste por error, cierra esto y usa <b>Eliminar</b>: desaparece sin contar como incumplida.</p>
      <button type="button" class="text-button" id="guia-cancelaciones">ⓘ Cómo funcionan las cancelaciones</button>`;
    box.querySelector('#guia-cancelaciones').onclick = guiaDeCancelaciones;
    box.querySelector('#cancela-cliente').onclick = preguntarDestinoCliente;
    box.querySelector('#cancela-entrenadora').onclick = preguntarCompensacion;
  };

  // Al cancelar (quien sea) aparece el aviso "Proponer rutina": un clic genera la rutina con IA y el catálogo (J-105). Cancela el cliente: todo es opcional (reprogramar, rutina o nada),
  // y lo único seguro es que, sin reprogramación ni rutina, se le descuenta automáticamente una clase. Cancela Eileen: se recuerda que también puede reprogramar.
  const avisoRutina = texto => `<div class="aviso-rutina"><b>💡 Proponer rutina</b><span>${texto}</span><button class="primary wide-button" id="proponer-rutina">Proponer rutina</button></div>`;

  const preguntarDestinoCliente = () => {
    const puedeRutina = sesion.status === 'scheduled';
    box.innerHTML = `${cabecera}
      <p style="color:#6f7b75">La cancela el cliente. <b>Todo es opcional</b>:</p>
      ${puedeRutina ? avisoRutina(`Para que no pierda la clase, puedes proponerle una rutina que haga por su cuenta. Solo vale el día de la clase: si la cumple, cuenta como su clase.${esCredito ? ' <b>Como entrena a crédito, si la cumple se cobra como clase dada ('+money.format(tarifaCredito)+').</b>' : ''}`) : ''}
      <button class="secondary wide-button" id="cancelar-reprogramada">Se reprogramará a otro día</button>
      <p class="section-note">No afecta el cumplimiento: contará la sesión nueva. Suma a sus reprogramaciones del mes.</p>
      ${!esCredito ? `<button class="secondary wide-button" id="cancelar-perdida">Cancelar sin reprogramar ni rutina</button>
      <p class="section-note"><b>Se le descuenta automáticamente una clase</b> de su plan. Cuenta como incumplida y baja su porcentaje.</p>` : ''}
      ${esCredito ? `<p style="color:#6f7b75">Como entrena a crédito, Eileen decide si esta cancelación se cobra.</p>
        <button class="secondary wide-button" id="cancelar-cobrada">Cancelar y cobrar ${money.format(tarifaCredito)}</button>
        <p class="section-note">Aparecerá como “Cancelación cobrada” en la factura y en tu portal.</p>
        <button class="secondary wide-button" id="cancelar-sin-cobro">Cancelar sin cobro</button>
        <p class="section-note">Se registra en asistencia, pero no genera cargo.</p>` : ''}
      ${puedeRutina ? `<p class="section-note">Si no la reprograma ni cumple la rutina, la clase se da por perdida${esCredito ? '' : ' y se le descuenta una clase'}.</p>` : ''}`;
    box.querySelector('#cancelar-reprogramada').onclick = () => cancelar({ reprogramada: true, quien: 'client' });
    box.querySelector('#proponer-rutina')?.addEventListener('click', () => ofrecerRutinaEnLugarDeClase(sesion, 'client'));
    const cancelarPerdida = box.querySelector('#cancelar-perdida');
    if (cancelarPerdida) cancelarPerdida.onclick = () => cancelar({ reprogramada: false, quien: 'client' });
    if (esCredito) {
      box.querySelector('#cancelar-cobrada').onclick = () => cancelar({ reprogramada: false, quien: 'client', creditCharge: true });
      box.querySelector('#cancelar-sin-cobro').onclick = () => cancelar({ reprogramada: false, quien: 'client', creditCharge: false });
    }
  };

  const preguntarCompensacion = () => {
    const puedeRutina = sesion.status === 'scheduled';
    box.innerHTML = `${cabecera}
      <p style="color:#6f7b75">La cancelas tú. ¿Qué hacemos?</p>
      ${puedeRutina ? avisoRutina(`Si no puedes atenderla, propónle una rutina para que entrene por su cuenta. Solo vale el día de la clase; si no la cumple, no pierde nada y tú decides cómo cerrarla.${esCredito ? ' <b>Como entrena a crédito, si la cumple se cobra como clase dada ('+money.format(tarifaCredito)+').</b>' : ''}`) : ''}
      <p class="aviso-reprogramar"><b>Recuerda:</b> también puedes <b>reprogramar</b> la clase.</p>
      <button class="secondary wide-button" id="compensar-reprogramar">Marcar para reprogramar</button>
      <p class="section-note">La nueva sesión se descontará del saldo mensual o paquete que corresponda a su fecha. No se crea un saldo de reposición.</p>
      <button class="secondary wide-button" id="compensar-nada">Cancelar sin reprogramar ni rutina</button>
      <p class="section-note">Se cancela sin más. No descuenta ni toca su cumplimiento; puedes reponerla después.</p>`;
    box.querySelector('#proponer-rutina')?.addEventListener('click', () => ofrecerRutinaEnLugarDeClase(sesion, 'trainer'));
    box.querySelector('#compensar-reprogramar').onclick = () => cancelar({ reprogramada: true, quien: 'trainer', compensa: 'none' });
    box.querySelector('#compensar-nada').onclick = () => cancelar({ reprogramada: false, quien: 'trainer', compensa: 'none' });
  };

  const cancelar = async ({ reprogramada, quien, compensa, creditCharge = false }) => {
    const resumen = quien === 'trainer'
      ? `Cancelar la clase de ${sesion.client}\n${compensa === 'discount' ? `Descuento de ${money.format(porClase)} al próximo cobro`
          : compensa === 'none' ? 'Sin reposición ni descuento' : 'Queda una clase por reponer'}`
      : `Cancelar la clase de ${sesion.client}\n${reprogramada ? 'Se reprogramará' : creditCharge ? `No se reprograma: se cobrará ${money.format(tarifaCredito)}` : 'No se reprograma: sin cobro adicional'}`;
    if (!confirmarGuardado(resumen)) return;
    try {
      const partes = [`rescheduled=${reprogramada}`, `by=${quien}`];
      if (compensa) partes.push(`resolution=${compensa}`);
      if (creditCharge) partes.push('creditCharge=true');
      const r = await api(`/api/sessions/${sesion.id}?${partes.join('&')}`, { method: 'DELETE' });
      await loadData(); renderAll(); modal.close();
      toast(r.compensacion ? `Cancelada · ${r.compensacion.detalle}` : (reprogramada ? 'Cancelada para reprogramar' : 'Cancelada · cuenta como incumplida'));
    } catch (error) { toast(error.message, true); }
  };

  preguntarQuien();
  openModal(box, true);
}

function editCancellationDialog(sesion) {
  const box = document.createElement('div');
  const cliente = data.clients.find(c => c.id === sesion.clientId);
  const esCredito = cliente?.paymentMode === 'no_anticipado';
  const tarifaCredito = Number(cliente?.creditSessionPrice || 25);
  const by = sesion.cancelledBy || 'client';
  const res = esCredito ? 'none' : (sesion.cancellationResolution || (sesion.cancellationKind === 'rescheduled' ? 'none' : by === 'client' ? 'debit' : 'none'));
  const resolution = res === 'makeup' ? 'none' : res;
  box.innerHTML = `<form id="edit-cancellation-form"><p class="eyebrow">AGENDA</p><h2>Editar cancelación</h2><p class="form-summary"><b>${escapeHtml(sesion.client)}</b><br>${sesion.date} · ${sesion.time}</p><label>Quién canceló<select name="by"><option value="client" ${by === 'client' ? 'selected' : ''}>El cliente</option><option value="trainer" ${by === 'trainer' ? 'selected' : ''}>La entrenadora</option></select></label><label>¿Se reprogramó?<select name="rescheduled"><option value="false" ${sesion.cancellationKind !== 'rescheduled' ? 'selected' : ''}>No, perdió la clase</option><option value="true" ${sesion.cancellationKind === 'rescheduled' ? 'selected' : ''}>Sí, se reprogramará</option></select></label>${esCredito ? `<label class="completion-check"><input type="checkbox" name="creditCharge" ${sesion.creditCharge ? 'checked' : ''} /> <span>Cobrar cancelación (${money.format(tarifaCredito)})</span></label><p class="section-note">Sólo aplica si la canceló el cliente y no se reprograma. Se mostrará en la factura y el portal.</p>` : `<label>Resolución<select name="resolution"><option value="debit" ${resolution === 'debit' ? 'selected' : ''}>Descontar del paquete</option><option value="none" ${resolution === 'none' ? 'selected' : ''}>Sin reposición ni descuento</option>${resolution === 'discount' ? '<option value="discount" selected>Crédito para próximo cobro (anterior; ya no se ofrece)</option>' : ''}</select></label>`}<p class="section-note">La sesión nueva, si se reprograma, consumirá el saldo mensual o paquete que corresponda a su fecha. No se crean saldos de reposición.</p><button class="primary wide-button">Guardar cambios</button></form>`;
  openModal(box, true);
  box.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
    try { await api(`/api/sessions/${sesion.id}/cancellation`, { method: 'PATCH', body: { cancelledBy: form.elements.by.value, rescheduled: form.elements.rescheduled.value === 'true', resolution: form.elements.resolution?.value || 'none', creditCharge: Boolean(form.elements.creditCharge?.checked) } }); await loadData(); renderAll(); modal.close(); toast('Cancelación actualizada'); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });
}

// Editar el horario en vez de tirarlo abajo. Añadir un día olvidado obligaba a
// detener el horario entero y crear otro, con lo que se perdían las sesiones ya
// puestas —y quedaban dos reglas para la misma persona si no se acordaba de
// detener la vieja—.
function editarHorarioFijo(regla, alGuardar) {
  if (!regla) return;
  const marcados = (regla.weekdays || []).map(Number);
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="editar-horario-form">
      <p class="eyebrow">HORARIO FIJO</p>
      <h2>Editar horario</h2>
      <p class="form-summary">${escapeHtml(regla.full_name)}</p>
      <fieldset class="repetir-semanal"><legend>Días</legend>
        <div class="dias-semana" id="editar-dias">
          ${[[1, 'lun'], [2, 'mar'], [3, 'mié'], [4, 'jue'], [5, 'vie'], [6, 'sáb'], [0, 'dom']]
            .map(([valor, texto]) => `<label><input type="checkbox" value="${valor}" ${marcados.includes(valor) ? 'checked' : ''} /><span>${texto}</span></label>`).join('')}
        </div>
      </fieldset>
      <div class="form-row">
        <label>Hora<input name="timeOfDay" type="time" required value="${String(regla.time_of_day).slice(0, 5)}" /></label>
        <label>Duración<select name="durationMinutes">${[30, 45, 60, 75, 90, 120].map(m => `<option value="${m}" ${Number(regla.duration_minutes) === m ? 'selected' : ''}>${m} minutos</option>`).join('')}</select></label>
      </div>
      <label>Modalidad<select name="mode">${['Presencial', 'Virtual', 'Exterior'].map(m => `<option ${m === regla.mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <p class="section-note">Este horario es indefinido: seguirá generando clases hasta que Eileen lo detenga o marque al cliente como inactivo.</p>
      <p class="commercial-note">Los días que quites retiran sus clases futuras que nadie haya tocado. Las ya marcadas o movidas se quedan. Todos los días marcados comparten esta hora: para otra hora en otro día, quita ese día aquí y agrégalo como un horario aparte (+ Agregar horario fijo).</p>
      <button class="primary wide-button">Guardar horario</button>
    </form>`;
  openModal(box);
  document.getElementById('editar-horario-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const dias = [...document.querySelectorAll('#editar-dias input:checked')].map(c => Number(c.value));
    if (!dias.length) { toast('Marca al menos un día', true); return; }
    const nombres = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
    if (!confirmarGuardado(`${regla.full_name}\nLos ${dias.sort().map(d => nombres[d]).join(', ')} a las ${form.get('timeOfDay')}`)) return;
    try {
      event.target.classList.add('loading-state');
      const r = await api(`/api/session-recurrences/${regla.id}`, { method: 'PATCH', body: {
        weekdays: dias, timeOfDay: form.get('timeOfDay'), durationMinutes: Number(form.get('durationMinutes')),
        mode: form.get('mode')
      } });
      await loadData(); renderAll(); modal.close();
      recurrenceManager();
      toast(`Horario guardado · ${r.creadas} agendada${r.creadas === 1 ? '' : 's'}${r.retiradas ? ` · ${r.retiradas} retirada${r.retiradas === 1 ? '' : 's'}` : ''}`);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

// Mi horario de trabajo, por turnos.
//
// Antes se deducía de la agenda —de la clase más temprana a la más tardía— y
// eso no sabe de cortes: quien entrena de 5 a 11 y de 4 a 8 tenía toda la
// tarde muerta ofrecida como hueco libre. Aquí se dice en claro, y cada día
// puede tener los turnos que haga falta.
const DIAS_SEMANA = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];

async function workingHoursEditor() {
  let tramos;
  try { tramos = (await api('/api/working-hours')).tramos; }
  catch (error) { toast(error.message, true); return; }

  const box = document.createElement('div');
  const pintar = () => {
    box.innerHTML = `
      <p class="eyebrow">AGENDA</p>
      <h2>Mi horario de trabajo</h2>
      <p style="color:#6f7b75;margin-top:-12px">Marca en qué franjas atiendes. Un día puede tener varios turnos: mañana y tarde, con el corte del mediodía en medio. Un día sin turnos es un día libre.</p>
      ${tramos.length ? '' : '<p class="conflict-warn">Todavía no lo has configurado. Mientras tanto, los huecos libres se deducen de tu propia agenda, de tu clase más temprana a la más tardía, y no saben de cortes.</p>'}
      ${DIAS_SEMANA.map(([valor, nombre]) => {
        const suyos = tramos.filter(t => Number(t.weekday) === valor);
        return `
          <div class="turnos-dia">
            <div class="turnos-cabecera"><b>${nombre}</b><button type="button" class="secondary" data-anadir="${valor}">+ Turno</button></div>
            ${suyos.length ? suyos.map((t, indice) => `
              <div class="turno-fila">
                <input type="time" value="${t.starts_at}" data-campo="starts_at" data-dia="${valor}" data-indice="${indice}" />
                <span>a</span>
                <input type="time" value="${t.ends_at}" data-campo="ends_at" data-dia="${valor}" data-indice="${indice}" />
                <button type="button" class="secondary" data-quitar="${valor}" data-indice="${indice}">Quitar</button>
              </div>`).join('') : '<p class="section-note">Día libre.</p>'}
          </div>`;
      }).join('')}
      <button type="button" class="primary wide-button" id="guardar-horario">Guardar horario</button>`;

    box.querySelectorAll('[data-anadir]').forEach(boton => {
      boton.onclick = () => {
        const dia = Number(boton.dataset.anadir);
        const suyos = tramos.filter(t => Number(t.weekday) === dia);
        // El segundo turno se propone por la tarde: es el caso para el que
        // existe esto, y así no hay que teclear las cuatro horas.
        tramos.push(suyos.length
          ? { weekday: dia, starts_at: '16:00', ends_at: '20:00' }
          : { weekday: dia, starts_at: '05:00', ends_at: '11:00' });
        pintar();
      };
    });
    box.querySelectorAll('[data-quitar]').forEach(boton => {
      boton.onclick = () => {
        const dia = Number(boton.dataset.quitar);
        const suyos = tramos.filter(t => Number(t.weekday) === dia);
        const fuera = suyos[Number(boton.dataset.indice)];
        tramos = tramos.filter(t => t !== fuera);
        pintar();
      };
    });
    box.querySelectorAll('[data-campo]').forEach(campo => {
      campo.onchange = () => {
        const dia = Number(campo.dataset.dia);
        const suyos = tramos.filter(t => Number(t.weekday) === dia);
        suyos[Number(campo.dataset.indice)][campo.dataset.campo] = campo.value;
      };
    });
    // Dentro de box y no del documento: la primera pintada ocurre antes de
    // que el modal esté insertado, y getElementById devolvería null.
    box.querySelector('#guardar-horario').onclick = async () => {
      const cuerpo = { tramos: tramos.map(t => ({ weekday: Number(t.weekday), startsAt: t.starts_at, endsAt: t.ends_at })) };
      const resumen = DIAS_SEMANA.map(([valor, nombre]) => {
        const suyos = cuerpo.tramos.filter(t => t.weekday === valor);
        return suyos.length ? `${nombre}: ${suyos.map(t => `${t.startsAt}–${t.endsAt}`).join(' y ')}` : `${nombre}: libre`;
      }).join('\n');
      if (!confirmarGuardado(resumen)) return;
      try {
        tramos = (await api('/api/working-hours', { method: 'PUT', body: cuerpo })).tramos;
        pintar();
        toast('Horario guardado');
      } catch (error) { toast(error.message, true); }
    };
  };
  pintar();
  openModal(box, true);
}

// Alta de un horario fijo desde el administrador (antes solo se creaba escondido en "Agendar sesión"). Un cliente puede tener varios, uno por cada hora distinta.
function nuevoHorarioFijo() {
  const clientes = data.clients.filter(client => client.statusRaw === 'active').slice().sort((p, q) => p.name.localeCompare(q.name, 'es'));
  const box = document.createElement('div');
  box.innerHTML = `
    <form id="nuevo-horario-form">
      <p class="eyebrow">HORARIO FIJO</p>
      <h2>Agregar horario fijo</h2>
      <label>Cliente<select name="clientId" required><option value="">Elige al cliente</option>${clientes.map(client => `<option value="${client.id}">${escapeHtml(client.name)}</option>`).join('')}</select></label>
      <fieldset class="repetir-semanal"><legend>Días</legend>
        <div class="dias-semana" id="nuevo-dias">
          ${[[1, 'lun'], [2, 'mar'], [3, 'mié'], [4, 'jue'], [5, 'vie'], [6, 'sáb'], [0, 'dom']].map(([valor, texto]) => `<label><input type="checkbox" value="${valor}" /><span>${texto}</span></label>`).join('')}
        </div>
      </fieldset>
      <div class="form-row">
        <label>Hora<input name="timeOfDay" type="time" required /></label>
        <label>Duración<select name="durationMinutes">${[30, 45, 60, 75, 90, 120].map(m => `<option value="${m}" ${m === 60 ? 'selected' : ''}>${m} minutos</option>`).join('')}</select></label>
      </div>
      <label>Modalidad<select name="mode">${['Presencial', 'Virtual', 'Exterior'].map(m => `<option>${m}</option>`).join('')}</select></label>
      <p class="section-note">Este horario no tiene fecha de finalización: seguirá generando clases hasta que Eileen lo detenga o marque al cliente como inactivo.</p>
      <p class="commercial-note">Los días marcados comparten la hora. Si el mismo cliente entrena a otra hora otro día, agrega otro horario fijo para esa hora.</p>
      <button class="primary wide-button">Guardar horario</button>
    </form>`;
  openModal(box);
  document.getElementById('nuevo-horario-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const dias = [...document.querySelectorAll('#nuevo-dias input:checked')].map(c => Number(c.value));
    if (!dias.length) { toast('Marca al menos un día', true); return; }
    const nombres = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
    const cliente = clientes.find(client => client.id === form.get('clientId'));
    if (!confirmarGuardado(`${cliente?.name || ''}\nLos ${dias.sort().map(d => nombres[d]).join(', ')} a las ${form.get('timeOfDay')}`)) return;
    try {
      event.target.classList.add('loading-state');
      const r = await api('/api/session-recurrences', { method: 'POST', body: {
        clientId: form.get('clientId'), weekdays: dias, timeOfDay: form.get('timeOfDay'), durationMinutes: Number(form.get('durationMinutes')),
        mode: form.get('mode')
      } });
      await loadData(); renderAll(); modal.close();
      recurrenceManager();
      toast(`Horario fijo guardado · ${r.creadas} sesion${r.creadas === 1 ? '' : 'es'} agendada${r.creadas === 1 ? '' : 's'}`);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

async function recurrenceManager() {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">AGENDA</p><h2>Horarios fijos</h2>
    <p style="color:#6f7b75;margin-top:-12px">Cada horario se repite solo, semana tras semana, hasta que lo detengas. Detener uno retira sus clases futuras y deja intactas las pasadas.</p>
    <button type="button" class="primary wide-button" id="agregar-horario-fijo">+ Agregar horario fijo</button>
    <p style="color:#6f7b75;margin-top:6px"><small>Todos los días de un horario comparten la misma hora. Si un cliente entrena a horas distintas (p. ej. lun y mar a las 17:30 y vie a las 10:00), agrega un horario por cada hora.</small></p>
    <div id="recurrencias-lista"><p class="empty">Cargando…</p></div>
    <div class="clases-dobles" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line, #e8dfe3)">
      <button type="button" class="secondary wide-button" id="buscar-clases-dobles">Buscar clases repetidas el mismo día</button>
      <p style="color:#6f7b75;margin:6px 0 0"><small>Muestra los días (de las últimas dos semanas en adelante) en que una persona tiene dos o más clases, estén marcadas o no. Las ya marcadas se listan para que las veas, pero solo se quitan desde aquí las programadas. Se sugiere quitar la que sobra: la programada de un día que ya tiene otra realizada, o la creada por un horario fijo en las últimas 36 horas. Tú decides cuáles se quitan.</small></p>
      <div id="clases-dobles-resultado"></div>
    </div>
    <div class="actualizar-calendario" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line, #e8dfe3)">
      <button type="button" class="secondary wide-button" id="rellenar-horarios">Actualizar el calendario ahora</button>
      <p style="color:#6f7b75;margin:6px 0 0"><small>El calendario se actualiza solo cada pocas horas con las próximas ocho semanas de cada horario. Pulsa aquí únicamente si acabas de cambiar un horario y todavía no ves sus clases. No toca los días en que el cliente ya tiene clase, aunque se haya corrido de hora.</small></p>
    </div>
    <div id="horarios-diagnostico"></div>`;
  openModal(box, true);
  document.getElementById('agregar-horario-fijo').onclick = () => nuevoHorarioFijo();
  document.getElementById('buscar-clases-dobles').onclick = async event => {
    const boton = event.currentTarget; const destino = document.getElementById('clases-dobles-resultado'); boton.disabled = true;
    try {
      const { groups } = await api('/api/sessions/duplicates');
      if (!groups.length) { destino.innerHTML = '<p class="form-summary">✓ No hay clases repetidas el mismo día.</p>'; return; }
      destino.innerHTML = `<p class="section-note">${groups.length} día${groups.length === 1 ? '' : 's'} con más de una clase. Marca las que se quitan (las ya marcadas no se pueden quitar desde aquí).</p>
        <div class="new-billing-allocs">${groups.map(group => `<div class="new-billing-alloc" style="grid-template-columns:1fr"><div><b>${escapeHtml(group.name)} · ${fechaCorta(group.day)}</b>${group.sessions.map(session => { const estado = session.status === 'completed' ? 'realizada' : session.status === 'no_show' ? 'no cumplió' : (session.past ? 'sin marcar' : 'programada'); return `<label style="display:flex;gap:8px;align-items:center;margin-top:4px">${session.removable ? `<input type="checkbox" data-quitar-clase="${session.id}"${session.suggestedRemove ? ' checked' : ''} />` : '<span style="width:13px"></span>'} ${escapeHtml(session.time)} <small>${estado} · ${session.fromRecurrence ? 'de un horario fijo' : 'agendada a mano'} · creada ${fechaHoraPanama(session.createdAt)}${session.suggestedRemove ? ' · sugerida para quitar' : ''}${session.removable ? '' : ' · ya marcada, no se quita aquí'}</small></label>`; }).join('')}</div></div>`).join('')}</div>
        <button type="button" class="primary wide-button" id="quitar-clases-dobles">Quitar las marcadas</button>`;
      document.getElementById('quitar-clases-dobles').onclick = async () => {
        const ids = [...destino.querySelectorAll('[data-quitar-clase]:checked')].map(input => input.dataset.quitarClase);
        if (!ids.length) return toast('No marcaste ninguna clase', true);
        if (!confirm(`Se borrarán ${ids.length} clase${ids.length === 1 ? '' : 's'} programadas. No cuentan como incumplidas y el calendario no las vuelve a crear. ¿Continuar?`)) return;
        let quitadas = 0;
        for (const id of ids) { try { await api(`/api/sessions/${id}/permanent`, { method: 'DELETE' }); quitadas += 1; } catch (error) { toast(error.message, true); } }
        await loadData(); renderAll(); toast(`${quitadas} clase${quitadas === 1 ? '' : 's'} quitada${quitadas === 1 ? '' : 's'}`); recurrenceManager();
      };
    } catch (error) { toast(error.message, true); } finally { boton.disabled = false; }
  };
  const pintar = async () => {
    const destino = document.getElementById('recurrencias-lista');
    try {
      const reglas = await api('/api/session-recurrences');
      if (!destino?.isConnected) return;
      reglas.sort((x, y) => String(x.full_name).localeCompare(String(y.full_name), 'es') || String(x.time_of_day).localeCompare(String(y.time_of_day)));
      destino.innerHTML = reglas.length ? `<div class="gasto-lista">${reglas.map(regla => {
        const dias = (regla.weekdays || []).map(d => DIAS_CORTOS[d]).join(' · ');
        const hora = String(regla.time_of_day).slice(0, 5);
        return `<article class="gasto-item">
          <div><b>${escapeHtml(regla.full_name)}${regla.paused ? ' · Paquete en pausa' : ''}</b><small>${dias} · ${hora} · ${regla.duration_minutes} min${regla.routine_title ? ` · ${escapeHtml(regla.routine_title)}` : ''}<br>${regla.proximas} sesion${regla.proximas === 1 ? '' : 'es'} ya agendada${regla.proximas === 1 ? '' : 's'}${regla.ends_on ? ` · hasta ${fechaCorta(regla.ends_on)}` : ' · sin fecha de fin'}${regla.paused ? ' · las sesiones futuras están retenidas' : ''}</small></div>
          <button class="secondary session-use" data-editar-horario="${regla.id}">Editar</button>
          <button class="secondary session-use" data-detener-horario="${regla.id}" data-nombre="${escapeHtml(regla.full_name)}">Detener</button>
        </article>`;
      }).join('')}</div>` : '<p class="empty">No hay horarios fijos activos.</p>';
      destino.querySelectorAll('[data-editar-horario]').forEach(boton => {
        boton.onclick = () => editarHorarioFijo(reglas.find(r => r.id === boton.dataset.editarHorario), pintar);
      });
      const rellenar = document.getElementById('rellenar-horarios');
      if (rellenar) rellenar.onclick = async () => {
        rellenar.disabled = true;
        try {
          const r = await api('/api/session-recurrences/extend', { method: 'POST' });
          await loadData(); renderAll(); pintar();
          toast(r.creadas ? `Calendario actualizado · ${r.creadas} clase${r.creadas === 1 ? '' : 's'} agregada${r.creadas === 1 ? '' : 's'}` : 'El calendario ya estaba al día');
          // Los días que siguen vacíos, con el motivo. Sin esto sólo queda
          // mirar el calendario y adivinar por qué falta uno.
          const diagnostico = document.getElementById('horarios-diagnostico');
          if (!diagnostico) return;
          if (r.fallidas?.length) toast(`${r.fallidas.length} horario${r.fallidas.length === 1 ? '' : 's'} dio error al rellenar`, true);
          const saltados = r.saltados || [];
          diagnostico.innerHTML = saltados.length ? `
            <p class="eyebrow" style="margin-top:16px">DÍAS SIN CLASE Y POR QUÉ</p>
            ${saltados.map(fila => {
              const cuando = formatoDiaCorto(fila.dia);
              if (fila.marcada) {
                const donde = new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Panama' }).format(new Date(fila.marcada.starts_at));
                const estados = { scheduled: 'programada', completed: 'realizada', cancelled: 'cancelada', no_show: 'no cumplió' };
                return `<p class="commercial-note"><b>${escapeHtml(fila.full_name)} · ${cuando}</b><br>Su clase de ese día está ahora el ${donde} (${estados[fila.marcada.status] || fila.marcada.status}). Por eso no se vuelve a crear.</p>`;
              }
              if (fila.choque) return `<p class="commercial-note"><b>${escapeHtml(fila.full_name)} · ${cuando}</b><br>Ya tiene otra sesión a esa misma hora.</p>`;
              return `<p class="commercial-note"><b>${escapeHtml(fila.full_name)} · ${cuando}</b><br>Vacío sin motivo aparente. Avísame de esto.</p>`;
            }).join('')}` : '';
        } catch (error) { toast(error.message, true); }
        finally { rellenar.disabled = false; }
      };
      destino.querySelectorAll('[data-detener-horario]').forEach(boton => {
        boton.onclick = async () => {
          if (!confirm(`¿Detener el horario fijo de ${boton.dataset.nombre}?\n\nSe retiran sus sesiones futuras que todavía nadie marcó. Las pasadas y las que ya tienen asistencia se quedan.`)) return;
          try {
            const r = await api(`/api/session-recurrences/${boton.dataset.detenerHorario}`, { method: 'DELETE' });
            await loadData(); renderAll(); await pintar();
            toast(`Horario detenido · ${r.sesionesRetiradas} sesiones futuras retiradas`);
          } catch (error) { toast(error.message, true); }
        };
      });
    } catch (error) {
      if (destino) destino.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    }
  };
  await pintar();
}

// Choques de horario: aviso, no barrera.
//
// A veces dos personas entrenan a la vez a propósito —una pareja, un grupo—,
// así que impedirlo sería estorbar. Pero agendar encima de alguien sin
// enterarse es un problema real, y la entrenadora lo descubre el día de la
// clase. Se avisa y se deja seguir.
//
// Una sesión cancelada no cuenta: dejó el hueco libre, y avisar de ella sería
// avisar de algo que no va a pasar. Es justo el caso de mover a alguien de
// hora y volver a poner a otro en la que quedó vacía.
const minutosDelDia = hora => Number(String(hora).slice(0, 2)) * 60 + Number(String(hora).slice(3, 5));
const choquesEn = (fecha, hora, duracionMinutos, ignorarSesionId) => {
  if (!fecha || !hora) return [];
  const inicio = minutosDelDia(hora);
  const fin = inicio + (Number(duracionMinutos) || 60);
  return data.sessions.filter(sesion => sesion.date === fecha
    && sesion.id !== ignorarSesionId
    && sesion.status !== 'cancelled'
    // Se solapan de verdad, no sólo si empiezan a la misma hora: una clase de
    // 7:00 a 8:00 choca con otra de 7:30 aunque no coincidan los relojes.
    && minutosDelDia(sesion.time) < fin
    && minutosDelDia(sesion.time) + sesion.durationMinutes > inicio);
};

const diaCorto = fecha => new Intl.DateTimeFormat('es-PA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Panama' })
  .format(new Date(`${fecha}T12:00:00-05:00`));

// El texto del aviso para uno o varios días. Se nombra a quién ya está ahí:
// "choca con algo" no sirve para decidir, y "choca con Julio a las 7:00" sí.
const textoDeChoques = (fechas, hora, duracionMinutos, ignorarSesionId) => {
  const conChoque = fechas
    .map(fecha => ({ fecha, choques: choquesEn(fecha, hora, duracionMinutos, ignorarSesionId) }))
    .filter(item => item.choques.length);
  if (!conChoque.length) return '';
  if (fechas.length === 1) {
    const quienes = conChoque[0].choques.map(s => `${escapeHtml(s.client)} (${s.time})`).join(', ');
    return `Ojo: a esa hora ya está ${quienes}. Puedes agendar igual.`;
  }
  const muestra = conChoque.slice(0, 3)
    .map(item => `${diaCorto(item.fecha)} con ${escapeHtml(item.choques[0].client)}`).join(', ');
  const resto = conChoque.length > 3 ? ` y ${conChoque.length - 3} más` : '';
  return `Ojo: ${conChoque.length} de esos días chocan — ${muestra}${resto}. Puedes agendar igual.`;
};

// Los días que generará un horario indefinido en las próximas cuatro semanas.
// No están creados todavía, así que hay que calcularlos para poder avisar.
const proximosDiasDe = (desde, marcados, semanas = 4) => {
  if (!desde || !marcados.length) return [];
  const cursor = new Date(`${desde}T12:00:00`);
  const salida = [];
  for (let i = 0; i < semanas * 7; i += 1) {
    if (marcados.includes(cursor.getDay())) salida.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return salida;
};

function newSession() {
  const content = formFromTemplate('new-session-template'); openModal(content);
  const clientSelect = document.getElementById('session-client'); data.clients.filter(client => client.status === 'Activo').forEach(client => clientSelect.add(new Option(client.name, client.id)));
  const routineSelect = document.getElementById('session-routine'); data.routines.forEach(routine => routineSelect.add(new Option(routine.title, routine.id)));
  document.querySelector('#session-form [name="date"]').value = dateKey(calendarCursor);

  // Repetición semanal. La fecha de arriba es el primer día; los días marcados
  // se generan desde ahí hasta la fecha de corte.
  const dias = () => [...document.querySelectorAll('#session-weekdays input:checked')].map(c => Number(c.value));
  const fechaInput = document.querySelector('#session-form [name="date"]');
  const hastaLabel = document.getElementById('session-until-label');
  const hastaInput = hastaLabel.querySelector('input');
  const pista = document.getElementById('session-repeat-hint');
  const boton = document.getElementById('session-submit');
  const aviso = document.createElement('p');
  aviso.className = 'conflict-warn';
  aviso.hidden = true;
  pista.after(aviso);
  const horaInput = document.querySelector('#session-form [name="time"]');
  const duracionInput = document.querySelector('#session-form [name="durationMinutes"]');

  const fechasRepetidas = () => {
    const marcados = dias();
    if (!marcados.length || !fechaInput.value || !hastaInput.value) return [];
    // Se recorre en mediodía para que el cambio de horario no desplace el día.
    const cursor = new Date(`${fechaInput.value}T12:00:00`);
    const fin = new Date(`${hastaInput.value}T12:00:00`);
    const salida = [];
    while (cursor <= fin && salida.length < 60) {
      if (marcados.includes(cursor.getDay())) salida.push(dateKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return salida;
  };

  const perpetua = document.getElementById('session-forever');
  const perpetuaLabel = document.getElementById('session-forever-label');
  const refrescar = () => {
    const marcados = dias();
    perpetuaLabel.hidden = !marcados.length;
    // Sin fecha de fin no se agenda un montón de sesiones: se guarda el horario
    // y la aplicación mantiene creadas las de las próximas semanas.
    hastaLabel.hidden = !marcados.length || perpetua.checked;
    if (marcados.length && !hastaInput.value && fechaInput.value) {
      // Cuatro semanas por defecto: un mes de entrenamientos es lo que se
      // agenda de una sentada, y siempre se puede acortar.
      const sugerida = new Date(`${fechaInput.value}T12:00:00`);
      sugerida.setDate(sugerida.getDate() + 27);
      hastaInput.value = dateKey(sugerida);
    }
    if (marcados.length && perpetua.checked) {
      const nombres = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
      const cuales = marcados.sort().map(d => nombres[d]).join(', ');
      pista.textContent = `Se repetirá los ${cuales} indefinidamente. Se detiene desde Agenda → Horarios fijos.`;
      boton.textContent = 'Guardar horario fijo';
      return;
    }
    const total = marcados.length ? fechasRepetidas().length : 1;
    pista.textContent = marcados.length ? `Se agendarán ${total} sesion${total === 1 ? '' : 'es'}.` : '';
    boton.textContent = total > 1 ? `Agendar ${total} sesiones` : 'Agendar sesión';
    revisarChoques();
  };

  const revisarChoques = () => {
    const marcados = dias();
    const fechas = marcados.length
      ? (perpetua.checked ? proximosDiasDe(fechaInput.value, marcados) : fechasRepetidas())
      : (fechaInput.value ? [fechaInput.value] : []);
    const texto = textoDeChoques(fechas, horaInput.value, Number(duracionInput.value));
    aviso.innerHTML = texto;
    aviso.hidden = !texto;
  };
  horaInput.addEventListener('change', revisarChoques);
  horaInput.addEventListener('input', revisarChoques);
  duracionInput.addEventListener('change', revisarChoques);
  perpetua.addEventListener('change', refrescar);
  document.querySelectorAll('#session-weekdays input').forEach(c => c.addEventListener('change', refrescar));
  fechaInput.addEventListener('change', refrescar);
  hastaInput.addEventListener('change', refrescar);
  refrescar();

  document.getElementById('session-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try {
      event.target.classList.add('loading-state');
      const routineId = form.get('routine');
      if (dias().length && perpetua.checked) {
        const resultado = await api('/api/session-recurrences', { method: 'POST', body: {
          clientId: form.get('client'),
          routineId: routineId === 'Evaluación / seguimiento' ? undefined : routineId,
          weekdays: dias(), timeOfDay: form.get('time'),
          durationMinutes: Number(form.get('durationMinutes')), mode: form.get('mode'), notes: form.get('notes') || undefined
        } });
        await loadData(); renderAll(); modal.close(); navigate('calendar');
        toast(`Horario fijo guardado · ${resultado.creadas} sesiones agendadas por ahora`);
        return;
      }
      const repetidas = fechasRepetidas();
      if (repetidas.length) {
        const resultado = await api('/api/sessions/batch', { method: 'POST', body: {
          clientId: form.get('client'),
          routineId: routineId === 'Evaluación / seguimiento' ? undefined : routineId,
          startsAt: repetidas.map(dia => panamaDateTimeIso(dia, form.get('time'))),
          durationMinutes: Number(form.get('durationMinutes')), mode: form.get('mode'), notes: form.get('notes') || undefined
        } });
        await loadData(); renderAll(); modal.close(); navigate('calendar');
        toast(resultado.omitidas
          ? `${resultado.creadas} sesiones agendadas · ${resultado.omitidas} ya existían`
          : `${resultado.creadas} sesiones agendadas`);
        return;
      }
      await api('/api/sessions', { method: 'POST', body: { clientId: form.get('client'), routineId: routineId === 'Evaluación / seguimiento' ? undefined : routineId, startsAt: panamaDateTimeIso(form.get('date'), form.get('time')), durationMinutes: Number(form.get('durationMinutes')), mode: form.get('mode'), notes: form.get('notes') || undefined } });
      await loadData(); renderAll(); modal.close(); navigate('calendar'); toast('Sesión agendada');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function editSessionSchedule(session) {
  if (!session) return;
  const content = document.createElement('div');
  content.innerHTML = `<form id="edit-session-form"><p class="eyebrow">HORARIO DE ENTRENAMIENTO</p><h2>Editar sesión</h2><p class="form-summary">${escapeHtml(session.routine)}</p><label>Cliente<select name="clientId" id="edit-session-client"></select><small>Si la agendaste a la persona equivocada, cámbiala aquí.</small></label><div class="form-row"><label>Fecha<input name="date" type="date" value="${session.date}" required /></label><label>Hora<input name="time" type="time" value="${session.time}" required /></label></div><div class="form-row"><label>Duración<select name="durationMinutes">${[30, 45, 60, 75, 90, 120].map(minutes => `<option value="${minutes}" ${minutes === session.durationMinutes ? 'selected' : ''}>${minutes} minutos</option>`).join('')}</select></label><label>Modalidad<select name="mode">${['Presencial', 'Virtual', 'Exterior'].map(mode => `<option ${mode === session.mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></label></div><label>Notas<textarea name="notes" rows="3" placeholder="Opcional">${escapeHtml(session.notes)}</textarea></label><p class="calendar-edit-help">El cambio se enviará a Google Calendar. Si después arrastras el evento en Google, el nuevo horario regresará automáticamente a Eileen.</p><button class="primary wide-button">Guardar horario</button></form>`;
  openModal(content);
  const clienteSel = document.getElementById('edit-session-client');
  // Sólo activos: agendar a quien ya no entrena ensucia su expediente, porque
  // las sesiones cuentan para su cumplimiento aunque esté dado de baja. El
  // actual se incluye siempre, o no se podría editar la hora de una sesión de
  // alguien que se dio de baja después de agendarla.
  data.clients
    .filter(c => c.statusRaw === 'active' || c.id === session.clientId)
    .forEach(c => clienteSel.add(new Option(`${c.name}${c.status === 'Activo' ? '' : ` · ${c.status}`}`, c.id)));
  clienteSel.value = session.clientId;
  const formulario = document.getElementById('edit-session-form');
  const avisoEdicion = document.createElement('p');
  avisoEdicion.className = 'conflict-warn';
  avisoEdicion.hidden = true;
  formulario.querySelector('.calendar-edit-help').before(avisoEdicion);
  const revisarChoquesEdicion = () => {
    // Se excluye la propia sesión: chocaría consigo misma en cuanto se abriera.
    const texto = textoDeChoques([formulario.elements.date.value], formulario.elements.time.value,
      Number(formulario.elements.durationMinutes.value), session.id);
    avisoEdicion.innerHTML = texto;
    avisoEdicion.hidden = !texto;
  };
  ['date', 'time', 'durationMinutes'].forEach(campo => {
    formulario.elements[campo].addEventListener('change', revisarChoquesEdicion);
    formulario.elements[campo].addEventListener('input', revisarChoquesEdicion);
  });
  revisarChoquesEdicion();
  formulario.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try {
      event.target.classList.add('loading-state');
      await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: {
        startsAt: panamaDateTimeIso(form.get('date'), form.get('time')),
        durationMinutes: Number(form.get('durationMinutes')), mode: form.get('mode'), notes: form.get('notes') || undefined,
        clientId: form.get('clientId') || undefined
      } });
      await Promise.all([refreshSessions(), refreshGoogleCalendarState()]);
      renderDashboard(); renderGoogleCalendar(); renderCalendar(); modal.close();
      toast(data.googleCalendar.connected ? 'Horario actualizado en Eileen y Google Calendar' : 'Horario actualizado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
const megabytes = bytes => `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MB`;

// Registro diario: la entrenadora atiende presencialmente a la mayoría y no
// alcanza a crear una rutina por día. Aquí marca quién entrenó y eso cuenta
// igual en el cumplimiento.
async function dailyTrainingLog(date = new Date().toISOString().slice(0, 10)) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">ASISTENCIA</p><h2>Entrenamientos de hoy</h2>
    <p style="color:#6f7b75;margin-top:-12px">Marca a quien entrenó. Cada marca cuenta en su cumplimiento y descuenta del paquete si tiene uno activo.</p>
    <label>Día<input type="date" id="daily-date" value="${date}" max="${new Date().toISOString().slice(0, 10)}" /></label>
    <div id="daily-list"><p class="empty">Cargando clientes…</p></div>`;
  openModal(box, true);
  document.getElementById('daily-date').onchange = event => dailyTrainingLog(event.target.value);
  renderDailyLog(date);
}

async function renderDailyLog(date) {
  const target = document.getElementById('daily-list');
  if (!target) return;
  try {
    const rows = await api(`/api/trainings/daily?date=${encodeURIComponent(date)}`);
    if (!target.isConnected) return;
    const marcados = rows.filter(row => row.session_id && Number(row.completion_percent) > 0).length;
    target.innerHTML = `<p class="section-note">${rows.length} clientes activos · ${marcados} con entrenamiento registrado ese día.</p>
      <div class="daily-list">${rows.map(row => {
        // Una sesión agendada de verdad no se puede desmarcar desde aquí: esta
        // pantalla sólo administra lo que ella misma creó.
        const agendada = row.session_id && !row.quick_logged;
        const cumplida = Boolean(row.session_id) && Number(row.completion_percent) > 0;
        return `<label class="daily-item${agendada ? ' locked' : ''}">
          <input type="checkbox" data-daily-client="${row.client_id}" ${cumplida ? 'checked' : ''} ${agendada ? 'disabled' : ''} />
          <span class="daily-name"><b>${escapeHtml(row.full_name)}</b><small>${agendada ? `Sesión agendada${row.routine_title ? `: ${escapeHtml(row.routine_title)}` : ''} · se marca desde la agenda` : row.billing_model === 'package' ? `${row.available_sessions} sesiones disponibles` : row.billing_model === 'monthly' && Number(row.available_sessions) ? `Mensualidad · ${row.available_sessions} sesiones disponibles` : 'Mensualidad'}</small></span>
        </label>`;
      }).join('')}</div>
      <button class="primary wide-button" id="daily-save">Guardar entrenamientos</button>`;

    document.getElementById('daily-save').onclick = async event => {
      const seleccion = [...target.querySelectorAll('[data-daily-client]')].filter(input => input.checked && !input.disabled).map(input => input.dataset.dailyClient);
      // Las agendadas van igual en la lista: si se omitieran, el servidor las
      // interpretaría como desmarcadas.
      const agendadas = [...target.querySelectorAll('[data-daily-client]')].filter(input => input.disabled && input.checked).map(input => input.dataset.dailyClient);
      try {
        event.target.disabled = true; event.target.textContent = 'Guardando…';
        const resultado = await api('/api/trainings/daily', { method: 'POST', body: { date, clientIds: [...seleccion, ...agendadas] } });
        await loadData(); renderAll();
        toast(`${resultado.registrados} registrado${resultado.registrados === 1 ? '' : 's'}${resultado.eliminados ? ` · ${resultado.eliminados} quitado${resultado.eliminados === 1 ? '' : 's'}` : ''}`);
        renderDailyLog(date);
      } catch (error) { toast(error.message, true); event.target.disabled = false; event.target.textContent = 'Guardar entrenamientos'; }
    };
  } catch (error) {
    if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function exerciseCatalogManager() {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">ENTRENAMIENTO</p><h2>Catálogo de ejercicios</h2>
    <p style="color:#6f7b75;margin-top:-12px">Los ejercicios y sus videos de demostración. Lo que subas aquí es lo que verá el cliente en su rutina.</p>
    <div class="catalog-toolbar"><input id="catalog-search" type="search" placeholder="Buscar ejercicio…" autocomplete="off" /><select id="catalog-section-filter"></select><button class="secondary" id="catalog-new">+ Nuevo ejercicio</button></div>
    <div id="catalog-list"><p class="empty">Cargando catálogo…</p></div>`;
  openModal(box, true);

  const filter = document.getElementById('catalog-section-filter');
  filter.add(new Option('Todas las secciones', ''));
  exerciseSectionOrder.filter(section => section !== 'total_body').forEach(section => filter.add(new Option(exerciseSectionLabels[section], section)));
  document.getElementById('catalog-new').onclick = () => exerciseEditor(null);
  filter.onchange = () => renderCatalogList();
  // input y no change: con 77 ejercicios, esperar al Enter obliga a mirar la
  // lista entera mientras se escribe.
  document.getElementById('catalog-search').addEventListener('input', () => renderCatalogList());
  renderCatalogList();
}

function renderCatalogList() {
  const target = document.getElementById('catalog-list');
  if (!target) return;
  const section = document.getElementById('catalog-section-filter')?.value || '';
  // Se busca sin acentos y sin distinguir mayúsculas: escribir "bulgara" debe
  // encontrar "Sentadilla Búlgara". Y también por nombre en inglés, que es como
  // vienen rotulados muchos aparatos del gimnasio.
  const normalizar = texto => String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const busqueda = normalizar(document.getElementById('catalog-search')?.value.trim());
  const shown = exerciseCatalog.filter(exercise => {
    if (section && exercise.section !== section) return false;
    if (!busqueda) return true;
    return normalizar([exercise.name, exercise.english, exercise.pattern, exercise.machine, exercise.freeWeight].join(' ')).includes(busqueda);
  });
  const withVideo = exerciseCatalog.filter(exercise => exercise.hasVideo).length;

  const filtrando = busqueda || section;
  target.innerHTML = `<p class="section-note">${filtrando ? `${shown.length} de ${exerciseCatalog.length} ejercicios` : `${exerciseCatalog.length} ejercicios`} · ${withVideo} con video · ${exerciseCatalog.length - withVideo} sin video.</p>
    ${shown.length ? `<div class="catalog-list">${shown.map(exercise => `<article class="catalog-item">
      <div class="catalog-item-copy"><b>${escapeHtml(exercise.name)}</b><small>${escapeHtml([exerciseSectionLabels[exercise.section], exercise.pattern, exercise.level].filter(Boolean).join(' · '))}</small></div>
      <span class="catalog-video ${exercise.hasVideo ? 'ready' : ''}">${exercise.hasVideo ? `▶ ${exercise.videoCount > 1 ? `${exercise.videoCount} demostraciones` : exercise.videoDurationSeconds ? `${Math.round(exercise.videoDurationSeconds)} s` : 'con video'}` : 'sin video'}</span>
      <div class="catalog-item-actions">
        <button class="secondary session-use" data-edit-exercise="${exercise.id}">Editar</button>
        ${exercise.hasVideo ? `<button class="secondary session-use" data-preview-exercise="${exercise.id}">Ver demostraciones</button>` : ''}
        <button class="secondary session-use" data-video-exercise="${exercise.id}">${exercise.hasVideo ? 'Agregar video' : 'Subir video'}</button>
      </div></article>`).join('')}</div>` : `<p class="empty">${busqueda ? `Ningún ejercicio coincide con “${escapeHtml(document.getElementById('catalog-search').value.trim())}”.` : 'No hay ejercicios en esta sección.'}</p>`}`;

  target.querySelectorAll('[data-edit-exercise]').forEach(button => {
    button.onclick = () => exerciseEditor(exerciseCatalog.find(exercise => exercise.id === button.dataset.editExercise));
  });
  target.querySelectorAll('[data-video-exercise]').forEach(button => {
    button.onclick = () => exerciseVideoUploader(exerciseCatalog.find(exercise => exercise.id === button.dataset.videoExercise));
  });
  target.querySelectorAll('[data-preview-exercise]').forEach(button => {
    button.onclick = () => previewExerciseVideo(exerciseCatalog.find(exercise => exercise.id === button.dataset.previewExercise));
  });
}

const routineDeliveryLabels = { assignment: 'Asignación', link: 'Enlace', offer: 'Oferta por una clase', travel_link: 'Enlace de viaje', new_version: 'Nueva versión' };
const routineCompletionLabel = item => item.completed
  ? `Cumplida${item.completed_on ? ` · ${fechaHoraPanama(item.completed_on, false)}` : ''}${item.completion_percent != null ? ` · ${Number(item.completion_percent)}%` : ''}`
  : 'Sin confirmar';
function copiarTexto(texto, mensaje = 'Resumen copiado') {
  const fallback = () => {
    const campo = document.createElement('textarea'); campo.value = texto; campo.setAttribute('readonly', ''); campo.style.position = 'fixed'; campo.style.opacity = '0';
    document.body.append(campo); campo.select(); document.execCommand('copy'); campo.remove(); toast(mensaje);
  };
  if (!navigator.clipboard?.writeText) { fallback(); return; }
  navigator.clipboard.writeText(texto).then(() => toast(mensaje)).catch(fallback);
}
function renderRoutineDeliveries(target, deliveries) {
  if (!target) return;
  target.innerHTML = deliveries.length ? `<div class="routine-delivery-list">${deliveries.map((item, index) => `<article class="routine-delivery-item"><header><div><b>${escapeHtml(item.client_name || 'Cliente')}</b><small>${fechaHoraPanama(item.sent_at)} · ${escapeHtml(routineDeliveryLabels[item.kind] || 'Envío')}</small></div><span class="routine-delivery-status ${item.completed ? 'done' : ''}">${routineCompletionLabel(item)}</span></header><div class="routine-delivery-actions"><button type="button" class="secondary" data-show-delivery-summary="${index}">Ver resumen</button><button type="button" class="secondary" data-copy-delivery-summary="${index}">Copiar</button></div><div class="routine-delivery-summary" data-delivery-summary="${index}" hidden>${escapeHtml(item.summary_text || 'No hay resumen guardado.')}</div></article>`).join('')}</div>` : '<p class="empty">Aún no hay envíos registrados.</p>';
  target.querySelectorAll('[data-show-delivery-summary]').forEach(button => button.onclick = () => {
    const summary = target.querySelector(`[data-delivery-summary="${button.dataset.showDeliverySummary}"]`); if (!summary) return;
    summary.hidden = !summary.hidden; button.textContent = summary.hidden ? 'Ver resumen' : 'Ocultar resumen';
  });
  target.querySelectorAll('[data-copy-delivery-summary]').forEach(button => button.onclick = () => copiarTexto(deliveries[Number(button.dataset.copyDeliverySummary)]?.summary_text || ''));
}
function routineDeliveriesSection(target, path) {
  if (!target) return;
  target.innerHTML = '<p class="empty">Cargando envíos de rutinas…</p>';
  api(path).then(deliveries => {
    if (!target.isConnected || !modal.open) return;
    renderRoutineDeliveries(target, Array.isArray(deliveries) ? deliveries : []);
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

// La entrenadora necesita ver lo que subió —comprobar el encuadre, si se
// entiende el movimiento— sin tener que entrar como cliente.
// La rutina como la ve el cliente, para que la entrenadora pueda revisar los
// videos de sus ejercicios sin entrar al portal ni buscarlos en el catálogo.
function routineVersionFromApi(item) {
  return { id: item.id, title: item.title, description: item.description || '', clients: (item.assigned_client_ids || []).length, assignedClientIds: item.assigned_client_ids || [], sessions: item.sessions_per_week, dueOn: item.due_on || null, exercises: item.exercises || [], version: Number(item.version || 1), rootRoutineId: item.root_routine_id || item.id, archivedAt: item.archived_at || null, deliveryCount: Number(item.deliveries_count || 0), deliveryClients: Number(item.delivery_clients_count || 0), lastSentAt: item.last_sent_at || null, lastCompletedAt: item.last_completed_at || null };
}
function routineVersionsSection(target, rootRoutineId) {
  if (!target) return;
  api(`/api/routines?root=${encodeURIComponent(rootRoutineId)}`).then(items => {
    if (!target.isConnected || !modal.open) return;
    const versions = Array.isArray(items) ? items.slice().sort((a, b) => Number(b.version || 1) - Number(a.version || 1)) : [];
    target.innerHTML = versions.length > 1 ? `<div class="routine-version-list">${versions.map(item => `<article class="routine-version-item"><div><b>Versión ${Number(item.version || 1)}</b><small>${item.archived_at ? `Archivada ${fechaHoraPanama(item.archived_at, false)}` : 'Vigente'} · ${Number(item.deliveries_count || 0)} envío${Number(item.deliveries_count || 0) === 1 ? '' : 's'}</small></div><button type="button" class="secondary" data-view-routine-version="${item.id}">Ver versión</button></article>`).join('')}</div>` : '<p class="empty">Esta rutina todavía no tiene otras versiones.</p>';
    target.querySelectorAll('[data-view-routine-version]').forEach(button => button.onclick = () => routineDetail(routineVersionFromApi(versions.find(item => item.id === button.dataset.viewRoutineVersion)), true));
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}
function routineDetail(routine, soloLectura = false) {
  const asignados = (routine.assignedClientIds || []).map(id => data.clients.find(client => client.id === id)?.name).filter(Boolean);
  const conVideo = (routine.exercises || []).filter(exercise => {
    const entry = exerciseCatalog.find(item => item.id === exercise.catalogId || item.slug === exercise.catalogId);
    return entry?.hasVideo;
  }).length;
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">PLAN DE ENTRENAMIENTO</p><h2>${escapeHtml(routine.title)}</h2>
    <p style="color:#6f7b75;margin-top:-12px"><span class="routine-descripcion">${escapeHtml(routine.description || '')}</span><br>${asignados.length ? escapeHtml(asignados.join(', ')) : 'Sin asignar'} · ${routine.sessions} veces por semana</p>
    ${routine.dueOn ? `<p class="routine-due${dateOnly(routine.dueOn) < new Date().toISOString().slice(0, 10) ? ' overdue' : ''}">Fecha límite: ${fechaCorta(routine.dueOn)}</p>` : ''}
    <p class="section-note">Versión ${routine.version || 1}${routine.archivedAt ? ' · archivada' : ' · vigente'} · ${routine.exercises.length} ejercicio${routine.exercises.length === 1 ? '' : 's'} · ${conVideo} con video. Esto es lo que ve el cliente en su portal.</p>
    <div class="exercise-preview">${exerciseRows(routine.exercises || [], exerciseCatalog, 'coachvideo')}</div>
    <p class="eyebrow" style="margin-top:20px">VERSIONES</p><div id="routine-version-history"><p class="empty">Cargando versiones…</p></div>
    <p class="eyebrow" style="margin-top:20px">HISTORIAL DE USO</p><div id="routine-delivery-history"><p class="empty">Cargando envíos de rutinas…</p></div>
    ${soloLectura ? '<p class="section-note">Esta versión se conserva como historial y no se puede editar.</p>' : '<button class="secondary wide-button" id="routine-detail-edit">Editar rutina</button>'}`;
  openModal(box, true);
  routineVersionsSection(document.getElementById('routine-version-history'), routine.rootRoutineId || routine.id);
  routineDeliveriesSection(document.getElementById('routine-delivery-history'), `/api/routines/${encodeURIComponent(routine.id)}/deliveries`);
  document.getElementById('routine-detail-edit')?.addEventListener('click', () => newRoutine(routine));
}

async function previewExerciseVideo(exercise) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">DEMOSTRACIÓN</p><h2>${escapeHtml(exercise.name)}</h2>
    <p style="color:#6f7b75;margin-top:-12px">Así lo ve el cliente en su rutina.</p>
    <div id="preview-video"><p class="empty">Cargando video…</p></div>
    <button class="secondary wide-button" id="preview-replace">Administrar demostraciones</button>`;
  openModal(box);
  document.getElementById('preview-replace').onclick = () => exerciseVideoUploader(exercise);
  try {
    const fuente = await api(`/api/exercises/${exercise.id}/video-urls`);
    const target = document.getElementById('preview-video');
    if (!target || !modal.open) return;
    // En bucle: son clips de pocos segundos y se revisan mirando el movimiento
    // repetido, no una sola vez.
    // Silenciado por necesidad, no por gusto: sin muted el navegador no deja
    // que un video arranque solo, y el clip no empezaría hasta pulsar play.
    target.innerHTML = fuente.videos.map(video => `<section class="exercise-video-variant"><b>${escapeHtml(video.label || 'Demostración')}</b><div class="exercise-video"><video controls loop muted autoplay playsinline preload="auto" src="${escapeHtml(video.videoUrl)}"></video></div></section>`).join('');
    target.querySelectorAll('video').forEach(video => video.play().catch(() => {}));
  } catch (error) {
    const target = document.getElementById('preview-video');
    if (target) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

async function reloadCatalog() {
  const catalog = await api('/api/exercises');
  exerciseCatalog = catalog.map(exercise => ({
    id: exercise.id, slug: exercise.slug, name: exercise.name, english: exercise.english || '',
    section: exercise.section, pattern: exercise.pattern || '', level: exercise.level,
    machine: exercise.machine || 'No aplica', freeWeight: exercise.free_weight || 'No aplica',
    cues: exercise.cues || '', usesWeight: Boolean(exercise.uses_weight), hasVideo: Boolean(exercise.has_video),
    videoCount: Number(exercise.video_count || (exercise.has_video ? 1 : 0)),
    videoDurationSeconds: exercise.video_duration_seconds ? Number(exercise.video_duration_seconds) : null
  }));
}

function exerciseEditor(exercise) {
  const box = document.createElement('div');
  const value = field => escapeHtml(exercise?.[field] ?? '');
  const chosen = (field, option) => (exercise?.[field] || '') === option ? ' selected' : '';
  box.innerHTML = `<form id="exercise-form"><p class="eyebrow">CATÁLOGO</p><h2>${exercise ? 'Editar ejercicio' : 'Nuevo ejercicio'}</h2>
    <label>Nombre<input name="name" required maxlength="120" value="${value('name')}" placeholder="Sentadilla búlgara" /></label>
    <div class="form-row">
      <label>Nombre en inglés<input name="english" maxlength="120" value="${value('english')}" /></label>
      <label>Sección<select name="section" required>${exerciseSectionOrder.filter(section => section !== 'total_body').map(section => `<option value="${section}"${chosen('section', section)}>${exerciseSectionLabels[section]}</option>`).join('')}</select></label>
    </div>
    <div class="form-row">
      <label>Patrón<input name="pattern" maxlength="60" value="${value('pattern')}" placeholder="Empuje, Tirón, Cadera…" /></label>
      <label>Nivel<select name="level">${['Todos', 'Principiante', 'Intermedio', 'Intermedio/Av', 'Avanzado'].map(level => `<option value="${level}"${(exercise?.level || 'Todos') === level ? ' selected' : ''}>${level}</option>`).join('')}</select></label>
    </div>
    <label>Con máquina<input name="machine" maxlength="180" value="${value('machine')}" /></label>
    <label>Sin máquina<input name="freeWeight" maxlength="180" value="${value('freeWeight')}" /></label>
    <label>Claves de ejecución<textarea name="cues" rows="2" maxlength="600" placeholder="Lo que el cliente debe cuidar al ejecutarlo">${value('cues')}</textarea></label>
    <label class="checkbox-line"><input type="checkbox" name="usesWeight"${exercise?.usesWeight ? ' checked' : ''} /> Lleva peso</label>
    <p class="section-note">Si lo marcas, al armar una rutina aparecerá el campo para anotar la carga. Se clasificó solo a partir de la máquina y el implemento; corrígelo si falló.</p>
    <button class="primary wide-button">${exercise ? 'Guardar cambios' : 'Crear ejercicio'}</button>
    ${exercise ? '<button type="button" class="secondary wide-button" id="delete-exercise">Eliminar del catálogo</button>' : ''}</form>`;
  openModal(box);

  if (exercise) document.getElementById('delete-exercise').onclick = async () => {
    if (!confirm(`¿Eliminar "${exercise.name}" del catálogo? Si tiene video, también se borra. Las rutinas ya guardadas conservan su copia.`)) return;
    try { await api(`/api/exercises/${exercise.id}`, { method: 'DELETE' }); await reloadCatalog(); modal.close(); toast('Ejercicio eliminado'); exerciseCatalogManager(); }
    catch (error) { toast(error.message, true); }
  };

  document.getElementById('exercise-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.target);
    const body = {
      name: values.get('name').trim(), english: values.get('english').trim() || null,
      section: values.get('section'), pattern: values.get('pattern').trim() || null,
      level: values.get('level'), machine: values.get('machine').trim() || null,
      freeWeight: values.get('freeWeight').trim() || null, cues: values.get('cues').trim() || null,
      usesWeight: Boolean(values.get('usesWeight'))
    };
    try {
      event.target.classList.add('loading-state');
      if (exercise) await api(`/api/exercises/${exercise.id}`, { method: 'PATCH', body });
      else await api('/api/exercises', { method: 'POST', body });
      await reloadCatalog(); modal.close(); toast(exercise ? 'Ejercicio actualizado' : 'Ejercicio creado'); exerciseCatalogManager();
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

function videoLabelFromFilename(filename) {
  const match = String(filename).match(/opci[oó]n\s*[-_ ]?(\d+)/i);
  return match ? `Opción ${match[1]}` : 'Demostración';
}

async function exerciseVideoUploader(exercise) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">DEMOSTRACIÓN</p><h2>Video de ${escapeHtml(exercise.name)}</h2>
    <p style="color:#6f7b75">Un clip corto ejecutando el ejercicio. El cliente lo verá en su rutina para hacerlo sin asistencia.</p>
    <p class="section-note">Puedes subir varias opciones sin reemplazarlas. Se comprimen antes de subir y se les quita el audio. Si el nombre incluye “opción 1”, “opción 2”, etc., esa etiqueta se conservará.</p>
    <div id="exercise-video-list"><p class="empty">Cargando demostraciones…</p></div>
    <label>Etiqueta opcional para los archivos seleccionados<input id="video-label" maxlength="80" placeholder="Se toma del nombre del archivo" /></label>
    <label style="border:2px dashed #d8a7bc;border-radius:9px;padding:24px;text-align:center;color:#8c5870;cursor:pointer">
      <input id="video-file" type="file" accept="video/*" multiple hidden />Agregar demostraciones<br><small style="color:#6f7b75;font-weight:400">Se acepta lo que grabe tu teléfono</small></label>
    <div id="video-result"></div>
    `;
  openModal(box);
  const result = document.getElementById('video-result');
  const list = document.getElementById('exercise-video-list');

  const renderExisting = async () => {
    try {
      const videos = await api(`/api/exercises/${exercise.id}/videos`);
      list.innerHTML = videos.length ? `<div class="exercise-video-list">${videos.map(video => `<div class="exercise-video-list-item"><span><b>${escapeHtml(video.label || 'Demostración')}</b><small>${video.duration_seconds ? `${Math.round(Number(video.duration_seconds))} s` : 'Duración no disponible'}</small></span><button type="button" class="secondary" data-delete-exercise-video="${video.id}">Quitar</button></div>`).join('')}</div>` : '<p class="empty">Todavía no hay demostraciones.</p>';
    } catch (error) { list.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
  };
  await renderExisting();

  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-delete-exercise-video]');
    if (!button || !confirm(`¿Quitar esta demostración de "${exercise.name}"?`)) return;
    try { button.disabled = true; await api(`/api/exercises/${exercise.id}/videos/${button.dataset.deleteExerciseVideo}`, { method: 'DELETE' }); await reloadCatalog(); await renderExisting(); toast('Demostración eliminada'); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });

  document.getElementById('video-file').addEventListener('change', async event => {
    const files = [...event.target.files]; if (!files.length) return;
    const say = (title, detail) => { result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div>`; };
    try {
      const customLabel = document.getElementById('video-label').value.trim();
      for (const file of files) {
        say('Comprimiendo…', `${file.name} · ${megabytes(file.size)} de origen.`);
        const compressed = await VideoCompressor.compress(file, { onProgress: fraction => say('Comprimiendo…', `${Math.round(fraction * 100)}% de ${file.name}`) });
        if (compressed.blob.size > 40 * 1024 * 1024) throw new Error(`Aun comprimido pesa ${megabytes(compressed.blob.size)} y el máximo son 40 MB. Graba un clip más corto.`);
        const ahorro = compressed.finalSize && compressed.originalSize && compressed.finalSize < compressed.originalSize ? ` (de ${megabytes(compressed.originalSize)} a ${megabytes(compressed.finalSize)})` : '';
        say('Subiendo…', `${file.name} · ${megabytes(compressed.blob.size)}${ahorro}`);
        const target = await api(`/api/exercises/${exercise.id}/videos-upload-url`, { method: 'POST', body: { contentType: compressed.contentType, sizeBytes: compressed.blob.size } });
        const upload = await fetch(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': compressed.contentType }, body: compressed.blob });
        if (!upload.ok) throw new Error(`El almacenamiento rechazó la subida (${upload.status})`);
        await api(`/api/exercises/${exercise.id}/videos`, { method: 'POST', body: { objectKey: target.objectKey, label: customLabel || videoLabelFromFilename(file.name), durationSeconds: compressed.durationSeconds || undefined } });
      }
      await reloadCatalog(); modal.close(); toast(`${files.length} demostración${files.length === 1 ? '' : 'es'} guardada${files.length === 1 ? '' : 's'}`); exerciseCatalogManager();
    } catch (error) {
      say('No se pudo guardar el video', error.message);
      event.target.value = '';
    }
  });
}

// duplicate = true reutiliza una rutina existente como punto de partida para
// otro cliente: copia los ejercicios pero nace sin asignar y se guarda como
// rutina nueva, sin tocar la original.
// ── Demostraciones en bucle (J-110) ──────────────────────────────────────────────────────────────
// Las URLs firmadas duran 5 minutos: se piden al aparecer el ejercicio en pantalla y se reutilizan 4 minutos. Los videos se reproducen solos, en bucle y sin sonido (el navegador no deja
// autoplay con sonido) y se pausan al salir de pantalla para no gastar datos con una rutina larga.
const demosEnMemoria = new Map();
async function demosDelEjercicio(exerciseId, { renovar = false } = {}) {
  const previo = demosEnMemoria.get(exerciseId);
  if (!renovar && previo && Date.now() - previo.at < 240_000) return previo.videos;
  const respuesta = await api(`/api/exercises/${exerciseId}/video-urls`);
  demosEnMemoria.set(exerciseId, { at: Date.now(), videos: respuesta.videos });
  return respuesta.videos;
}
async function pintarDemos(caja, renovar = false) {
  try {
    const videos = await demosDelEjercicio(caja.dataset.demoEjercicio, { renovar });
    caja.innerHTML = videos.map(video => `<figure class="exercise-demo-item"><video muted loop autoplay playsinline controls preload="metadata" src="${escapeHtml(video.videoUrl)}"></video>${videos.length > 1 ? `<figcaption>${escapeHtml(video.label || 'Demostración')}</figcaption>` : ''}</figure>`).join('');
    caja.dataset.cargado = '1';
    // Si la URL firmada venció con el editor abierto, se pide otra una sola vez.
    caja.querySelectorAll('video').forEach(video => { video.addEventListener('error', () => { if (!caja.dataset.renovado) { caja.dataset.renovado = '1'; pintarDemos(caja, true); } }, { once: true }); video.play().catch(() => {}); });
  } catch (error) { caja.textContent = 'No se pudo cargar la demostración.'; caja.dataset.cargado = ''; }
}
function observarDemos(contenedor) {
  const cajas = [...contenedor.querySelectorAll('[data-demo-ejercicio]')];
  if (!cajas.length) return null;
  if (!('IntersectionObserver' in window)) { cajas.forEach(caja => pintarDemos(caja)); return null; }
  const observador = new IntersectionObserver(entradas => entradas.forEach(entrada => {
    const caja = entrada.target;
    if (entrada.isIntersecting) {
      if (!caja.dataset.cargado) pintarDemos(caja); else caja.querySelectorAll('video').forEach(video => video.play().catch(() => {}));
    } else caja.querySelectorAll('video').forEach(video => video.pause());
  }), { rootMargin: '160px' });
  cajas.forEach(caja => observador.observe(caja));
  return observador;
}

function newRoutine(routine = null, duplicate = false, propuesta = null) {
  const editing = Boolean(routine) && !duplicate;
  const initialDueOn = editing ? dateOnly(routine?.dueOn || '') : '';
  // Si la propuesta viene de una clase (oferta en lugar de la clase) o de un viaje, ese contexto se conserva al regenerarla con IA: sin esto, el segundo "Proponer con IA" tiraba el vínculo con la clase o el viaje.
  const contextoPropuesta = propuesta ? Object.fromEntries(['ofertaSesionId', 'ofertaCliente', 'ofertaOrigen', 'ofertaDuracion', 'enlaceViajeId', 'enlaceCliente'].filter(clave => propuesta[clave] !== undefined).map(clave => [clave, propuesta[clave]])) : {};
  const content = formFromTemplate('new-routine-template'); openModal(content, true);
  // OJO: openModal MUEVE los nodos del fragmento al diálogo, así que `content` queda vacío. Todo lo que sigue se busca en el formulario ya montado: antes se consultaba el fragmento vacío,
  // saltaba un TypeError al abrir "Editar" o "Reutilizar" y el editor se quedaba sin conectar (ningún botón respondía). Esto estaba así desde la primera versión del editor.
  const formularioRutina = document.getElementById('routine-form');
  if (routine) {
    formularioRutina.querySelector('h2').textContent = editing ? 'Editar rutina' : 'Reutilizar rutina';
    formularioRutina.querySelector('[name="title"]').value = routine.title;
    formularioRutina.querySelector('[name="description"]').value = routine.description;
    formularioRutina.querySelector('[name="sessions"]').value = routine.sessions;
    formularioRutina.querySelector('button.primary').textContent = editing ? 'Guardar cambios' : 'Guardar rutina completa';
    if (editing) {
      const aviso = document.createElement('p');
      aviso.className = 'section-note';
      aviso.textContent = 'Puedes agregar, quitar, cambiar y mover ejercicios entre bloques. El cliente asignado se conserva; la fecha límite sí puede cambiarse.';
      formularioRutina.prepend(aviso);
    }
  }
  const clientSelect = document.getElementById('routine-client');
  data.clients.forEach(client => clientSelect.add(new Option(`${client.name}${client.status === 'Activo' ? '' : ` · ${client.status}`}`, client.id)));
  // Una copia nace sin cliente a propósito: se está reutilizando justamente
  // porque va para otra persona, y heredar al cliente original invitaría a
  // pisarle la rutina sin darse cuenta.
  if (editing && routine?.assignedClientIds?.[0]) clientSelect.value = routine.assignedClientIds[0];
  if (editing) {
    clientSelect.disabled = true;
    clientSelect.closest('label')?.insertAdjacentHTML('beforeend', '<small>El cliente asignado se conserva al editar; puedes cambiar la fecha límite.</small>');
  }
  if (editing && routine?.dueOn) document.getElementById('routine-due').value = dateOnly(routine.dueOn);
  if (editing && !routine?.assignedClientIds?.length) {
    const due = document.getElementById('routine-due'); due.disabled = true;
    due.closest('label')?.insertAdjacentHTML('beforeend', '<small>Asigna la rutina a un cliente para ponerle fecha.</small>');
  }
  const categorySelect = document.getElementById('exercise-category');
  const levelSelect = document.getElementById('exercise-level');
  const exerciseSelect = document.getElementById('exercise-choice');
  const reference = document.getElementById('exercise-reference');
  const selectedList = document.getElementById('selected-exercises');
  const exerciseCount = document.getElementById('exercise-count');
  const selectedExercises = routine ? routine.exercises.map(exercise => typeof exercise === 'string' ? { name: exercise, category: 'Importado', level: '', sets: 3, reps: '10' } : { ...exercise }) : [];
  const sectionsWithExercises = exerciseSectionOrder.filter(section => section === 'total_body' || exerciseCatalog.some(exercise => exercise.section === section));
  sectionsWithExercises.forEach(section => categorySelect.add(new Option(exerciseSectionLabels[section], section)));
  categorySelect.value = 'total_body';
  [...new Set(exerciseCatalog.map(exercise => exercise.level))].forEach(level => levelSelect.add(new Option(level, level)));

  const currentExercise = () => exerciseCatalog.find(exercise => exercise.id === exerciseSelect.value);
  const renderReference = () => {
    const exercise = currentExercise();
    // El video se abre aquí mismo, no en otro modal: reemplazar el modal
    // borraría la rutina a medio armar.
    reference.innerHTML = exercise ? `<div><b>${escapeHtml(exercise.name)}</b><span>${escapeHtml([exercise.english, exerciseSectionLabels[exercise.section], exercise.pattern].filter(Boolean).join(' · '))}</span></div><span class="exercise-level">${escapeHtml(exercise.level)}</span><small><b>Con máquina:</b> ${escapeHtml(exercise.machine)}<br><b>Sin máquina:</b> ${escapeHtml(exercise.freeWeight)}${exercise.cues ? `<br><b>Ejecución:</b> ${escapeHtml(exercise.cues)}` : ''}${exercise.hasVideo ? '' : '<br>Sin video: el cliente no podrá verlo ejecutado.'}</small>${exercise.hasVideo ? `<button type="button" class="secondary session-use exercise-video-toggle" data-play-exercise="${exercise.id}" data-video-target="refvideo-${exercise.id}">▶ Ver cómo se hace</button><div class="exercise-video" id="refvideo-${exercise.id}" hidden></div>` : ''}` : '<p class="empty">No hay ejercicios con estos filtros.</p>';
  };
  const renderChoices = () => {
    const choices = exerciseCatalog.filter(exercise =>
      (categorySelect.value === 'total_body' || exercise.section === categorySelect.value)
      && (!levelSelect.value || exercise.level === levelSelect.value));
    exerciseSelect.replaceChildren(...choices.map(exercise => new Option(
      `${exercise.hasVideo ? '▶ ' : ''}${exercise.name}${exercise.english ? ` · ${exercise.english}` : ''}`, exercise.id)));
    renderReference();
  };
  // Propuesta con IA: rellena el formulario y lo deja para revisar. No guarda
  // nada — asignar una rutina a una persona es criterio de la entrenadora, no
  // del modelo, y más aún cuando hay lesiones de por medio.
  document.getElementById('routine-suggest').onclick = () => {
    const caja = document.createElement('div');
    caja.innerHTML = `<p class="eyebrow">ENTRENAMIENTO</p><h2>Proponer con IA</h2>
      <p style="color:#6f7b75;margin-top:-12px">Describe lo que buscas. Se usarán sólo ejercicios de tu catálogo, y se tendrán en cuenta las lesiones del cliente y sus rutinas recientes.</p>
      <form id="sugerencia-form">
        <label>Qué quieres para esta rutina<textarea name="description" rows="3" required minlength="10" maxlength="600" placeholder="Ej. Rutina de 45 min: espalda, tríceps y pierna. Tiene disponible: mancuernas y bandas"></textarea></label>
        <label>Para cliente<select name="clientId"><option value="">Sin cliente · sin historial que considerar</option>${data.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></label>
        <label class="checkbox-line"><input type="checkbox" name="repeat" /> Repetir los mismos grupos musculares aunque se hayan trabajado hace poco</label>
        <button class="primary wide-button">Proponer</button>
      </form>`;
    openModal(caja, true);
    // El cliente ya elegido en la rutina se hereda: es el caso normal.
    if (clientSelect.value) caja.querySelector('[name="clientId"]').value = clientSelect.value;
    document.getElementById('sugerencia-form').addEventListener('submit', async evento => {
      evento.preventDefault();
      const valores = new FormData(evento.target);
      const boton = evento.target.querySelector('button');
      boton.disabled = true; boton.textContent = 'Pensando…';
      try {
        const generada = await api('/api/routines/suggest', { method: 'POST', body: {
          description: valores.get('description'),
          clientId: valores.get('clientId') || undefined,
          repeatMuscleGroups: Boolean(valores.get('repeat')),
          forClient: Boolean(contextoPropuesta.ofertaSesionId),
          forTravel: Boolean(contextoPropuesta.enlaceViajeId),
          durationMinutes: contextoPropuesta.ofertaDuracion || (contextoPropuesta.enlaceViajeId ? 40 : undefined)
        } });
        modal.close();
        // Se pasa como argumento y no por un evento en window: cada apertura
        // del formulario registraba un escucha que sólo se retiraba al
        // dispararse, así que los de las veces anteriores seguían vivos y la
        // nota de la propuesta salía repetida una vez por cada uno.
        newRoutine(null, false, { ...generada, ...contextoPropuesta, clientId: valores.get('clientId') || '' });
      } catch (error) { toast(error.message, true); boton.disabled = false; boton.textContent = 'Proponer'; }
    });
  };
  // Se aplica al final del montaje, cuando renderSelected y la lista ya existen.
  const aplicarPropuesta = () => {
    selectedExercises.splice(0, selectedExercises.length);
    for (const sugerido of propuesta.exercises) {
      const enCatalogo = exerciseCatalog.find(item => item.name.toLowerCase() === sugerido.name.toLowerCase());
      selectedExercises.push({
        block: sugerido.block, rounds: sugerido.rounds,
        catalogId: enCatalogo?.id, name: sugerido.name, english: enCatalogo?.english || '',
        category: enCatalogo ? exerciseSectionLabels[enCatalogo.section] : 'Propuesto',
        level: enCatalogo?.level || '', machine: enCatalogo?.machine || '',
        sets: sugerido.sets || 3, reps: sugerido.reps || '12', notes: sugerido.notes || ''
      });
    }
    renderSelected();
    const avisos = [];
    if (propuesta.rationale) avisos.push(propuesta.rationale);
    if (propuesta.avoided?.length) avisos.push(`Se evitó repetir: ${propuesta.avoided.join(', ')}.`);
    if (propuesta.descartados?.length) avisos.push(`Se descartaron por no estar en tu catálogo: ${propuesta.descartados.join(', ')}.`);
    avisos.push('La propuesta es editable: puedes agregar o quitar ejercicios del catálogo y asignarlos a un bloque o dejarlos sueltos.');
    // La IA no inventa cargas: no conoce al cliente. Eileen las fija a su criterio.
    if (selectedExercises.some(item => admitePeso(exerciseCatalog.find(entrada => entrada.id === item.catalogId || entrada.name === item.name)))) avisos.push('Fija el peso de los ejercicios con carga.');
    if (avisos.length) {
      const nota = document.createElement('p');
      nota.className = 'section-note aviso-ambito';
      nota.textContent = `${avisos.join(' ')} Revísala antes de guardar.`;
      document.getElementById('routine-form').prepend(nota);
    }
    toast('Propuesta lista · revísala antes de guardar');
  };

  let observadorDemos = null;
  let bloqueTamano = 3; let bloqueRondas = 3;
  // Mover un ejercicio a un bloque lo deja al final del tramo de ese bloque (los bloques siguen contiguos); "sin bloque" lo manda al final de la lista; "nuevo" abre el bloque siguiente.
  const colocarEnBloque = (item, destino) => {
    const posicion = selectedExercises.indexOf(item); if (posicion >= 0) selectedExercises.splice(posicion, 1);
    const maximo = Math.max(0, ...selectedExercises.map(otro => Number(otro.block) || 0));
    const bloque = destino === 'nuevo' ? maximo + 1 : Number(destino) || 0;
    if (!bloque) { delete item.block; delete item.rounds; selectedExercises.push(item); return; }
    const companero = selectedExercises.find(otro => otro.block === bloque);
    let ultimo = -1; selectedExercises.forEach((otro, k) => { if (otro.block === bloque) ultimo = k; });
    item.block = bloque; item.rounds = companero?.rounds || 3; item.sets = item.rounds;
    selectedExercises.splice(ultimo >= 0 ? ultimo + 1 : selectedExercises.length, 0, item);
  };
  const agregarEjercicio = item => {
    selectedExercises.push(item);
    const destino = document.getElementById('agregar-a')?.value || '';
    if (destino) colocarEnBloque(item, destino);
    renderSelected();
    const filas = selectedList.querySelectorAll('.selected-exercise'); filas[selectedExercises.indexOf(item)]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const renderSelected = () => {
    observadorDemos?.disconnect();
    normalizarBloques(selectedExercises);
    // "Agregar a": sin bloque, cualquiera de los bloques actuales o uno nuevo. Con bloques, lo natural es seguir en el último.
    const agregarA = document.getElementById('agregar-a');
    if (agregarA) {
      const total = Math.max(0, ...selectedExercises.map(otro => Number(otro.block) || 0));
      const previo = agregarA.value;
      agregarA.innerHTML = `<option value="">Sin bloque (suelto)</option>${Array.from({ length: total }, (_, n) => `<option value="${n + 1}">Bloque ${n + 1}</option>`).join('')}<option value="nuevo">Un bloque nuevo (${total + 1})</option>`;
      agregarA.value = [...agregarA.options].some(o => o.value === previo) ? previo : (total ? String(total) : '');
    }
    selectedList.replaceChildren();
    exerciseCount.textContent = `${selectedExercises.length} ejercicio${selectedExercises.length !== 1 ? 's' : ''}`;
    if (!selectedExercises.length) {
      const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Todavía no has agregado ejercicios. Usa el selector superior para construir la rutina.'; selectedList.append(empty); return;
    }
    // Armar bloques de un golpe (J-113): "bloques de 3 ejercicios con 3 rondas". Después se puede cambiar el bloque de cada ejercicio y las rondas de cada bloque.
    if (selectedExercises.length >= 2) {
      const herramienta = document.createElement('div'); herramienta.className = 'bloques-herramienta';
      const opciones = (valores, elegido) => valores.map(valor => `<option value="${valor}" ${valor === elegido ? 'selected' : ''}>${valor}</option>`).join('');
      herramienta.innerHTML = `<span>Dividir en bloques de</span><select id="bloque-tamano" aria-label="Ejercicios por bloque">${opciones([2, 3, 4, 5, 6], bloqueTamano)}</select><span>ejercicios, con</span><select id="bloque-rondas" aria-label="Rondas por bloque">${opciones([1, 2, 3, 4, 5, 6], bloqueRondas)}</select><span>rondas</span><button type="button" class="secondary" id="armar-bloques">Armar bloques</button>${selectedExercises.some(item => item.block) ? '<button type="button" class="secondary" id="quitar-bloques">Quitar bloques</button>' : ''}`;
      selectedList.append(herramienta);
      herramienta.querySelector('#armar-bloques').onclick = () => {
        bloqueTamano = Number(herramienta.querySelector('#bloque-tamano').value); bloqueRondas = Number(herramienta.querySelector('#bloque-rondas').value);
        selectedExercises.forEach((item, posicion) => { item.block = Math.floor(posicion / bloqueTamano) + 1; item.rounds = bloqueRondas; item.sets = bloqueRondas; });
        renderSelected();
      };
      herramienta.querySelector('#quitar-bloques')?.addEventListener('click', () => { selectedExercises.forEach(item => { delete item.block; delete item.rounds; if (item.sets > 6) item.sets = 3; }); renderSelected(); });
    }
    // Si el cliente ya usó pesos en rutinas anteriores, se pueden traer todos de una vez; cada uno se puede cambiar después.
    const pendientes = selectedExercises.filter(item => !item.weight && pesosPrevios[item.name]);
    if (pendientes.length) {
      const traer = document.createElement('button'); traer.type = 'button'; traer.className = 'secondary usar-ultimos-pesos';
      traer.textContent = `Usar los últimos pesos del cliente (${pendientes.length})`;
      traer.onclick = () => { pendientes.forEach(item => { item.weight = pesosPrevios[item.name].weight; }); renderSelected(); };
      selectedList.append(traer);
    }
    selectedExercises.forEach((exercise, index) => {
      // Cabecera del bloque, con sus rondas editables (valen para todo el bloque).
      if (exercise.block && (index === 0 || selectedExercises[index - 1].block !== exercise.block)) {
        const cabecera = document.createElement('div'); cabecera.className = 'bloque-cabecera';
        cabecera.innerHTML = `<b>Bloque ${exercise.block}</b><label>Rondas <input type="number" min="1" max="10" value="${exercise.rounds || 3}" data-bloque-rondas="${exercise.block}" /></label><small>Los ejercicios se hacen seguidos y se repite el bloque.</small>`;
        selectedList.append(cabecera);
      } else if (!exercise.block && index > 0 && selectedExercises[index - 1].block) {
        const suelto = document.createElement('div'); suelto.className = 'bloque-cabecera suelto'; suelto.innerHTML = '<b>Sin bloque</b><small>Ejercicios sueltos, con sus series.</small>'; selectedList.append(suelto);
      }
      const row = document.createElement('div'); row.className = 'selected-exercise';
      const order = document.createElement('span'); order.className = 'selected-exercise-number'; order.textContent = String(index + 1);
      const copy = document.createElement('div'); const name = document.createElement('b'); const details = document.createElement('span');
      name.textContent = exercise.name; details.textContent = [exercise.category, exercise.level].filter(Boolean).join(' · '); copy.append(name, details);
      const mover = document.createElement('div'); mover.className = 'mover-ejercicio';
      mover.innerHTML = `<button type="button" class="secondary" data-mover-ejercicio="${index}" data-dir="-1" aria-label="Subir ${escapeHtml(exercise.name)}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="secondary" data-mover-ejercicio="${index}" data-dir="1" aria-label="Bajar ${escapeHtml(exercise.name)}" ${index === selectedExercises.length - 1 ? 'disabled' : ''}>↓</button>`;
      copy.append(mover);
      const dose = document.createElement('div'); dose.className = 'selected-exercise-dose';
      const setsLabel = document.createElement('label'); setsLabel.className = 'selected-exercise-field'; const setsTitle = document.createElement('span'); setsTitle.textContent = 'Series'; const sets = document.createElement('input'); sets.type = 'number'; sets.min = '1'; sets.max = '20'; sets.value = exercise.sets; sets.dataset.exerciseSets = String(index); setsLabel.append(setsTitle, sets);
      const repsLabel = document.createElement('label'); repsLabel.className = 'selected-exercise-field'; const repsTitle = document.createElement('span'); repsTitle.textContent = 'Repeticiones / tiempo'; const reps = document.createElement('input'); reps.value = exercise.reps; reps.dataset.exerciseReps = String(index); repsLabel.append(repsTitle, reps);
      // Un ejercicio de bloque no lleva series propias: sus rondas son las del bloque.
      const bloqueLabel = document.createElement('label'); bloqueLabel.className = 'selected-exercise-field campo-bloque';
      const maxBloque = Math.max(0, ...selectedExercises.map(item => item.block || 0));
      bloqueLabel.innerHTML = `<span>Bloque</span><select data-exercise-block="${index}"><option value="" ${exercise.block ? '' : 'selected'}>Sin bloque</option>${Array.from({ length: Math.min(20, maxBloque) }, (_, n) => `<option value="${n + 1}" ${exercise.block === n + 1 ? 'selected' : ''}>Bloque ${n + 1}</option>`).join('')}<option value="nuevo">Bloque nuevo (${maxBloque + 1})</option></select>`;
      // Cambiar por otro ejercicio del catálogo (agrupados por sección).
      const cambiarLabel = document.createElement('label'); cambiarLabel.className = 'selected-exercise-field campo-bloque';
      const porSeccion = exerciseSectionOrder.filter(seccion => seccion !== 'total_body').map(seccion => ({ seccion, lista: exerciseCatalog.filter(entrada => entrada.section === seccion) })).filter(grupo => grupo.lista.length);
      cambiarLabel.innerHTML = `<span>Cambiar por otro ejercicio</span><select data-cambiar-ejercicio="${index}"><option value="">Elegir otro…</option>${porSeccion.map(grupo => `<optgroup label="${escapeHtml(exerciseSectionLabels[grupo.seccion] || grupo.seccion)}">${grupo.lista.map(entrada => `<option value="${entrada.id}">${escapeHtml(entrada.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
      if (exercise.block) dose.append(bloqueLabel, cambiarLabel, repsLabel); else dose.append(bloqueLabel, cambiarLabel, setsLabel, repsLabel);
      // El peso sólo se pide donde tiene sentido: una plancha o la caminadora
      // no llevan kilos, y pedirlos en todos llenaría la rutina de huecos.
      const enCatalogo = exerciseCatalog.find(item => item.id === exercise.catalogId || item.name === exercise.name);
      if (admitePeso(enCatalogo)) {
        const pesoLabel = document.createElement('label'); pesoLabel.className = 'selected-exercise-field';
        const pesoTitulo = document.createElement('span'); pesoTitulo.textContent = 'Peso';
        const peso = document.createElement('input');
        peso.value = exercise.weight || '';
        peso.dataset.exerciseWeight = String(index);
        // Nace en blanco a propósito. Lo que el cliente levantó la última vez
        // se ofrece como pista, no se rellena: el peso de hoy lo decide quien
        // lo tiene delante, y arrastrar el de hace dos meses sería colar un
        // número que nadie revisó.
        const anterior = pesosPrevios[exercise.name];
        peso.placeholder = anterior ? `Antes: ${anterior.weight}` : 'Ej. 20 lb';
        if (anterior) peso.title = `La última vez usó ${anterior.weight} (${anterior.on})`;
        pesoLabel.append(pesoTitulo, peso);
        const equivalencia = document.createElement('small');
        equivalencia.className = 'peso-equivalencia';
        const pintarEquivalencia = () => { equivalencia.textContent = equivalenciaPeso(peso.value); };
        pintarEquivalencia();
        peso.addEventListener('input', pintarEquivalencia);
        pesoLabel.append(equivalencia);
        if (anterior) {
          const pista = document.createElement('small');
          pista.className = 'peso-anterior';
          pista.textContent = `Última vez: ${anterior.weight} · ${anterior.on}`;
          pista.tabIndex = 0; pista.role = 'button';
          pista.onclick = () => {
            peso.value = anterior.weight;
            selectedExercises[index].weight = anterior.weight;
            peso.dispatchEvent(new Event('input'));
          };
          pesoLabel.append(pista);
        }
        dose.append(pesoLabel);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'exercise-remove'; remove.dataset.removeExercise = String(index); remove.setAttribute('aria-label', `Quitar ${exercise.name}`); remove.textContent = '×';
      row.append(order, copy, dose, remove);
      // La demostración del catálogo se ve aquí mismo, en bucle y sin sonido, para revisar la rutina sin abrir ejercicio por ejercicio (J-110). Se carga al aparecer en pantalla.
      if (enCatalogo?.hasVideo) {
        const demo = document.createElement('div'); demo.className = 'exercise-demo'; demo.dataset.demoEjercicio = enCatalogo.id;
        demo.innerHTML = '<span class="exercise-demo-espera">Cargando demostración…</span>'; row.append(demo);
      } else {
        const sin = document.createElement('small'); sin.className = 'exercise-demo-sin'; sin.textContent = enCatalogo ? 'Sin video de demostración todavía' : 'Ejercicio fuera del catálogo · sin demostración'; row.append(sin);
      }
      selectedList.append(row);
    });
    observadorDemos = observarDemos(selectedList);
  };
  // Se copia explícitamente lo que la rutina necesita guardar. catalogId es lo
  // que después permite al portal encontrar el video del ejercicio.
  // Pesos que este cliente ya manejó. Se piden al elegir cliente, porque
  // dependen de él y no de la rutina.
  let pesosPrevios = {};
  const cargarPesosPrevios = async () => {
    const id = clientSelect.value;
    pesosPrevios = id ? await api(`/api/clients/${id}/exercise-weights`).catch(() => ({})) : {};
    renderSelected();
  };
  clientSelect.addEventListener('change', () => void cargarPesosPrevios());
  if (clientSelect.value) void cargarPesosPrevios();

  const prescription = exercise => ({
    catalogId: exercise.id, name: exercise.name, english: exercise.english,
    category: exerciseSectionLabels[exercise.section] || exercise.section,
    level: exercise.level, machine: exercise.machine, freeWeight: exercise.freeWeight,
    sets: Number(document.getElementById('exercise-sets').value) || 3,
    reps: document.getElementById('exercise-reps').value.trim() || '10'
  });
  categorySelect.addEventListener('change', renderChoices); levelSelect.addEventListener('change', renderChoices); exerciseSelect.addEventListener('change', renderReference);
  document.getElementById('add-exercise').insertAdjacentHTML('beforebegin', '<label class="campo-agregar-a">Agregar a<select id="agregar-a"></select></label>');
  renderSelected();
  document.getElementById('add-exercise').addEventListener('click', () => { const exercise = currentExercise(); if (!exercise) return; agregarEjercicio(prescription(exercise)); });
  document.getElementById('add-custom-exercise').addEventListener('click', () => {
    const input = document.getElementById('custom-exercise'); const name = input.value.trim(); if (!name) return;
    agregarEjercicio({ name, category: 'Personalizado', level: 'Personalizado', sets: Number(document.getElementById('exercise-sets').value) || 3, reps: document.getElementById('exercise-reps').value.trim() || '10' });
    input.value = ''; renderSelected();
  });
  selectedList.addEventListener('change', event => {
    if (!event.target.matches('[data-exercise-block]')) return;
    const item = selectedExercises[Number(event.target.dataset.exerciseBlock)]; if (!item) return;
    colocarEnBloque(item, event.target.value);
    renderSelected();
  });
  // Cambiar un ejercicio por otro del catálogo conservando su lugar, su bloque y sus repeticiones (el peso y las notas eran del ejercicio anterior).
  selectedList.addEventListener('change', event => {
    if (!event.target.matches('[data-cambiar-ejercicio]')) return;
    const item = selectedExercises[Number(event.target.dataset.cambiarEjercicio)]; const nuevo = exerciseCatalog.find(entrada => entrada.id === event.target.value);
    if (!item || !nuevo) return;
    Object.assign(item, { catalogId: nuevo.id, name: nuevo.name, english: nuevo.english, category: exerciseSectionLabels[nuevo.section] || nuevo.section, level: nuevo.level, machine: nuevo.machine, freeWeight: nuevo.freeWeight });
    delete item.notes; if (!admitePeso(nuevo)) delete item.weight;
    renderSelected(); toast(`Cambiado por ${nuevo.name}`);
  });
  // Subir o bajar un ejercicio dentro de la lista (también para pasarlo de un bloque a otro junto a su vecino).
  selectedList.addEventListener('click', event => {
    const boton = event.target.closest('[data-mover-ejercicio]'); if (!boton) return;
    const posicion = Number(boton.dataset.moverEjercicio); const destino = posicion + Number(boton.dataset.dir);
    if (destino < 0 || destino >= selectedExercises.length) return;
    [selectedExercises[posicion], selectedExercises[destino]] = [selectedExercises[destino], selectedExercises[posicion]];
    renderSelected();
  });
  selectedList.addEventListener('click', event => { const button = event.target.closest('[data-remove-exercise]'); if (!button) return; selectedExercises.splice(Number(button.dataset.removeExercise), 1); renderSelected(); });
  selectedList.addEventListener('input', event => {
    if (event.target.matches('[data-bloque-rondas]')) {
      const rondas = Math.max(1, Math.min(10, Number(event.target.value) || 1));
      selectedExercises.filter(item => item.block === Number(event.target.dataset.bloqueRondas)).forEach(item => { item.rounds = rondas; item.sets = rondas; });
    }
    if (event.target.matches('[data-exercise-sets]')) selectedExercises[Number(event.target.dataset.exerciseSets)].sets = Math.max(1, Math.min(20, Number(event.target.value) || 1));
    if (event.target.matches('[data-exercise-reps]')) selectedExercises[Number(event.target.dataset.exerciseReps)].reps = event.target.value.trim() || '1';
    // El peso puede quedarse vacío: no todos los días se anota, y forzar un
    // valor inventaría una carga que nadie usó.
    if (event.target.matches('[data-exercise-weight]')) selectedExercises[Number(event.target.dataset.exerciseWeight)].weight = event.target.value.trim();
  });
  renderChoices(); renderSelected();
  // Si se viene de la propuesta con IA, se vuelca aquí: ya existe el formulario
  // y la lista de ejercicios.
  if (propuesta) {
    const form = document.getElementById('routine-form');
    if (propuesta.enlaceViajeId) {
      const aviso = document.createElement('p'); aviso.className = 'conflict-warn';
      aviso.innerHTML = `Rutina de viaje para <b>${escapeHtml(propuesta.enlaceCliente || 'el cliente')}</b>. Al guardarla podrás enviársela por un <b>enlace temporal</b>, elegir su vigencia y compartirlo por WhatsApp.`;
      form.prepend(aviso);
    }
    if (propuesta.ofertaSesionId) {
      const aviso = document.createElement('p'); aviso.className = 'conflict-warn';
      aviso.innerHTML = `Esta rutina se le ofrecerá a <b>${escapeHtml(propuesta.ofertaCliente || 'el cliente')}</b> <b>en lugar de su clase, y solo vale el día de la clase</b>. Al guardarla se le avisa; si la cumple ese día, la clase cuenta como realizada${propuesta.ofertaOrigen === 'client' ? '; si no la cumple, <b>la clase se da por perdida</b>' : ''}.`;
      form.prepend(aviso);
    }
    form.elements.title.value = propuesta.title;
    form.elements.description.value = propuesta.description || propuesta.title;
    form.elements.sessions.value = propuesta.sessionsPerWeek;
    if (propuesta.clientId) { clientSelect.value = propuesta.clientId; void cargarPesosPrevios(); }
    if (propuesta.exercises?.length) aplicarPropuesta();
  }
  document.getElementById('routine-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const assigned = form.get('client');
    if (!selectedExercises.length) { toast('Agrega al menos un ejercicio a la rutina', true); return; }
    try {
      event.target.classList.add('loading-state');
      const cambiaConjunto = editing && !sameExerciseSetForVersion(routine.exercises || [], selectedExercises);
      let confirmVersion = false;
      if (cambiaConjunto && (Number(routine.deliveryCount || 0) > 0 || Number(routine.clients || 0) > 0)) {
        confirmVersion = await confirmarNuevaVersion(routine.deliveryClients || routine.clients || 1);
        if (!confirmVersion) { event.target.classList.remove('loading-state'); return; }
      }
      const cuerpo = { title: form.get('title'), description: form.get('description'), sessionsPerWeek: Number(form.get('sessions')), clientId: editing ? undefined : (assigned || undefined), exercises: selectedExercises };
      if (confirmVersion) cuerpo.confirmVersion = true;
      const dueOn = String(form.get('dueOn') || '');
      if (!editing || dueOn !== initialDueOn) cuerpo.dueOn = dueOn || null;
      const rutaGuardado = editing ? `/api/routines/${routine.id}` : '/api/routines';
      let guardada;
      try { guardada = await apiConAvisoDeRepetido(rutaGuardado, { method: editing ? 'PATCH' : 'POST', body: cuerpo }); }
      catch (error) {
        // El servidor decide con más criterios que la pantalla si la rutina está en uso (cumplimientos, cronómetros, enlaces...). Si exige confirmar la versión y la pantalla no la había pedido, se pide ahora y se reintenta: sin esto Eileen quedaba con un error y sin forma de confirmar.
        if (error.code !== 'routine_version_required') throw error;
        if (!await confirmarNuevaVersion(error.clientCount || 1)) { event.target.classList.remove('loading-state'); return; }
        guardada = await apiConAvisoDeRepetido(rutaGuardado, { method: 'PATCH', body: { ...cuerpo, confirmVersion: true } });
      }
      if (!guardada) { event.target.classList.remove('loading-state'); return; }
      if (propuesta?.enlaceViajeId) {
        if (assigned !== propuesta.clientId) throw new Error('La rutina de viaje debe quedar asignada al mismo cliente.');
        await loadData(); renderAll(); modal.close();
        const clienteViaje = data.clients.find(item => item.id === propuesta.clientId);
        const viajeActual = (data.travel || []).find(item => item.id === propuesta.enlaceViajeId) || null;
        enviarEnlaceRutina({ id: guardada.id, title: String(form.get('title')) }, clienteViaje, viajeActual);
        return;
      }
      if (propuesta?.ofertaSesionId) {
        if (assigned !== propuesta.clientId) throw new Error('La rutina ofrecida debe quedar asignada al mismo cliente de la clase.');
        const oferta = await apiConAvisoDeRepetido(`/api/sessions/${propuesta.ofertaSesionId}/routine-offer`, { method: 'POST', body: { routineId: guardada.id, origin: propuesta.ofertaOrigen || 'trainer' } });
        if (!oferta) { event.target.classList.remove('loading-state'); return; }
        await loadData(); renderAll(); modal.close(); toast(`Rutina ofrecida a ${propuesta.ofertaCliente || 'el cliente'} · la clase sigue pendiente`);
        return;
      }
      await loadData(); renderAll(); modal.close(); navigate('routines'); toast('Rutina guardada');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function mensajeDeSaldo(resultado, dicho) {
  const billing = resultado?.billing;
  if (billing?.action === 'debited' && billing.packageLabel) {
    return `${dicho} · descontado de «${billing.packageLabel}» · quedan ${billing.remainingSessions}`;
  }
  if (billing?.action === 'returned') return `${dicho} · ${billing.message}`;
  if (billing?.action === 'not_debited') return `${dicho} · ${billing.message}`;
  return dicho;
}
async function completeSession(id) {
  try { const resultado = await api(`/api/sessions/${id}/complete`, { method: 'POST' }); await loadData(); renderAll(); toast(mensajeDeSaldo(resultado, 'Sesión completada')); }
  catch (error) { toast(error.message, true); }
}
// Cobrar en dos toques: abrir el selector y elegir el método. La fecha es hoy,
// que es el caso normal. Para un pago de otro día está "Otra fecha", que abre
// el formulario completo.
const metodosPago = ['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro'];

// Barras enfrentadas por mes: ingreso y gasto lado a lado. Se eligió barras
// sobre líneas porque lo que importa aquí es la diferencia entre dos
// magnitudes en cada mes, no la tendencia de una sola.
function financeChartSvg(timeline) {
  const ancho = 560, alto = 210, izq = 46, der = 12, arriba = 16, abajo = 26;
  const tope = Math.max(1, ...timeline.map(m => Math.max(m.income, m.expense)));
  const escalaY = valor => alto - abajo - ((alto - arriba - abajo) * valor) / tope;
  const anchoMes = (ancho - izq - der) / timeline.length;
  const anchoBarra = Math.max(3, Math.min(14, anchoMes / 2.6));

  const marcas = [0, 0.5, 1].map(f => {
    const y = escalaY(tope * f);
    return `<line x1="${izq}" y1="${y}" x2="${ancho - der}" y2="${y}" stroke="#ece5e7" stroke-width="1"/><text x="${izq - 6}" y="${y + 3}" text-anchor="end" font-size="8" fill="#7c7077">${Math.round(tope * f).toLocaleString('en-US')}</text>`;
  }).join('');

  const barras = timeline.map((mes, i) => {
    const centro = izq + anchoMes * i + anchoMes / 2;
    const yIngreso = escalaY(mes.income), yGasto = escalaY(mes.expense);
    const base = alto - abajo;
    return `<rect x="${centro - anchoBarra - 1}" y="${yIngreso}" width="${anchoBarra}" height="${Math.max(0, base - yIngreso)}" rx="2" fill="#8fb89c"/>
      <rect x="${centro + 1}" y="${yGasto}" width="${anchoBarra}" height="${Math.max(0, base - yGasto)}" rx="2" fill="#dca78f"/>
      <text x="${centro}" y="${alto - 8}" text-anchor="middle" font-size="8" fill="#7c7077">${mes.month.slice(5)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${ancho} ${alto}" class="finance-chart" role="img" aria-label="Ingresos contra gastos por mes">${marcas}${barras}</svg>
    <div class="chart-leyenda"><span><i style="background:#8fb89c"></i>Ingresos</span><span><i style="background:#dca78f"></i>Gastos</span></div>`;
}

function financeDashboard(rango = 'meses:12', mount = null) {
  const anio = new Date().getFullYear();
  const opciones = [
    ['meses:6', 'Últimos 6 meses'], ['meses:12', 'Últimos 12 meses'], ['meses:24', 'Últimos 24 meses'],
    ['anio:0', `Este año (${anio})`], ['anioAnterior:0', `Año anterior (${anio - 1})`], ['todo:0', 'Todo el historial']
  ];
  const [modo, meses] = rango.split(':');
  const consulta = modo === 'meses' ? `rango=meses&months=${meses}` : `rango=${modo}`;
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">FINANZAS</p><h2>Ingresos y gastos</h2>
    <label>Período<select id="fin-meses">${opciones.map(([valor, texto]) => `<option value="${valor}"${valor === rango ? ' selected' : ''}>${texto}</option>`).join('')}</select></label>
    <div id="fin-cuerpo"><p class="empty">Calculando…</p></div>`;
  const destino = mount || document.getElementById('finanzas-mount');
  if (destino) destino.replaceChildren(box); else openModal(box, true);
  document.getElementById('fin-meses').onchange = event => financeDashboard(event.target.value, destino);
  api(`/api/finance/summary?${consulta}`).then(datos => {
    const target = document.getElementById('fin-cuerpo');
    if (!target?.isConnected) return;
    const t = datos.totales;
    const filas = datos.timeline.filter(m => m.income || m.expense).reverse().map(mes => `<tr>
      <td>${attendanceMonthLabel(mes.month)}</td><td>${money.format(mes.income)}</td><td>${money.format(mes.expense)}</td>
      <td><span class="delta ${mes.net >= 0 ? 'good' : 'bad'}">${money.format(mes.net)}</span></td></tr>`).join('');

    // El negocio arriba y lo personal aparte. Mezclarlos daba un margen que no
    // describía ni una cosa ni la otra: el supermercado restando de lo que
    // cobra por entrenar.
    target.innerHTML = `<p class="eyebrow">EL NEGOCIO</p>
      <div class="metrics" style="grid-template-columns:repeat(2,1fr)">
        <article><span>Ingresos</span><strong>${money.format(t.ingresos)}</strong></article>
        <article><span>Gastos del negocio</span><strong>${money.format(t.gastosNegocio)}</strong></article>
        <article><span>Neto del negocio</span><strong class="${t.netoNegocio >= 0 ? 'neto-positivo' : 'neto-negativo'}">${t.gastosSinClasificar > 0 ? '—' : money.format(t.netoNegocio)}</strong>${t.gastosSinClasificar > 0 ? '<small>falta clasificar</small>' : ''}</article>
        <article><span>Margen</span><strong>${t.margenNegocio === null ? '—' : `${t.margenNegocio}%`}</strong><small>${t.margenNegocio === null ? (t.gastosSinClasificar > 0 ? 'falta clasificar' : 'sin ingresos') : 'de cada dólar cobrado'}</small></article>
      </div>
      ${t.gastosSinClasificar > 0 ? `<p class="section-note aviso-ambito">${money.format(t.gastosSinClasificar)} en categorías sin marcar como negocio o personal, fuera de este margen. Clasifícalas en <b>Gastos → Categorías</b>.</p>` : ''}
      <p class="eyebrow" style="margin-top:18px">PERSONAL Y TOTAL</p>
      <div class="metrics" style="grid-template-columns:repeat(2,1fr)">
        <article><span>Gastos personales</span><strong>${money.format(t.gastosPersonal)}</strong></article>
        <article><span>Gasto total</span><strong>${money.format(t.gastos)}</strong></article>
        <article><span>Neto total</span><strong class="${t.neto >= 0 ? 'neto-positivo' : 'neto-negativo'}">${money.format(t.neto)}</strong><small>ingresos menos todo el gasto</small></article>
        <article><span>Promedio mensual</span><strong>${money.format(t.promedioMensualNeto)}</strong><small>${t.mesesConActividad} mes${t.mesesConActividad === 1 ? '' : 'es'} con movimiento</small></article>
      </div>
      ${financeChartSvg(datos.timeline)}
      ${datos.categorias.length ? `<p class="eyebrow" style="margin-top:18px">GASTO POR CATEGORÍA</p><div class="gasto-resumen">${datos.categorias.map(c => `<span class="ambito-${c.ambito || 'ninguno'}"><b>${money.format(c.total)}</b>${escapeHtml(c.categoria)} · ${c.cantidad}${c.ambito ? '' : ' · sin clasificar'}</span>`).join('')}</div>` : ''}
      <p class="eyebrow" style="margin-top:18px">MES A MES</p>
      ${filas ? `<div class="table-wrap"><table><thead><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Neto</th></tr></thead><tbody>${filas}</tbody></table></div>` : '<p class="empty">Sin movimientos en el período.</p>'}
      <p class="section-note">Ingreso son pagos recibidos, no facturas emitidas: una factura es una promesa y un pago es dinero que entró.${t.gastos === 0 ? ' Todavía no hay gastos registrados, así que el neto es igual al ingreso.' : ''}</p>`;
  }).catch(error => {
    const target = document.getElementById('fin-cuerpo');
    if (target) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  });
}

// Vincular cobros ya hechos con su saldo de sesiones. Los que se pagaron en
// Zoho entraron como facturas sueltas: el cliente pagó pero la app no le
// reconoce sesiones disponibles.

// Gastos: la otra mitad de las finanzas. En lista y no en tabla, por el
// teléfono.
function expensesManager(desde = null, hasta = null, mount = null) {
  // Desde enero y no desde el primero del mes: con el historial importado de
  // Zoho, abrir en el mes en curso mostraba "no hay gastos" aunque hubiera
  // cientos registrados. El año entero cabe de sobra en el tope de la consulta.
  const primeroDelAnio = new Date(today.getFullYear(), 0, 1).toISOString().slice(0, 10);
  const rango = { desde: desde || primeroDelAnio, hasta: hasta || dateKey(today) };
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">FINANZAS</p><h2>Gastos</h2>
    <div class="metrics billing-metrics" id="gasto-metrics"><article><span>Gasto del año</span><strong>—</strong></article><article><span>Gasto del negocio</span><strong>—</strong></article><article><span>Gasto personal</span><strong>—</strong></article><article><span>Mayor categoría</span><strong>—</strong></article></div>
    <div class="billing-insights">
      <article class="card billing-trend-card"><div class="card-head"><div><h3>Gastos durante el año</h3><p id="gasto-chart-summary">Evolución mensual en USD</p></div><span class="insight-year" id="gasto-chart-year"></span></div><div class="billing-line-chart" id="gasto-line-chart" aria-live="polite"><p class="empty">Calculando tendencia anual…</p></div></article>
      <article class="card top-payers-card"><div class="card-head"><div><h3>Categorías con más gasto</h3><p id="gasto-rank-summary">Durante el año</p></div></div><div class="top-payers-list" id="gasto-rank-list"><p class="empty">Calculando ranking…</p></div></article>
    </div>
    <div class="form-row"><label>Desde<input type="date" id="gasto-desde" value="${rango.desde}" /></label><label>Hasta<input type="date" id="gasto-hasta" value="${rango.hasta}" /></label></div>
    <div class="catalog-toolbar"><button class="secondary" id="gasto-nuevo">+ Registrar gasto</button><button class="secondary" id="gasto-categorias">Categorías</button></div>
    <div id="gasto-lista"><p class="empty">Cargando gastos…</p></div>`;
  const destino = mount || document.getElementById('gastos-mount');
  if (destino) destino.replaceChildren(box); else openModal(box, true);
  const recargar = () => expensesManager(document.getElementById('gasto-desde').value, document.getElementById('gasto-hasta').value, destino);
  document.getElementById('gasto-desde').onchange = recargar;
  document.getElementById('gasto-hasta').onchange = recargar;
  document.getElementById('gasto-nuevo').onclick = () => expenseEditor(null, rango);
  document.getElementById('gasto-categorias').onclick = () => expenseCategories(rango);
  renderExpenses(rango);
  renderExpenseInsights();
}

// El mismo tratamiento visual que Cobros, pero para el gasto: KPIs del año, la
// tendencia mensual y el ranking de categorías que más gastan. Los datos salen
// del resumen de finanzas del año (timeline de gasto + gasto por categoría), así
// que no hace falta un endpoint nuevo. El gráfico es del año en curso, igual que
// la tendencia de facturación, no del rango de la lista de abajo.
function renderExpenseInsights() {
  const chartEl = document.getElementById('gasto-line-chart');
  const rankEl = document.getElementById('gasto-rank-list');
  const metricsEl = document.getElementById('gasto-metrics');
  if (!chartEl?.isConnected) return;
  const anio = today.getFullYear();
  const yearTag = document.getElementById('gasto-chart-year'); if (yearTag) yearTag.textContent = anio;
  api('/api/finance/summary?rango=anio').then(datos => {
    if (!chartEl.isConnected) return;
    const valores = Array(12).fill(0);
    (datos.timeline || []).forEach(mes => { const idx = Number(String(mes.month).slice(5, 7)) - 1; if (idx >= 0 && idx < 12) valores[idx] += Number(mes.expense || 0); });
    const totalAnio = valores.reduce((suma, valor) => suma + valor, 0);
    const maxValue = Math.max(...valores, 1);
    const left = 54; const top = 18; const plotWidth = 650; const plotHeight = 176;
    const points = valores.map((value, index) => ({ x: left + (index * plotWidth / 11), y: top + plotHeight - (value / maxValue * plotHeight), value }));
    const line = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const area = `${left},${top + plotHeight} ${line} ${left + plotWidth},${top + plotHeight}`;
    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const compactMoney = value => new Intl.NumberFormat('es-PA', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value);
    const grid = [0, .5, 1].map(ratio => {
      const y = top + plotHeight - ratio * plotHeight;
      return `<g><line x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}" /><text x="${left - 8}" y="${y + 4}" text-anchor="end">${compactMoney(maxValue * ratio)}</text></g>`;
    }).join('');
    const labels = monthNames.map((name, index) => `<text x="${points[index].x}" y="${top + plotHeight + 27}" text-anchor="middle">${name}</text>`).join('');
    const dots = points.map((point, index) => `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${monthNames[index]}: ${money.format(point.value)}</title></circle>`).join('');
    chartEl.innerHTML = `<svg viewBox="0 0 720 235" role="img" aria-label="Gasto mensual de ${anio}"><g class="billing-chart-grid">${grid}${labels}</g><polygon class="billing-chart-area" points="${area}"/><polyline class="billing-chart-line" points="${line}"/>${dots}</svg>`;
    const resumen = document.getElementById('gasto-chart-summary'); if (resumen) resumen.textContent = `${money.format(totalAnio)} en gastos durante ${anio}`;
    const t = datos.totales || {};
    const cats = (datos.categorias || []).slice().sort((a, b) => Number(b.total || 0) - Number(a.total || 0));
    const mayor = cats[0];
    if (metricsEl) metricsEl.innerHTML = `<article><span>Gasto del año</span><strong>${money.format(Number(t.gastos || 0))}</strong></article><article><span>Gasto del negocio</span><strong>${money.format(Number(t.gastosNegocio || 0))}</strong></article><article><span>Gasto personal</span><strong>${money.format(Number(t.gastosPersonal || 0))}</strong></article><article><span>Mayor categoría</span><strong>${mayor ? money.format(Number(mayor.total || 0)) : '—'}</strong>${mayor ? `<small>${escapeHtml(mayor.categoria)}</small>` : ''}</article>`;
    const topCats = cats.slice(0, 6);
    const topAmount = Math.max(...topCats.map(c => Number(c.total || 0)), 1);
    if (rankEl) rankEl.innerHTML = topCats.length ? topCats.map((c, index) => `<div class="top-payer"><span class="top-payer-rank">${index + 1}</span><div class="top-payer-person"><b>${escapeHtml(c.categoria)}</b><small>${c.cantidad} gasto${Number(c.cantidad) === 1 ? '' : 's'}${c.ambito ? '' : ' · sin clasificar'}</small><i><span style="width:${Math.max(4, Number(c.total || 0) / topAmount * 100)}%"></span></i></div><strong>${money.format(Number(c.total || 0))}</strong></div>`).join('') : '<p class="empty">Sin gastos registrados este año.</p>';
  }).catch(error => {
    if (!chartEl.isConnected) return;
    chartEl.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    if (rankEl) rankEl.innerHTML = '<p class="empty">No se pudo cargar el ranking.</p>';
  });
}

function renderExpenses(rango) {
  const target = document.getElementById('gasto-lista');
  api(`/api/expenses?from=${rango.desde}&to=${rango.hasta}`).then(gastos => {
    if (!target?.isConnected) return;
    const total = gastos.reduce((suma, gasto) => suma + Number(gasto.amount), 0);
    const porCategoria = new Map();
    gastos.forEach(gasto => {
      const clave = gasto.category_name || 'Sin categoría';
      porCategoria.set(clave, (porCategoria.get(clave) || 0) + Number(gasto.amount));
    });
    const resumen = [...porCategoria.entries()].sort((a, b) => b[1] - a[1]);

    target.innerHTML = `<p class="section-note">${gastos.length} gasto${gastos.length === 1 ? '' : 's'} · ${money.format(total)} en el período.</p>
      ${resumen.length ? `<div class="gasto-resumen">${resumen.map(([nombre, monto]) => `<span><b>${money.format(monto)}</b>${escapeHtml(nombre)}</span>`).join('')}</div>` : ''}
      ${gastos.length ? `<div class="gasto-lista">${gastos.map(gasto => `<article class="gasto-item">
        <div><b>${escapeHtml(gasto.description)}</b><small>${gasto.spent_on ? fechaCorta(gasto.spent_on) : ''} · ${escapeHtml(gasto.category_name || 'Sin categoría')}${gasto.client_name ? ` · ${escapeHtml(gasto.client_name)}` : ''}${gasto.source_system ? ' · importado de Zoho' : ''}</small></div>
        <span class="gasto-monto">${money.format(gasto.amount)}</span>
        <div class="gasto-acciones"><button class="secondary session-use" data-editar-gasto="${gasto.id}">Editar</button><button class="secondary session-use" data-borrar-gasto="${gasto.id}">Eliminar</button></div>
      </article>`).join('')}</div>` : '<p class="empty">No hay gastos en este período.</p>'}`;

    target.querySelectorAll('[data-editar-gasto]').forEach(b => {
      b.onclick = () => expenseEditor(gastos.find(g => g.id === b.dataset.editarGasto), rango);
    });
    target.querySelectorAll('[data-borrar-gasto]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('¿Eliminar este gasto del registro?')) return;
        try { await api(`/api/expenses/${b.dataset.borrarGasto}`, { method: 'DELETE' }); toast('Gasto eliminado'); renderExpenses(rango); }
        catch (error) { toast(error.message, true); }
      };
    });
  }).catch(error => { if (target?.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

async function expenseEditor(gasto, rango) {
  const categorias = await api('/api/expense-categories').catch(() => []);
  const box = document.createElement('div');
  const v = campo => escapeHtml(gasto?.[campo] ?? '');
  box.innerHTML = `<form id="gasto-form"><p class="eyebrow">FINANZAS</p><h2>${gasto ? 'Editar gasto' : 'Registrar gasto'}</h2>
    <label>Descripción<input name="description" required maxlength="300" value="${v('description')}" placeholder="Alquiler del local" /></label>
    <div class="form-row">
      <label>Monto (USD)<input name="amount" type="number" min="0" step="0.01" required value="${gasto?.amount ?? ''}" /></label>
      <label>Fecha<input name="spentOn" type="date" required value="${gasto ? dateOnly(gasto.spent_on) : dateKey(today)}" /></label>
    </div>
    <label>Categoría<select name="categoryId"><option value="">Sin categoría</option>${categorias.filter(c => !c.archived).map(c => `<option value="${c.id}"${gasto?.category_id === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></label>
    <div class="form-row">
      <label>Método de pago<select name="paymentMethod"><option value="">Sin especificar</option>${metodosPago.map(m => `<option${gasto?.payment_method === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Referencia<input name="reference" maxlength="160" value="${v('reference')}" placeholder="Opcional" /></label>
    </div>
    <label>Notas<textarea name="notes" rows="2" maxlength="500">${v('notes')}</textarea></label>
    <button class="primary wide-button">${gasto ? 'Guardar cambios' : 'Registrar gasto'}</button></form>`;
  openModal(box);
  document.getElementById('gasto-form').addEventListener('submit', async event => {
    event.preventDefault();
    const valores = new FormData(event.target);
    const cuerpo = {
      description: valores.get('description').trim(), amount: Number(valores.get('amount')),
      spentOn: valores.get('spentOn'), categoryId: valores.get('categoryId') || null,
      paymentMethod: valores.get('paymentMethod') || null, reference: valores.get('reference').trim() || null,
      notes: valores.get('notes').trim() || null
    };
    try {
      event.target.classList.add('loading-state');
      if (gasto) await api(`/api/expenses/${gasto.id}`, { method: 'PATCH', body: cuerpo });
      else await api('/api/expenses', { method: 'POST', body: cuerpo });
      modal.close(); toast(gasto ? 'Gasto actualizado' : 'Gasto registrado'); expensesManager(rango.desde, rango.hasta);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

async function expenseCategories(rango) {
  const categorias = await api('/api/expense-categories').catch(() => []);
  // Eileen lleva aquí también sus finanzas personales, así que cada categoría
  // dice a cuál de las dos pertenece. Sin eso, el alquiler de su apartamento
  // se restaría de lo que cobra por entrenar.
  const sinAmbito = categorias.filter(c => !c.ambito).length;
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">FINANZAS</p><h2>Categorías de gasto</h2>
    <form id="categoria-form" class="catalog-toolbar"><input name="name" required minlength="2" maxlength="120" placeholder="Nombre de la categoría" /><button class="secondary">Agregar</button></form>
    ${sinAmbito ? `<p class="section-note aviso-ambito">${sinAmbito} categoría${sinAmbito === 1 ? '' : 's'} sin marcar como negocio o personal. Hasta clasificarlas, su gasto no entra en el margen del negocio.</p>` : ''}
    ${categorias.length ? `<div class="gasto-lista">${categorias.map(c => `<article class="gasto-item">
      <div><b>${escapeHtml(c.name)}</b><small>${c.usos} gasto${c.usos === 1 ? '' : 's'} · ${money.format(c.total)}${c.source_system ? ' · de Zoho' : ''}</small></div>
      <div class="categoria-acciones">
        <select class="ambito-select" data-ambito="${c.id}" aria-label="Ámbito de ${escapeHtml(c.name)}">
          ${[['', 'Sin clasificar'], ['negocio', 'Negocio'], ['personal', 'Personal']].map(([v, t]) => `<option value="${v}"${(c.ambito || '') === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <button class="secondary session-use" data-borrar-categoria="${c.id}">Eliminar</button>
      </div>
    </article>`).join('')}</div>` : '<p class="empty">Todavía no hay categorías.</p>'}
    <p class="section-note">Eliminar una categoría no borra sus gastos: quedan sin clasificar.</p>
    <button class="secondary wide-button" id="volver-gastos">Volver a gastos</button>`;
  openModal(box, true);
  document.getElementById('volver-gastos').onclick = () => { modal.close(); expensesManager(rango.desde, rango.hasta); };
  document.getElementById('categoria-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await api('/api/expense-categories', { method: 'POST', body: { name: new FormData(event.target).get('name').trim() } }); toast('Categoría creada'); expenseCategories(rango); }
    catch (error) { toast(error.message, true); }
  });
  box.querySelectorAll('[data-ambito]').forEach(sel => {
    sel.onchange = async () => {
      try {
        await api(`/api/expense-categories/${sel.dataset.ambito}`, { method: 'PATCH', body: { ambito: sel.value || null } });
        toast('Ámbito actualizado'); expenseCategories(rango);
      } catch (error) { toast(error.message, true); }
    };
  });
  box.querySelectorAll('[data-borrar-categoria]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('¿Eliminar esta categoría? Sus gastos quedarán sin clasificar.')) return;
      try { await api(`/api/expense-categories/${b.dataset.borrarCategoria}`, { method: 'DELETE' }); toast('Categoría eliminada'); expenseCategories(rango); }
      catch (error) { toast(error.message, true); }
    };
  });
}

// Renovar un paquete de clases: por decisión de la entrenadora, abre uno nuevo
// de 6 semanas con su cobro (ella indica método y fecha en el modal). Si al
// cliente le quedaban clases, decide si las pierde —para renovar "al mes" y
// negociar— o si se las arrastra al nuevo.
function renovarPaquete(pack) {
  const restantes = remainingSessions(pack);
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">CONTROL DE PAQUETES</p><h2>Renovar paquete</h2>
    <p class="form-summary">${escapeHtml(pack.client)} · ${escapeHtml(pack.label)}</p>
    ${restantes > 0 ? `<p class="form-summary">Le quedan <b>${restantes}</b> ${restantes === 1 ? 'clase' : 'clases'} sin tomar.</p>` : ''}
    <form id="renovar-form">
      <div class="form-row">
        <label>Sesiones contratadas<input name="totalSessions" type="number" min="1" max="400" required value="${pack.total}" /></label>
        <label>Monto<input name="amount" type="number" min="0" step="0.01" required value="${pack.amount}" /></label>
      </div>
      <div class="form-row">
        <label>Fecha de pago<input name="paidOn" type="date" required value="${dateKey(today)}" /></label>
        <label>Método de pago<select name="method" required><option>Efectivo</option><option>Yappy</option><option>Transferencia bancaria</option><option>Tarjeta</option><option>Otro</option></select></label>
      </div>
      <label>Referencia o comprobante<input name="reference" placeholder="Opcional" /></label>
      ${restantes > 0 ? `<label>Clases que le quedan (${restantes})<select name="carryover"><option value="perder" selected>Perder — empieza limpio</option><option value="arrastrar">Arrastrar — se suman al nuevo</option></select><small>Renovar al mes perdiendo clases es tu palanca para negociar.</small></label>` : ''}
      <button class="primary wide-button">Renovar y cobrar</button>
    </form>`;
  openModal(box);
  document.getElementById('renovar-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const carryover = form.get('carryover') === 'arrastrar';
    if (!confirmarGuardado(`Renovar el paquete de ${pack.client}\n${form.get('method')} · ${form.get('paidOn')}${restantes > 0 ? `\nClases que le quedan: ${carryover ? 'se arrastran al nuevo' : 'se pierden'}` : ''}`)) return;
    try {
      event.target.classList.add('loading-state');
      const r = await api(`/api/packages/${pack.id}/renew`, { method: 'POST', body: {
        method: form.get('method'), reference: form.get('reference') || undefined, paidOn: form.get('paidOn'),
        totalSessions: Number(form.get('totalSessions')), amount: Number(form.get('amount')), carryover
      } });
      await loadData(); renderAll(); modal.close();
      const perdidas = Number(r?.perdidas) || 0;
      toast(`Paquete renovado · ${r?.sessions} clases, vence ${fechaCorta(r?.expiresOn)}${perdidas ? ` · ${perdidas} ${perdidas === 1 ? 'clase perdida' : 'clases perdidas'}` : ''}.`);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

// Bitácora: qué se ha borrado, quién y cuándo. Una bitácora que nadie puede
// leer no sirve de nada, así que se mira desde la propia aplicación y no
// entrando a la base.
const ENTIDADES = {
  '/api/clients/:id': 'Cliente', '/api/plans/:id': 'Plan', '/api/packages/:id': 'Saldo de sesiones',
  '/api/routines/:id': 'Rutina', '/api/exercises/:id': 'Ejercicio', '/api/exercises/:id/video': 'Video de ejercicio',
  '/api/sessions/:id': 'Sesión', '/api/invoices/:id': 'Cobro (anulado)', '/api/invoices/:id/permanent': 'Cobro (definitivo)',
  '/api/expense-categories/:id': 'Categoría de gasto', '/api/expenses/:id': 'Gasto',
  '/api/documents/:id': 'Documento', '/api/inbody/:id': 'Medición InBody',
  '/api/conditions/:id': 'Condición o lesión', '/api/progress-photos/:id': 'Foto de progreso'
};
const resumenBitacora = detalle => {
  if (!detalle || typeof detalle !== 'object') return '';
  for (const clave of ['concept', 'name', 'label', 'title', 'description', 'full_name']) {
    if (typeof detalle[clave] === 'string') return detalle[clave];
  }
  for (const anidado of ['plan', 'categoria', 'client', 'invoice', 'assessment', 'routine']) {
    const valor = detalle[anidado];
    if (valor && typeof valor === 'object') {
      const dentro = resumenBitacora(valor);
      if (dentro) return dentro;
    }
  }
  return '';
};
async function auditLog() {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">REGISTRO</p><h2>Qué se ha borrado</h2>
    <p style="color:#6f7b75;margin-top:-12px">La aplicación borra de verdad. Aquí queda constancia de quién quitó qué y cuándo.</p>
    <div id="bitacora-lista"><p class="empty">Cargando…</p></div>`;
  openModal(box, true);
  try {
    const filas = await api('/api/audit-log?limit=100');
    const destino = document.getElementById('bitacora-lista');
    if (!destino?.isConnected) return;
    destino.innerHTML = filas.length ? `<div class="gasto-lista">${filas.map(fila => {
      const cuando = new Date(fila.created_at);
      const que = ENTIDADES[fila.route] || fila.route;
      const detalle = resumenBitacora(fila.detail);
      return `<article class="gasto-item"><div>
        <b>${escapeHtml(que)}${detalle ? ` · ${escapeHtml(detalle)}` : ''}</b>
        <small>${new Intl.DateTimeFormat('es-PA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Panama' }).format(cuando)} · ${escapeHtml(fila.user_email || 'desconocido')}</small>
      </div></article>`;
    }).join('')}</div>` : '<p class="empty">Todavía no se ha borrado nada.</p>';
  } catch (error) {
    const destino = document.getElementById('bitacora-lista');
    if (destino) destino.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

// Qué mes cubre cada cobro. Las mensualidades se pagan por adelantado, así que
// lo cobrado en agosto cubre septiembre; sin decirlo, la generación automática
// mira la fecha de emisión, da septiembre por pendiente y emite un segundo
// cobro. Aquí se le dice.

function pendingCollections() {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">COBROS PENDIENTES</p><h2>Registrar cobros</h2>
    <p style="color:#6f7b75;margin-top:-12px">Elige el método y queda cobrado con fecha de hoy.</p>
    <div id="pending-list"></div>`;
  openModal(box, true);
  renderPendingCollections();
}

function renderPendingCollections() {
  const target = document.getElementById('pending-list');
  if (!target) return;
  const pendientes = data.invoices
    .filter(invoice => invoice.status === 'pending' && invoice.source !== 'zoho_invoice')
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const total = pendientes.reduce((suma, invoice) => suma + Number(invoice.balance || invoice.amount), 0);
  const hoy = dateKey(today);

  target.innerHTML = pendientes.length ? `<p class="section-note">${pendientes.length} pendiente${pendientes.length === 1 ? '' : 's'} · ${money.format(total)} por cobrar.</p>
    <div class="pending-list">${pendientes.map(invoice => `<article class="pending-item${invoice.due < hoy ? ' overdue' : ''}">
      <div><b>${escapeHtml(invoice.client)}</b><small>${escapeHtml(invoice.concept)} · vence ${invoice.due}${invoice.due < hoy ? ' · vencida' : ''}</small></div>
      <span class="pending-amount">${money.format(invoice.balance || invoice.amount)}</span>
      <div class="pending-actions">
        <select data-quick-collect="${invoice.id}" aria-label="Cobrar ${escapeHtml(invoice.client)}">
          <option value="">Cobrar hoy…</option>
          ${['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro'].map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
        <button class="secondary session-use" data-other-date="${invoice.id}">Otra fecha</button>
      </div></article>`).join('')}</div>` : '<p class="empty">No hay cobros pendientes.</p>';

  target.querySelectorAll('[data-quick-collect]').forEach(selector => {
    selector.onchange = async event => {
      const metodo = event.target.value; if (!metodo) return;
      event.target.disabled = true;
      try {
        const factura = data.invoices.find(item => item.id === event.target.dataset.quickCollect);
        await api(`/api/invoices/${event.target.dataset.quickCollect}/confirm`, { method: 'POST', body: { amount: factura?.amount, method: metodo, paidOn: dateKey(today) } });
        await loadData(); renderAll(); toast(`Cobrado · ${metodo}`); renderPendingCollections();
      } catch (error) { toast(error.message, true); event.target.disabled = false; event.target.value = ''; }
    };
  });
  target.querySelectorAll('[data-other-date]').forEach(button => {
    button.onclick = () => confirmInvoice(button.dataset.otherDate);
  });
}

function confirmInvoice(id, editing = false) {
  const invoice = data.invoices.find(item => item.id === id); if (!invoice) return;
  const content = formFromTemplate('confirm-payment-template'); openModal(content);
  const detalleFamiliar = detalleCobroFamiliar(invoice);
  const totalFamiliar = totalFamiliarDelCorte(invoice);
  const saldoActual = Number(invoice.balance ?? invoice.amount);
  document.getElementById('payment-summary').textContent = `${invoice.client} · ${detalleFamiliar || invoice.concept} · Factura ${money.format(invoice.amount)} · ${invoice.paidAmount > 0 ? `pagado ${money.format(invoice.paidAmount)} · ` : ''}pendiente ${money.format(saldoActual)}${totalFamiliar ? ` · Total familiar del corte: ${money.format(totalFamiliar)}` : ''}`;
  const paymentForm = document.getElementById('payment-form');
  paymentForm.elements.amount.value = invoice.paidAmount > 0 ? invoice.paidAmount.toFixed(2) : invoice.amount.toFixed(2);
  paymentForm.elements.paidOn.value = invoice.paidOn || dateKey(today);
  paymentForm.elements.method.value = invoice.method === 'pending' ? 'Efectivo' : invoice.method;
  paymentForm.elements.reference.value = invoice.reference || '';
  if (editing) { content.querySelector('h2').textContent = 'Editar pago recibido'; content.querySelector('button').textContent = 'Guardar pago'; }
  document.getElementById('payment-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    if (!confirmarGuardado(`${editing ? 'Cambiar el pago' : 'Registrar pago'}\n${money.format(Number(form.get('amount')))} · ${form.get('method')} · ${form.get('paidOn')}`)) return;
    try {
      event.target.classList.add('loading-state');
      const respuesta = await api(`/api/invoices/${id}${editing ? '/payment' : '/confirm'}`, { method: editing ? 'PATCH' : 'POST', body: { amount: Number(form.get('amount')), method: form.get('method'), reference: form.get('reference') || undefined, paidOn: form.get('paidOn') } });
      const coberturaAbierta = respuesta?.coberturaAutomatica || [];
      const paqueteActivado = respuesta?.paqueteActivado || null;
      await loadData(); renderAll(); modal.close(); navigate('billing');
      if (coberturaAbierta.length) {
        // Se renovó sola la mensualidad del titular y su gente. Ya no se abre el
        // editor cada vez: para clientela fija es fricción de más. La cobertura
        // queda resuelta por la confirmación del pago.
        const detalle = coberturaAbierta.map(c => `${c.fullName}${c.sessions ? ` (${c.sessions})` : ''}`).join(', ');
        toast(`Mensualidad renovada · ${detalle}. Sesiones cargadas.`);
      } else if (paqueteActivado && paqueteActivado.sessions) {
        // El paquete ligado ya estaba y el pago lo despertó: se avisa que sus
        // sesiones quedaron disponibles.
        toast(`Pago confirmado · ${paqueteActivado.kind === 'monthly' ? 'mensualidad activada' : `paquete de ${paqueteActivado.sessions} sesiones activado`}${paqueteActivado.kind === 'monthly' ? ` (${paqueteActivado.sessions} sesiones)` : ''}.`);
      } else if (Number(respuesta?.balance ?? respuesta?.invoice?.balance ?? 0) > 0) {
        toast(`Pago parcial registrado · saldo ${money.format(Number(respuesta?.balance ?? respuesta?.invoice?.balance))}`);
      } else {
        toast('Pago confirmado');
      }
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
// Aplicar un cobro a las mensualidades que cubre.
//
// Una factura de Zoho llega como una sola línea a nombre de quien paga: los
// $350 de Eduardo no dicen en ninguna parte que son la mensualidad suya y la
// de Beatris. Y no se pueden editar, porque sobre lo suyo manda Zoho. Aquí se
// anota por fuera a quién cubren, y de ahí sale el saldo de sesiones de cada
// uno sin emitir un cobro nuevo.
async function applyInvoiceCoverage(id) {
  let datos;
  try { datos = await api(`/api/invoices/${id}/coverage`); }
  catch (error) { toast(error.message, true); return; }

  const { invoice: serverInvoice, candidates, applied, suggestedPeriod, coverageStart } = datos;
  const invoice = data.invoices.find(item => item.id === id) || {
    clientId: serverInvoice.client_id,
    client: serverInvoice.full_name,
    billedForClientId: serverInvoice.billed_for_client_id || serverInvoice.client_id,
    billedForSpecified: serverInvoice.billed_for_client_id != null,
    billedFor: serverInvoice.full_name,
    amount: Number(serverInvoice.amount),
    concept: serverInvoice.concept,
    source: serverInvoice.source_system || 'eileen'
  };
  const destinatarioId = invoice.billedForSpecified ? invoice.billedForClientId : null;
  const destinatario = destinatarioId ? candidates.find(persona => persona.id === destinatarioId) : null;
  const importeFactura = Number(invoice.amount ?? serverInvoice.amount) || 0;
  const box = document.createElement('div');
  const mes = String(suggestedPeriod).slice(0, 7);
  const yaCubierto = new Set(applied.map(a => a.client_id));

  // Una línea con beneficiario explícito ya representa una sola mensualidad:
  // no se vuelve a repartir entre toda la familia. Sólo los cobros antiguos
  // agregados, sin billed_for_client_id, se distribuyen entre varias personas.
  const repartibles = candidates.filter(p => !yaCubierto.has(p.id) && p.status === 'active'
    && (!destinatarioId || p.id === destinatarioId));
  const disponibleTotal = Math.max(0, importeFactura - applied.reduce((s, a) => s + Number(a.amount || 0), 0));
  const baseSuma = repartibles.reduce((s, p) => s + (Number(p.suggested_amount) || 0), 0);
  const montoPrefill = {};
  if (baseSuma > 0 && disponibleTotal > 0) {
    let acumulado = 0;
    repartibles.forEach((p, i) => {
      if (i < repartibles.length - 1) {
        const v = Math.round((Number(p.suggested_amount) || 0) / baseSuma * disponibleTotal * 100) / 100;
        montoPrefill[p.id] = v; acumulado += v;
      } else {
        // El último toma el remanente para que la suma dé exacta al centavo.
        montoPrefill[p.id] = Math.round((disponibleTotal - acumulado) * 100) / 100;
      }
    });
  }

  const filas = candidates.map(persona => {
    const cubierta = yaCubierto.has(persona.id);
    const inactiva = persona.status !== 'active';
    const elegible = !destinatarioId || persona.id === destinatarioId;
    const monto = elegible ? (montoPrefill[persona.id] ?? (Number(persona.suggested_amount) || 0)) : 0;
    return `
      <div class="coverage-row${cubierta ? ' coverage-row-done' : ''}">
        <label class="coverage-pick">
          <input type="checkbox" name="pick" value="${persona.id}" ${cubierta || inactiva || !elegible ? 'disabled' : 'checked'} />
          <span><b>${escapeHtml(persona.full_name)}</b><small>${escapeHtml(persona.plan_name || 'Sin plan comercial')}${inactiva ? ' · inactivo' : ''}</small></span>
        </label>
        <label>Monto<input type="number" min="0" step="0.01" name="amount-${persona.id}" value="${monto}" ${cubierta || !elegible ? 'disabled' : ''} /></label>
        <label>Sesiones<input type="number" min="0" step="1" name="sessions-${persona.id}" value="${Number(persona.suggested_sessions) || 0}" ${cubierta || !elegible ? 'disabled' : ''} /></label>
      </div>`;
  }).join('');

  const aplicadas = applied.length ? `
    <div class="coverage-applied">
      <p class="eyebrow">YA APLICADO</p>
      ${applied.map(a => `<div class="coverage-applied-row"><span>${escapeHtml(a.full_name)} · ${money.format(a.amount)}${a.total_sessions ? ` · ${Number(a.total_sessions) - Number(a.used_sessions || 0)} de ${a.total_sessions} sesiones` : ''}</span><button type="button" class="secondary session-use" data-drop-coverage="${a.id}">Quitar</button></div>`).join('')}
    </div>` : '';

  box.innerHTML = `
    <form id="coverage-form">
      <p class="eyebrow">${invoice.source === 'zoho_invoice' ? 'COBRO DE ZOHO' : 'COBRO LOCAL'}</p>
      <h2>Aplicar a mensualidades</h2>
      <p class="commercial-note">${escapeHtml(invoice.client || serverInvoice.full_name)} · ${escapeHtml(invoice.concept || serverInvoice.concept)} · <b>${money.format(importeFactura)}</b></p>
      ${destinatario ? `<p class="commercial-note">Esta línea cubre únicamente la mensualidad de <b>${escapeHtml(destinatario.full_name)}</b> por ${money.format(importeFactura)}. No se reparte entre otras personas.</p>` : ''}
      <label>Mes que cubre<input type="month" name="period" value="${mes}" required /><small id="coverage-ciclo">&nbsp;</small></label>
      <div class="coverage-list">${filas || '<p class="empty">Nadie a quien aplicar este cobro.</p>'}</div>
      <p class="commercial-note" id="coverage-total"></p>
      ${aplicadas}
      <button class="primary wide-button">Abrir saldos</button>
    </form>`;
  openModal(box);

  const form = document.getElementById('coverage-form');
  // El aviso de descuadre se recalcula al vuelo: es lo que deja ver de un
  // golpe si el reparto se pasa o se queda corto frente al total cobrado.
  const totalizar = () => {
    const suma = candidates.reduce((acumulado, persona) => {
      const pick = form.querySelector(`input[name="pick"][value="${persona.id}"]`);
      if (!pick?.checked) return acumulado;
      return acumulado + (Number(form.elements[`amount-${persona.id}`]?.value) || 0);
    }, 0);
    const total = importeFactura;
    const nota = document.getElementById('coverage-total');
    const yaAplicado = applied.reduce((acumulado, a) => acumulado + Number(a.amount || 0), 0);
    const cuadra = Math.abs(suma + yaAplicado - total) < 0.01;
    nota.textContent = cuadra
      ? `Reparte los ${money.format(total)} completos.`
      : `Repartes ${money.format(suma + yaAplicado)} de ${money.format(total)}. Puede ser correcto si el cobro incluye algo más.`;
    nota.classList.toggle('coverage-warn', !cuadra);
  };
  form.addEventListener('input', totalizar);
  totalizar();

  // El mes elegido no dice hasta cuándo cubre, y ahí estaba el malentendido:
  // con corte el día 1, "octubre" son las clases del 1 de octubre al 1 de
  // noviembre, no las de octubre a secas. Se enseña el período de verdad.
  const pistaCiclo = document.getElementById('coverage-ciclo');
  const corteDeReferencia = candidates.length ? Number(candidates[0].billing_cutoff_day) || 1 : 1;
  const pintarCiclo = async () => {
    if (!pistaCiclo || !form.elements.period.value) return;
    try {
      // La vigencia nace en la fecha real del pago (no en el día 1 del mes
      // elegido como referencia contable). Por ejemplo, un pago del 28/08
      // con corte 28 cubre del 28/08 al 28/09.
      const inicio = (coverageStart && String(coverageStart).slice(0, 10)) || `${form.elements.period.value}-01`;
      const ciclo = await api(`/api/billing/cycle?from=${inicio}&cutoffDay=${corteDeReferencia}`);
      pistaCiclo.textContent = `Cubre del ${ciclo.label.replace(' – ', ' al ')}, según el corte día ${corteDeReferencia}.`;
    } catch { pistaCiclo.textContent = ''; }
  };
  form.elements.period.addEventListener('change', pintarCiclo);
  pintarCiclo();

  form.querySelectorAll('[data-drop-coverage]').forEach(boton => {
    boton.onclick = async () => {
      if (!confirm('¿Quitar esta cobertura?\n\nSe lleva el saldo de sesiones si no se ha usado ninguna.')) return;
      try {
        await api(`/api/invoices/${id}/coverage/${boton.dataset.dropCoverage}`, { method: 'DELETE' });
        await loadData(); renderAll(); modal.close(); toast('Cobertura quitada');
      } catch (error) { toast(error.message, true); }
    };
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const entries = candidates
      .filter(persona => form.querySelector(`input[name="pick"][value="${persona.id}"]`)?.checked)
      .map(persona => ({
        clientId: persona.id,
        amount: Number(form.elements[`amount-${persona.id}`].value) || 0,
        sessions: Number(form.elements[`sessions-${persona.id}`].value) || 0
      }));
    if (!entries.length) { toast('Marca al menos a una persona', true); return; }
    const periodo = `${form.elements.period.value}-01`;
    const resumen = entries.map(e => {
      const persona = candidates.find(c => c.id === e.clientId);
      return `${persona.full_name} · ${money.format(e.amount)} · ${e.sessions} sesiones`;
    }).join('\n');
    if (!confirmarGuardado(`Aplicar este cobro a:\n${resumen}\n\n${pistaCiclo?.textContent || `Mes cubierto: ${form.elements.period.value}`}`)) return;
    try {
      event.target.classList.add('loading-state');
      await api(`/api/invoices/${id}/coverage`, { method: 'POST', body: { billingPeriod: periodo, entries } });
      await loadData(); renderAll(); modal.close();
      toast(`${entries.length} saldo${entries.length === 1 ? '' : 's'} abierto${entries.length === 1 ? '' : 's'}`);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

// Aplicar un cobro ya pagado a un paquete de clases: abre un saldo de N sesiones
// ligado a ese cobro, sin emitir factura nueva. Un paquete no dura más de 6
// semanas desde el pago; si se pasa del mes, se avisa pero se deja seguir.
function applyInvoicePackage(id) {
  const invoice = data.invoices.find(item => item.id === id); if (!invoice) return;
  const destinatarioId = invoice.billedForClientId || invoice.clientId;
  const destinatario = clienteDeLaLinea(invoice);
  const destinatarioNombre = destinatario?.name || invoice.billedFor || invoice.client;
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const inicio = new Date(`${(invoice.coverageStart || invoice.paidOn || invoice.issued || invoice.due || dateKey(today))}T12:00:00`);
  const avisoDesde = new Date(inicio); avisoDesde.setMonth(avisoDesde.getMonth() + 1);
  const tope = new Date(inicio); tope.setDate(tope.getDate() + 42);
  // Prellenar las clases: del plan del cliente, y si no, de su último paquete.
  // Así los de paquete (que no tienen meta mensual) también autocompletan.
  const clientePaq = data.clients.find(c => c.id === destinatarioId);
  const ultimoPaquete = data.packages
    .filter(p => p.clientId === destinatarioId && p.kind === 'package')
    .sort((a, b) => (b.purchasedOn || '').localeCompare(a.purchasedOn || ''))[0];
  const clasesSugeridas = (clientePaq && clientePaq.sessionsIncluded) || (ultimoPaquete && ultimoPaquete.total) || '';
  // La validez arranca desde el pago y dura los "días de validez" del plan del
  // cliente (p. ej. 35 = 5 semanas). Ese es el valor por defecto; se puede
  // ajustar a mano hasta el tope de 6 semanas.
  const diasValidez = (clientePaq && clientePaq.validityDays) || 42;
  const porDefecto = new Date(inicio); porDefecto.setDate(porDefecto.getDate() + diasValidez);

  const box = document.createElement('div');
  box.innerHTML = `
    <form id="package-form">
      <p class="eyebrow">${invoice.source === 'zoho_invoice' ? 'COBRO DE ZOHO' : 'COBRO LOCAL'}</p>
      <h2>Aplicar a paquete de clases</h2>
      <p class="commercial-note">${escapeHtml(invoice.client)} · ${escapeHtml(invoice.concept)} · <b>${money.format(invoice.amount)}</b></p>
      ${destinatarioNombre !== invoice.client ? `<p class="commercial-note">Este paquete quedará a nombre de <b>${escapeHtml(destinatarioNombre)}</b>.</p>` : ''}
      <label>Clases del paquete<input type="number" name="sessions" min="1" step="1" value="${clasesSugeridas}" required /></label>
      <label>Válido hasta<input type="date" name="expiresOn" value="${fmt(porDefecto)}" min="${fmt(inicio)}" max="${fmt(tope)}" required /></label>
      <p class="commercial-note" id="package-note">${diasValidez} días de validez desde el pago, según su plan.</p>
      <button class="primary wide-button">Abrir paquete</button>
    </form>`;
  openModal(box);

  const form = document.getElementById('package-form');
  const nota = document.getElementById('package-note');
  const revisar = () => {
    const valor = form.elements.expiresOn.value;
    const boton = form.querySelector('button');
    if (!valor) { nota.textContent = `${diasValidez} días de validez desde el pago, según su plan.`; nota.classList.remove('coverage-warn'); boton.disabled = false; return; }
    const expira = new Date(`${valor}T12:00:00`);
    if (expira > tope) {
      nota.textContent = 'Se pasa de las 6 semanas: acorta la fecha, un paquete no puede durar más que eso.';
      nota.classList.add('coverage-warn'); boton.disabled = true;
    } else if (expira > porDefecto) {
      nota.textContent = `Pasa de los ${diasValidez} días de validez del plan; revisa que sea intencional.`;
      nota.classList.add('coverage-warn'); boton.disabled = false;
    } else {
      nota.textContent = 'Dentro de la validez del plan. Correcto.';
      nota.classList.remove('coverage-warn'); boton.disabled = false;
    }
  };
  form.addEventListener('input', revisar); revisar();

  form.addEventListener('submit', async event => {
    event.preventDefault(); const datos = new FormData(event.target);
    const sesiones = Number(datos.get('sessions'));
    // Evitar duplicar: si el cliente ya tiene un paquete vivo, avisar antes de
    // abrir otro. El caso típico es un paquete que quedó pendiente y en vez de
    // marcarlo pagado desde "Editar" se aplica otro cobro, dejando dos saldos.
    const vivo = (data.packages || []).find(p => p.clientId === destinatarioId && p.status !== 'expired' && p.kind === 'package');
    if (vivo && !confirm(`${destinatarioNombre} ya tiene un paquete (${remainingSessions(vivo)} disponibles, ${vivo.status === 'pending' ? 'pendiente de pago' : 'activo'}).\n\nAbrir otro dejaría dos saldos. Si solo querías marcar el existente como pagado, cancela y corrige el cobro desde el expediente del cliente.\n\n¿Abrir un paquete nuevo de todas formas?`)) return;
    if (!confirmarGuardado(`Abrir un paquete de ${sesiones} clases para ${destinatarioNombre}\nVálido hasta ${datos.get('expiresOn')}`)) return;
    try {
      event.target.classList.add('loading-state');
      const resp = await api(`/api/invoices/${id}/package`, { method: 'POST', body: { totalSessions: sesiones, expiresOn: datos.get('expiresOn') } });
      await loadData(); renderAll(); modal.close();
      toast(`Paquete de ${sesiones} clases abierto para ${destinatarioNombre}${resp?.saldado ? ' · cobro marcado como pagado' : ''}`);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

async function recalculateCreditInvoice(id) {
  try {
    const preview = await api(`/api/invoices/${id}/recalculate`, { method: 'POST', body: { apply: false } });
    const cambio = Number(preview.difference || 0);
    const signo = cambio > 0 ? '+' : '';
    const estado = value => value === 'confirmed' ? 'Confirmada' : value === 'pending' ? 'Pendiente' : value === 'void' ? 'Anulada' : String(value || '—');
    const mensaje = `Recalcular factura de crédito\n\n` +
      `Antes: ${money.format(Number(preview.previousAmount || 0))} · ${estado(preview.previousStatus)}\n` +
      `Después: ${money.format(Number(preview.newAmount || 0))} · ${estado(preview.newStatus)}\n` +
      `Diferencia: ${signo}${money.format(cambio)}\n\n` +
      (cambio > 0
        ? 'Si aumenta, quedará pendiente por la diferencia.'
        : cambio < 0
          ? 'Si baja, seguirá confirmada; no se hará devolución automática.'
          : 'No hay cambio en el importe.') +
      '\n\n¿Aplicar este recálculo?';
    if (!confirm(mensaje)) return;
    await api(`/api/invoices/${id}/recalculate`, { method: 'POST', body: { apply: true } });
    await loadData(); renderAll();
    toast('Factura de crédito recalculada');
  } catch (error) { toast(error.message, true); }
}

function editInvoice(id) {
  const invoice = data.invoices.find(item => item.id === id); if (!invoice) return;
  const box = document.createElement('div');
  box.innerHTML = `<form id="edit-invoice-form"><p class="eyebrow">COBRO LOCAL</p><h2>Editar cobro</h2><label>Concepto<input name="concept" required value="${escapeHtml(invoice.concept)}" /></label><div class="form-row"><label>Monto (USD)<input name="amount" type="number" min="0" step="0.01" required value="${invoice.amount}" /></label><label>Vencimiento<input name="dueOn" type="date" required value="${invoice.due}" /></label></div><button class="primary wide-button">Guardar cobro</button></form>`;
  openModal(box);
  document.getElementById('edit-invoice-form').addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(event.target);
    if (!confirmarGuardado(`Cambiar el cobro a ${money.format(Number(values.get('amount')) || 0)}\n${values.get('concept')}`)) return;
    try { event.target.classList.add('loading-state'); await api(`/api/invoices/${id}`, { method: 'PATCH', body: { concept: values.get('concept'), amount: Number(values.get('amount')), dueOn: values.get('dueOn') } }); await loadData(); renderAll(); modal.close(); toast('Cobro actualizado'); }
    catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
// Postgres devuelve las columnas date como Date, y al serializarse a JSON
// llegan en ISO largo. Un input[type=date] rechaza ese formato y se queda en
// blanco, así que la fecha guardada desaparecía al abrir el formulario.
const dateOnly = value => value ? String(value).slice(0, 10) : '';
// Formato para MOSTRAR: dd-mm-yyyy. Los valores de máquina (inputs, filtros,
// comparaciones) siguen en yyyy-mm-dd con dateOnly/dateKey; esto es sólo lo que
// ve la entrenadora. Acepta un Date o una cadena ISO/parcial.
const fechaCorta = value => {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};
const poseLabels = { front: 'Frente', side: 'Perfil', back: 'Espalda', other: 'Otra' };
const conditionKindLabels = { injury: 'Lesión', condition: 'Padecimiento' };
const severityLabels = { mild: 'Leve', moderate: 'Moderada', severe: 'Severa' };
const conditionStatusLabels = { active: 'Activa', monitoring: 'En observación', recovered: 'Recuperada' };
const attendanceMonthLabel = month => {
  const [year, position] = month.split('-');
  return capitalized(new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(new Date(Number(year), Number(position) - 1, 1)));
};

// Dirección favorable por métrica. El peso queda neutro a propósito: subir o
// bajar sólo es bueno según la meta del cliente, y la app no debe opinar.
const metricDirection = { weight: 0, smm: 1, fat: -1, pbf: -1, score: 1 };
const metricUnits = { weight: ' kg', smm: ' kg', fat: ' kg', pbf: '%', score: '' };

function deltaChip(key, value) {
  if (!Number.isFinite(value)) return '<span class="delta neutral">—</span>';
  if (value === 0) return '<span class="delta neutral">sin cambio</span>';
  const direction = metricDirection[key] ?? 0;
  const tone = direction === 0 ? 'neutral' : (value > 0) === (direction > 0) ? 'good' : 'bad';
  return `<span class="delta ${tone}">${value > 0 ? '▲' : '▼'} ${Math.abs(value).toFixed(1)}${metricUnits[key] || ''}</span>`;
}

function inbodyComparison(inbody) {
  const latest = inbody.history.at(-1);
  if (!latest?.delta) return '<p class="empty">Hace falta una segunda medición para comparar.</p>';
  const fields = [['weight', 'Peso'], ['smm', 'Masa muscular'], ['fat', 'Masa grasa'], ['pbf', 'Grasa corporal'], ['score', 'InBody Score']];
  return `<p class="comparison-caption">Contra la medición del ${latest.previousDate}</p><div class="comparison-grid">${fields.map(([key, label]) =>
    `<article><span>${label}</span>${deltaChip(key, latest.delta[key])}</article>`).join('')}</div>`;
}

const inbodyNumber = (values, key, decimals = 1) => {
  const value = Number(values?.[key]);
  return Number.isFinite(value) ? value.toFixed(decimals) : '—';
};
function inbodyDetailSection(values = {}) {
  const segments = [
    ['Brazo derecho', 'rightArm'], ['Brazo izquierdo', 'leftArm'], ['Tronco', 'trunk'], ['Pierna derecha', 'rightLeg'], ['Pierna izquierda', 'leftLeg']
  ];
  const hasDetails = ['totalBodyWaterL','softLeanMassKg','visceralFatAreaCm2','phaseAngleDeg','basalMetabolicRateKcal'].some(key => Number.isFinite(Number(values[key])));
  if (!hasDetails) return '';
  const metricCard = (label, key, unit = '', decimals = 1) => `<article class="inbody-detail-card"><span>${label}</span><strong>${inbodyNumber(values, key, decimals)}${Number.isFinite(Number(values[key])) ? unit : ''}</strong></article>`;
  return `<section class="inbody-detail-panel"><p class="eyebrow">DETALLE DE LA EVALUACIÓN</p><div class="inbody-detail-grid">
    ${metricCard('Agua corporal total','totalBodyWaterL',' L')}${metricCard('Masa libre de grasa','fatFreeMassKg',' kg')}${metricCard('Masa magra suave','softLeanMassKg',' kg')}${metricCard('Proteína','proteinKg',' kg')}${metricCard('Minerales','mineralsKg',' kg')}${metricCard('Área grasa visceral','visceralFatAreaCm2',' cm²')}${metricCard('Nivel grasa visceral','visceralFatLevel','',0)}${metricCard('ECW ratio','ecwRatio','',3)}${metricCard('Ángulo de fase','phaseAngleDeg','°')}${metricCard('Metabolismo basal','basalMetabolicRateKcal',' kcal',0)}${metricCard('Calorías recomendadas','recommendedCaloriesKcal',' kcal',0)}${metricCard('Cintura','waistCircumferenceCm',' cm')}${metricCard('Cintura/cadera','waistHipRatio','',2)}${metricCard('Masa mineral ósea','boneMineralContentKg',' kg')}
  </div><h3 class="inbody-detail-heading">Distribución segmental</h3><div class="table-wrap"><table class="inbody-segment-table"><thead><tr><th>Segmento</th><th>Magra</th><th>% ideal</th><th>% actual</th><th>Grasa</th><th>% grasa</th><th>ECW</th></tr></thead><tbody>${segments.map(([label, key]) => `<tr><td>${label}</td><td>${inbodyNumber(values, `${key}LeanKg`)} kg</td><td>${inbodyNumber(values, `${key}LeanPercentIdeal`,0)}%</td><td>${inbodyNumber(values, `${key}LeanPercentCurrent`,0)}%</td><td>${inbodyNumber(values, `${key}FatKg`)} kg</td><td>${inbodyNumber(values, `${key}FatPercent`,0)}%</td><td>${inbodyNumber(values, `${key}EcwRatio`,3)}</td></tr>`).join('')}</tbody></table></div><h3 class="inbody-detail-heading">Control de peso</h3><div class="inbody-control-grid">${metricCard('Peso objetivo','targetWeightKg',' kg')}${metricCard('Control de peso','weightControlKg',' kg')}${metricCard('Control de grasa','fatControlKg',' kg')}${metricCard('Control muscular','muscleControlKg',' kg')}</div><p class="inbody-review-note">Métricas de seguimiento tomadas del reporte; no constituyen diagnóstico médico.</p></section>`;
}

// Saldos en el expediente, en lista y no en tabla: la tabla de paquetes se
// desplaza en horizontal en el teléfono y su última columna queda escondida.
// Ver el archivo original de un expediente. Hasta ahora sólo se podía borrar:
// los datos del InBody estaban a la vista pero el reporte del que salieron era
// inalcanzable, así que no había forma de contrastarlos.
async function viewDocument(item) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">ARCHIVO DEL EXPEDIENTE</p><h2>${escapeHtml(item.original_name)}</h2>
    <div id="document-view"><p class="empty">Abriendo archivo…</p></div>`;
  openModal(box, true);
  try {
    const fuente = await api(`/api/documents/${item.id}/download-url`);
    const target = document.getElementById('document-view');
    if (!target || !modal.open) return;
    const esImagen = String(item.content_type || '').startsWith('image/');
    target.innerHTML = `${esImagen
      ? `<img class="document-image" src="${escapeHtml(fuente.downloadUrl)}" alt="${escapeHtml(item.original_name)}" />`
      : `<object class="document-embed" data="${escapeHtml(fuente.downloadUrl)}" type="${escapeHtml(item.content_type || 'application/pdf')}"><p class="empty">Tu navegador no puede mostrarlo aquí. Ábrelo en una pestaña.</p></object>`}
      <a class="secondary wide-button document-open" href="${escapeHtml(fuente.downloadUrl)}" target="_blank" rel="noopener">Abrir en una pestaña nueva</a>
      <p class="section-note">El enlace es privado y caduca en ${Math.round(fuente.expiresInSeconds / 60)} minutos.</p>`;
  } catch (error) {
    const target = document.getElementById('document-view');
    if (target) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function balancesSection(target, client) {
  api(`/api/clients/${encodeURIComponent(client.id)}/balances`).then(saldos => {
    if (!target.isConnected || !modal.open) return;
    target.innerHTML = `${saldos.length ? `<div class="balance-list">${saldos.map(saldo => {
      const restantes = Number(saldo.remaining);
      const vencido = saldo.vencido_con_saldo;
      return `<article class="balance-item${vencido ? ' expired' : ''}">
        <div><b>${escapeHtml(saldo.label)}</b><small>${saldo.kind === 'monthly' ? 'Mensualidad' : 'Paquete'} · ${saldo.used_sessions} de ${saldo.total_sessions} usadas${saldo.expires_on ? ` · ${vencido ? 'venció' : 'vence'} ${fechaCorta(saldo.expires_on)}` : ' · sin vencimiento'}</small>
          ${saldo.origin_invoice_id ? `<small class="pack-origin">Salió del cobro ${escapeHtml(saldo.origin_source === 'zoho_invoice' ? 'Zoho ' : '')}${escapeHtml(saldo.origin_invoice_number || saldo.origin_concept || 'sin número')}${saldo.origin_date ? ` · ${fechaCorta(saldo.origin_date)}` : ''}</small>` : ''}
          ${saldo.renovacion_pendiente ? '<small class="pack-renovar">Renovación pendiente</small>' : ''}
          ${vencido ? `<small class="balance-warning">${restantes} sesión${restantes === 1 ? '' : 'es'} sin dar · cuenta como incumplimiento</small>` : ''}</div>
        <span class="session-balance">${restantes}</span>
        ${saldo.kind === 'package' && saldo.status !== 'pending' ? `<button class="secondary session-use" data-renovar="${saldo.id}">Renovar</button>` : ''}
        ${saldo.expires_on ? `<button class="secondary session-use" data-reschedule="${saldo.id}">Reprogramar</button>` : ''}
        ${Number(saldo.used_sessions) === 0 ? `<button class="secondary session-use" data-borrar-paquete="${saldo.id}">Eliminar</button>` : ''}
      </article>`;
    }).join('')}</div>` : '<p class="empty">Este cliente no tiene saldos de sesiones.</p>'}`;
    target.querySelectorAll('[data-reschedule]').forEach(button => {
      button.onclick = () => reschedulePackage(saldos.find(saldo => saldo.id === button.dataset.reschedule), client);
    });
    target.querySelectorAll('[data-renovar]').forEach(button => {
      const saldo = saldos.find(s => s.id === button.dataset.renovar);
      button.onclick = () => renovarPaquete({ id: saldo.id, client: client.name, label: saldo.label, total: Number(saldo.total_sessions), used: Number(saldo.used_sessions), amount: Number(saldo.amount), kind: saldo.kind });
    });
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

function clientBillingSection(client) {
  const deuda = Number(client.deudaPendiente || 0);
  const credito = Number(client.creditoPendiente || 0);
  const facturas = data.invoices
    .filter(invoice => invoice.status !== 'void' && (invoice.clientId === client.id || invoice.billedForClientId === client.id))
    .sort((a, b) => String(b.due || b.issued || '').localeCompare(String(a.due || a.issued || '')))
    .slice(0, 6);
  const estado = deuda > 0
    ? `<span class="payment-status pending">Morosidad · ${money.format(deuda)}</span>`
    : '<span class="payment-status confirmed">Al día</span>';
  const filas = facturas.length ? facturas.map(invoice => {
    const saldo = Number(invoice.balance || 0);
    const etiqueta = invoice.status === 'confirmed' ? 'Confirmado' : invoice.status === 'pending' ? (invoice.paidAmount > 0 ? 'Pago parcial' : 'Pendiente') : 'Anulada';
    const detalle = invoice.billedForClientId === client.id && invoice.clientId !== client.id
      ? `Pagador: ${invoice.client}`
      : invoice.clientId !== client.id ? `Cubre a ${client.name}` : '';
    return `<div class="client-invoice-row"><div><b>${escapeHtml(invoice.concept)}</b><small>${fechaCorta(invoice.due)} · ${money.format(invoice.amount)}${saldo > 0 ? ` · saldo ${money.format(saldo)}` : ''}${detalle ? ` · ${escapeHtml(detalle)}` : ''}</small></div><span class="payment-status ${invoice.status === 'confirmed' ? 'confirmed' : 'pending'}">${etiqueta}</span></div>`;
  }).join('') : '<p class="empty">No hay cobros registrados para este cliente.</p>';
  return `<p class="eyebrow" style="margin-top:20px">FACTURACIÓN Y COBROS</p><div class="client-billing-summary"><article><span>Estado</span><strong>${estado}</strong></article><article><span>Saldo pendiente</span><strong class="${deuda > 0 ? 'due' : ''}">${money.format(deuda)}</strong></article><article><span>Crédito disponible</span><strong class="${credito > 0 ? 'credit' : ''}">${money.format(credito)}</strong></article></div><div class="client-invoice-list">${filas}</div>`;
}

const billingKindLabels = { monthly: 'Mensualidad', credit: 'A crédito', package: 'Paquete' };
function billingDateText(value) {
  const [year, month, day] = String(value || '').slice(0, 10).split('-');
  return year && month && day ? `${day}-${month}-${year}` : String(value || '');
}
function billingLineText(line) {
  return `${billingKindLabels[line.kind] || line.kind} · ${money.format(Number(line.price))} · ${billingDateText(line.startsOn)}${line.endsOn ? ` → ${billingDateText(line.endsOn)}` : ' → vigente'}`;
}
function billingSubscriptionCard(line, editable = false, client = null) {
  const beneficiary = escapeHtml(line.beneficiaryName || 'Beneficiario');
  const payer = escapeHtml(line.payerName || 'Pagador');
  const automatic = editable ? `<label class="declarative-billing-auto"><input type="checkbox" data-auto-billing="${line.id}"${line.autoGenerate !== false ? ' checked' : ''} /> Facturación automática</label>` : '';
  return `<article class="declarative-billing-line"><div><strong>${beneficiary}</strong><small>${(() => { const hoy = dateKey(new Date()); return line.startsOn > hoy ? `<b>Próximo · rige desde ${billingDateText(line.startsOn)}</b><br>` : line.endsOn && line.endsOn >= hoy ? `<b>Vigente hasta ${billingDateText(line.endsOn)}</b><br>` : ''; })()}${billingLineText(line)}${line.kind === 'package' && line.cycleDays ? ` · ciclo ${line.cycleDays} días` : ''}${line.sessionsReference ? ` · referencia ${line.sessionsReference} sesiones` : ''}</small><small>Pagador: ${payer}</small>${automatic}</div>${editable && line.endsOn === null ? `<div class="declarative-billing-actions"><button type="button" class="secondary" data-close-billing="${line.id}">Cerrar línea</button><button type="button" class="secondary" data-edit-billing="${line.id}">Cambiar monto</button><button type="button" class="secondary" data-correct-billing="${line.id}">Corregir monto</button></div>` : editable && line.endsOn >= dateKey(new Date()) && line.startsOn <= dateKey(new Date()) ? `<div class="declarative-billing-actions"><button type="button" class="secondary" data-correct-billing="${line.id}">Corregir monto</button></div>` : ''}</article>`;
}
// Corregir un monto equivocado en el mismo registro (no un cambio de precio con fecha): queda en la bitácora con su motivo.
function billingCorrectDialog(client, line) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="billing-correct-form"><p class="eyebrow">PLAN DE FACTURACIÓN</p><h2>Corregir monto</h2><p class="form-summary">${escapeHtml(line.beneficiaryName || '')} · ${escapeHtml(billingLineText(line))}</p>
    <label>Monto correcto<input name="price" type="number" min="0.01" step="0.01" required value="${Number(line.price || 0).toFixed(2)}" /></label>
    <label>Motivo<input name="reason" required minlength="3" maxlength="300" value="Monto corregido" /></label>
    <p class="section-note">Úsalo cuando el monto estaba mal, no cuando cambia el precio. Cambia el importe de esta línea tal como está (con la misma fecha de inicio). Si el siguiente tramo ya programado queda con el mismo importe, se unen en una sola línea.</p>
    <button class="primary wide-button">Corregir monto</button></form>`;
  openModal(box);
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault(); const values = new FormData(event.target);
    try {
      const result = await api(`/api/billing-subscriptions/${line.id}/correct-price`, { method: 'POST', body: { price: Number(values.get('price')), reason: values.get('reason') } });
      modal.close(); await loadBillingSubscriptionsEditor(client); toast(result.merged ? 'Monto corregido y unido al tramo siguiente' : 'Monto corregido');
    } catch (error) { toast(error.message, true); }
  };
}
function billingCloseDialog(client, line) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="billing-close-form"><p class="eyebrow">PLAN DE FACTURACIÓN</p><h2>Cerrar concepto a facturar</h2><p class="form-summary">${escapeHtml(billingLineText(line))}</p><label>Fecha final<input name="endsOn" type="date" required value="${line.endsOn || dateKey(new Date())}" /></label><p class="section-note">La fecha se guarda como AAAA-MM-DD. En pantalla se muestra como DD-MM-AAAA. El concepto conserva su historial y deja de estar vigente desde el siguiente día.</p><button class="primary wide-button">Cerrar concepto</button></form>`;
  openModal(box);
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const endsOn = new FormData(event.target).get('endsOn');
    try { await api(`/api/billing-subscriptions/${line.id}`, { method: 'PATCH', body: { endsOn } }); modal.close(); await loadBillingSubscriptionsEditor(client); toast('Concepto cerrado'); } catch (error) { toast(error.message, true); }
  };
}
function renderBillingSubscriptions(target, payload, client, editable = false) {
  if (!target) return;
  if (payload.error) { target.innerHTML = `<p class="empty">${escapeHtml(payload.error)}</p>`; return; }
  const proposal = payload.proposal || [];
  target.innerHTML = `<div class="declarative-billing-summary">${(payload.summary?.breakdown || []).length ? `<strong>Total vigente hoy de ${escapeHtml(payload.summary?.payerName || client.name)}: ${money.format(Number(payload.summary?.totalForPayer || 0))}</strong>${payload.summary.breakdown.map(item => `<small>${escapeHtml(item.beneficiaryName)} · ${money.format(Number(item.amount))}</small>`).join('')}` : (payload.summary?.paidBy || []).length ? `<strong>${escapeHtml(client.name)} no es pagador</strong><small>Su mensualidad la factura ${escapeHtml(payload.summary.paidBy.join(' y '))}</small>` : '<strong>Sin conceptos vigentes hoy</strong>'}${payload.summary?.upcoming ? `<strong style="margin-top:8px">Desde ${billingDateText(payload.summary.upcoming.startsOn)}: ${money.format(Number(payload.summary.upcoming.totalForPayer))}</strong>${payload.summary.upcoming.breakdown.map(item => `<small>${escapeHtml(item.beneficiaryName)} · ${money.format(Number(item.amount))}</small>`).join('')}` : ''}</div>${payload.lines?.length ? (() => { const hoy = dateKey(new Date()); const vigentes = payload.lines.filter(line => !line.endsOn || line.endsOn >= hoy).sort((a, b) => (a.startsOn > hoy) - (b.startsOn > hoy) || a.beneficiaryName.localeCompare(b.beneficiaryName, 'es')); const historial = payload.lines.filter(line => line.endsOn && line.endsOn < hoy); return `<div class="declarative-billing-lines">${vigentes.map(line => billingSubscriptionCard(line, editable, client)).join('') || '<p class="empty">No hay conceptos vigentes.</p>'}</div>${historial.length ? `<details class="declarative-billing-history"><summary>Historial de montos anteriores (${historial.length})</summary><div class="declarative-billing-lines">${historial.map(line => billingSubscriptionCard(line, false, client)).join('')}</div></details>` : ''}`; })() : '<p class="empty">Aún no hay conceptos confirmados.</p>'}${proposal.length ? `<div class="declarative-billing-proposals"><p class="section-note"><b>Propuestas tomadas del expediente</b><br>Inicio propuesto en el último corte. No se guarda hasta que confirmes o ajustes cada concepto.</p>${proposal.map((line, index) => `<article class="declarative-billing-line proposal"><div><strong>${escapeHtml(line.beneficiaryName)}</strong><small>${billingLineText(line)}</small></div><button type="button" class="secondary" data-confirm-billing-proposal="${index}">Confirmar concepto</button></article>`).join('')}</div>` : ''}<p class="section-note">Preparado para el sistema nuevo; hoy la facturación automática sigue usando el monto mensual del cliente.</p>`;
  target.querySelectorAll('[data-correct-billing]').forEach(button => button.onclick = () => { const line = payload.lines.find(item => item.id === button.dataset.correctBilling); if (line) billingCorrectDialog(client, line); });
  target.querySelectorAll('[data-close-billing]').forEach(button => button.onclick = async () => {
    const line = payload.lines.find(item => item.id === button.dataset.closeBilling);
    if (line) billingCloseDialog(client, line);
  });
  target.querySelectorAll('[data-edit-billing]').forEach(button => button.onclick = () => {
    const line = payload.lines.find(item => item.id === button.dataset.editBilling); if (line) billingSubscriptionDialog(client, line);
  });
  target.querySelectorAll('[data-auto-billing]').forEach(input => input.onchange = async () => {
    const previous = !input.checked;
    try { await api(`/api/billing-subscriptions/${input.dataset.autoBilling}`, { method: 'PATCH', body: { autoGenerate: input.checked } }); toast(input.checked ? 'Facturación automática activada' : 'Facturación automática desactivada'); } catch (error) { input.checked = previous; toast(error.message, true); }
  });
  target.querySelectorAll('[data-confirm-billing-proposal]').forEach(button => button.onclick = () => {
    const line = proposal[Number(button.dataset.confirmBillingProposal)]; if (line) billingSubscriptionDialog(client, line);
  });
}
async function loadBillingSubscriptionsEditor(client) {
  const target = document.getElementById('client-billing-subscriptions-editor');
  if (!target) return;
  try { renderBillingSubscriptions(target, await api(`/api/clients/${client.id}/billing-subscriptions`), client, true); } catch (error) { target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
}
function billingSubscriptionDialog(client, initial = null) {
  const allClients = data.clients;
  const line = initial || { beneficiaryClientId: client.id, payerClientId: client.paysForMeId || client.id, kind: client.billingModel === 'package' ? 'package' : client.paymentMode === 'no_anticipado' ? 'credit' : 'monthly', price: client.plan || client.creditSessionPrice || 25, startsOn: dateKey(new Date()), endsOn: null, cycleDays: client.billingModel === 'package' ? 35 : null, sessionsReference: client.monthlySessionTarget || client.sessionsIncluded || null };
  const editingAmount = Boolean(initial?.id);
  const referenceModelFor = kind => kind === 'package' ? 'package' : kind === 'credit' ? 'single' : 'monthly';
  const referencePlansFor = (kind, includeSpecial) => data.plans.filter(plan => plan.active && plan.billingModel === referenceModelFor(kind) && (includeSpecial || !plan.specialFor));
  const referenceOption = plan => `${plan.name}${plan.zone ? ` · ${plan.zone}` : ''} · ${money.format(plan.price)}${plan.sessionsIncluded ? ` · ${plan.sessionsIncluded} sesiones` : ''}${plan.specialFor ? ` · especial para ${plan.specialFor}` : ''}`;
  const box = document.createElement('div');
  box.innerHTML = `<form id="billing-subscription-form"><p class="eyebrow">PLAN DE FACTURACIÓN</p><h2>${editingAmount ? 'Cambiar monto' : 'Agregar concepto a facturar'}</h2><label>Beneficiario<select name="beneficiaryClientId">${allClients.map(item => `<option value="${item.id}"${item.id === line.beneficiaryClientId ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Pagador<select name="payerClientId">${allClients.map(item => `<option value="${item.id}"${item.id === line.payerClientId ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Tipo<select name="kind"${editingAmount ? ' disabled' : ''}><option value="monthly"${line.kind === 'monthly' ? ' selected' : ''}>Mensualidad</option><option value="credit"${line.kind === 'credit' ? ' selected' : ''}>A crédito</option><option value="package"${line.kind === 'package' ? ' selected' : ''}>Paquete</option></select></label><fieldset class="billing-reference-picker"><legend>Tarifa de referencia</legend><label class="checkbox-line"><input name="showSpecialRates" type="checkbox" /> Mostrar tarifas especiales</label><select name="referencePlan"><option value="">Sin sugerencia</option></select><small>Solo prellena el monto y las sesiones; puedes modificarlos. No crea ningún vínculo con la tarifa.</small></fieldset><label>Monto<input name="price" type="number" min="0.01" step="0.01" required value="${Number(line.price || 0).toFixed(2)}" /></label><label>Desde${editingAmount ? ' <span class="muted">(desde cuándo rige el monto nuevo; debe ser posterior al inicio actual)</span>' : ''}<input name="startsOn" type="date" required value="${editingAmount ? '' : (line.startsOn || dateKey(new Date()))}" /></label><label>Hasta <span class="muted">(opcional)</span><input name="endsOn" type="date" value="${line.endsOn || ''}" /></label><label class="package-only">Días de ciclo<input name="cycleDays" type="number" min="1" max="366" value="${line.cycleDays || ''}" /></label><label>Sesiones de referencia <span class="muted">(opcional)</span><input name="sessionsReference" type="number" min="1" value="${line.sessionsReference || ''}" /></label><label class="checkbox-line"><input name="autoGenerate" type="checkbox"${line.autoGenerate !== false ? ' checked' : ''} /> Facturación automática</label><p class="section-note">Esta sección sólo registra el acuerdo comercial. No crea facturas, no cambia saldos y no modifica el monto mensual legado.</p><button class="primary wide-button">${editingAmount ? 'Guardar nuevo monto' : 'Confirmar concepto'}</button></form>`;
  openModal(box);
  const form = box.querySelector('form'); const kind = form.elements.kind; const packageOnly = box.querySelector('.package-only'); const referencePlan = form.elements.referencePlan; const showSpecialRates = form.elements.showSpecialRates;
  const refreshReferenceOptions = () => {
    const previous = referencePlan.value;
    const options = referencePlansFor(kind.value, showSpecialRates.checked);
    referencePlan.innerHTML = `<option value="">Sin sugerencia</option>${options.map(plan => `<option value="${plan.id}">${escapeHtml(referenceOption(plan))}</option>`).join('')}`;
    referencePlan.value = options.some(plan => plan.id === previous) ? previous : '';
  };
  const togglePackage = () => { packageOnly.hidden = kind.value !== 'package'; if (kind.value !== 'package') form.elements.cycleDays.value = ''; };
  const applyReference = () => {
    const selected = data.plans.find(plan => plan.id === referencePlan.value);
    if (!selected) return;
    form.elements.price.value = selected.price.toFixed(2);
    form.elements.sessionsReference.value = selected.sessionsIncluded || '';
    if (kind.value === 'package') form.elements.cycleDays.value = selected.validityDays || 30;
  };
  kind.onchange = () => { togglePackage(); refreshReferenceOptions(); };
  showSpecialRates.onchange = refreshReferenceOptions;
  referencePlan.onchange = applyReference;
  togglePackage(); refreshReferenceOptions();
  form.onsubmit = async event => {
    event.preventDefault(); const values = new FormData(form); const body = { beneficiaryClientId: values.get('beneficiaryClientId'), payerClientId: values.get('payerClientId'), kind: values.get('kind'), price: Number(values.get('price')), startsOn: values.get('startsOn'), endsOn: values.get('endsOn') || null, cycleDays: values.get('cycleDays') ? Number(values.get('cycleDays')) : null, sessionsReference: values.get('sessionsReference') ? Number(values.get('sessionsReference')) : null, autoGenerate: values.get('autoGenerate') === 'on' };
    try { await api(editingAmount ? `/api/billing-subscriptions/${initial.id}` : `/api/clients/${client.id}/billing-subscriptions`, { method: editingAmount ? 'PATCH' : 'POST', body: editingAmount ? { price: body.price, startsOn: body.startsOn, endsOn: body.endsOn, cycleDays: body.cycleDays, sessionsReference: body.sessionsReference, autoGenerate: body.autoGenerate } : body }); modal.close(); toast(editingAmount ? 'Monto del concepto actualizado' : 'Concepto a facturar confirmado'); await loadBillingSubscriptionsEditor(client); } catch (error) { toast(error.message, true); }
  };
}

function reschedulePackage(saldo, client) {
  const restantes = Number(saldo.remaining);
  const enUnMes = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const box = document.createElement('div');
  box.innerHTML = `<form id="reschedule-form"><p class="eyebrow">SALDO DE SESIONES</p><h2>Reprogramar</h2>
    <p class="form-summary">${escapeHtml(saldo.label)} · ${restantes} sesión${restantes === 1 ? '' : 'es'} sin dar</p>
    <label>Nueva fecha de vencimiento<input name="expiresOn" type="date" required value="${enUnMes}" /></label>
    <label>Motivo<input name="note" maxlength="120" placeholder="Opcional · ej. no se agendaron por viaje de la entrenadora" /></label>
    <p class="section-note">Al correr la fecha, esas ${restantes} sesión${restantes === 1 ? '' : 'es'} vuelven a estar disponibles y dejan de contar como incumplimiento en el porcentaje de ${escapeHtml(client.name)}.</p>
    <button class="primary wide-button">Reprogramar</button></form>`;
  openModal(box);
  document.getElementById('reschedule-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.target);
    try {
      event.target.classList.add('loading-state');
      await api(`/api/packages/${saldo.id}/reschedule`, { method: 'PATCH', body: { expiresOn: values.get('expiresOn'), note: values.get('note').trim() || null } });
      await loadData(); renderAll(); modal.close(); toast('Saldo reprogramado'); clientDetail(client.id);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

// Gráfica lineal en SVG con viewBox: escala sola al ancho disponible, así se
// ve igual en el teléfono que en el escritorio, sin dos maquetaciones y sin
// meter una librería de gráficas.
function complianceChartSvg(timeline) {
  const ancho = 520, alto = 190, izq = 34, der = 14, arriba = 18, abajo = 26;
  if (timeline.filter(mes => mes.compliancePercent !== null).length < 2) {
    return '<p class="empty">Se necesitan al menos dos meses con actividad para comparar.</p>';
  }
  const paso = (ancho - izq - der) / Math.max(1, timeline.length - 1);
  const px = i => izq + paso * i;
  const py = p => alto - abajo - ((alto - arriba - abajo) * p) / 100;

  const rejilla = [0, 25, 50, 75, 100].map(p =>
    `<line x1="${izq}" y1="${py(p)}" x2="${ancho - der}" y2="${py(p)}" stroke="#ece5e7" stroke-width="1"/><text x="${izq - 6}" y="${py(p) + 3}" text-anchor="end" font-size="8" fill="#7c7077">${p}%</text>`).join('');

  // Un mes sin actividad corta la línea en vez de bajarla a cero: no es lo
  // mismo no cumplir que no haber tenido nada que cumplir.
  const tramos = []; let actual = [];
  timeline.forEach((mes, i) => {
    if (mes.compliancePercent === null) { if (actual.length > 1) tramos.push(actual); actual = []; return; }
    actual.push(`${px(i)},${py(Number(mes.compliancePercent))}`);
  });
  if (actual.length > 1) tramos.push(actual);
  const lineas = tramos.map(t => `<polyline points="${t.join(' ')}" fill="none" stroke="#c98aa6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`).join('');

  const puntos = timeline.map((mes, i) => {
    const etiqueta = `<text x="${px(i)}" y="${alto - 8}" text-anchor="middle" font-size="8" fill="#7c7077">${mes.month.slice(5)}</text>`;
    if (mes.compliancePercent === null) return etiqueta;
    const y = py(Number(mes.compliancePercent));
    // El primer valor se ancla a la izquierda y el último a la derecha: centrados
    // se salían del área, y el del primer mes se encimaba con la escala del eje.
    const anclaje = i === 0 ? 'start' : i === timeline.length - 1 ? 'end' : 'middle';
    return `${etiqueta}<circle cx="${px(i)}" cy="${y}" r="3.5" fill="#c98aa6"/><text x="${px(i)}" y="${y - 8}" text-anchor="${anclaje}" font-size="8" font-weight="700" fill="#3d3238">${mes.compliancePercent}%</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${ancho} ${alto}" class="compliance-chart" role="img" aria-label="Cumplimiento mes a mes">${rejilla}${lineas}${puntos}</svg>`;
}

// Informe de asistencia: 1 a 4 clientes (o todos), por rango de fechas propio o
// por el ciclo de facturación vigente de cada cliente. Comparativa + mes a mes.
const pctColor = p => p === null ? 'neutral' : p >= 90 ? 'good' : p >= 70 ? 'neutral' : 'bad';
const pctChip = p => p === null ? '<span class="delta neutral">sin actividad</span>' : `<span class="delta ${pctColor(p)}">${p}%</span>`;
function complianceReport(client = null) {
  const seleccion = client ? [{ id: client.id, name: client.name }] : [];
  const ordenados = (data.clients || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const hoy = dateKey(today);
  const hace30 = dateKey(new Date(Date.now() - 30 * 24 * 3600_000));
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">INFORME DE ASISTENCIA</p><h2>Asistencia de clientes</h2>
    <div class="report-clients">
      <label class="checkbox-line"><input type="checkbox" id="report-all" ${seleccion.length ? '' : 'checked'} /> Todos los clientes activos</label>
      <div id="report-picker" ${seleccion.length ? '' : 'hidden'}>
        <div id="report-chips" class="report-chips"></div>
        <label>Agregar cliente (máx. 4)<select id="report-add"><option value="">— elegir —</option>${ordenados.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></label>
      </div>
    </div>
    <label>Período<select id="report-mode"><option value="cycle">Ciclo actual de cada cliente (por corte)</option><option value="range">Rango de fechas</option></select></label>
    <div id="report-range" class="form-row" hidden><label>Desde<input type="date" id="report-from" value="${hace30}" max="${hoy}" /></label><label>Hasta<input type="date" id="report-to" value="${hoy}" max="${hoy}" /></label></div>
    <button class="primary wide-button" id="report-run">Generar informe</button>
    <div id="report-body"></div>`;
  openModal(box, true);

  const chips = document.getElementById('report-chips');
  const add = document.getElementById('report-add');
  const pintarChips = () => {
    chips.innerHTML = seleccion.map(c => `<span class="report-chip">${escapeHtml(c.name)}<button type="button" data-quitar="${c.id}" aria-label="Quitar">×</button></span>`).join('');
    chips.querySelectorAll('[data-quitar]').forEach(b => b.onclick = () => { const i = seleccion.findIndex(s => s.id === b.dataset.quitar); if (i >= 0) seleccion.splice(i, 1); pintarChips(); });
    add.disabled = seleccion.length >= 4;
  };
  pintarChips();
  add.onchange = () => {
    const c = ordenados.find(x => x.id === add.value);
    if (c && seleccion.length < 4 && !seleccion.some(s => s.id === c.id)) { seleccion.push({ id: c.id, name: c.name }); pintarChips(); }
    add.value = '';
  };
  document.getElementById('report-all').onchange = event => { document.getElementById('report-picker').hidden = event.target.checked; };
  document.getElementById('report-mode').onchange = event => { document.getElementById('report-range').hidden = event.target.value !== 'range'; };
  document.getElementById('report-run').onclick = () => renderComplianceReport(seleccion);
  if (seleccion.length) renderComplianceReport(seleccion);
}

let ultimoInformeAsistencia = null;
function renderComplianceReport(seleccion) {
  const target = document.getElementById('report-body');
  const todos = document.getElementById('report-all').checked;
  const mode = document.getElementById('report-mode').value;
  if (!todos && !seleccion.length) { target.innerHTML = '<p class="empty">Elige al menos un cliente o marca "Todos".</p>'; return; }
  const params = new URLSearchParams({ mode });
  if (!todos) params.set('clientIds', seleccion.map(s => s.id).join(','));
  if (mode === 'range') { params.set('from', document.getElementById('report-from').value); params.set('to', document.getElementById('report-to').value); }
  target.innerHTML = '<p class="empty">Calculando…</p>';
  api(`/api/compliance/report?${params.toString()}`).then(informe => {
    if (!target?.isConnected || !modal.open) return;
    ultimoInformeAsistencia = informe;
    const comparativa = informe.clients.map(c => `<tr><td data-label="Cliente"><b>${escapeHtml(c.name)}</b><br><small>${fechaCorta(c.from)} – ${fechaCorta(c.to)}</small></td><td data-label="%">${pctChip(c.compliancePercent)}</td><td data-label="Clases">${c.activities}</td><td data-label="Cumpl.">${c.completed}</td><td data-label="Sin hacer">${c.missed}</td></tr>`).join('');
    const detalle = informe.clients.map(c => {
      const filas = c.monthly.length ? c.monthly.map(m => `<tr><td>${attendanceMonthLabel(m.month)}</td><td>${m.activities || '—'}</td><td>${m.completed || '—'}</td><td>${m.missed || '—'}</td><td>${pctChip(m.compliancePercent)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Sin actividad en el período.</td></tr>';
      return `<div class="report-client-detail"><h3>${escapeHtml(c.name)}</h3>${c.monthly.length ? complianceChartSvg(c.monthly) : ''}<div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Mes</th><th>Clases</th><th>Cumpl.</th><th>Sin hacer</th><th>%</th></tr></thead><tbody>${filas}</tbody></table></div></div>`;
    }).join('');
    target.innerHTML = `<p class="eyebrow" style="margin-top:8px">COMPARATIVA ${informe.mode === 'cycle' ? '· CICLO ACTUAL' : '· RANGO'}</p>
      <div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Cliente</th><th>%</th><th>Clases</th><th>Cumpl.</th><th>Sin hacer</th></tr></thead><tbody>${comparativa}</tbody></table></div>
      <button class="secondary wide-button" id="report-csv" style="margin-top:12px">Exportar CSV ↓</button>
      <p class="eyebrow" style="margin-top:22px">DETALLE MES A MES</p>${detalle}
      <p class="section-note">Las clases pendientes, futuras, pausadas y canceladas por la entrenadora no forman parte de la métrica.</p>`;
    document.getElementById('report-csv').onclick = () => exportarInformeCsv();
  }).catch(error => { if (target?.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}
function exportarInformeCsv() {
  if (!ultimoInformeAsistencia) return;
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lineas = [['Cliente', 'Desde', 'Hasta', 'Mes', 'Clases', 'Completadas', 'Sin hacer', '% cumplimiento']];
  for (const c of ultimoInformeAsistencia.clients) {
    lineas.push([c.name, c.from, c.to, 'TOTAL', c.activities, c.completed, c.missed, c.compliancePercent ?? '']);
    for (const m of c.monthly) lineas.push([c.name, c.from, c.to, m.month, m.activities, m.completed, m.missed, m.compliancePercent ?? '']);
  }
  const csv = '﻿' + lineas.map(f => f.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `asistencia-${dateKey(today)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function attendanceSection(target, clientId) {
  api(`/api/clients/${encodeURIComponent(clientId)}/attendance?months=6`).then(report => {
    if (!target.isConnected || !modal.open) return;
    const rows = report.timeline.map(month => {
      const compliance = month.complianceRate === null ? '<span class="delta neutral">sin referencia</span>'
        : `<span class="delta ${month.complianceRate >= 0.9 ? 'good' : month.complianceRate >= 0.7 ? 'neutral' : 'bad'}">${Math.round(month.complianceRate * 100)}%</span>`;
      return `<tr><td>${attendanceMonthLabel(month.month)}</td><td>${month.completed}${month.expected === null ? '' : ` / ${month.expected}`}</td><td>${compliance}</td><td>${month.noShow || '—'}</td><td>${month.cancelled || '—'}</td></tr>`;
    }).join('');
    const basis = report.timeline.at(-1)?.basis;
    const note = basis === 'client' ? `Meta pactada en la ficha del cliente: ${report.monthlySessionTarget} sesiones al mes. Se edita en “Editar contacto”.`
      : basis === 'package' ? `Meta derivada del paquete contratado (${escapeHtml(report.timeline.at(-1).packageLabel || 'sin nombre')}), repartido entre los meses que cubre.`
      : basis === 'agenda' ? `La meta se mide contra su agenda de horarios fijos: ${report.agendaSessionsPerWeek} clase${report.agendaSessionsPerWeek === 1 ? '' : 's'} por semana.`
      : basis === 'routine' ? `Sin vencimiento en el paquete, la meta usa la cadencia de la rutina activa: ${report.sessionsPerWeek} por semana.`
      : 'Sin meta pactada, ni paquete con vencimiento, ni horario fijo, ni rutina activa. Fija las sesiones esperadas al mes en “Editar contacto”, o dale un horario fijo, para medir el cumplimiento.';
    target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Mes</th><th>Cumplidas</th><th>Cumplimiento</th><th>Faltas</th><th>Canceladas</th></tr></thead><tbody>${rows}</tbody></table></div><p class="section-note">${escapeHtml(note)}</p>`;
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

const routineHistoryFilters = new Map();
function routineHistoryCycle(client, offset = 0) {
  const cutoff = Math.max(1, Number(client.cutoffDay || client.billingCutoffDay) || 1);
  const days = (year, month) => new Date(year, month + 1, 0).getDate();
  const cut = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(cutoff, days(year, month))).padStart(2, '0')}`;
  let year = today.getFullYear(); let month = today.getMonth();
  if (dateKey(today) < cut(year, month)) month -= 1;
  month += offset;
  while (month > 11) { month -= 12; year += 1; }
  while (month < 0) { month += 12; year -= 1; }
  let nextYear = year; let nextMonth = month + 1;
  if (nextMonth > 11) { nextMonth = 0; nextYear += 1; }
  return { from: cut(year, month), to: cut(nextYear, nextMonth) };
}
function routineHistorySection(target, client) {
  if (!target) return;
  const key = client.id; const state = routineHistoryFilters.get(key) || { mode: 'month', month: dateKey(today).slice(0, 7), cutOffset: 0, from: '', to: '' };
  routineHistoryFilters.set(key, state);
  target.innerHTML = '<p class="empty">Cargando historial de rutinas…</p>';
  api(`/api/clients/${encodeURIComponent(client.id)}/routine-history`).then(initialPayload => {
    let payload = initialPayload;
    if (!target.isConnected || !modal.open) return;
    const render = () => {
      let from = ''; let to = '';
      if (state.mode === 'month') {
        const [year, month] = state.month.split('-').map(Number); from = `${state.month}-01`; to = `${state.month}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
      } else if (state.mode === 'cutoff') ({ from, to } = routineHistoryCycle(client, state.cutOffset));
      else { from = state.from; to = state.to; }
      const history = payload.history.filter(item => (!from || item.completed_on >= from) && (!to || item.completed_on <= to));
      const seconds = value => formatRoutineElapsed(value);
      const completed = history.filter(item => item.completion_percent >= 100).length;
      const timed = history.filter(item => item.elapsed_seconds > 0);
      const average = timed.length ? Math.round(timed.reduce((sum, item) => sum + item.elapsed_seconds, 0) / timed.length) : 0;
      const omitted = new Map(); history.forEach(item => item.exercises.filter(exercise => !exercise.completed).forEach(exercise => omitted.set(exercise.name, (omitted.get(exercise.name) || 0) + 1)));
      const omittedText = [...omitted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name} (${count})`).join(' · ');
      const modeLabel = state.mode === 'month' ? `Mes · ${attendanceMonthLabel(state.month)}` : state.mode === 'cutoff' ? `Corte ${state.cutOffset === 0 ? 'actual' : 'anterior'}` : 'Rango personalizado';
      const rows = history.map(item => `<article class="routine-history-item"><header><div><b>${escapeHtml(item.title)}</b><small>${fechaCorta(item.completed_on)} · ${item.completion_percent}% de avance</small></div><strong>${seconds(item.elapsed_seconds)}</strong></header><p>${item.exercises.filter(exercise => exercise.completed).length} de ${item.exercises.length} ejercicios · ${item.feeling ? escapeHtml({ muy_dificil: '😣 Muy difícil', dificil: '😕 Difícil', bien: '🙂 Bien', excelente: '😄 Excelente' }[item.feeling] || item.feeling) : 'sin sensación indicada'}${item.difficulty ? ` · dificultad: ${escapeHtml({ facil: 'Fácil', bien: 'Bien', dificil: 'Difícil' }[item.difficulty] || item.difficulty)}` : ''}</p><div class="routine-history-exercises">${item.exercises.map(exercise => `<span class="${exercise.completed ? 'done' : ''}">${exercise.completed ? '✓' : '○'} ${escapeHtml(exercise.name)}</span>`).join('')}</div>${item.feedback ? `<p class="routine-history-feedback">${escapeHtml(item.feedback)}</p>` : ''}<button type="button" class="secondary routine-history-edit" data-correct-routine-duration="${item.id}" data-current-duration="${item.elapsed_seconds}">Corregir duración</button></article>`).join('');
      target.innerHTML = `<div class="routine-history-controls${state.mode === 'range' ? ' range-mode' : ''}"><label>Filtrar por<select data-routine-history-mode><option value="month" ${state.mode === 'month' ? 'selected' : ''}>Mes</option><option value="cutoff" ${state.mode === 'cutoff' ? 'selected' : ''}>Corte</option><option value="range" ${state.mode === 'range' ? 'selected' : ''}>Rango de fechas</option></select></label><label>Mes<input type="month" data-routine-history-month value="${state.month}" max="${dateKey(today).slice(0, 7)}" /></label><label data-routine-history-range>Desde<input type="date" data-routine-history-from value="${state.from}" /></label><label data-routine-history-range>Hasta<input type="date" data-routine-history-to value="${state.to}" /></label><button type="button" class="secondary" data-routine-history-apply>Aplicar filtro</button><button type="button" class="secondary" data-routine-history-previous>${state.mode === 'cutoff' ? '‹ Corte anterior' : '‹ Mes anterior'}</button><button type="button" class="secondary" data-routine-history-current>${state.mode === 'cutoff' ? (state.cutOffset === 0 ? 'Corte actual' : 'Corte actual') : 'Mes actual'}</button></div><p class="section-note">${modeLabel} · ${from ? `${fechaCorta(from)} al ${fechaCorta(to)}` : 'elige un rango'}.</p><div class="routine-history-summary"><article><strong>${history.length}</strong><span>rutinas registradas</span></article><article><strong>${completed}</strong><span>completadas</span></article><article><strong>${seconds(average)}</strong><span>duración promedio</span></article></div>${omittedText ? `<p class="section-note">Ejercicios omitidos con más frecuencia: ${escapeHtml(omittedText)}</p>` : ''}<div>${rows || '<p class="routine-history-empty">No hay rutinas registradas en este período.</p>'}</div>`;
      target.querySelector('[data-routine-history-mode]').onchange = event => { state.mode = event.target.value; render(); };
      target.querySelector('[data-routine-history-month]').onchange = event => { state.month = event.target.value; state.mode = 'month'; render(); };
      target.querySelector('[data-routine-history-from]').onchange = event => { state.from = event.target.value; };
      target.querySelector('[data-routine-history-to]').onchange = event => { state.to = event.target.value; };
      target.querySelector('[data-routine-history-apply]').onclick = () => render();
      target.querySelector('[data-routine-history-previous]').onclick = () => { if (state.mode === 'cutoff') state.cutOffset = Math.max(-24, state.cutOffset - 1); else { const [year, month] = state.month.split('-').map(Number); const date = new Date(year, month - 2, 1); state.month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; } render(); };
      target.querySelector('[data-routine-history-current]').onclick = () => { if (state.mode === 'cutoff') state.cutOffset = 0; else state.month = dateKey(today).slice(0, 7); render(); };
      target.querySelectorAll('[data-correct-routine-duration]').forEach(button => button.onclick = async () => {
        const current = Number(button.dataset.currentDuration || 0); const answer = window.prompt('Duración activa en minutos (Eileen puede corregirla dejando bitácora):', String(Math.round(current / 60)));
        if (answer === null) return; const minutes = Number(answer); if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) { toast('Indica minutos entre 0 y 1440', true); return; }
        try { await api(`/api/clients/${client.id}/routine-history/${button.dataset.correctRoutineDuration}`, { method: 'PATCH', body: { elapsedSeconds: Math.round(minutes * 60) } }); toast('Duración corregida y registrada'); const fresh = await api(`/api/clients/${encodeURIComponent(client.id)}/routine-history`); payload = fresh; render(); } catch (error) { toast(error.message, true); }
      });
    };
    render();
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

function conditionsSection(target, client) {
  api(`/api/clients/${encodeURIComponent(client.id)}/conditions`).then(items => {
    if (!target.isConnected || !modal.open) return;
    target.innerHTML = `${items.length ? `<div class="condition-list">${items.map(item => `<article class="condition-item ${item.status}">
      <header><b>${escapeHtml(item.title)}</b><span class="condition-tag ${item.severity}">${severityLabels[item.severity]}</span></header>
      <small>${conditionKindLabels[item.kind]}${item.body_area ? ` · ${escapeHtml(item.body_area)}` : ''} · ${conditionStatusLabels[item.status]}${item.started_on ? ` · desde ${fechaCorta(item.started_on)}` : ' · antecedente sin fecha'}${item.resolved_on ? ` · resuelta ${fechaCorta(item.resolved_on)}` : ''}</small>
      ${item.restrictions ? `<p class="condition-restriction">Restricción: ${escapeHtml(item.restrictions)}</p>` : ''}
      ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}
      <div class="condition-actions"><button class="secondary session-use" data-edit-condition="${item.id}">Editar</button><button class="secondary session-use" data-delete-condition="${item.id}">Eliminar</button></div>
    </article>`).join('')}</div>` : '<p class="empty">No hay lesiones ni padecimientos registrados.</p>'}<button class="secondary wide-button" id="add-condition">+ Registrar lesión o padecimiento</button>`;
    document.getElementById('add-condition').onclick = () => conditionEditor(client, null);
    target.querySelectorAll('[data-edit-condition]').forEach(button => {
      button.onclick = () => conditionEditor(client, items.find(item => item.id === button.dataset.editCondition));
    });
    target.querySelectorAll('[data-delete-condition]').forEach(button => {
      button.onclick = async () => {
        if (!confirm('¿Eliminar este registro del expediente?')) return;
        try { await api(`/api/conditions/${button.dataset.deleteCondition}`, { method: 'DELETE' }); toast('Registro eliminado'); conditionsSection(target, client); }
        catch (error) { toast(error.message, true); }
      };
    });
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

function conditionEditor(client, condition) {
  const box = document.createElement('div');
  const value = (field, fallback = '') => escapeHtml(condition?.[field] ?? fallback);
  const selected = (field, option) => (condition?.[field] || (field === 'kind' ? 'injury' : field === 'severity' ? 'moderate' : 'active')) === option ? ' selected' : '';
  box.innerHTML = `<form id="condition-form"><p class="eyebrow">EXPEDIENTE CLÍNICO</p><h2>${condition ? 'Editar registro' : 'Registrar lesión o padecimiento'}</h2>
    <label>Título<input name="title" required maxlength="160" value="${value('title')}" placeholder="Tendinitis de hombro derecho" /></label>
    <div class="form-row">
      <label>Tipo<select name="kind"><option value="injury"${selected('kind', 'injury')}>Lesión</option><option value="condition"${selected('kind', 'condition')}>Padecimiento</option></select></label>
      <label>Zona<input name="bodyArea" maxlength="120" value="${value('body_area')}" placeholder="Hombro" /></label>
    </div>
    <div class="form-row">
      <label>Severidad<select name="severity"><option value="mild"${selected('severity', 'mild')}>Leve</option><option value="moderate"${selected('severity', 'moderate')}>Moderada</option><option value="severe"${selected('severity', 'severe')}>Severa</option></select></label>
      <label>Estado<select name="status"><option value="active"${selected('status', 'active')}>Activa</option><option value="monitoring"${selected('status', 'monitoring')}>En observación</option><option value="recovered"${selected('status', 'recovered')}>Recuperada</option></select></label>
    </div>
    <div class="form-row">
      <label>Desde<input name="startedOn" type="date" value="${dateOnly(condition?.started_on)}" /></label>
      <label>Resuelta el<input name="resolvedOn" type="date" value="${dateOnly(condition?.resolved_on)}" /></label>
    </div>
    <p class="section-note">Deja la fecha vacía si es un antecedente y el cliente no recuerda cuándo empezó.</p>
    <label>Restricciones de entrenamiento<textarea name="restrictions" rows="2" maxlength="1000" placeholder="Evitar press por encima de la cabeza">${value('restrictions')}</textarea></label>
    <label>Notas<textarea name="notes" rows="2" maxlength="2000">${value('notes')}</textarea></label>
    <button class="primary wide-button">${condition ? 'Guardar cambios' : 'Registrar'}</button></form>`;
  openModal(box);
  document.getElementById('condition-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.target);
    const body = {
      kind: values.get('kind'), title: values.get('title').trim(), bodyArea: values.get('bodyArea').trim() || null,
      severity: values.get('severity'), status: values.get('status'),
      startedOn: values.get('startedOn') || null, resolvedOn: values.get('resolvedOn') || null,
      restrictions: values.get('restrictions').trim() || null, notes: values.get('notes').trim() || null
    };
    try {
      event.target.classList.add('loading-state');
      if (condition) await api(`/api/conditions/${condition.id}`, { method: 'PATCH', body });
      else await api(`/api/clients/${client.id}/conditions`, { method: 'POST', body });
      modal.close(); toast(condition ? 'Registro actualizado' : 'Registro agregado'); clientDetail(client.id);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

function photosSection(target, client) {
  api(`/api/clients/${encodeURIComponent(client.id)}/progress-photos`).then(photos => {
    if (!target.isConnected || !modal.open) return;
    target.innerHTML = `${photos.length ? `<div class="photo-grid">${photos.map(photo => {
      const near = photo.nearest_inbody;
      const linked = near
        ? `<small>InBody ${String(near.testedAt).slice(0, 10)} · ${near.daysApart === 0 ? 'mismo día' : `${near.daysApart} día${near.daysApart === 1 ? '' : 's'} de diferencia`}${Number.isFinite(Number(near.values?.weightKg)) ? ` · ${Number(near.values.weightKg)} kg` : ''}${Number.isFinite(Number(near.values?.percentBodyFat)) ? ` · ${Number(near.values.percentBodyFat)}% grasa` : ''}</small>`
        : '<small>Sin InBody con el cual comparar</small>';
      return `<figure class="photo-card">${photo.viewUrl ? `<img src="${escapeHtml(photo.viewUrl)}" alt="Foto de progreso del ${fechaCorta(photo.taken_on)}" loading="lazy" />` : '<div class="photo-missing">Archivo no disponible</div>'}
        <figcaption><b>${fechaCorta(photo.taken_on)}</b><span>${poseLabels[photo.pose]}</span>${linked}${photo.notes ? `<small>${escapeHtml(photo.notes)}</small>` : ''}
        <button class="secondary session-use" data-delete-photo="${photo.id}">Eliminar</button></figcaption></figure>`;
    }).join('')}</div>` : '<p class="empty">No hay fotos de progreso en este expediente.</p>'}<button class="secondary wide-button" id="add-photo">+ Subir foto de progreso</button>`;
    document.getElementById('add-photo').onclick = () => photoUploader(client);
    target.querySelectorAll('[data-delete-photo]').forEach(button => {
      button.onclick = async () => {
        if (!confirm('¿Eliminar esta foto de progreso? El archivo permanece en el expediente.')) return;
        try { await api(`/api/progress-photos/${button.dataset.deletePhoto}`, { method: 'DELETE' }); toast('Foto eliminada'); photosSection(target, client); }
        catch (error) { toast(error.message, true); }
      };
    });
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

function photoUploader(client) {
  const box = document.createElement('div');
  const today = new Date().toISOString().slice(0, 10);
  box.innerHTML = `<form id="photo-form"><p class="eyebrow">SEGUIMIENTO VISUAL</p><h2>Foto de progreso</h2>
    <p style="color:#6f7b75">Se guarda en el expediente privado de ${escapeHtml(client.name)} y se compara contra el InBody más cercano a su fecha.</p>
    <div class="form-row">
      <label>Fecha de la foto<input name="takenOn" type="date" required value="${today}" max="${today}" /></label>
      <label>Vista<select name="pose"><option value="front">Frente</option><option value="side">Perfil</option><option value="back">Espalda</option><option value="other">Otra</option></select></label>
    </div>
    <p class="section-note">Usa la fecha en que se tomó la foto, no la de hoy: así se empareja con el InBody correcto.</p>
    <label>Nota<input name="notes" maxlength="500" placeholder="Opcional" /></label>
    <label style="border:2px dashed #d8a7bc;border-radius:9px;padding:24px;text-align:center;color:#8c5870;cursor:pointer">
      <input id="photo-file" type="file" accept="image/jpeg,image/png,image/webp" hidden />Seleccionar foto<br><small style="color:#6f7b75;font-weight:400">JPG, PNG o WebP · máximo 20 MB</small></label>
    <div id="photo-result"></div></form>`;
  openModal(box);
  const result = document.getElementById('photo-result');
  document.getElementById('photo-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    const values = new FormData(document.getElementById('photo-form'));
    result.innerHTML = '<div class="alert-item" style="margin-top:15px"><b>Subiendo foto…</b><span>Conexión privada con el expediente.</span></div>';
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} supera el límite de 20 MB`);
      const extension = file.name.split('.').pop()?.toLowerCase();
      const contentType = file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[extension];
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new Error(`${file.name} no es una imagen JPG, PNG o WebP válida`);
      const created = await api('/api/documents/upload-url', { method: 'POST', body: { clientId: client.id, kind: 'progress_photo', fileName: file.name, contentType, sizeBytes: file.size } });
      await api(`/api/documents/${created.document.id}/content`, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
      await api(`/api/clients/${client.id}/progress-photos`, { method: 'POST', body: { documentId: created.document.id, takenOn: values.get('takenOn'), pose: values.get('pose'), notes: values.get('notes').trim() || null } });
      modal.close(); toast('Foto de progreso guardada'); clientDetail(client.id);
    } catch (error) {
      result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>No se pudo guardar la foto</b><span>${escapeHtml(error.message)}</span></div>`;
      event.target.value = '';
    }
  });
}

function pausePackageDialog(client) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="pause-package-form"><p class="eyebrow">PAUSA DE PAQUETE</p><h2>Pausar paquete</h2><p class="form-summary">${escapeHtml(client.name)} · El saldo y el vencimiento quedarán congelados.</p><label>Fecha inicial<input name="startsOn" type="date" value="${dateKey(new Date())}" required /><small>No puede ser una fecha futura.</small></label><label>Fecha prevista de fin <span style="color:#8c6f7d">(opcional)</span><input name="endsOn" type="date" /><small>Recibirás un recordatorio dos días antes. Déjala vacía para una pausa indefinida.</small></label><label>Justificación<textarea name="reason" rows="3" maxlength="300" placeholder="Ej. viaje, lesión o acuerdo con la entrenadora"></textarea></label><button class="primary wide-button">Confirmar pausa</button></form>`;
  openModal(box, true);
  box.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
    try { await api(`/api/clients/${client.id}/package-pause`, { method: 'POST', body: { startsOn: form.elements.startsOn.value, endsOn: form.elements.endsOn.value || undefined, reason: form.elements.reason.value || undefined } }); modal.close(); await loadData(); renderAll(); toast('Paquete pausado: clases y vencimiento congelados'); clientDetail(client.id); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });
}

// ── Viajes del cliente y rutina por enlace (J-107) ───────────────────────────────────────────────
// Un enlace "hasta el día X" vence a la medianoche siguiente: se muestra como las 11:59 p. m. de X para que no parezca que vence al empezar el día.
const venceTexto = iso => { const d = new Date(iso); const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Panama' }).format(d); return fechaHoraPanama(hm === '00:00' ? new Date(d.getTime() - 60000) : d); };
const fechaViaje = valor => valor ? fechaCorta(`${String(valor).slice(0, 10)}T12:00:00-05:00`) : '';
function etiquetaViaje(clientId) {
  const hoy = dateKey(today);
  const actual = viajeDelCliente(clientId, hoy);
  if (actual) return `<p class="viaje-etiqueta">✈ De viaje${actual.ends_on ? ` hasta el ${fechaViaje(actual.ends_on)}` : ' · regreso sin definir'}${actual.destination ? ` · ${escapeHtml(actual.destination)}` : ''}</p>`;
  const proximo = (data.travel || []).filter(item => item.client_id === clientId && item.starts_on > hoy).sort((x, y) => x.starts_on.localeCompare(y.starts_on))[0];
  return proximo ? `<p class="viaje-etiqueta proximo">✈ Viaja el ${fechaViaje(proximo.starts_on)}</p>` : '';
}

function viajeDialog(client, viaje = null) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="viaje-form"><p class="eyebrow">VIAJE</p><h2>${viaje ? 'Editar viaje' : 'Marcar viaje'}</h2>
    <p class="form-summary"><b>${escapeHtml(client.name)}</b></p>
    <div class="aviso-reprogramar">Viajar <b>no pausa su plan ni su cobro</b>. Pregúntale si quiere una rutina: si la acepta y la confirma <b>el día de cada clase</b>, esa clase cuenta. Si no hay acción, esa clase <b>se cancela sola</b> al terminar el día (cancelación del cliente) y queda registrada con este viaje.</div>
    <div class="form-row"><label>Sale el<input type="date" name="startsOn" required value="${viaje?.starts_on || dateKey(today)}" /></label>
    <label>Regresa el<input type="date" name="endsOn" value="${viaje?.ends_on || ''}" /><small>Déjalo vacío si aún no lo sabe.</small></label></div>
    <label>Destino (opcional)<input name="destination" maxlength="80" value="${escapeHtml(viaje?.destination || '')}" placeholder="Ej. Madrid" /></label>
    <label>Nota (opcional)<textarea name="note" rows="2" maxlength="300">${escapeHtml(viaje?.note || '')}</textarea></label>
    <button class="primary wide-button">${viaje ? 'Guardar cambios' : 'Marcar viaje'}</button></form>`;
  openModal(box);
  document.getElementById('viaje-form').addEventListener('submit', async evento => {
    evento.preventDefault();
    const valores = new FormData(evento.target);
    const cuerpo = { startsOn: valores.get('startsOn'), endsOn: valores.get('endsOn') || null, destination: valores.get('destination') || undefined, note: valores.get('note') || undefined };
    try {
      evento.target.classList.add('loading-state');
      const guardado = viaje
        ? await api(`/api/travel/${viaje.id}`, { method: 'PATCH', body: cuerpo })
        : await api(`/api/clients/${client.id}/travel`, { method: 'POST', body: cuerpo });
      await loadData(); renderAll(); modal.close();
      toast(viaje ? 'Viaje actualizado' : 'Viaje marcado');
      if (!viaje && confirm(`¿Preparar ahora una rutina de viaje para ${client.name.split(' ')[0]}?\n\nSin una rutina que confirmar, sus clases de esos días no tienen cómo contar.`)) prepararRutinaDeViaje(client, guardado);
      else clientDetail(client.id);
    } catch (error) { toast(error.message, true); evento.target.classList.remove('loading-state'); }
  });
}

async function viajesSection(target, client) {
  if (!target) return;
  try {
    const [viajes, enlaces] = await Promise.all([api(`/api/clients/${client.id}/travel`), api(`/api/clients/${client.id}/share-links`).catch(() => [])]);
    if (!target.isConnected) return;
    const hoy = dateKey(today);
    const estado = viaje => viaje.ends_on && viaje.ends_on < hoy ? 'pasado' : viaje.starts_on > hoy ? 'próximo' : 'en curso';
    const activos = enlaces.filter(item => item.active);
    target.innerHTML = `<button type="button" class="secondary wide-button" id="marcar-viaje">✈ Marcar viaje</button>
      ${viajes.length ? viajes.map(viaje => `<div class="viaje-fila ${estado(viaje).replace(' ', '-')}"><div><b>✈ ${fechaViaje(viaje.starts_on)} → ${viaje.ends_on ? fechaViaje(viaje.ends_on) : 'regreso sin definir'}${viaje.ends_on ? ` · ${Math.round((new Date(`${viaje.ends_on}T12:00:00`) - new Date(`${viaje.starts_on}T12:00:00`)) / 86400000) + 1} días` : ''}</b><small>${estado(viaje)}${viaje.destination ? ` · ${escapeHtml(viaje.destination)}` : ''}${viaje.note ? ` · ${escapeHtml(viaje.note)}` : ''}${viaje.cancelled_sessions ? ` · <b>${viaje.cancelled_sessions} clase${viaje.cancelled_sessions === 1 ? '' : 's'} cancelada${viaje.cancelled_sessions === 1 ? '' : 's'} por este viaje</b>` : ''}</small></div>
        <div class="viaje-acciones">${estado(viaje) !== 'pasado' ? `<button type="button" class="secondary" data-viaje-rutina="${viaje.id}">Preparar rutina</button>` : ''}<button type="button" class="secondary" data-viaje-editar="${viaje.id}">Editar</button>${viaje.cancelled_sessions ? '' : `<button type="button" class="secondary" data-viaje-borrar="${viaje.id}">Quitar</button>`}</div></div>`).join('')
        : '<p class="empty">No hay viajes marcados.</p>'}
      ${activos.length ? `<p class="section-note" style="margin-top:12px"><b>Enlaces de rutina activos</b></p>${activos.map(item => `<div class="viaje-fila"><div><b>${escapeHtml(item.routine_title)}</b><small>Vence el ${venceTexto(item.expires_at)} · abierto ${item.opens} vez${item.opens === 1 ? '' : 'es'}</small></div><div class="viaje-acciones"><button type="button" class="secondary" data-enlace-revocar="${item.id}">Revocar</button></div></div>`).join('')}` : ''}`;
    target.querySelector('#marcar-viaje').onclick = () => viajeDialog(client);
    target.querySelectorAll('[data-viaje-editar]').forEach(boton => { boton.onclick = () => viajeDialog(client, viajes.find(item => item.id === boton.dataset.viajeEditar)); });
    target.querySelectorAll('[data-viaje-rutina]').forEach(boton => { boton.onclick = () => prepararRutinaDeViaje(client, viajes.find(item => item.id === boton.dataset.viajeRutina)); });
    target.querySelectorAll('[data-viaje-borrar]').forEach(boton => {
      boton.onclick = async () => {
        if (!confirm('¿Quitar este viaje? Sus clases dejarán de marcarse como de viaje.')) return;
        try { await api(`/api/travel/${boton.dataset.viajeBorrar}`, { method: 'DELETE' }); await loadData(); renderAll(); viajesSection(target, client); toast('Viaje quitado'); }
        catch (error) { toast(error.message, true); }
      };
    });
    target.querySelectorAll('[data-enlace-revocar]').forEach(boton => {
      boton.onclick = async () => {
        if (!confirm('¿Revocar este enlace? Quien lo tenga dejará de poder abrirlo.')) return;
        try { await api(`/api/share-links/${boton.dataset.enlaceRevocar}`, { method: 'DELETE' }); viajesSection(target, client); toast('Enlace revocado'); }
        catch (error) { toast(error.message, true); }
      };
    });
  } catch (error) { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
}

// Preparar la rutina de viaje: un clic la genera con IA y el catálogo (sin máquinas ni equipo), se revisa en el editor y al guardarla se ofrece el enlace para enviarla.
function prepararRutinaDeViaje(client, viaje) {
  const nombre = client.name.split(' ')[0];
  const caja = document.createElement('div');
  const resumen = `<p class="eyebrow">VIAJE</p><h2>Rutina de viaje</h2><p class="form-summary"><b>${escapeHtml(client.name)}</b><br>✈ ${fechaViaje(viaje.starts_on)} → ${viaje.ends_on ? fechaViaje(viaje.ends_on) : 'regreso sin definir'}${viaje.destination ? ` · ${escapeHtml(viaje.destination)}` : ''}</p>`;
  openModal(caja, true);
  const alEditor = propuesta => { modal.close(); newRoutine(null, false, { ...propuesta, clientId: client.id, enlaceViajeId: viaje.id, enlaceCliente: client.name }); };
  const manual = () => alEditor({ title: `Rutina de viaje de ${nombre}`, description: '', sessionsPerWeek: 3, exercises: [], rationale: '', avoided: [], descartados: [] });
  const pedirEspecificacion = () => {
    caja.innerHTML = `${resumen}<form id="viaje-especificaciones">${campoEspecificacion('Ej. Rutina de 30 min de pierna y core. Tiene gimnasio en el hotel: mancuernas y caminadora')}
      <button class="primary wide-button">Generar con IA</button><button type="button" class="secondary wide-button" id="viaje-sin-ia">Armarla yo, sin IA</button></form>`;
    caja.querySelector('#viaje-sin-ia').onclick = manual;
    caja.querySelector('#viaje-especificaciones').addEventListener('submit', evento => { evento.preventDefault(); generar(textoEspecificacion(evento.target)); });
  };
  const generar = async texto => {
    caja.innerHTML = `${resumen}<p class="section-note" role="status">Generando una rutina que se pueda hacer de viaje, con tu catálogo de ejercicios… puede tardar unos segundos.</p>`;
    try {
      alEditor(await api('/api/routines/suggest', { method: 'POST', body: {
        description: descripcionConEspecificacion(`Rutina de viaje para que ${nombre} entrene por su cuenta mientras está fuera${viaje.destination ? ` (${viaje.destination})` : ''}.`, texto),
        clientId: client.id, forTravel: true, durationMinutes: 40
      } }));
    } catch (error) {
      caja.innerHTML = `${resumen}<p class="conflict-warn">${escapeHtml(error.message)}</p><button class="primary wide-button" id="viaje-reintentar">Cambiar la especificación y reintentar</button><button class="secondary wide-button" id="viaje-manual">Armarla yo, sin IA</button>`;
      caja.querySelector('#viaje-reintentar').onclick = pedirEspecificacion; caja.querySelector('#viaje-manual').onclick = manual;
    }
  };
  pedirEspecificacion();
}

// Enviar una rutina por enlace temporal: sin cuenta ni contraseña para el cliente, con la vigencia que elija Eileen.
function enviarEnlaceRutina(rutina, client, viaje = null) {
  const nombre = client.name.split(' ')[0];
  const box = document.createElement('div');
  const hastaRegreso = viaje?.ends_on && viaje.ends_on >= dateKey(today);
  box.innerHTML = `<form id="enlace-form"><p class="eyebrow">RUTINA POR ENLACE</p><h2>Enviar a ${escapeHtml(nombre)}</h2>
    <p class="form-summary"><b>${escapeHtml(rutina.title)}</b></p>
    <p class="section-note">El cliente la abre sin cuenta ni contraseña, ve los videos de cada ejercicio, usa el cronómetro y confirma al terminar. Pasada la vigencia el enlace deja de funcionar, y puedes revocarlo antes.</p>
    <fieldset class="enlace-vigencia"><legend>Vigencia</legend>
      ${hastaRegreso ? `<label class="checkbox-line"><input type="radio" name="vigencia" value="regreso" checked /> Hasta su regreso (${fechaViaje(viaje.ends_on)})</label>` : ''}
      <label class="checkbox-line"><input type="radio" name="vigencia" value="24" ${hastaRegreso ? '' : 'checked'} /> 24 horas</label>
      <label class="checkbox-line"><input type="radio" name="vigencia" value="72" /> 3 días</label>
      <label class="checkbox-line"><input type="radio" name="vigencia" value="168" /> 7 días</label>
      <label class="checkbox-line"><input type="radio" name="vigencia" value="fecha" /> Hasta una fecha <input type="date" name="hasta" min="${dateKey(today)}" /></label>
    </fieldset>
    ${viaje ? '<div class="aviso-reprogramar">Recuerda: durante el viaje, confirmar la rutina <b>el día de su clase</b> es lo que hace que esa clase cuente.</div>' : ''}
    <button class="primary wide-button">Crear enlace</button></form>`;
  openModal(box);
  document.getElementById('enlace-form').addEventListener('submit', async evento => {
    evento.preventDefault();
    const valores = new FormData(evento.target); const vigencia = valores.get('vigencia');
    const cuerpo = { clientId: client.id, travelId: viaje?.id };
    if (vigencia === 'regreso') cuerpo.until = viaje.ends_on;
    else if (vigencia === 'fecha') { if (!valores.get('hasta')) { toast('Elige la fecha hasta la que vale', true); return; } cuerpo.until = valores.get('hasta'); }
    else cuerpo.hours = Number(vigencia);
    try {
      evento.target.classList.add('loading-state');
      const enlace = await apiConAvisoDeRepetido(`/api/routines/${rutina.id}/share-links`, { method: 'POST', body: cuerpo });
      if (!enlace) { evento.target.classList.remove('loading-state'); return; }
      const mensaje = `Hola ${nombre}, te dejé tu rutina${viaje ? ' para el viaje' : ''}: ${enlace.url}\n\nÁbrela, mira los videos y confirma al terminar${viaje ? ' (confírmala el día de tu clase para que cuente)' : ''}. El enlace vale hasta el ${venceTexto(enlace.expiresAt)}`;
      box.innerHTML = `<p class="eyebrow">RUTINA POR ENLACE</p><h2>Enlace listo</h2>
        <p class="form-summary">Vale hasta el <b>${venceTexto(enlace.expiresAt)}</b> (hora de Panamá).</p>
        <label>Enlace<input id="enlace-url" readonly value="${escapeHtml(enlace.url)}" /></label>
        <button type="button" class="primary wide-button" id="enlace-copiar">Copiar enlace</button>
        <a class="secondary wide-button enlace-whatsapp" id="enlace-whatsapp" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(mensaje)}">Enviar por WhatsApp</a>
        <p class="section-note">El enlace no se vuelve a mostrar completo después; si lo pierdes, crea otro. Lo ves y revocas en el expediente, sección Viajes.</p>`;
      document.getElementById('enlace-copiar').onclick = async () => {
        try { await navigator.clipboard.writeText(enlace.url); toast('Enlace copiado'); }
        catch { const campo = document.getElementById('enlace-url'); campo.select(); document.execCommand('copy'); toast('Enlace copiado'); }
      };
    } catch (error) { toast(error.message, true); evento.target.classList.remove('loading-state'); }
  });
}

function clientDetail(id) {
  const client = data.clients.find(item => item.id === id); const inbody = client.inbody;
  const pack = clientPackage(client.name);
  const pagador = client.paysForMeId ? data.clients.find(item => item.id === client.paysForMeId) : null;
  const dependientes = data.clients.filter(item => item.paysForMeId === client.id);
  const notaPago = pagador ? `<br><span class="pago-nota">Paga ${escapeHtml(pagador.name)}</span>`
    : dependientes.length ? `<br><span class="pago-nota">Paga también por ${escapeHtml(dependientes.map(d => d.name).join(', '))}</span>` : '';
  const commercialDescription = client.billingModel === 'package'
    ? `${client.planName || pack?.label || `Paquete ${client.sessionsIncluded || 0} sesiones`} · ${pack ? remainingSessions(pack) : client.sessionsIncluded || 0} disponibles · ${money.format(client.plan)}`
    : client.billingModel === 'single'
    ? `${client.planName || 'Sesiones individuales'} · ${money.format(client.plan)} por sesión`
    : client.paymentMode === 'no_anticipado'
    ? `Crédito · ${money.format(client.creditSessionPrice || 25)} por sesión · corte día ${client.cutoffDay}`
    : `${client.planName || 'Mensualidad'} · ${money.format(client.plan)} al mes · corte día ${client.cutoffDay}`;
  const box = document.createElement('div');
  const reviewNotice = client.inbodyReviews.length ? `<button class="secondary wide-button" id="review-inbody">Revisar ${client.inbodyReviews.length} evaluación${client.inbodyReviews.length > 1 ? 'es' : ''} pendiente${client.inbodyReviews.length > 1 ? 's' : ''}</button>` : '';
  box.innerHTML = `<p class="eyebrow">EXPEDIENTE</p><h2>${escapeHtml(client.name)}</h2><p style="color:#6f7b75;margin-top:-12px">${escapeHtml(client.goal)}<br>${commercialDescription}${notaPago}</p>${clientBillingSection(client)}<p class="eyebrow" style="margin-top:20px">PLAN DE FACTURACIÓN</p><div id="client-billing-subscriptions"><p class="empty">Cargando conceptos a facturar…</p></div><button type="button" class="secondary wide-button" id="add-billing-subscription-detail">Agregar concepto a facturar</button><p class="section-note">Preparado para el sistema nuevo; hoy la facturación automática sigue usando el monto mensual del cliente.</p>${inbody ? `<div class="metrics" style="grid-template-columns:repeat(2,1fr)"><article><span>Peso</span><strong>${inbody.weight} kg</strong></article><article><span>Masa muscular</span><strong>${inbody.smm} kg</strong></article><article><span>Grasa corporal</span><strong>${inbody.pbf}%</strong></article><article><span>InBody Score</span><strong>${inbody.score}/100</strong></article></div><p class="eyebrow" style="margin-top:20px">CAMBIO DESDE LA MEDICIÓN ANTERIOR</p>${inbodyComparison(inbody)}<p class="eyebrow" style="margin-top:20px">HISTORIAL IMPORTADO</p><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Peso</th><th>Músculo</th><th>Grasa</th><th>vs. anterior</th><th></th></tr></thead><tbody>${inbody.history.slice().reverse().map(reading => `<tr><td>${reading.date}</td><td>${reading.weight} kg</td><td>${reading.smm} kg</td><td>${reading.pbf}%</td><td class="delta-cell">${reading.delta ? `${deltaChip('weight', reading.delta.weight)}${deltaChip('smm', reading.delta.smm)}${deltaChip('pbf', reading.delta.pbf)}` : '<span class="delta neutral">primera</span>'}</td><td>${reading.documentId ? `<button class="secondary session-use" data-view-inbody="${reading.documentId}" data-inbody-client="${client.id}">Ver reporte</button>` : ''}<button class="secondary session-use" data-delete-inbody="${reading.id}">Eliminar</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Aún no se ha confirmado una evaluación InBody.</p>'}${reviewNotice}<p class="eyebrow" style="margin-top:20px">SALDO DE SESIONES</p><div id="client-balances"><p class="empty">Cargando saldos…</p></div><p class="eyebrow" style="margin-top:20px">ASISTENCIA MENSUAL</p><div id="client-attendance"><p class="empty">Calculando cumplimiento…</p></div><p class="eyebrow" style="margin-top:20px">RUTINAS ENVIADAS</p><div id="client-routine-deliveries"><p class="empty">Cargando envíos de rutinas…</p></div><p class="eyebrow" style="margin-top:20px">HISTORIAL DE RUTINAS</p><div id="client-routine-history"><p class="empty">Cargando historial de rutinas…</p></div><p class="eyebrow" style="margin-top:20px">LESIONES Y PADECIMIENTOS</p><div id="client-conditions"><p class="empty">Cargando expediente clínico…</p></div><p class="eyebrow" style="margin-top:20px">FOTOS DE PROGRESO</p><div id="client-photos"><p class="empty">Cargando fotos…</p></div><p class="eyebrow" style="margin-top:20px">DOCUMENTOS PRIVADOS</p><div id="client-documents"><p class="empty">Cargando documentos del expediente…</p></div><div class="detail-actions"><button class="secondary" id="edit-client-contact">Editar contacto</button><button class="secondary" id="edit-client-plan">Editar plan y corte</button><button class="secondary" id="client-report">Informe de cumplimiento</button><button class="secondary" id="portal-link">${client.portalActive ? 'Enviar enlace de acceso' : 'Activar portal con enlace'}</button><button class="secondary" id="portal-access">${client.portalActive ? 'Poner contraseña a mano' : 'Activar con contraseña'}</button><button class="secondary" id="delete-client">Eliminar cliente</button></div><button class="primary wide-button" id="open-scan">${inbody ? 'Importar nuevo InBody' : 'Importar InBody'}</button>`;
  openModal(box); const pauseButton = document.createElement('button'); pauseButton.className = 'secondary wide-button'; pauseButton.textContent = client.pauseId ? 'Reanudar paquete' : 'Pausar paquete'; box.querySelector('.detail-actions').appendChild(pauseButton); pauseButton.onclick = async () => { try { if (client.pauseId) { await api(`/api/client-pauses/${client.pauseId}/resume`, { method: 'POST' }); toast('Paquete reactivado y vencimiento extendido'); await loadData(); renderAll(); modal.close(); clientDetail(client.id); } else pausePackageDialog(client); } catch (error) { toast(error.message, true); } }; document.getElementById('open-scan').onclick = () => inbodyImport(client); document.getElementById('edit-client-contact').onclick = () => editClient(client); document.getElementById('edit-client-plan').onclick = () => clientPlanEditor(client); document.getElementById('portal-access').onclick = () => portalAccessEditor(client); document.getElementById('portal-link').onclick = () => portalAccessLink(client); document.getElementById('client-report').onclick = () => complianceReport(client); document.getElementById('delete-client').onclick = () => deleteResource(`/api/clients/${client.id}`, `¿Eliminar a ${client.name}? También se eliminarán sus documentos, sesiones y cobros asociados.`, 'Cliente eliminado');
  if (inbody) {
    const summary = box.querySelector('.metrics');
    if (summary) summary.insertAdjacentHTML('afterend', inbodyDetailSection(inbody.values));
  }
  if (client.inbodyReviews.length) document.getElementById('review-inbody').onclick = () => inbodyReview(client, client.inbodyReviews);
  api(`/api/clients/${client.id}/billing-subscriptions`).then(payload => renderBillingSubscriptions(document.getElementById('client-billing-subscriptions'), payload, client)).catch(error => {
    const target = document.getElementById('client-billing-subscriptions'); if (target) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  });
  document.getElementById('add-billing-subscription-detail').onclick = () => billingSubscriptionDialog(client);
  // Viajes: arriba del expediente, junto al resumen del cliente, para encontrarlos sin recorrer todo el modal.
  box.querySelector('h2').nextElementSibling?.insertAdjacentHTML('afterend', '<p class="eyebrow" style="margin-top:20px">VIAJES</p><div id="client-travel"><p class="empty">Cargando…</p></div>');
  viajesSection(document.getElementById('client-travel'), client);
  const balanceTarget = document.getElementById('client-balances');
  if (balanceTarget) {

    balanceTarget.insertAdjacentHTML('beforebegin', '<p class="eyebrow" style="margin-top:20px">PESO REGISTRADO POR EL CLIENTE</p><div id="client-weight-logs"><p class="empty">Cargando registros…</p></div>');
    clientWeightLogsSection(document.getElementById('client-weight-logs'), client.id);
  }
  balancesSection(document.getElementById('client-balances'), client);
  attendanceSection(document.getElementById('client-attendance'), client.id);
  routineDeliveriesSection(document.getElementById('client-routine-deliveries'), `/api/clients/${encodeURIComponent(client.id)}/routine-deliveries`);
  routineHistorySection(document.getElementById('client-routine-history'), client);
  clientWeightLogsSection(document.getElementById('client-weight-logs'), client.id);
  conditionsSection(document.getElementById('client-conditions'), client);
  photosSection(document.getElementById('client-photos'), client);
  api(`/api/documents?clientId=${encodeURIComponent(client.id)}`).then(items => {
    const target = document.getElementById('client-documents');
    if (!target || !modal.open) return;
    // En lista y no en tabla: la tabla se desplaza en horizontal en el teléfono
    // y la última columna —donde viven las acciones— queda fuera de la vista.
    const tipos = { inbody: 'InBody', contract: 'Contrato', receipt: 'Comprobante', progress_photo: 'Foto de progreso', other: 'Otro' };
    target.innerHTML = items.length ? `<div class="document-list">${items.map(item => `<article class="document-item">
      <div><b>${escapeHtml(item.original_name)}</b><small>${tipos[item.kind] || escapeHtml(item.kind)} · ${String(item.created_at).slice(0, 10)}${item.size_bytes ? ` · ${(Number(item.size_bytes) / 1024).toFixed(0)} KB` : ''}${item.upload_status !== 'ready' ? ' · incompleto' : ''}</small></div>
      <div class="document-actions">
        ${item.upload_status === 'ready' ? `<button class="secondary session-use" data-view-document="${item.id}">Ver archivo</button>` : ''}
        <button class="secondary session-use" data-delete-document="${item.id}">Eliminar</button>
      </div></article>`).join('')}</div>` : '<p class="empty">No hay archivos guardados en este expediente.</p>';
    target.querySelectorAll('[data-view-document]').forEach(button => {
      button.onclick = () => viewDocument(items.find(item => item.id === button.dataset.viewDocument));
    });
  }).catch(error => {
    const target = document.getElementById('client-documents');
    if (target) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  });
}

const inbodyReviewFields = [
  ['weightKg', 'Peso', 'kg'], ['skeletalMuscleMassKg', 'Músculo', 'kg'], ['bodyFatMassKg', 'Masa grasa', 'kg'],
  ['percentBodyFat', 'Grasa', '%'], ['bmi', 'IMC', ''], ['visceralFatAreaCm2', 'Área grasa visceral', 'cm²'], ['visceralFatLevel', 'Nivel grasa visceral', 'nivel'],
  ['totalBodyWaterL', 'Agua corporal total', 'L'], ['softLeanMassKg', 'Masa magra suave', 'kg'], ['fatFreeMassKg', 'Masa libre de grasa', 'kg'],
  ['ecwRatio', 'ECW', ''], ['phaseAngleDeg', 'Ángulo de fase', '°'], ['basalMetabolicRateKcal', 'Metabolismo basal', 'kcal'], ['inBodyScore', 'Score', '']
];

function inbodyReview(client, assessments, pageErrors = [], skippedPages = []) {
  const box = document.createElement('div');
  const latestTestedAt = assessments.reduce((latest, item) => String(item.tested_at) > latest ? String(item.tested_at) : latest, '');
  const rows = assessments.map((item, index) => {
    const reviewValues = { ...item.values };
    if (String(item.tested_at) !== latestTestedAt) delete reviewValues.inBodyScore;
    return `<section class="inbody-review-item" data-assessment="${item.id}"><div class="inbody-review-item-head"><b>Medición ${index + 1}</b><label>Fecha<input aria-label="Fecha" data-inbody-date type="date" required value="${String(item.tested_at).slice(0, 10)}"></label></div><div class="inbody-review-fields">${inbodyReviewFields.map(([key, label, unit]) => `<label class="inbody-cell"><span>${label}</span><input aria-label="${label}" data-inbody-key="${key}" type="number" step="0.001" value="${reviewValues[key] ?? ''}"><small>${unit}</small></label>`).join('')}</div></section>`;
  }).join('');
  const notes = assessments.flatMap(item => item.review_notes || []);
  box.innerHTML = `<form id="inbody-review-form"><p class="eyebrow">REVISIÓN DE DATOS</p><h2>Confirmar historial InBody</h2><p class="inbody-review-copy">Compara estos datos con el reporte de ${escapeHtml(client.name)}. Solo corrige una cifra si no coincide; el resto ya fue capturado automáticamente.</p>${notes.length ? `<div class="inbody-warnings"><b>Revisar con atención</b>${[...new Set(notes)].map(note => `<span>${escapeHtml(note)}</span>`).join('')}</div>` : ''}${pageErrors.length ? `<div class="inbody-warnings"><b>Archivos con lectura incompleta</b>${pageErrors.map(note => `<span>${escapeHtml(note)}</span>`).join('')}</div>` : ''}${skippedPages.length ? `<div class="inbody-warnings"><b>Ahorro de IA activado</b><span>${skippedPages.length} página${skippedPages.length > 1 ? 's quedaron' : ' quedó'} guardada${skippedPages.length > 1 ? 's' : ''} sin enviarse a IA porque no contiene métricas comparables.</span></div>` : ''}<div class="inbody-review-list">${rows}</div><p class="inbody-review-note">La confirmación guarda el historial y habilita las comparaciones. No genera diagnósticos médicos.</p><button class="primary wide-button">Confirmar resultados</button></form>`;
  openModal(box, true);
  document.getElementById('inbody-review-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; button.textContent = 'Guardando…';
    try {
      for (const row of event.currentTarget.querySelectorAll('[data-assessment]')) {
        const original = assessments.find(item => item.id === row.dataset.assessment); const values = { ...original.values };
        row.querySelectorAll('[data-inbody-key]').forEach(input => { if (input.value === '') delete values[input.dataset.inbodyKey]; else values[input.dataset.inbodyKey] = Number(input.value); });
        const date = row.querySelector('[data-inbody-date]').value;
        const testedAt = new Date(`${date}T12:00:00-05:00`).toISOString();
        await api(`/api/inbody/${original.id}`, { method: 'PATCH', body: { testedAt, values, extractionStatus: 'ready' } });
      }
      await loadData(); renderAll(); modal.close(); navigate('clients'); toast('Historial InBody confirmado');
    } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = 'Confirmar resultados'; }
  });
}

function inbodyImport(client) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">IMPORTACIÓN AUTOMÁTICA</p><h2>Analizar InBody</h2><p style="color:#6f7b75">Sube las páginas del reporte en JPG, PNG o WebP. Se guardarán en el expediente privado antes de iniciar el análisis.</p><p class="inbody-review-note">La extracción se revisa antes de guardar el historial. Para DeepSeek, sube las páginas del reporte como imágenes.</p><label style="border:2px dashed #d8a7bc;border-radius:9px;padding:24px;text-align:center;color:#8c5870;cursor:pointer"><input id="inbody-file" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden />Seleccionar reporte InBody<br><small style="color:#6f7b75;font-weight:400">Máximo 20 MB por archivo</small></label><div id="scan-result"></div>`;
  openModal(box);
  const result = document.getElementById('scan-result');
  const analyzeDocuments = async documentIds => {
    result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>Analizando el reporte…</b><span>Leyendo métricas, fechas e historial y comprobando la coherencia de los resultados.</span></div>`;
    try {
      const analyzed = await api('/api/inbody/analyze', { method: 'POST', body: { clientId: client.id, documentIds } });
      inbodyReview(client, analyzed.assessments, analyzed.pageErrors, analyzed.skippedPages);
    } catch (analysisError) {
      result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>Reporte guardado; análisis pendiente</b><span>${escapeHtml(analysisError.message)}. El archivo permanece seguro y puedes reintentarlo desde esta misma pantalla.</span></div>`;
    }
  };
  api(`/api/documents?clientId=${encodeURIComponent(client.id)}`).then(documents => {
    const saved = documents.filter(document => document.kind === 'inbody' && document.upload_status === 'ready');
    if (!saved.length || result.children.length) return;
    result.innerHTML = `<div class="alert-item inbody-retry" style="margin-top:15px"><b>${saved.length > 1 ? `${saved.length} archivos guardados disponibles` : 'Archivo guardado disponible'}</b><span>${saved.length > 1 ? 'Puedes volver a analizar todos juntos para reconstruir el historial completo y comparar las fechas.' : `${escapeHtml(saved[0].original_name)} ya está en el expediente.`}</span><div class="saved-inbody-list">${saved.map(document => `<label><input type="checkbox" data-saved-inbody value="${document.id}" checked> ${escapeHtml(document.original_name)}</label>`).join('')}</div><button class="secondary" id="retry-saved-inbody">Volver a analizar seleccionados</button></div>`;
    document.getElementById('retry-saved-inbody').addEventListener('click', () => {
      const ids = [...result.querySelectorAll('[data-saved-inbody]:checked')].map(input => input.value);
      if (!ids.length) return toast('Selecciona al menos un archivo', true);
      analyzeDocuments(ids);
    });
  }).catch(() => {});
  document.getElementById('inbody-file').addEventListener('change', async event => {
    const files = [...event.target.files]; if (!files.length) return;
    result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>Subiendo ${files.length} archivo${files.length > 1 ? 's' : ''}…</b><span>Conexión privada con el expediente de ${escapeHtml(client.name)}.</span></div>`;
    try {
      const documentIds = [];
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} supera el límite de 20 MB`);
        const extension = file.name.split('.').pop()?.toLowerCase();
        const contentType = file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[extension];
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new Error(`${file.name} no es una imagen JPG, PNG o WebP válida`);
        const created = await api('/api/documents/upload-url', { method: 'POST', body: { clientId: client.id, kind: 'inbody', fileName: file.name, contentType, sizeBytes: file.size } });
        await api(`/api/documents/${created.document.id}/content`, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
        documentIds.push(created.document.id);
      }
      await analyzeDocuments(documentIds);
    } catch (error) { result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>No se pudo completar la carga</b><span>${escapeHtml(error.message)}</span></div>`; }
  });
}
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', event => {
  event.preventDefault(); navigate(link.dataset.view);
}));
document.querySelectorAll('[data-view-go]').forEach(button => button.addEventListener('click', event => {
  event.preventDefault(); navigate(button.dataset.viewGo);
}));
// ── Facturas del módulo nuevo (1B-2) ─────────────────────────────────────────
// Documento por cobrar con número FAC-. Módulo interno: hoy convive con el
// sistema anterior y NO cambia lo que éste factura. El dinero recibido (cobros)
// se registra aparte (1B-3).
const newBillingKinds = { mensual: 'Mensualidad', credito: 'A crédito', clase_suelta: 'Clase suelta', paquete: 'Paquete', manual: 'Manual' };
const newBillingStatusLabels = { pendiente: 'Pago pendiente', parcial: 'Pago parcial', pagada: 'Pagada', anulada: 'Anulada' };
const newBillingStatusClass = { pendiente: 'pago-pendiente', parcial: 'parcial', pagada: 'pagada', anulada: 'anulada' };
const newBillingFilters = { status: 'activa', clientId: '', month: '', cutDay: '' };
const newBillingMonthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const newBillingMonthText = value => { const [year, month] = value.split('-'); const name = newBillingMonthNames[Number(month) - 1]; return `${name[0].toUpperCase()}${name.slice(1)} ${year}`; };
function newBillingStatusText(invoice) {
  return newBillingStatusLabels[invoice.status] || invoice.status;
}
// Estado con color bien visible (J-097): pago pendiente = ámbar, pagada = verde, parcial = azul, anulada = gris.
function newBillingStatusChip(invoice) {
  return `<span class="estado-chip ${newBillingStatusClass[invoice.status] || ''}">${escapeHtml(newBillingStatusText(invoice))}</span>`;
}
const estadoPausaChip = texto => `<span class="estado-chip en-pausa">${escapeHtml(texto || 'En pausa')}</span>`;
async function newBillingInvoices() {
  const root = document.getElementById('facturas-nuevo-mount');
  if (!root) return;
  const f = newBillingFilters;
  if (!root.querySelector('#new-billing-list')) root.innerHTML = '<article class="card"><p class="empty">Cargando facturas…</p></article>';
  let result;
  try {
    const query = new URLSearchParams({ status: f.status, details: '1' });
    if (f.clientId) query.set('clientId', f.clientId);
    if (f.month) query.set('month', f.month);
    if (f.cutDay) query.set('cutDay', f.cutDay);
    result = await api(`/api/billing/invoices?${query}`);
  } catch (error) { root.innerHTML = `<article class="card"><p class="empty">${escapeHtml(error.message)}</p></article>`; return; }
  const { invoices, summary, meta } = result;
  const clientOptions = data.clients.slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(client => `<option value="${client.id}"${client.id === f.clientId ? ' selected' : ''}>${escapeHtml(client.name)}</option>`).join('');
  const monthOptions = meta.months.map(month => `<option value="${month}"${month === f.month ? ' selected' : ''}>${newBillingMonthText(month)}</option>`).join('');
  const cutOptions = meta.cutDays.map(day => `<option value="${day}"${String(day) === String(f.cutDay) ? ' selected' : ''}>Corte del ${day}</option>`).join('');
  const percent = summary.total > 0 ? Math.round((summary.paid / summary.total) * 100) : 0;
  const filtered = f.status !== 'activa' || f.clientId || f.month || f.cutDay;
  root.innerHTML = `<article class="card"><div class="card-head"><div><h3>Facturas</h3><p id="new-billing-summary">${summary.count} facturas${filtered ? ' con estos filtros' : ''} · Total ${money.format(summary.total)} · Saldo ${money.format(summary.balance)}</p></div></div>
    <div class="subpanel-toolbar"><button class="primary" type="button" id="new-billing-create">+ Nueva factura</button></div>
    <div class="billing-period-bar">
      <label>Mes de emisión<select id="new-billing-month"><option value="">Todos</option>${monthOptions}</select></label>
      <label>Corte<select id="new-billing-cut"><option value="">Todos</option>${cutOptions}</select></label>
      <label>Cliente<select id="new-billing-client"><option value="">Todos</option>${clientOptions}</select></label>
      <label>Estado<select id="new-billing-status">${[['activa', 'Vigentes'], ['pendiente', 'Pago pendiente'], ['parcial', 'Pago parcial'], ['pagada', 'Pagadas'], ['vencida', 'Pago pendiente con fecha cumplida'], ['anulada', 'Anuladas'], ['all', 'Todas (con anuladas)']].map(([value, text]) => `<option value="${value}"${value === f.status ? ' selected' : ''}>${text}</option>`).join('')}</select></label>
      ${filtered ? '<button class="secondary" type="button" id="new-billing-clear">Quitar filtros</button>' : ''}</div>
    <div class="metrics new-billing-metrics">
      <article><span>Facturado</span><strong>${summary.count} · ${money.format(summary.total)}</strong></article>
      <article><span>Cobrado</span><strong>${summary.paymentsCount} · ${money.format(summary.paid)}</strong></article>
      <article><span>Saldo pendiente</span><strong>${money.format(summary.balance)}</strong></article>
      <article><span>Pagadas / pendientes</span><strong>${summary.paidCount} / ${summary.pendingCount}</strong></article>
      <article class="kpi-pendiente"><span>Pago pendiente con fecha cumplida</span><strong>${summary.overdueCount} · ${money.format(summary.overdueBalance)}</strong></article>
      <article><span>% cobrado</span><strong>${percent}%</strong></article></div>
    <div id="new-billing-list">${invoices.length ? `<div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Factura</th><th>Pagador</th><th>Ciclo</th><th>Líneas</th><th>Total</th><th>Cobro</th><th>Estado</th><th></th></tr></thead><tbody>${invoices.map(invoice => `<tr>
      <td data-label="Factura"><b>${escapeHtml(invoice.code)}</b><br><small>${escapeHtml(newBillingKinds[invoice.kind] || invoice.kind)} · corte ${invoice.cutDay}</small></td>
      <td data-label="Pagador">${escapeHtml(invoice.payerName)}</td>
      <td data-label="Ciclo">${fechaCorta(invoice.cycleStart)} → ${fechaCorta(invoice.cycleEnd)}<br><small>vence ${fechaCorta(invoice.dueOn)}</small></td>
      <td data-label="Líneas">${invoice.lines.map(line => `${escapeHtml(line.beneficiaryName)}: ${money.format(line.amount)}`).join('<br>')}</td>
      <td data-label="Total">${money.format(invoice.total)}</td>
      <td data-label="Cobro">${invoice.payments.length ? invoice.payments.map(payment => `${money.format(payment.amount)} · ${escapeHtml(payment.method)}<br><small>${fechaCorta(payment.paidOn)}</small>`).join('<br>') : 'Sin cobro'}${invoice.balance > 0 && invoice.paid > 0 ? `<br><small>saldo ${money.format(invoice.balance)}</small>` : ''}</td>
      <td data-label="Estado">${newBillingStatusChip(invoice)}${invoice.status === 'anulada' && invoice.voidReason ? `<br><small>${escapeHtml(invoice.voidReason)}</small>` : ''}</td>
      <td data-label="">${invoice.status !== 'anulada' && invoice.balance > 0 ? `<button class="primary" type="button" data-new-invoice-pay="${invoice.id}">Registrar cobro</button> ` : ''}${invoice.status !== 'anulada' && ['mensual', 'paquete'].includes(invoice.kind) && invoice.lines.length > 1 ? `<button class="secondary" type="button" data-new-invoice-split="${invoice.id}">Corregir reparto</button> ` : ''}<button class="secondary" type="button" data-new-invoice-pdf="${invoice.id}" data-code="${escapeHtml(invoice.code)}">Ver PDF</button>${invoice.status === 'anulada' || invoice.paid > 0 ? '' : ` <button class="secondary" type="button" data-new-invoice-void="${invoice.id}" data-code="${escapeHtml(invoice.code)}">Anular</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No hay facturas con estos filtros.</p>'}</div></article>`;
  document.getElementById('new-billing-create').onclick = () => newBillingInvoiceDialog();
  const bind = (id, key) => { document.getElementById(id).onchange = event => { f[key] = event.target.value; newBillingInvoices(); }; };
  bind('new-billing-month', 'month'); bind('new-billing-cut', 'cutDay'); bind('new-billing-client', 'clientId'); bind('new-billing-status', 'status');
  const clear = document.getElementById('new-billing-clear');
  if (clear) clear.onclick = () => { Object.assign(f, { status: 'activa', clientId: '', month: '', cutDay: '' }); newBillingInvoices(); };
  const list = document.getElementById('new-billing-list');
  list.querySelectorAll('[data-new-invoice-pay]').forEach(button => button.onclick = () => { const invoice = invoices.find(item => item.id === button.dataset.newInvoicePay); newBillingPaymentDialog({ payerId: invoice.payerClientId, amount: invoice.balance, invoiceId: invoice.id }); });
  list.querySelectorAll('[data-new-invoice-split]').forEach(button => button.onclick = () => newBillingSplitDialog(invoices.find(item => item.id === button.dataset.newInvoiceSplit)));
  list.querySelectorAll('[data-new-invoice-pdf]').forEach(button => button.onclick = () => previewProtectedPdf(`/api/billing/invoices/${button.dataset.newInvoicePdf}/pdf`, `Factura ${button.dataset.code}`, `factura-${button.dataset.code}.pdf`));
  list.querySelectorAll('[data-new-invoice-void]').forEach(button => button.onclick = () => newBillingVoidDialog(button.dataset.newInvoiceVoid, button.dataset.code));
}
// Historial de Zoho (solo lectura): lo facturado en Zoho antes del inicio en limpio. No tiene botones que escriban.
const newArchiveFilters = { month: '', status: '', clientId: '' };
const newArchiveStatus = { pagada: 'Pagada', pendiente: 'Sin cobro registrado', anulada: 'Anulada' };
async function newBillingArchive() {
  const root = document.getElementById('archivo-mount');
  if (!root) return;
  const f = newArchiveFilters;
  if (!root.querySelector('#new-archive-list')) root.innerHTML = '<article class="card"><p class="empty">Cargando archivo…</p></article>';
  let result;
  try {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(f)) if (value) query.set(key, value);
    result = await api(`/api/billing/archive?${query}`);
  } catch (error) { root.innerHTML = `<article class="card"><p class="empty">${escapeHtml(error.message)}</p></article>`; return; }
  const { invoices, summary, meta } = result;
  const clientOptions = data.clients.slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(client => `<option value="${client.id}"${client.id === f.clientId ? ' selected' : ''}>${escapeHtml(client.name)}</option>`).join('');
  const monthOptions = meta.months.map(month => `<option value="${month}"${month === f.month ? ' selected' : ''}>${newBillingMonthText(month)}</option>`).join('');
  const filtered = Object.values(f).some(Boolean);
  root.innerHTML = `<article class="card"><div class="card-head"><div><h3>Historial de Zoho</h3><p>${summary.count} facturas${filtered ? ' con estos filtros' : ''} · Total ${money.format(summary.total)} · Solo lectura</p></div></div>
    <p class="section-note">Lo facturado en Zoho antes de ${fechaCorta(result.cleanStart)}, solo para consultar. Desde esa fecha todo vive en Facturas y Cobros.</p>
    <div class="billing-period-bar">
      <label>Mes<select id="new-archive-month"><option value="">Todos</option>${monthOptions}</select></label>
      <label>Cliente<select id="new-archive-client"><option value="">Todos</option>${clientOptions}</select></label>
      <label>Estado<select id="new-archive-status"><option value="">Todos</option>${Object.entries(newArchiveStatus).map(([value, text]) => `<option value="${value}"${f.status === value ? ' selected' : ''}>${text}</option>`).join('')}</select></label>
      ${filtered ? '<button class="secondary" type="button" id="new-archive-clear">Quitar filtros</button>' : ''}</div>
    <div class="metrics new-billing-metrics">
      <article><span>Facturado</span><strong>${summary.count} · ${money.format(summary.total)}</strong></article>
      <article><span>Cobrado</span><strong>${money.format(summary.paid)}</strong></article></div>
    <div id="new-archive-list">${invoices.length ? `<div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Factura</th><th>Cliente</th><th>Concepto</th><th>Emisión</th><th>Total</th><th>Cobro</th><th>Estado</th></tr></thead><tbody>${invoices.map(invoice => `<tr>
      <td data-label="Factura"><b>${escapeHtml(invoice.number || '—')}</b><br><small>Zoho</small></td>
      <td data-label="Cliente">${escapeHtml(invoice.client)}</td>
      <td data-label="Concepto">${escapeHtml(invoice.concept)}</td>
      <td data-label="Emisión">${fechaCorta(invoice.issuedOn)}${invoice.dueOn ? `<br><small>vence ${fechaCorta(invoice.dueOn)}</small>` : ''}</td>
      <td data-label="Total">${money.format(invoice.amount)}</td>
      <td data-label="Cobro">${invoice.payments.length ? invoice.payments.map(payment => `${money.format(payment.amount)}${payment.method ? ` · ${escapeHtml(payment.method)}` : ''}<br><small>${fechaCorta(payment.paidOn)}</small>`).join('<br>') : '—'}</td>
      <td data-label="Estado">${escapeHtml(newArchiveStatus[invoice.status] || invoice.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No hay facturas con estos filtros.</p>'}</div></article>`;
  const bind = (id, key) => { document.getElementById(id).onchange = event => { f[key] = event.target.value; newBillingArchive(); }; };
  bind('new-archive-month', 'month'); bind('new-archive-client', 'clientId'); bind('new-archive-status', 'status');
  const clear = document.getElementById('new-archive-clear');
  if (clear) clear.onclick = () => { Object.assign(f, { month: '', status: '', clientId: '' }); newBillingArchive(); };
}
// Corregir el reparto por persona de una factura ya emitida (aunque esté pagada) SIN cambiar su total: el servidor revierte los cobros aplicados, anula la factura,
// emite una nueva con el mismo ciclo y fechas, y vuelve a aplicar los mismos cobros, todo en una sola operación.
function newBillingSplitDialog(invoice) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="new-split-form"><p class="eyebrow">FACTURAS</p><h2>Corregir reparto de ${escapeHtml(invoice.code)}</h2>
    <p class="section-note">El total de ${money.format(invoice.total)} no cambia: solo cómo se reparte entre las personas. ${invoice.paid > 0 ? `Los ${money.format(invoice.paid)} ya cobrados se vuelven a aplicar solos a la factura nueva. ` : ''}La factura actual queda anulada con su motivo y la nueva toma el siguiente número, con el mismo ciclo y fechas.</p>
    ${invoice.lines.map(line => `<label>${escapeHtml(line.beneficiaryName)}<input name="line" data-beneficiary="${line.beneficiaryClientId}" type="number" min="0.01" step="0.01" required value="${Number(line.amount).toFixed(2)}" /></label>`).join('')}
    <p class="form-summary" id="new-split-total"></p>
    <label>Motivo<input name="reason" required minlength="3" maxlength="300" value="Reparto por persona corregido" /></label>
    <button class="primary wide-button">Corregir reparto</button></form>`;
  openModal(box);
  const form = box.querySelector('form'); const summary = form.querySelector('#new-split-total');
  const inputs = [...form.querySelectorAll('[name=line]')];
  const refresh = () => {
    const sum = inputs.reduce((total, input) => total + centsOf(input.value), 0); const target = centsOf(invoice.total);
    summary.textContent = sum === target ? `Total ${money.format(sum / 100)} ✓` : `Suma ${money.format(sum / 100)}; debe seguir sumando ${money.format(target / 100)}`;
    summary.classList.toggle('error', sum !== target);
  };
  inputs.forEach(input => input.addEventListener('input', refresh)); refresh();
  form.onsubmit = async event => {
    event.preventDefault();
    const body = { reason: form.elements.reason.value, lines: inputs.map(input => ({ beneficiaryClientId: input.dataset.beneficiary, amount: Number(input.value) })) };
    try {
      form.classList.add('loading-state');
      const result = await api(`/api/billing/invoices/${invoice.id}/redistribute`, { method: 'POST', body });
      modal.close(); toast(`${result.oldCode} reemplazada por ${result.newCode}`); newBillingInvoices();
    } catch (error) { toast(error.message, true); form.classList.remove('loading-state'); }
  };
}
function newBillingVoidDialog(id, code) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="new-billing-void-form"><p class="eyebrow">FACTURAS (NUEVO)</p><h2>Anular ${escapeHtml(code)}</h2><p class="section-note">La factura queda en el historial con su número y el motivo; no se borra. Si tiene cobros aplicados, hay que revertirlos antes.</p><label>Motivo<input name="reason" required minlength="3" maxlength="300" placeholder="Ej.: capturada con el monto equivocado" /></label><button class="primary wide-button">Anular factura</button></form>`;
  openModal(box);
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    try { await api(`/api/billing/invoices/${id}/void`, { method: 'POST', body: { reason: new FormData(event.target).get('reason') } }); modal.close(); toast(`Factura ${code} anulada`); newBillingInvoices(); } catch (error) { toast(error.message, true); }
  };
}
function newBillingInvoiceDialog() {
  const clientsSorted = data.clients.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const options = (selected = '') => clientsSorted.map(client => `<option value="${client.id}"${client.id === selected ? ' selected' : ''}>${escapeHtml(client.name)}</option>`).join('');
  const today = dateKey(new Date());
  const box = document.createElement('div');
  box.innerHTML = `<form id="new-billing-form"><p class="eyebrow">FACTURAS (NUEVO)</p><h2>Nueva factura</h2>
    <label>Pagador<select name="payerClientId" required><option value="">Elige al pagador</option>${options()}</select><small>Quien paga. En una familia es uno solo; sus beneficiarios van como líneas.</small></label>
    <label>Tipo<select name="kind">${Object.entries(newBillingKinds).map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></label>
    <label>Inicio del ciclo<input name="cycleStart" type="date" value="${today}" required /></label>
    <label>Fin del ciclo<input name="cycleEnd" type="date" /><small>Vacío: el siguiente corte del pagador (o el mismo día en clases sueltas y manuales).</small></label>
    <label class="new-billing-package" hidden>Días del ciclo<input name="cycleDays" type="number" min="1" max="366" placeholder="Ej.: 35" /></label>
    <label>Fecha de emisión<input name="issuedOn" type="date" value="${today}" required /></label>
    <label>Vencimiento<input name="dueOn" type="date" /><small>Vacío: el mismo día de la emisión.</small></label>
    <p class="eyebrow" style="margin-top:14px">LÍNEAS POR BENEFICIARIO</p><div id="new-billing-lines"></div>
    <button type="button" class="secondary" id="new-billing-add-line">+ Agregar persona</button>
    <label>Notas<textarea name="notes" rows="2" maxlength="500"></textarea></label>
    <p class="form-summary" id="new-billing-total">Total: ${money.format(0)}</p>
    <button class="primary wide-button">Crear factura</button></form>`;
  openModal(box);
  const form = box.querySelector('form'); const linesBox = box.querySelector('#new-billing-lines');
  const recalc = () => {
    let total = 0;
    linesBox.querySelectorAll('.new-billing-line').forEach(row => { total += Math.round((Number(row.querySelector('[name=quantity]').value || 0) * Number(row.querySelector('[name=unitAmount]').value || 0)) * 100); });
    box.querySelector('#new-billing-total').textContent = `Total: ${money.format(total / 100)}`;
  };
  const addLine = () => {
    const row = document.createElement('div'); row.className = 'new-billing-line';
    row.innerHTML = `<select name="beneficiaryClientId" required><option value="">Beneficiario</option>${options()}</select><input name="description" placeholder="Concepto (ej.: Paquete 12 sesiones)" maxlength="200" /><label class="new-billing-field">Cantidad<input name="quantity" type="number" min="0.01" step="0.01" value="1" aria-label="Cantidad" /><small>Casi siempre 1</small></label><label class="new-billing-field">Importe por unidad (USD)<input name="unitAmount" type="number" step="0.01" placeholder="Ej.: 420" required aria-label="Importe" /><small>Lo que cuesta, ej. 420</small></label><label class="new-billing-field">Clases de referencia<input name="sessionsReference" type="number" min="1" placeholder="Opcional" aria-label="Clases de referencia" /><small>Solo informativo</small></label><button type="button" class="secondary">Quitar persona</button>`;
    row.querySelector('button').onclick = () => { if (linesBox.children.length > 1) { row.remove(); recalc(); } };
    row.addEventListener('input', recalc); linesBox.appendChild(row);
  };
  addLine();
  box.querySelector('#new-billing-add-line').onclick = addLine;
  const kind = form.elements.kind; const packageField = form.querySelector('.new-billing-package');
  kind.onchange = () => { packageField.hidden = kind.value !== 'paquete'; };
  form.elements.payerClientId.onchange = event => { const first = linesBox.querySelector('[name=beneficiaryClientId]'); if (first && !first.value) first.value = event.target.value; };
  form.onsubmit = async event => {
    event.preventDefault();
    const values = new FormData(form);
    const lines = [...linesBox.querySelectorAll('.new-billing-line')].map(row => {
      const item = { beneficiaryClientId: row.querySelector('[name=beneficiaryClientId]').value, quantity: Number(row.querySelector('[name=quantity]').value || 1), unitAmount: Number(row.querySelector('[name=unitAmount]').value) };
      const description = row.querySelector('[name=description]').value.trim(); if (description) item.description = description;
      const sessions = row.querySelector('[name=sessionsReference]').value; if (sessions) item.sessionsReference = Number(sessions);
      return item;
    });
    const body = { payerClientId: values.get('payerClientId'), kind: values.get('kind'), cycleStart: values.get('cycleStart'), issuedOn: values.get('issuedOn'), lines };
    if (values.get('cycleEnd')) body.cycleEnd = values.get('cycleEnd');
    if (values.get('dueOn')) body.dueOn = values.get('dueOn');
    if (values.get('cycleDays')) body.cycleDays = Number(values.get('cycleDays'));
    if (values.get('notes').trim()) body.notes = values.get('notes').trim();
    try { form.classList.add('loading-state'); const result = await api('/api/billing/invoices', { method: 'POST', body }); modal.close(); toast(`Factura ${result.code} creada`); newBillingInvoices(); }
    catch (error) { toast(error.message, true); form.classList.remove('loading-state'); }
  };
}
// ── Cobros del módulo nuevo (1B-3) ───────────────────────────────────────────
// COBRO = dinero recibido (no es una factura). Se aplica a una o varias facturas del
// mismo pagador; lo que no se aplica queda como saldo a favor. Un cobro no se edita ni se
// borra: una aplicación equivocada se REVIERTE y un cobro mal registrado se ANULA, ambos
// con motivo.
const newBillingMethods = ['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro'];
const newBillingPaymentStatus = { sin_aplicar: 'Sin aplicar', parcial: 'Aplicado en parte', aplicado: 'Aplicado', anulado: 'Anulado' };
const newBillingPaymentFilters = { status: 'all', payerId: '' };
const centsOf = value => Math.round(Number(value || 0) * 100);

// Lista las facturas abiertas del pagador con un campo de importe por factura. Reparte
// `getAvailable()` empezando por la más antigua; el usuario puede cambiar cualquier importe.
async function newBillingAllocator(container, payerId, getAvailable, firstInvoiceId = '') {
  container.innerHTML = '<p class="empty">Cargando facturas abiertas…</p>';
  let open = [];
  try { open = (await api(`/api/billing/invoices?status=abierta&payerId=${payerId}`)).invoices.slice().sort((a, b) => (b.id === firstInvoiceId) - (a.id === firstInvoiceId) || a.cycleStart.localeCompare(b.cycleStart) || a.number - b.number); }
  catch (error) { container.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; return { items: () => [], suggest: () => {} }; }
  if (!open.length) { container.innerHTML = '<p class="empty">Este pagador no tiene facturas abiertas: el cobro quedará como saldo a favor.</p>'; return { items: () => [], suggest: () => {} }; }
  container.innerHTML = `<div class="new-billing-allocs">${open.map(invoice => `<div class="new-billing-alloc" data-invoice="${invoice.id}">
      <div><b>${escapeHtml(invoice.code)}</b><small>${fechaCorta(invoice.cycleStart)} → ${fechaCorta(invoice.cycleEnd)} · saldo ${money.format(invoice.balance)}</small></div>
      <input type="number" min="0" max="${invoice.balance}" step="0.01" value="0" aria-label="Importe para ${escapeHtml(invoice.code)}" data-balance="${invoice.balance}" /></div>`).join('')}
    <p class="form-summary" data-alloc-summary></p></div>`;
  const inputs = [...container.querySelectorAll('input')];
  const summary = container.querySelector('[data-alloc-summary]');
  const refresh = () => {
    const used = inputs.reduce((sum, input) => sum + centsOf(input.value), 0);
    const left = centsOf(getAvailable()) - used;
    summary.textContent = `Aplicado ${money.format(used / 100)} · ${left >= 0 ? `queda como saldo a favor ${money.format(left / 100)}` : `excede lo disponible por ${money.format(-left / 100)}`}`;
    summary.classList.toggle('error', left < 0);
  };
  const suggest = () => {
    let left = centsOf(getAvailable());
    inputs.forEach(input => { const take = Math.max(0, Math.min(left, centsOf(input.dataset.balance))); input.value = take ? (take / 100).toFixed(2) : '0'; left -= take; });
    refresh();
  };
  inputs.forEach(input => input.addEventListener('input', refresh));
  suggest();
  return {
    suggest,
    items: () => inputs.map(input => ({ invoiceId: input.closest('[data-invoice]').dataset.invoice, amount: Number(input.value) })).filter(item => item.amount > 0)
  };
}

async function newBillingPayments() {
  const root = document.getElementById('cobros-nuevo-mount');
  if (!root) return;
  const payerOptions = data.clients.slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(client => `<option value="${client.id}"${client.id === newBillingPaymentFilters.payerId ? ' selected' : ''}>${escapeHtml(client.name)}</option>`).join('');
  root.innerHTML = `<article class="card"><div class="card-head"><div><h3>Cobros</h3><p id="new-payment-summary">Cargando…</p></div></div>
    <p class="section-note">Cobro = dinero recibido. Se aplica a las facturas del mismo pagador; lo que no se aplica queda como saldo a favor. Un cobro no se edita: se revierte la aplicación o se anula el cobro, con motivo.</p>
    <div class="subpanel-toolbar"><button class="primary" type="button" id="new-payment-create">+ Registrar cobro</button></div>
    <div class="billing-period-bar"><label>Estado<select id="new-payment-status">${[['all', 'Todos'], ['available', 'Con saldo a favor'], ['voided', 'Anulados']].map(([value, text]) => `<option value="${value}"${value === newBillingPaymentFilters.status ? ' selected' : ''}>${text}</option>`).join('')}</select></label>
      <label>Pagador<select id="new-payment-payer"><option value="">Todos</option>${payerOptions}</select></label></div>
    <div id="new-payment-list"><p class="empty">Cargando cobros…</p></div></article>`;
  document.getElementById('new-payment-create').onclick = () => newBillingPaymentDialog();
  document.getElementById('new-payment-status').onchange = event => { newBillingPaymentFilters.status = event.target.value; newBillingPayments(); };
  document.getElementById('new-payment-payer').onchange = event => { newBillingPaymentFilters.payerId = event.target.value; newBillingPayments(); };
  const list = document.getElementById('new-payment-list');
  try {
    const query = new URLSearchParams({ status: newBillingPaymentFilters.status });
    if (newBillingPaymentFilters.payerId) query.set('payerId', newBillingPaymentFilters.payerId);
    const result = await api(`/api/billing/payments?${query}`);
    document.getElementById('new-payment-summary').textContent = `${result.summary.count} cobros · Recibido ${money.format(result.summary.total)} · Aplicado ${money.format(result.summary.applied)} · Saldo a favor ${money.format(result.summary.available)}`;
    if (!result.payments.length) { list.innerHTML = '<p class="empty">No hay cobros con este filtro.</p>'; return; }
    list.innerHTML = `<div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Fecha</th><th>Pagador</th><th>Monto</th><th>Método</th><th>Referencia</th><th>Aplicado</th><th>Disponible</th><th>Estado</th><th></th></tr></thead><tbody>${result.payments.map(payment => `<tr>
      <td data-label="Fecha">${fechaCorta(payment.paidOn)}</td>
      <td data-label="Pagador">${escapeHtml(payment.payerName)}</td>
      <td data-label="Monto">${money.format(payment.amount)}</td>
      <td data-label="Método">${escapeHtml(payment.method)}</td>
      <td data-label="Referencia">${escapeHtml(payment.reference || '—')}</td>
      <td data-label="Aplicado">${money.format(payment.applied)}</td>
      <td data-label="Disponible">${money.format(payment.available)}</td>
      <td data-label="Estado">${escapeHtml(newBillingPaymentStatus[payment.status] || payment.status)}${payment.voidReason ? `<br><small>${escapeHtml(payment.voidReason)}</small>` : ''}</td>
      <td data-label=""><button class="secondary" type="button" data-new-payment-open="${payment.id}">${payment.status === 'anulado' ? 'Ver' : 'Aplicar / ver'}</button></td></tr>`).join('')}</tbody></table></div>`;
    list.querySelectorAll('[data-new-payment-open]').forEach(button => button.onclick = () => newBillingPaymentDetail(button.dataset.newPaymentOpen));
  } catch (error) { list.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
}

function newBillingPaymentDialog(preset = {}) {
  const clientsSorted = data.clients.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const box = document.createElement('div');
  box.innerHTML = `<form id="new-payment-form"><p class="eyebrow">COBROS (NUEVO)</p><h2>Registrar cobro</h2>
    <label>Pagador<select name="payerClientId" required><option value="">Elige al pagador</option>${clientsSorted.map(client => `<option value="${client.id}">${escapeHtml(client.name)}</option>`).join('')}</select><small>Quien entregó el dinero. En una familia es quien paga por todos.</small></label>
    <label>Fecha del cobro<input name="paidOn" type="date" value="${dateKey(new Date())}" required /></label>
    <label>Monto recibido (USD)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
    <label>Método<select name="method">${newBillingMethods.map(method => `<option>${method}</option>`).join('')}</select></label>
    <label>Referencia<input name="reference" maxlength="160" placeholder="Opcional: número de transferencia, Yappy…" /></label>
    <label>Notas<textarea name="notes" rows="2" maxlength="500"></textarea></label>
    <p class="eyebrow" style="margin-top:14px">APLICAR A FACTURAS ABIERTAS</p><div id="new-payment-allocator"><p class="empty">Elige primero al pagador.</p></div>
    <button class="primary wide-button">Registrar cobro</button></form>`;
  openModal(box);
  const form = box.querySelector('form'); const allocatorBox = box.querySelector('#new-payment-allocator');
  let allocator = { items: () => [], suggest: () => {} };
  const loadAllocator = async () => { allocator = form.elements.payerClientId.value ? await newBillingAllocator(allocatorBox, form.elements.payerClientId.value, () => form.elements.amount.value, preset.invoiceId) : { items: () => [], suggest: () => {} }; };
  form.elements.payerClientId.onchange = loadAllocator;
  if (preset.payerId) { form.elements.payerClientId.value = preset.payerId; if (preset.amount) form.elements.amount.value = Number(preset.amount).toFixed(2); loadAllocator(); }
  form.elements.amount.addEventListener('input', () => allocator.suggest());
  form.onsubmit = async event => {
    event.preventDefault();
    const values = new FormData(form);
    const body = { payerClientId: values.get('payerClientId'), paidOn: values.get('paidOn'), amount: Number(values.get('amount')), method: values.get('method') };
    if (values.get('reference').trim()) body.reference = values.get('reference').trim();
    if (values.get('notes').trim()) body.notes = values.get('notes').trim();
    const applications = allocator.items(); if (applications.length) body.applications = applications;
    try { form.classList.add('loading-state'); const result = await api('/api/billing/payments', { method: 'POST', body }); modal.close(); toast(`Cobro registrado${result.available > 0 ? ` · saldo a favor ${money.format(result.available)}` : ''}`); if (document.getElementById('subpanel-facturas-nuevo')?.classList.contains('active')) newBillingInvoices(); else newBillingPayments(); }
    catch (error) { toast(error.message, true); form.classList.remove('loading-state'); }
  };
}

async function newBillingPaymentDetail(id) {
  let payment;
  try { payment = await api(`/api/billing/payments/${id}`); } catch (error) { return toast(error.message, true); }
  const box = document.createElement('div');
  const active = payment.applications.filter(item => !item.reversedAt);
  box.innerHTML = `<div><p class="eyebrow">COBROS (NUEVO)</p><h2>${money.format(payment.amount)} · ${escapeHtml(payment.payerName)}</h2>
    <p class="form-summary">${fechaCorta(payment.paidOn)} · ${escapeHtml(payment.method)}${payment.reference ? ` · ${escapeHtml(payment.reference)}` : ''}<br>${escapeHtml(newBillingPaymentStatus[payment.status] || payment.status)} · aplicado ${money.format(payment.applied)} · disponible ${money.format(payment.available)}${payment.voidReason ? `<br>Anulado: ${escapeHtml(payment.voidReason)}` : ''}</p>
    <p class="eyebrow" style="margin-top:14px">APLICACIONES</p>
    ${payment.applications.length ? `<div class="new-billing-allocs">${payment.applications.map(item => `<div class="new-billing-alloc"><div><b>${escapeHtml(item.invoiceCode)}</b><small>${money.format(item.amount)} · ${fechaCorta(item.appliedOn)}${item.reversedAt ? ` · revertida: ${escapeHtml(item.reversalReason || '')}` : ''}</small></div>${item.reversedAt ? '<span></span>' : `<button type="button" class="secondary" data-reverse="${item.id}" data-code="${escapeHtml(item.invoiceCode)}">Revertir</button>`}</div>`).join('')}</div>` : '<p class="empty">Todavía no se aplicó a ninguna factura.</p>'}
    ${payment.status !== 'anulado' && payment.available > 0 ? `<p class="eyebrow" style="margin-top:14px">APLICAR EL SALDO A FAVOR (${money.format(payment.available)})</p><div id="new-payment-detail-alloc"></div><button class="primary wide-button" type="button" id="new-payment-apply">Aplicar</button>` : ''}
    ${payment.status !== 'anulado' && !active.length ? '<button class="secondary wide-button" type="button" id="new-payment-void" style="margin-top:12px">Anular este cobro</button>' : ''}</div>`;
  openModal(box);
  const refreshAll = () => { modal.close(); newBillingPayments(); };
  box.querySelectorAll('[data-reverse]').forEach(button => button.onclick = () => newBillingReasonDialog(`Revertir la aplicación a ${button.dataset.code}`, 'Revertir aplicación', async reason => {
    await api(`/api/billing/payment-applications/${button.dataset.reverse}/reverse`, { method: 'POST', body: { reason } }); toast('Aplicación revertida'); refreshAll();
  }));
  const voidButton = box.querySelector('#new-payment-void');
  if (voidButton) voidButton.onclick = () => newBillingReasonDialog('Anular el cobro', 'Anular cobro', async reason => {
    await api(`/api/billing/payments/${id}/void`, { method: 'POST', body: { reason } }); toast('Cobro anulado'); refreshAll();
  });
  const allocBox = box.querySelector('#new-payment-detail-alloc');
  if (allocBox) {
    const allocator = await newBillingAllocator(allocBox, payment.payerClientId, () => payment.available);
    box.querySelector('#new-payment-apply').onclick = async () => {
      const applications = allocator.items();
      if (!applications.length) return toast('Indica el importe de al menos una factura', true);
      try { await api(`/api/billing/payments/${id}/applications`, { method: 'POST', body: { applications } }); toast('Cobro aplicado'); refreshAll(); } catch (error) { toast(error.message, true); }
    };
  }
}

function newBillingReasonDialog(title, action, onSubmit) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="new-billing-reason-form"><p class="eyebrow">COBROS (NUEVO)</p><h2>${escapeHtml(title)}</h2><p class="section-note">Queda en el historial con su motivo; nada se borra.</p><label>Motivo<input name="reason" required minlength="3" maxlength="300" placeholder="Ej.: se aplicó a la factura equivocada" /></label><button class="primary wide-button">${escapeHtml(action)}</button></form>`;
  openModal(box);
  box.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    try { await onSubmit(new FormData(event.target).get('reason')); } catch (error) { toast(error.message, true); }
  };
}
// ── Próximas facturas (1B-6) ─────────────────────────────────────────────────
// Lo que el generador emitirá en los próximos 35 días y las alertas que impedirían emitir bien (cliente con cobro sin plan, pagador sin factura
// de referencia, línea que se perdería de una factura, ciclo atrasado). Es la pantalla de vigilancia de todos los días; el corte y la carga inicial ya se hicieron.
const newCutoverKinds = { monthly: 'Mensualidad', credit: 'A crédito', package: 'Paquete', mensual: 'Mensualidad', credito: 'A crédito', paquete: 'Paquete' };
const newCutoverPlanStatus = { emitir: 'Se emite hoy', programada: 'Programada', omitida: 'Omitida (se crea a mano)', sin_cargo: 'Sin cargo', sin_referencia: 'Sin factura previa' };
const newUpcomingAlertKeys = ['plans', 'reference', 'dropped-lines', 'omitted'];
function newCutoverItemText(item) {
  return Object.entries(item).map(([key, value]) => {
    if (typeof value === 'number') return /price|amount/i.test(key) ? money.format(value) : String(value);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return fechaCorta(value);
    return newCutoverKinds[value] || String(value ?? '');
  }).filter(Boolean).join(' · ');
}

async function newBillingUpcoming() {
  const root = document.getElementById('proximas-mount');
  if (!root) return;
  root.innerHTML = '<article class="card"><p class="empty">Cargando…</p></article>';
  try {
    const [readiness, plan] = await Promise.all([api('/api/billing/cutover/readiness'), api('/api/billing/generation/plan?horizon=35')]);
    const engine = readiness.engine;
    const alerts = readiness.checks.filter(check => newUpcomingAlertKeys.includes(check.key) && check.status !== 'ok');
    const toIssue = plan.plan.filter(item => item.status === 'emitir').length;
    const scheduled = plan.plan.filter(item => item.status === 'programada').length;
    root.innerHTML = `<article class="card"><div class="card-head"><div><h3>Próximas facturas</h3><p>${toIssue} se emiten hoy · ${scheduled} programadas en los próximos ${plan.horizon} días · ${fechaCorta(readiness.today)}</p></div></div>
      ${engine.state === 'new' ? '' : `<p class="form-summary error"><b>Atención:</b> el generador nuevo no está activo (estado ${escapeHtml(engine.state)}). Lo que ves es solo una vista previa.</p>`}
      ${(() => { const enPausa = data.clients.filter(client => client.statusRaw === 'paused'); return enPausa.length ? `<p class="eyebrow">EN PAUSA</p><div class="new-billing-allocs">${enPausa.map(client => `<div class="new-billing-alloc" style="grid-template-columns:1fr"><div><b>${estadoPausaChip('En pausa')} ${escapeHtml(client.name)}</b><small>Sin facturación mientras dure la pausa. Al reanudar, su día de corte se corre tantos días como duró y el ciclo sigue donde se detuvo. (A crédito: se factura lo ya dado al cerrar el ciclo.)</small></div></div>`).join('')}</div>` : ''; })()}
      <p class="eyebrow">ALERTAS</p>
      ${alerts.length ? `<div class="new-billing-allocs">${alerts.map(check => `<div class="new-billing-alloc" style="grid-template-columns:1fr"><div><b>${check.status === 'warn' ? '!' : '✗'} ${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail)}</small>${check.items?.length ? `<small>${check.items.slice(0, 12).map(item => escapeHtml(newCutoverItemText(item))).join('<br>')}${check.items.length > 12 ? `<br>… y ${check.items.length - 12} más` : ''}</small>` : ''}</div></div>`).join('')}</div>` : '<p class="form-summary">✓ Todo en orden: cada cliente con cobro tiene su plan, cada pagador su factura de referencia y no hay ciclos atrasados.</p>'}
      <p class="eyebrow" style="margin-top:14px">LO QUE EMITIRÁ EL GENERADOR (PRÓXIMOS ${plan.horizon} DÍAS)</p>
      ${plan.plan.length ? `<div class="table-wrap"><table class="stack-mobile"><thead><tr><th>Emisión</th><th>Pagador</th><th>Modalidad</th><th>Ciclo</th><th>Líneas</th><th>Total</th><th>Estado</th></tr></thead><tbody>${plan.plan.map(item => `<tr><td data-label="Emisión">${item.status === 'sin_referencia' ? '—' : fechaCorta(item.kind === 'credito' ? item.cycleEnd : item.cycleStart)}</td><td data-label="Pagador">${escapeHtml(item.payerName)}</td><td data-label="Modalidad">${escapeHtml(newCutoverKinds[item.kind] || item.kind)}</td><td data-label="Ciclo">${item.status === 'sin_referencia' ? '—' : `${fechaCorta(item.cycleStart)} → ${fechaCorta(item.cycleEnd)}`}</td><td data-label="Líneas">${item.lines.map(line => `${escapeHtml(line.beneficiaryName)}: ${money.format(line.amount)}`).join('<br>') || '—'}</td><td data-label="Total">${money.format(item.total)}</td><td data-label="Estado">${escapeHtml(newCutoverPlanStatus[item.status] || item.status)}${item.reason ? `<br><small>${escapeHtml(item.reason)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No hay nada programado en este período.</p>'}
      <p class="section-note">El generador corre solo, cada 15 minutos, y emite las facturas <b>únicamente el mismo día del corte</b>. Si alguna no salió ese día, queda como "Omitida (se crea a mano)" y se crea en Facturas. Las a crédito (Julio) se emiten el último día del mes, <b>desde las 21:00</b>, con las clases que Eileen ya marcó en Asistencia: hay que marcar las del día antes de esa hora.</p>
      <div class="subpanel-toolbar"><button class="secondary" type="button" id="new-upcoming-run"${engine.newWrites ? '' : ' disabled'}>Generar ahora lo que toca hoy</button></div></article>`;
    const run = document.getElementById('new-upcoming-run');
    if (run && engine.newWrites) run.onclick = async () => {
      run.disabled = true;
      try { const result = await api('/api/billing/generation/run', { method: 'POST', body: {} }); toast(`${result.created.length} factura(s) generada(s)`); newBillingUpcoming(); } catch (error) { toast(error.message, true); run.disabled = false; }
    };
  } catch (error) { root.innerHTML = `<article class="card"><p class="empty">${escapeHtml(error.message)}</p></article>`; }
}
function addDaysIso(iso, days) { const base = new Date(`${iso}T12:00:00Z`); base.setUTCDate(base.getUTCDate() + days); return base.toISOString().slice(0, 10); }

// dd-mm-aaaa y hora de 12 h (a. m./p. m.) en horario de Panamá, sin depender del idioma del navegador.
function fechaHoraPanama(value, withTime = true) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '';
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).split('-');
  if (!withTime) return `${d}-${m}-${y}`;
  const hora = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Panama', hour: 'numeric', minute: '2-digit', hour12: true }).format(date).replace('AM', 'a. m.').replace('PM', 'p. m.');
  return `${d}-${m}-${y} ${hora}`;
}
function horaPanama(value) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Panama', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

// ── Reportes del módulo nuevo (1B-5) ─────────────────────────────────────────
// Estado de cuenta por pagador, cuentas por cobrar con antigüedad, cobrado por mes y método, morosidad con los beneficiarios
// afectados, pagos sin aplicar y la bitácora. Todo sale de las tablas nuevas; los CSV y el PDF se descargan con la sesión.
const newReportState = { report: 'receivables', payerId: '', from: '', to: '', year: '', asOf: '' };
const newReportOptions = [['receivables', 'Cuentas por cobrar'], ['statement', 'Estado de cuenta por pagador'], ['collections', 'Cobrado por mes y método'], ['delinquency', 'Morosidad'], ['unapplied', 'Pagos sin aplicar'], ['audit', 'Bitácora de cambios']];
const newAgingLabels = { al_dia: 'Al día', '1-7': '1 a 7 días', '8-30': '8 a 30 días', '31+': 'Más de 30 días' };

async function newBillingDownload(path, filename) {
  try {
    const response = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!response.ok) throw new Error('No se pudo generar el archivo');
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = blobUrl; link.download = filename; link.click(); URL.revokeObjectURL(blobUrl);
  } catch (error) { toast(error.message, true); }
}

async function newBillingReports() {
  const root = document.getElementById('reportes-nuevo-mount');
  if (!root) return;
  const hoy = dateKey(new Date());
  if (!newReportState.to) { newReportState.to = hoy; newReportState.from = dateKey(new Date(Date.now() - 180 * 86_400_000)); newReportState.year = hoy.slice(0, 4); newReportState.asOf = hoy; }
  const payers = data.clients.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!newReportState.payerId && payers[0]) newReportState.payerId = payers[0].id;
  root.innerHTML = `<article class="card"><div class="card-head"><div><h3>Reportes</h3><p id="new-report-summary">Cargando…</p></div></div>
    <p class="section-note">Salen solo de las facturas y cobros del módulo nuevo. Los importes están en USD y las fechas en dd-mm-aaaa.</p>
    <div class="billing-period-bar"><label>Reporte<select id="new-report-kind">${newReportOptions.map(([value, text]) => `<option value="${value}"${value === newReportState.report ? ' selected' : ''}>${text}</option>`).join('')}</select></label>
      ${newReportState.report === 'statement' ? `<label>Pagador<select id="new-report-payer">${payers.map(client => `<option value="${client.id}"${client.id === newReportState.payerId ? ' selected' : ''}>${escapeHtml(client.name)}</option>`).join('')}</select></label><label>Desde<input type="date" id="new-report-from" value="${newReportState.from}" /></label><label>Hasta<input type="date" id="new-report-to" value="${newReportState.to}" /></label>` : ''}
      ${newReportState.report === 'receivables' ? `<label>Al día<input type="date" id="new-report-asof" value="${newReportState.asOf}" /></label>` : ''}
      ${newReportState.report === 'collections' ? `<label>Año<input type="number" id="new-report-year" min="2020" max="2100" value="${newReportState.year}" /></label>` : ''}</div>
    <div class="subpanel-toolbar" id="new-report-actions"></div><div id="new-report-body"><p class="empty">Cargando…</p></div></article>`;
  const rerender = () => newBillingReports();
  document.getElementById('new-report-kind').onchange = event => { newReportState.report = event.target.value; rerender(); };
  const bind = (id, key) => { const element = document.getElementById(id); if (element) element.onchange = event => { newReportState[key] = event.target.value; rerender(); }; };
  bind('new-report-payer', 'payerId'); bind('new-report-from', 'from'); bind('new-report-to', 'to'); bind('new-report-asof', 'asOf'); bind('new-report-year', 'year');
  const body = document.getElementById('new-report-body'); const summary = document.getElementById('new-report-summary'); const actions = document.getElementById('new-report-actions');
  const button = (text, onClick) => { const element = document.createElement('button'); element.type = 'button'; element.className = 'secondary'; element.textContent = text; element.onclick = onClick; actions.appendChild(element); };
  const table = (head, rows) => rows.length ? `<div class="table-wrap"><table class="stack-mobile"><thead><tr>${head.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map((cell, index) => `<td data-label="${head[index]}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">No hay datos para este reporte.</p>';
  try {
    if (newReportState.report === 'receivables') {
      const r = await api(`/api/billing/reports/receivables?asOf=${newReportState.asOf}`);
      summary.textContent = `${r.rows.length} facturas con saldo · Total por cobrar ${money.format(r.total)}`;
      button('Descargar CSV', () => newBillingDownload(`/api/billing/reports/receivables?asOf=${newReportState.asOf}&format=csv`, `cuentas-por-cobrar-${newReportState.asOf}.csv`));
      body.innerHTML = `<div class="metrics" style="grid-template-columns:repeat(2,1fr)">${r.buckets.map(bucket => `<article><span>${newAgingLabels[bucket.bucket]}</span><strong>${money.format(bucket.balance)}</strong><small>${bucket.count} factura(s)</small></article>`).join('')}</div>` +
        table(['Pagador', 'Factura', 'Ciclo', 'Vence', 'Total', 'Pagado', 'Saldo', 'Antigüedad'], r.rows.map(row => [escapeHtml(row.payer), escapeHtml(row.code), `${fechaCorta(row.cycleStart)} → ${fechaCorta(row.cycleEnd)}`, fechaCorta(row.dueOn), money.format(row.total), money.format(row.paid), money.format(row.balance), `${newAgingLabels[row.bucket]}${row.daysOverdue ? ` · ${row.daysOverdue} d` : ''}`]));
    } else if (newReportState.report === 'statement') {
      const query = `from=${newReportState.from}&to=${newReportState.to}`;
      const r = await api(`/api/billing/accounts/${newReportState.payerId}/statement?${query}`);
      summary.textContent = `${r.client.full_name} · Facturado ${money.format(r.totals.invoiced)} · Cobrado ${money.format(r.totals.received)} · Saldo ${money.format(r.totals.balance)}`;
      button('Ver PDF', () => previewProtectedPdf(`/api/billing/accounts/${newReportState.payerId}/statement?${query}&format=pdf`, `Estado de cuenta · ${r.client.full_name}`, `estado-de-cuenta-${newReportState.from}-${newReportState.to}.pdf`));
      button('Descargar CSV', () => newBillingDownload(`/api/billing/accounts/${newReportState.payerId}/statement?${query}&format=csv`, `estado-de-cuenta-${newReportState.from}-${newReportState.to}.csv`));
      body.innerHTML = '<p class="eyebrow">FACTURAS</p>' + table(['Fecha', 'Factura', 'Concepto', 'Facturado', 'Pagado', 'Saldo'], r.rows.map(row => [fechaCorta(row.issued_on), escapeHtml(row.invoice_number), escapeHtml(row.concept), money.format(row.amount), money.format(row.paid_amount), money.format(row.balance_amount)])) +
        '<p class="eyebrow" style="margin-top:14px">COBROS</p>' + table(['Fecha', 'Método', 'Referencia', 'Monto', 'Aplicado', 'A favor'], r.payments.map(row => [fechaCorta(row.paid_on), escapeHtml(row.method), escapeHtml(row.reference || '—'), money.format(row.amount), money.format(row.applied), money.format(row.available)]));
    } else if (newReportState.report === 'collections') {
      const r = await api(`/api/billing/reports/collections?year=${newReportState.year}`);
      summary.textContent = `${r.year} · Cobrado ${money.format(r.total)}`;
      button('Descargar CSV', () => newBillingDownload(`/api/billing/reports/collections?year=${newReportState.year}&format=csv`, `cobrado-${newReportState.year}.csv`));
      body.innerHTML = table(['Mes', 'Cobros', 'Total', 'Por método'], r.months.map(row => [escapeHtml(row.month.split('-').reverse().join('-')), String(row.count), money.format(row.total), Object.entries(row.methods).map(([method, total]) => `${escapeHtml(method)}: ${money.format(total)}`).join('<br>')]));
    } else if (newReportState.report === 'delinquency') {
      const r = await api('/api/billing/reports/delinquency');
      summary.textContent = `${r.payers.length} pagador(es) con pago pendiente · ${money.format(r.total)} por cobrar`;
      body.innerHTML = table(['Pagador', 'Pago pendiente', 'Más antigua', 'Facturas', 'Beneficiarios afectados'], r.payers.map(row => [escapeHtml(row.payer), money.format(row.balance), `${row.oldestDays} días`, row.invoices.map(invoice => `${escapeHtml(invoice.code)} (${fechaCorta(invoice.dueOn)})`).join('<br>'), row.beneficiaries.length ? row.beneficiaries.map(escapeHtml).join(', ') : '—']));
    } else if (newReportState.report === 'unapplied') {
      const r = await api('/api/billing/payments?status=available');
      summary.textContent = `${r.payments.length} cobro(s) con saldo a favor · ${money.format(r.summary.available)}`;
      body.innerHTML = table(['Fecha', 'Pagador', 'Monto', 'Método', 'Aplicado', 'A favor'], r.payments.map(row => [fechaCorta(row.paidOn), escapeHtml(row.payerName), money.format(row.amount), escapeHtml(row.method), money.format(row.applied), money.format(row.available)]));
    } else {
      const r = await api('/api/billing/audit?limit=100');
      summary.textContent = `Últimos ${r.entries.length} cambios`;
      body.innerHTML = table(['Fecha y hora', 'Acción', 'Quién', 'Detalle'], r.entries.map(row => [escapeHtml(fechaHoraPanama(row.at)), escapeHtml(row.action), escapeHtml(row.user), `<small style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(JSON.stringify(row.detail).slice(0, 160))}</small>`]));
    }
  } catch (error) { body.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; summary.textContent = ''; }
}
// Sub-pestañas del área financiera: Cobros / Finanzas / Planes / Gastos.
// Cada dataset en su propia pantalla, para no amontonar todo en una sola página
// —sobre todo en el teléfono—. Finanzas y Gastos se pintan al abrir su pestaña.
function activarSubtab(nombre) {
  document.querySelectorAll('#billing .subtab').forEach(boton => boton.classList.toggle('active', boton.dataset.subtab === nombre));
  document.querySelectorAll('#billing .subpanel').forEach(panel => panel.classList.toggle('active', panel.id === `subpanel-${nombre}`));
  if (nombre === 'facturas-nuevo') newBillingInvoices();
  if (nombre === 'cobros-nuevo') newBillingPayments();
  if (nombre === 'proximas') newBillingUpcoming();
  if (nombre === 'reportes-nuevo') newBillingReports();
  if (nombre === 'archivo') newBillingArchive();
  if (nombre === 'finanzas') financeDashboard();
  if (nombre === 'gastos') expensesManager();
}
document.getElementById('billing-subtabs')?.addEventListener('click', event => {
  const boton = event.target.closest('[data-subtab]');
  if (boton) activarSubtab(boton.dataset.subtab);
});
// Arrastrar, en pantalla grande. Es el mismo gesto que en Google y termina en
// el mismo diálogo que el de tocar: una sola forma de confirmar.
document.addEventListener('dragstart', event => {
  const chip = event.target.closest?.('[data-mover-sesion]');
  if (!chip) return;
  event.dataTransfer.setData('text/plain', chip.dataset.moverSesion);
  event.dataTransfer.effectAllowed = 'move';
  chip.classList.add('moviendo');
});
document.addEventListener('dragend', event => {
  event.target.closest?.('[data-mover-sesion]')?.classList.remove('moviendo');
});
document.addEventListener('dragover', event => {
  const dia = event.target.closest?.('[data-calendar-date]');
  if (!dia) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  dia.classList.add('destino-posible');
});
document.addEventListener('dragleave', event => {
  event.target.closest?.('[data-calendar-date]')?.classList.remove('destino-posible');
});
document.addEventListener('drop', event => {
  const dia = event.target.closest?.('[data-calendar-date]');
  if (!dia) return;
  event.preventDefault();
  dia.classList.remove('destino-posible');
  const sesion = data.sessions.find(item => item.id === event.dataTransfer.getData('text/plain'));
  sesionAMover = null; renderCalendar();
  if (sesion && sesion.date !== dia.dataset.calendarDate) moverSesionA(sesion, dia.dataset.calendarDate);
});
window.addEventListener('popstate', () => { if (currentUser?.role !== 'client') view(viewFromHash()); });
window.addEventListener('hashchange', () => { if (currentUser?.role !== 'client') view(viewFromHash()); });
document.addEventListener('click', event => {
  const actionButton = event.target.closest('[data-action]');
  const invoicePdfButton = event.target.closest('[data-invoice-pdf]');
  const editSessionButton = event.target.closest('[data-edit-session]');
  const calendarModeButton = event.target.closest('[data-calendar-mode]');
  const calendarShiftButton = event.target.closest('[data-calendar-shift]');
  const calendarDateButton = event.target.closest('[data-calendar-date]');
  // Tocar una clase la pone "en la mano"; el siguiente toque en un día la
  // mueve allí. Tiene que salir antes que el manejador del día, o el propio
  // toque que la coge saltaría también al día donde ya estaba.
  const chipSesion = event.target.closest('[data-mover-sesion]');
  if (chipSesion) {
    event.preventDefault(); event.stopPropagation();
    const sesion = data.sessions.find(item => item.id === chipSesion.dataset.moverSesion);
    if (!sesion || sesion.status !== 'scheduled') { toast('Sólo se pueden mover las clases programadas'); return; }
    sesionAMover = sesionAMover === sesion.id ? null : sesion.id;
    renderCalendar();
    return;
  }
  if (event.target.closest('#calendar-mover-cancelar')) { sesionAMover = null; renderCalendar(); return; }
  if (calendarDateButton && sesionAMover) {
    event.preventDefault();
    const sesion = data.sessions.find(item => item.id === sesionAMover);
    const destino = calendarDateButton.dataset.calendarDate;
    sesionAMover = null; renderCalendar();
    if (sesion && sesion.date !== destino) moverSesionA(sesion, destino);
    return;
  }
  if (calendarModeButton) { calendarMode = calendarModeButton.dataset.calendarMode; renderCalendar(); }
  if (calendarShiftButton) {
    const amount = Number(calendarShiftButton.dataset.calendarShift);
    if (calendarMode === 'month') { calendarCursor.setDate(1); calendarCursor.setMonth(calendarCursor.getMonth() + amount); }
    else calendarCursor.setDate(calendarCursor.getDate() + amount * (calendarMode === 'week' ? 7 : 1));
    renderCalendar();
  }
  if (event.target.closest('[data-calendar-today]')) { calendarCursor = new Date(today); calendarCursor.setHours(12, 0, 0, 0); renderCalendar(); }
  // La tira de días de la lista mueve el mismo cursor que el calendario, para
  // que "el día seleccionado" sea una sola cosa y no dos que se contradicen.
  const diaLista = event.target.closest('[data-session-day]');
  if (diaLista) { calendarCursor = new Date(`${diaLista.dataset.sessionDay}T12:00:00`); renderCalendar(); }
  const semanaLista = event.target.closest('[data-session-week]');
  if (semanaLista) {
    calendarCursor.setDate(calendarCursor.getDate() + Number(semanaLista.dataset.sessionWeek) * 7);
    renderCalendar();
  }
  if (calendarDateButton) { calendarCursor = new Date(`${calendarDateButton.dataset.calendarDate}T12:00:00`); calendarMode = 'day'; renderCalendar(); }
  if (actionButton?.dataset.action === 'new-client') newClient();
  if (actionButton?.dataset.action === 'new-invoice') newInvoice();
  if (actionButton?.dataset.action === 'new-session') newSession();
  if (actionButton?.dataset.action === 'new-routine') newRoutine();
  if (actionButton?.dataset.action === 'exercise-catalog') exerciseCatalogManager();
  if (actionButton?.dataset.action === 'daily-log') dailyTrainingLog();
  if (actionButton?.dataset.action === 'recurrences') recurrenceManager();
  if (actionButton?.dataset.action === 'working-hours') workingHoursEditor();
  if (actionButton?.dataset.action === 'cancel-guide') guiaDeCancelaciones();
  if (actionButton?.dataset.action === 'pending-collections') pendingCollections();
  if (actionButton?.dataset.action === 'audit-log') auditLog();
  if (actionButton?.dataset.action === 'compliance-report') complianceReport();
  if (actionButton?.dataset.action === 'new-plan') planEditor();
  if (actionButton?.dataset.action === 'export-compliance') exportCompliance();
  if (actionButton?.dataset.action === 'informe-mensual') informeMensual();
  if (actionButton?.dataset.action === 'account-statement') financialReportDialog('account-statement');
  if (actionButton?.dataset.action === 'accounts-receivable') financialReportDialog('accounts-receivable');
  if (invoicePdfButton) previewProtectedPdf(`/api/invoices/${invoicePdfButton.dataset.invoicePdf}/pdf`, `Comprobante ${invoicePdfButton.dataset.invoiceNumber}`, `comprobante-${invoicePdfButton.dataset.invoiceNumber}.pdf`);
  if (editSessionButton) editSessionSchedule(data.sessions.find(session => session.id === editSessionButton.dataset.editSession));
  if (event.target.dataset.editPlan) planEditor(data.plans.find(plan => plan.id === event.target.dataset.editPlan));
  if (event.target.dataset.client) clientDetail(event.target.dataset.client);
  if (event.target.dataset.editClient) editClient(data.clients.find(client => client.id === event.target.dataset.editClient));
  if (event.target.dataset.editRoutine) newRoutine(data.routines.find(routine => routine.id === event.target.dataset.editRoutine));
  if (event.target.dataset.duplicateRoutine) newRoutine(data.routines.find(routine => routine.id === event.target.dataset.duplicateRoutine), true);
  if (event.target.dataset.openRoutine) routineDetail(data.routines.find(routine => routine.id === event.target.dataset.openRoutine));
  if (event.target.dataset.deleteRoutine) {
    const rutina = data.routines.find(item => item.id === event.target.dataset.deleteRoutine);
    const enUso = Number(rutina?.deliveryCount || 0) > 0 || Number(rutina?.clients || 0) > 0;
    deleteResource(`/api/routines/${event.target.dataset.deleteRoutine}`, enUso ? 'Esta rutina ya tiene historial. Se archivará y dejará de estar vigente; sus envíos y cumplimientos se conservarán.' : '¿Eliminar esta rutina? Las sesiones ya realizadas conservarán su historial.', enUso ? 'Rutina archivada' : 'Rutina eliminada');
  }
  if (event.target.dataset.inbody) inbodyImport(data.clients.find(client => client.id === event.target.dataset.inbody));
  if (event.target.dataset.completeSession) completeSession(event.target.dataset.completeSession);
  if (event.target.dataset.confirmInvoice) confirmInvoice(event.target.dataset.confirmInvoice);
  if (event.target.dataset.editPayment) confirmInvoice(event.target.dataset.editPayment, true);
  if (event.target.dataset.editInvoice) editInvoice(event.target.dataset.editInvoice);
  if (event.target.dataset.recalculateInvoice) recalculateCreditInvoice(event.target.dataset.recalculateInvoice);
  if (event.target.dataset.applyCoverage) applyInvoiceCoverage(event.target.dataset.applyCoverage);
  if (event.target.dataset.applyPackage) applyInvoicePackage(event.target.dataset.applyPackage);
  if (event.target.dataset.colocarReposicion) colocarReposicion(data.clients.find(c => c.id === event.target.dataset.colocarReposicion));
  if (event.target.dataset.reactivarSesion) {
    const sesion = data.sessions.find(item => item.id === event.target.dataset.reactivarSesion);
    const reprogramada = sesion?.cancellationKind === 'rescheduled';
    const aviso = reprogramada
      ? `Esta cancelación de ${sesion?.client} está marcada como reprogramada.\n\nReactivarla podría dejar dos clases si ya creaste la de reemplazo. Si no la creaste, primero edita la cancelación a «No, perdió la clase».`
      : `¿Reactivar la clase de ${sesion?.client} del ${sesion?.date} a las ${sesion?.time}?\n\nVuelve a estar programada y se deshace la cancelación: se devuelve la clase al paquete o se retira el crédito pendiente.`;
    if (confirm(aviso)) {
      api(`/api/sessions/${event.target.dataset.reactivarSesion}/reactivate`, { method: 'POST' })
        .then(async () => { await loadData(); renderAll(); toast('Clase reactivada'); })
        .catch(error => toast(error.message, true));
    }
  }
  if (event.target.dataset.purgeSession) {
    const sesion = data.sessions.find(item => item.id === event.target.dataset.purgeSession);
    const cancelada = sesion?.status === 'cancelled';
    const aviso = cancelada
      ? `¿Quitar de la agenda la sesión cancelada de ${sesion?.client} del ${sesion?.date}?\n\nDesaparece del historial y del contador de canceladas. No deja rastro.`
      : `¿Eliminar la sesión de ${sesion?.client} del ${sesion?.date} a las ${sesion?.time}?\n\nDesaparece de la agenda y de Google Calendar. No cuenta como incumplida: úsalo cuando se agendó por error.`;
    if (confirm(aviso)) {
      api(`/api/sessions/${event.target.dataset.purgeSession}/permanent`, { method: 'DELETE' })
        .then(async () => { await loadData(); renderAll(); toast('Sesión quitada de la agenda'); })
        .catch(error => toast(error.message, true));
    }
  }
  if (event.target.dataset.borrarPaquete) {
    if (confirm('¿Eliminar este saldo de sesiones?\n\nSólo se puede si nadie lo ha usado. El cobro que lo originó no se borra.')) {
      api(`/api/packages/${event.target.dataset.borrarPaquete}`, { method: 'DELETE' })
        .then(async () => { await loadData(); renderAll(); toast('Saldo eliminado'); if (modal.open) modal.close(); })
        .catch(error => toast(error.message, true));
    }
  }
  if (event.target.dataset.purgeInvoice) {
    const factura = data.invoices.find(item => item.id === event.target.dataset.purgeInvoice);
    // Un cobro ya cobrado se lleva por delante el pago, y con él el ingreso
    // que figura en finanzas. El aviso lo dice antes, no después.
    const cobrado = factura?.status === 'confirmed';
    const aviso = cobrado
      ? `¿Borrar definitivamente "${factura?.concept}" de ${factura?.client}?\n\nEstá confirmado como PAGADO: se borra también el pago registrado y ese ingreso desaparece de finanzas. Esto no deja rastro.\n\nÚsalo sólo para cobros de prueba o duplicados por error. Para un cobro real está Anular.`
      : `¿Borrar definitivamente "${factura?.concept}" de ${factura?.client}?\n\nEsto no deja rastro. Úsalo sólo para cobros de prueba o duplicados por error, nunca para un cobro real: para eso está Anular.`;
    if (confirm(aviso)) {
      api(`/api/invoices/${event.target.dataset.purgeInvoice}/permanent${cobrado ? '?force=true' : ''}`, { method: 'DELETE' })
        .then(async resultado => {
          await loadData(); renderAll();
          const partes = ['Cobro borrado'];
          if (resultado.pagosBorrados) partes.push('con su pago');
          if (resultado.saldoBorrado) partes.push('y su saldo de sesiones');
          toast(partes.join(' '));
        })
        .catch(error => toast(error.message, true));
    }
  }
  if (event.target.dataset.deleteInvoice) deleteResource(`/api/invoices/${event.target.dataset.deleteInvoice}`, '¿Anular este cobro? No se eliminará de los reportes históricos.', 'Cobro anulado');
  if (event.target.dataset.viewInbody) {
    // Sin await: este manejador no es async y usarlo aquí rompe el archivo
    // entero al interpretarse, no sólo esta línea.
    const documentId = event.target.dataset.viewInbody;
    api(`/api/documents?clientId=${encodeURIComponent(event.target.dataset.inbodyClient)}`)
      .then(documentos => {
        const archivo = documentos.find(item => item.id === documentId);
        if (archivo) viewDocument(archivo); else toast('El archivo original ya no está en el expediente', true);
      })
      .catch(error => toast(error.message, true));
  }
  if (event.target.dataset.deleteInbody) deleteResource(`/api/inbody/${event.target.dataset.deleteInbody}`, '¿Eliminar esta medición InBody? El archivo original permanecerá en el expediente.', 'Medición InBody eliminada');
  if (event.target.dataset.deleteDocument) deleteResource(`/api/documents/${event.target.dataset.deleteDocument}`, '¿Eliminar este archivo? Si corresponde a un InBody, también se eliminarán sus métricas asociadas.', 'Archivo del expediente eliminado');
  if (event.target.dataset.cancelSession) cancelSessionDialog(data.sessions.find(item => item.id === event.target.dataset.cancelSession));
  if (event.target.dataset.proponerRutina) proponerRutinaDesdeAgenda(data.sessions.find(item => item.id === event.target.dataset.proponerRutina));
  if (event.target.dataset.shareRoutine) {
    const rutina = data.routines.find(item => item.id === event.target.dataset.shareRoutine);
    const clienteRutina = data.clients.find(item => item.id === rutina?.assignedClientIds?.[0]);
    if (rutina && clienteRutina) enviarEnlaceRutina(rutina, clienteRutina, (data.travel || []).filter(item => item.client_id === clienteRutina.id && (!item.ends_on || item.ends_on >= dateKey(today))).sort((x, y) => x.starts_on.localeCompare(y.starts_on))[0] || null);
  }
  if (event.target.dataset.retirarRutina) {
    if (!confirm('¿Retirar la rutina ofrecida? La clase sigue programada y el cliente ya no la verá como pendiente.')) return;
    api(`/api/sessions/${event.target.dataset.retirarRutina}/routine-offer`, { method: 'DELETE' })
      .then(async () => { await loadData(); renderAll(); toast('Rutina retirada'); })
      .catch(error => toast(error.message, true));
  }
  if (event.target.dataset.editCancellation) editCancellationDialog(data.sessions.find(item => item.id === event.target.dataset.editCancellation));
});
document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-session-compliance]'); if (!form) return;
  event.preventDefault();
  const outcome = form.elements.outcome ? form.elements.outcome.value : (form.elements.completed.checked ? 'completed' : 'no_show');
  const completionPercent = outcome === 'completed' ? Number(form.elements.completionPercent.value) : 0;
  const dicho = { scheduled: 'Sin marcar', completed: 'Cumplió', no_show: 'No asistió' }[outcome];
  try { form.classList.add('loading-state'); const resultado = await api(`/api/sessions/${form.dataset.sessionCompliance}/compliance`, { method: 'PATCH', body: { outcome, completionPercent } }); await loadData(); renderAll(); toast(mensajeDeSaldo(resultado, `Guardado · ${dicho}`)); }
  catch (error) { toast(error.message, true); form.classList.remove('loading-state'); }
});
document.addEventListener('change', event => {
  const checkbox = event.target.matches('input[name="completed"]') ? event.target : null;
  if (checkbox && checkbox.closest('[data-session-compliance], [data-portal-routine], [data-portal-session]')) { const percent = checkbox.closest('form').elements.completionPercent; percent.value = checkbox.checked ? (Number(percent.value) || 100) : 0; }
  const outcome = event.target.matches('select[name="outcome"], input[type="radio"][name="outcome"]') ? event.target : null;
  if (outcome && outcome.closest('[data-session-compliance]')) {
    const percent = outcome.closest('form').elements.completionPercent;
    percent.value = outcome.value === 'completed' ? (Number(percent.value) || 100) : 0;
    percent.disabled = outcome.value !== 'completed';
  }
});
document.querySelector('.modal-close').addEventListener('click', () => modal.close());
document.getElementById('client-search').addEventListener('input', event => renderClients(event.target.value));
document.getElementById('client-status-filter').addEventListener('change', () => renderClients(document.getElementById('client-search').value));
document.getElementById('compliance-period').addEventListener('change', async event => {
  compliancePeriod = event.target.value;
  try { data.compliance = await api(`/api/compliance/summary?period=${compliancePeriod}`); renderDashboard(); }
  catch (error) { toast(error.message, true); }
});
const notifyBillingPeriodChange = () => document.dispatchEvent(new CustomEvent('billingperiodchange', { detail: { month: billingMonth, year: billingYear } }));
const resetBillingList = () => { billingVisibleInvoices = 100; };
document.getElementById('billing-month').addEventListener('change', event => { billingMonth = event.target.value; resetBillingList(); renderBilling(); notifyBillingPeriodChange(); });
document.getElementById('billing-year').addEventListener('change', event => { billingYear = event.target.value; if (billingYear === 'all') billingMonth = 'all'; resetBillingList(); renderBilling(); notifyBillingPeriodChange(); });
document.getElementById('billing-source').addEventListener('change', event => { billingSource = event.target.value; resetBillingList(); renderBilling(); });
document.getElementById('billing-client-filter')?.addEventListener('input', event => {
  billingClientFilter = event.target.value;
  resetBillingList();
  renderBilling();
});
document.getElementById('billing-client-clear')?.addEventListener('click', () => {
  billingClientFilter = '';
  resetBillingList();
  renderBilling();
});
document.getElementById('billing-current-period').addEventListener('click', () => {
  billingMonth = String(today.getMonth() + 1); billingYear = String(today.getFullYear()); billingSource = 'all'; resetBillingList(); renderBilling(); notifyBillingPeriodChange();
});
document.getElementById('attendance-month')?.addEventListener('change', event => {
  attendanceMonth = event.target.value || dateKey(today).slice(0, 7);
  attendanceFrom = '';
  attendanceTo = '';
  attendanceCurrentCutOnly = false;
  attendanceCutOffset = 0;
  attendanceReport = null;
  loadAttendanceReport();
});
document.getElementById('attendance-current')?.addEventListener('click', () => {
  attendanceMonth = dateKey(today).slice(0, 7);
  attendanceFrom = '';
  attendanceTo = '';
  attendanceCurrentCutOnly = false;
  attendanceCutOffset = 0;
  attendanceReport = null;
  loadAttendanceReport();
});
document.getElementById('attendance-apply-range')?.addEventListener('click', () => {
  const from = document.getElementById('attendance-from')?.value || '';
  const to = document.getElementById('attendance-to')?.value || '';
  if (!from || !to || from > to) {
    toast('Selecciona un rango válido: la fecha final debe ser igual o posterior a la inicial.', true);
    return;
  }
  attendanceFrom = from;
  attendanceTo = to;
  attendanceCurrentCutOnly = false;
  attendanceCutOffset = 0;
  attendanceReport = null;
  loadAttendanceReport();
});
document.getElementById('attendance-clear-range')?.addEventListener('click', () => {
  attendanceFrom = '';
  attendanceTo = '';
  attendanceCurrentCutOnly = false;
  attendanceCutOffset = 0;
  attendanceReport = null;
  loadAttendanceReport();
});
document.querySelectorAll('[data-attendance-status]').forEach(input => input.addEventListener('change', event => {
  attendanceStatusFilters[event.target.value] = event.target.checked;
  renderAttendanceReport();
}));
document.getElementById('attendance-client-filter')?.addEventListener('input', event => {
  attendanceClientFilter = event.target.value;
  if (attendanceCurrentCutOnly && !attendanceCutClient()) { attendanceCurrentCutOnly = false; attendanceCutOffset = 0; }
  if (attendanceCurrentCutOnly) {
    attendanceReport = null;
    loadAttendanceReport();
  } else renderAttendanceReport();
});
document.getElementById('attendance-current-cut')?.addEventListener('change', event => {
  if (event.target.checked && !attendanceCutClient()) {
    event.target.checked = false;
    attendanceCurrentCutOnly = false;
    attendanceCutOffset = 0;
    toast('Escribe un cliente único para consultar su corte vigente.', true);
    renderAttendanceReport();
    return;
  }
  attendanceCurrentCutOnly = event.target.checked;
  if (!attendanceCurrentCutOnly) attendanceCutOffset = 0;
  attendanceReport = null;
  loadAttendanceReport();
});
document.getElementById('attendance-cut-previous')?.addEventListener('click', () => {
  if (!attendanceCurrentCutOnly || !attendanceCutClient()) return;
  attendanceCutOffset += 1;
  attendanceReport = null;
  loadAttendanceReport();
});
document.getElementById('attendance-cut-next')?.addEventListener('click', () => {
  if (!attendanceCurrentCutOnly || attendanceCutOffset === 0 || !attendanceCutClient()) return;
  attendanceCutOffset -= 1;
  attendanceReport = null;
  loadAttendanceReport();
});
document.getElementById('billing-load-more').addEventListener('click', () => { billingVisibleInvoices += 100; renderBilling(); });
document.getElementById('show-zoho-invoices').addEventListener('click', () => {
  billingReturnState = { month: billingMonth, year: billingYear, source: billingSource };
  billingMonth = 'all'; billingYear = 'all'; billingSource = 'zoho_invoice'; resetBillingList(); renderBilling(); notifyBillingPeriodChange();
  document.getElementById('billing-invoices-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('billing-back-from-zoho').addEventListener('click', () => {
  const previous = billingReturnState || { month: String(today.getMonth() + 1), year: String(today.getFullYear()), source: 'all' };
  billingMonth = previous.month; billingYear = previous.year; billingSource = previous.source;
  billingReturnState = null; resetBillingList(); renderBilling(); notifyBillingPeriodChange();
});
document.getElementById('notification-button').addEventListener('click', () => notificationCenter(false));
document.getElementById('today').textContent = new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }).format(today);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let refreshingApplication = false;
  const reloadForUpdate = () => {
    if (refreshingApplication) return;
    refreshingApplication = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    reloadForUpdate();
  });
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'EILEEN_UPDATE_READY' && event.data.version !== APP_VERSION) reloadForUpdate();
    // Llegó una notificación push con la app abierta: además de la burbuja del sistema, suena el acorde y se refrescan los datos.
    if (event.data?.type === 'EILEEN_PUSH' && event.data.sound && currentUser?.role !== 'client') {
      sonarAviso();
      toast(`${event.data.title} · ${event.data.body}`);
      loadData().then(renderAll).catch(() => {});
    }
  });
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`, { updateViaCache: 'none' });
      const activateWaitingWorker = () => registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      activateWaitingWorker();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) worker.postMessage({ type: 'SKIP_WAITING' });
        });
      });
      await registration.update();
      activateWaitingWorker();

      const checkApplicationVersion = async () => {
        try {
          const response = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
          if (!response.ok) return;
          const latest = await response.json();
          if (latest.version === APP_VERSION) return;
          await registration.update();
          activateWaitingWorker();
        } catch {}
      };
      await checkApplicationVersion();
      window.setInterval(checkApplicationVersion, 5 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkApplicationVersion();
      });
    } catch {
      await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`).catch(() => {});
    }
  });
}

const portalViewTitles = { 'portal-dashboard': 'Mi progreso', 'portal-routines': 'Mis rutinas', 'portal-calendar': 'Mi agenda', 'portal-billing': 'Facturación', 'portal-reports': 'Mis informes' };

// La rutina guarda una copia del ejercicio en JSON; el video vive en el
// catálogo. catalogId es lo que une a los dos. Un ejercicio personalizado, o
// uno cuyo ejercicio de catálogo se borró después, simplemente no ofrece video.
// Se usa con dos catálogos distintos: el que recibe el cliente en su portal
// (has_video, tal como llega de la API) y el que tiene la entrenadora en
// memoria (hasVideo, ya mapeado). Por eso se leen las dos formas.
function exerciseRows(exercises, catalog, prefix = 'video') {
  let bloqueActual = null;
  return exercises.map((exercise, position) => {
    if (typeof exercise === 'string') return `<span>${escapeHtml(exercise)}</span>`;
    // Encabezado del bloque (J-113): dice cuántas rondas y que los ejercicios se hacen seguidos.
    const bloque = exercise.block || null; let encabezado = '';
    if (bloque !== bloqueActual) {
      if (bloque) encabezado = `<div class="routine-block-title"><b>Bloque ${bloque}</b> · ${textoRondas(exercise.rounds || exercise.sets || 3)}<small>Haz estos ejercicios seguidos, en orden, y repite el bloque ${exercise.rounds || exercise.sets || 3} ${Number(exercise.rounds || exercise.sets || 3) === 1 ? 'vez' : 'veces'}.</small></div>`;
      else if (bloqueActual) encabezado = '<div class="routine-block-title"><b>Además</b></div>';
      bloqueActual = bloque;
    }
    // Las rutinas creadas antes de mover el catálogo a la base guardaron el
    // slug del archivo estático como catalogId; las nuevas guardan el uuid. La
    // siembra conservó esos mismos slugs, así que buscar por ambos hace que las
    // rutinas viejas también muestren video.
    const catalogEntry = (catalog || []).find(item => item.id === exercise.catalogId || item.slug === exercise.catalogId);
    const tieneVideo = Boolean(catalogEntry?.has_video ?? catalogEntry?.hasVideo);
    const dose = [!bloque && exercise.sets && setsLabel(exercise.sets), exercise.reps, exercise.weight && `Peso: ${exercise.weight}`].filter(Boolean).join(' · ');
    // La posición entra en el id porque una rutina puede repetir el mismo
    // ejercicio —el mismo movimiento en dos rangos de repeticiones es normal— y
    // dos contenedores con el mismo id harían que el segundo botón abriera el
    // video del primero.
    const videoId = `${prefix}-${catalogEntry?.id}-${position}`;
    return `${encabezado}<div class="portal-exercise">
      <b>${escapeHtml(exercise.name)}</b>
      ${dose ? `<small>${escapeHtml(dose)}</small>` : ''}
      ${catalogEntry?.cues ? `<small>${escapeHtml(catalogEntry.cues)}</small>` : ''}
      ${tieneVideo
        ? `<button type="button" class="secondary session-use exercise-video-toggle" data-play-exercise="${catalogEntry.id}" data-video-target="${videoId}">▶ Ver demostraciones</button><div class="exercise-video" id="${videoId}" hidden></div>`
        // Decir "sin video" en vez de no mostrar nada: la ausencia de botón se
        // veía idéntica a que la función estuviera rota, y hoy sólo un
        // ejercicio de 77 tiene video.
        : `<small class="sin-video">${catalogEntry ? 'Sin video todavía' : 'Ejercicio fuera del catálogo · no admite video'}</small>`}
    </div>`;
  }).join('');
}

function portalExerciseCompleted(routineId, exerciseIndex, todayCompletion) {
  const detail = (portalData?.routineExerciseCompletions || []).find(item => item.routine_id === routineId
    && String(item.completed_on).slice(0, 10) === dateKey(today) && Number(item.exercise_index) === exerciseIndex);
  // Las rutinas terminadas antes de existir el checklist no tienen detalle.
  return detail ? Boolean(detail.completed) : Number(todayCompletion?.completion_percent || 0) >= 100;
}

function portalExerciseRows(exercises, routineId = null, todayCompletion = null) {
  if (!routineId) return exerciseRows(exercises, portalData?.exercises || []);
  let bloqueActual = null;
  return exercises.map((exercise, position) => {
    if (typeof exercise === 'string') exercise = { name: exercise };
    const bloque = exercise.block || null; let encabezado = '';
    if (bloque !== bloqueActual) {
      if (bloque) encabezado = `<div class="routine-block-title"><b>Bloque ${escapeHtml(String(bloque))}</b> · ${textoRondas(exercise.rounds || exercise.sets || 3)}<small>Haz estos ejercicios seguidos, en orden, y repite el bloque ${exercise.rounds || exercise.sets || 3} ${Number(exercise.rounds || exercise.sets || 3) === 1 ? 'vez' : 'veces'}.</small></div>`;
      else if (bloqueActual) encabezado = '<div class="routine-block-title"><b>Además</b></div>';
      bloqueActual = bloque;
    }
    const catalogEntry = (portalData?.exercises || []).find(item => item.id === exercise.catalogId || item.slug === exercise.catalogId);
    const tieneVideo = Boolean(catalogEntry?.has_video ?? catalogEntry?.hasVideo);
    const dose = [!bloque && exercise.sets && setsLabel(exercise.sets), exercise.reps, exercise.weight && `Peso: ${exercise.weight}`].filter(Boolean).join(' · ');
    const checked = portalExerciseCompleted(routineId, position, todayCompletion);
    const videoId = `portal-${routineId}-${catalogEntry?.id || position}-${position}`;
    const video = tieneVideo
      ? `<button type="button" class="secondary session-use exercise-video-toggle" data-play-exercise="${catalogEntry.id}" data-video-target="${videoId}">▶ Ver demostración</button><div class="exercise-video" id="${videoId}" hidden></div>`
      : `<small class="sin-video">${catalogEntry ? 'Sin video todavía' : 'Ejercicio fuera del catálogo'}</small>`;
    return `${encabezado}<div class="routine-exercise-item"><label class="routine-exercise-check${checked ? ' done' : ''}"><input type="checkbox" data-portal-routine-exercise="${routineId}" data-exercise-index="${position}" ${checked ? 'checked' : ''}><span><b>${escapeHtml(exercise.name || 'Ejercicio')}</b>${dose ? `<small>${escapeHtml(dose)}</small>` : ''}</span></label>${video}</div>`;
  }).join('');
}

// La URL firmada se pide al darle reproducir, no al cargar la pantalla: dura
// cinco minutos y pedir cuarenta de golpe las vencería antes de usarlas.
let publicRoutineToken = null;
async function playExerciseVideo(exerciseId, button) {
  // El contenedor se nombra desde el botón: el mismo ejercicio puede aparecer
  // en la rutina del cliente y en la vista de la entrenadora, y dos elementos
  // con el mismo id harían que reproducir uno abriera el otro.
  const container = document.getElementById(button.dataset.videoTarget || `video-${exerciseId}`);
  if (!container) return;
  if (container.dataset.loaded === 'true') {
    const visible = !container.hidden;
    container.hidden = visible;
    if (visible) container.querySelector('video')?.pause();
    button.textContent = visible ? '▶ Ver demostraciones' : 'Ocultar demostraciones';
    return;
  }
  button.disabled = true; button.textContent = 'Cargando…';
  try {
    const source = publicRoutineToken
      ? await api(`/api/public/routine/${publicRoutineToken}/exercises/${exerciseId}/video-urls`, { auth: false })
      : await api(`/api/exercises/${exerciseId}/video-urls`);
    container.innerHTML = source.videos.map(video => `<section class="exercise-video-variant"><b>${escapeHtml(video.label || 'Demostración')}</b><div class="exercise-video"><video controls loop muted autoplay playsinline preload="auto" src="${escapeHtml(video.videoUrl)}"></video></div></section>`).join('');
    container.dataset.loaded = 'true'; container.hidden = false;
    button.textContent = 'Ocultar demostraciones';
    container.querySelectorAll('video').forEach(video => video.play().catch(() => {}));
  } catch (error) {
    toast(error.message, true);
    button.textContent = '▶ Ver demostraciones';
  } finally { button.disabled = false; }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-play-exercise]');
  if (button) playExerciseVideo(button.dataset.playExercise, button);
});
const portalViewIds = new Set(Object.keys(portalViewTitles));
const portalViewFromHash = () => portalViewIds.has(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'portal-dashboard';
const portalView = id => {
  document.querySelectorAll('.portal-view').forEach(item => item.classList.toggle('active', item.id === id));
  document.querySelectorAll('[data-portal-view]').forEach(item => item.classList.toggle('active', item.dataset.portalView === id));
  document.getElementById('portal-title').textContent = portalViewTitles[id]; window.scrollTo(0, 0);
};
const portalNavigate = (id, { replace = false } = {}) => {
  const target = portalViewIds.has(id) ? id : 'portal-dashboard'; portalView(target);
  if (window.location.hash !== `#${target}`) window.history[replace ? 'replaceState' : 'pushState'](null, '', `#${target}`);
};
const portalSession = item => ({
  id: item.id,
  startsAt: new Date(item.starts_at),
  status: item.status,
  completionPercent: Number(item.completion_percent || 0),
  routine: item.routine_title || 'Evaluación / seguimiento',
  mode: item.mode,
  cancellationKind: item.cancellation_kind || '',
  cancelledBy: item.cancelled_by || '',
  creditCharge: Boolean(item.credit_charge),
  reprogramada: Boolean(item.reprogramada)
});
const monthLabel = date => new Intl.DateTimeFormat('es-PA', { month: 'short' }).format(date).replace('.', '');
const portalDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
const portalCutoffDate = (year, month, cutoff) => `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(cutoff, portalDaysInMonth(year, month))).padStart(2, '0')}`;
const PORTAL_MAX_CUT_HISTORY = 12;
function portalCycle(offset = 0) {
  const cutoff = Math.max(1, Number(portalData?.client?.billing_cutoff_day) || 1);
  const now = dateKey(today);
  let year = today.getFullYear(); let month = today.getMonth();
  if (now < portalCutoffDate(year, month, cutoff)) month -= 1;
  month += offset;
  while (month > 11) { month -= 12; year += 1; }
  while (month < 0) { month += 12; year -= 1; }
  const inicio = portalCutoffDate(year, month, cutoff);
  let nextYear = year; let nextMonth = month + 1;
  if (nextMonth > 11) { nextMonth = 0; nextYear += 1; }
  return { inicio, vence: portalCutoffDate(nextYear, nextMonth, cutoff) };
}
function portalPeriod() {
  if (portalPeriodMode === 'cutoff') {
    const cycle = portalCycle(portalCutOffset);
    const label = portalCutOffset === 0 ? 'Corte actual' : portalCutOffset === -1 ? 'Corte anterior' : `Corte de hace ${Math.abs(portalCutOffset)}`;
    // El resto del portal filtra por `from`/`to`; portalCycle conserva
    // `from` permanece inclusivo para facturas, pagos y paquetes: una factura
    // anticipada puede estar fechada exactamente el día de inicio del ciclo.
    // Las sesiones usan su propia frontera exclusiva y los textos muestran el
    // día siguiente para no prometer un día que no entra en asistencia.
    return { ...cycle, from: cycle.inicio, labelFrom: addDaysIso(cycle.inicio, 1), to: cycle.vence, sessionsFromExclusive: cycle.inicio, label, kind: 'cutoff' };
  }
  const [year, month] = portalPeriodMonth.split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  return { from: `${portalPeriodMonth}-01`, to: `${portalPeriodMonth}-${String(last).padStart(2, '0')}`, label: attendanceMonthLabel(portalPeriodMonth), kind: 'month' };
}
function portalDateInPeriod(value, period) {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : panamaDateTimeParts(value).date;
  return date >= period.from && date <= period.to;
}
function portalSessionInPeriod(value, period) {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : panamaDateTimeParts(value).date;
  return period.sessionsFromExclusive ? date > period.sessionsFromExclusive && date <= period.to : date >= period.from && date <= period.to;
}
function portalPeriodSessions(period = portalPeriod()) {
  return (portalData?.sessions || []).filter(item => {
    return portalSessionInPeriod(item.starts_at, period);
  });
}
function portalPeriodInvoices(period = portalPeriod()) {
  return (portalData?.invoices || []).filter(item => portalDateInPeriod(item.issued_on || item.due_on, period));
}
function portalPeriodPackages(period = portalPeriod()) {
  const packages = (portalData?.packages || []).filter(item => {
    const purchased = String(item.purchased_on || '').slice(0, 10);
    const expires = String(item.expires_on || '').slice(0, 10);
    if (period.kind === 'month') return !purchased || (purchased >= period.from && purchased <= period.to);
    return (!purchased || purchased <= period.to) && (!expires || expires >= period.from);
  });
  return packages.sort((a, b) => String(b.purchased_on || '').localeCompare(String(a.purchased_on || '')));
}
function portalPeriodControlsMarkup(prefix = 'portal-report-period') {
  const cutoff = portalPeriodMode === 'cutoff';
  const currentMonth = dateKey(today).slice(0, 7);
  const modeLabel = cutoff ? 'Corte seleccionado' : 'Mes seleccionado';
  const cutoffButton = cutoff ? 'Volver al mes' : 'Ver corte actual';
  const previousLabel = cutoff ? '‹ Corte anterior' : '‹ Mes anterior';
  const nextLabel = cutoff ? 'Corte siguiente ›' : 'Mes siguiente ›';
  const currentLabel = cutoff && portalCutOffset === 0 ? 'Corte actual' : cutoff ? 'Volver al corte actual' : 'Mes actual';
  return `<div class="portal-period-controls portal-report-period-controls" id="${prefix}-controls" aria-label="Filtros de período"><div class="portal-period-copy"><p class="eyebrow">CONSULTA TU PERÍODO</p><strong>${modeLabel}</strong><small>Elige mes o corte para actualizar el informe.</small></div><label for="${prefix}-month">Mes<input type="month" id="${prefix}-month" value="${portalPeriodMonth}" max="${currentMonth}"${cutoff ? ' disabled' : ''} /></label><button type="button" class="primary portal-cutoff-button${cutoff ? ' active-filter' : ''}" id="${prefix}-cutoff">${cutoffButton}</button><div class="portal-period-nav" aria-label="Navegar períodos"><button type="button" class="secondary" id="${prefix}-previous" aria-label="${cutoff ? 'Corte anterior' : 'Mes anterior'}"${cutoff && portalCutOffset <= -PORTAL_MAX_CUT_HISTORY ? ' disabled' : ''}>${previousLabel}</button><button type="button" class="secondary" id="${prefix}-current">${currentLabel}</button><button type="button" class="secondary" id="${prefix}-next" aria-label="${cutoff ? 'Corte siguiente' : 'Mes siguiente'}"${cutoff ? (portalCutOffset === 0 ? ' disabled' : '') : (portalPeriodMonth >= currentMonth ? ' disabled' : '')}>${nextLabel}</button></div></div>`;
}
function updatePortalPeriodFromMonth(value) {
  portalPeriodMonth = value || dateKey(today).slice(0, 7);
  portalPeriodMode = 'month';
  portalCutOffset = 0;
  renderPortal();
}
function movePortalPeriod(direction) {
  if (portalPeriodMode === 'cutoff') {
    if ((direction < 0 && portalCutOffset > -PORTAL_MAX_CUT_HISTORY) || (direction > 0 && portalCutOffset < 0)) portalCutOffset += direction;
  } else {
    const [year, month] = portalPeriodMonth.split('-').map(Number);
    const candidate = new Date(year, month - 1 + direction, 1, 12);
    const candidateMonth = `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}`;
    const currentMonth = dateKey(today).slice(0, 7);
    portalPeriodMonth = direction > 0 && candidateMonth > currentMonth ? currentMonth : candidateMonth;
  }
  renderPortal();
}
function bindPortalPeriodControls(prefix) {
  document.getElementById(`${prefix}-month`)?.addEventListener('change', event => updatePortalPeriodFromMonth(event.target.value));
  document.getElementById(`${prefix}-cutoff`)?.addEventListener('click', () => {
    portalPeriodMode = portalPeriodMode === 'cutoff' ? 'month' : 'cutoff';
    portalCutOffset = 0;
    renderPortal();
  });
  document.getElementById(`${prefix}-previous`)?.addEventListener('click', () => movePortalPeriod(-1));
  document.getElementById(`${prefix}-next`)?.addEventListener('click', () => movePortalPeriod(1));
  document.getElementById(`${prefix}-current`)?.addEventListener('click', () => {
    if (portalPeriodMode === 'cutoff') portalCutOffset = 0;
    else portalPeriodMonth = dateKey(today).slice(0, 7);
    renderPortal();
  });
}
function portalActivities(sessions = null, period = null) {
  const source = sessions || (portalData?.complianceSessions || []).filter(item => !period || portalSessionInPeriod(item.starts_at, period));
  return source.map(item => ({
    date: new Date(item.starts_at),
    percent: item.status === 'completed' ? Number(item.completion_percent || 0) : 0,
    completed: item.status === 'completed',
    measured: true
  }));
}
// Calendario del portal. Antes era una lista corrida de fechas: para saber si
// el miércoles había hueco había que recorrerla entera, y las sesiones propias
// se perdían entre los "Ocupado" de los demás.
//
// El mes se ve de un vistazo y el detalle del día se abre debajo, que es donde
// el cliente marca si cumplió. Se conserva la ficha de siempre para no tocar
// ese formulario.
// Agenda semanal del portal. La semana entera con sus horas: se ve de un
// vistazo qué está ocupado y qué queda libre, que es lo que un cliente
// necesita para pedir un cambio de hora.
//
// La rejilla va al minuto: las sesiones empiezan a y media, a menos cuarto o
// donde haga falta, y encajarlas a marcas fijas las pintaba fuera de su hora.
// La rejilla se mide en unidades de 5 minutos y las bandas visibles son de 30.
// Con filas de media hora, una sesión de 5:45 se encajaba a la fuerza en la
// marca de 5:30 y, al redondear también el final, se estiraba hasta las 7:00:
// sesenta minutos ocupando noventa y comiéndose dos tramos que estaban libres.
// Con la unidad en 5, cualquier hora que se agende cae en una línea exacta.
const PORTAL_UNIDAD_MINUTOS = 5;
const PORTAL_BANDA_MINUTOS = 30;

let portalWeekStart = startOfWeek(today);
let portalSelectedDay = dateKey(today);
let portalWeightUnit = 'kg';

function startOfWeek(fecha) {
  const inicio = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 12);
  // Semana de lunes a domingo.
  inicio.setDate(inicio.getDate() - ((inicio.getDay() + 6) % 7));
  return inicio;
}

function portalSlotCard(slot, ownSessions) {
  const date = new Date(slot.starts_at);
  const own = slot.is_mine ? ownSessions.get(slot.id) : null;
  const isCancelled = own && (own.status === 'cancelled' || own.status === 'no_show');
  const resultLabel = own?.reprogramada
    ? 'Reprogramada'
    : own?.creditCharge
      ? `Cancelación cobrada · ${money.format(Number(portalData.client?.credit_session_price || 25))}`
      : own?.status === 'no_show'
        ? 'No asistió · cuenta como cancelada'
        : own?.cancelledBy === 'client'
          ? 'Cancelada por el cliente · sin cobro'
          : 'Cancelada por la entrenadora';
  const form = own && !isCancelled
    ? `<form data-portal-session="${own.id}" class="portal-session-form"><label class="completion-check"><input name="completed" type="checkbox" ${own.status === 'completed' ? 'checked' : ''} /><span>Cumplí</span></label><label class="completion-percent"><input name="completionPercent" type="number" min="0" max="100" value="${own.status === 'completed' ? own.completionPercent || 100 : 0}" /><span>%</span></label><button class="secondary">Guardar</button></form>`
    : isCancelled ? `<small class="portal-session-status ${own.reprogramada ? 'reprogramada' : own.creditCharge ? 'cobrada' : ''}">${escapeHtml(resultLabel)}</small>` : '';
  return `<article class="portal-slot ${own ? 'mine' : 'busy'}"><time><b>${new Intl.DateTimeFormat('es-PA', { weekday: 'short', day: 'numeric', month: 'short' }).format(date)}</b><span>${new Intl.DateTimeFormat('es-PA', { hour: 'numeric', minute: '2-digit' }).format(date)}</span></time><div><b>${own ? escapeHtml(own.routine) : 'Ocupado'}</b><span>${own ? escapeHtml(own.mode) : 'Horario no disponible'}</span></div>${form}</article>`;
}

function renderPortalCalendar(ownSessions) {
  const contenedor = document.getElementById('portal-calendar-list');
  if (!contenedor) return;

  const dias = Array.from({ length: 7 }, (_, n) => {
    const fecha = new Date(portalWeekStart);
    fecha.setDate(fecha.getDate() + n);
    return fecha;
  });
  const clavesSemana = dias.map(dateKey);

  // Cada hueco ocupado, con su minuto de inicio y fin dentro del día.
  const ocupados = portalData.busySlots.map(slot => {
    const inicio = new Date(slot.starts_at);
    const minutos = inicio.getHours() * 60 + inicio.getMinutes();
    const duracion = Number(slot.duration_minutes) || 60;
    return { slot, dia: dateKey(inicio), desde: minutos, hasta: minutos + duracion, mia: Boolean(slot.is_mine) };
  }).filter(item => clavesSemana.includes(item.dia));

  // El rango de horas sale de lo que hay: mostrar de 0 a 24 llenaría la
  // pantalla de filas vacías a las tres de la mañana. Si la semana está libre
  // se usa una franja razonable de mañana y tarde. Los bordes se alinean a la
  // banda de media hora para que las etiquetas queden en su sitio.
  const conAlgo = ocupados.length;
  const primero = conAlgo ? Math.min(...ocupados.map(o => o.desde)) : 6 * 60;
  const ultimo = conAlgo ? Math.max(...ocupados.map(o => o.hasta)) : 19 * 60;
  const desde = Math.max(0, Math.floor((primero - 30) / PORTAL_BANDA_MINUTOS) * PORTAL_BANDA_MINUTOS);
  const hasta = Math.min(24 * 60, Math.ceil((ultimo + 30) / PORTAL_BANDA_MINUTOS) * PORTAL_BANDA_MINUTOS);
  const unidades = Math.max(1, (hasta - desde) / PORTAL_UNIDAD_MINUTOS);
  const unidadesPorBanda = PORTAL_BANDA_MINUTOS / PORTAL_UNIDAD_MINUTOS;

  const comoHora = minutos => {
    const h = Math.floor(minutos / 60); const m = minutos % 60;
    const sufijo = h < 12 ? 'a' : 'p';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')}${sufijo}`;
  };

  const hoyClave = dateKey(today);
  const cabecera = dias.map(fecha => {
    const clave = dateKey(fecha);
    return `<button type="button" class="portal-col-dia ${clave === hoyClave ? 'hoy' : ''} ${viajeDeFecha(clave) ? 'viaje' : ''}" style="grid-row:1;grid-column:${clavesSemana.indexOf(clave) + 2}" data-portal-dia="${clave}" ${viajeDeFecha(clave) ? 'title="Día de viaje"' : ''}>
      <b>${['L', 'M', 'X', 'J', 'V', 'S', 'D'][(fecha.getDay() + 6) % 7]}</b>
      <i>${fecha.getDate()}</i>${viajeDeFecha(clave) ? '<em class="portal-avion" aria-label="De viaje">✈</em>' : ''}
    </button>`;
  }).join('');

  // El fondo va en bandas de media hora: son las que llevan etiqueta y las que
  // dan la retícula. Sólo los bloques necesitan precisión al minuto.
  const bandas = [];
  for (let minuto = desde; minuto < hasta; minuto += PORTAL_BANDA_MINUTOS) bandas.push(minuto);
  const fondo = bandas.map((minuto, banda) => {
    const filaInicio = banda * unidadesPorBanda + 2;
    const celdas = clavesSemana.map((clave, columna) => {
      const yaPaso = new Date(`${clave}T00:00:00`).getTime() + (minuto + PORTAL_BANDA_MINUTOS) * 60_000 < Date.now();
      return `<span class="portal-tramo ${yaPaso ? 'pasado' : 'libre'} ${viajeDeFecha(clave) ? 'viaje' : ''}" style="grid-row:${filaInicio} / span ${unidadesPorBanda};grid-column:${columna + 2}" title="${yaPaso ? 'Ya pasó' : 'Disponible'}"></span>`;
    }).join('');
    const etiqueta = `<span class="portal-hora" style="grid-row:${filaInicio} / span ${unidadesPorBanda};grid-column:1">${minuto % 60 === 0 ? comoHora(minuto) : ''}</span>`;
    return etiqueta + celdas;
  }).join('');

  // Y encima, cada sesión en su minuto exacto.
  const bloques = ocupados.map(o => {
    const columna = clavesSemana.indexOf(o.dia);
    if (columna < 0) return '';
    const inicio = Math.max(o.desde, desde);
    const fin = Math.min(o.hasta, hasta);
    if (fin <= inicio) return '';
    const filaInicio = Math.round((inicio - desde) / PORTAL_UNIDAD_MINUTOS) + 2;
    const cuantas = Math.max(1, Math.round((fin - inicio) / PORTAL_UNIDAD_MINUTOS));
    return `<button type="button" class="portal-bloque ${o.mia ? 'mia' : 'ocupada'}"
      style="grid-row:${filaInicio} / span ${cuantas};grid-column:${columna + 2}"
      data-portal-dia="${o.dia}" title="${o.mia ? 'Tu sesión' : 'Ocupado'} · ${comoHora(o.desde)} a ${comoHora(o.hasta)}">${o.mia ? '●' : ''}</button>`;
  }).join('');

  const rango = `${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short' }).format(dias[0])} – ${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short' }).format(dias[6])}`;
  const delDia = ocupados.filter(o => o.dia === portalSelectedDay).sort((a, b) => a.desde - b.desde);
  const fechaElegida = new Date(`${portalSelectedDay}T12:00:00`);

  contenedor.innerHTML = `
    <div class="portal-mes">
      <button type="button" class="portal-mes-nav" data-portal-semana="-1" aria-label="Semana anterior">‹</button>
      <b>${rango}</b>
      <button type="button" class="portal-mes-nav" data-portal-semana="1" aria-label="Semana siguiente">›</button>
    </div>
    <div class="portal-semana-rejilla" style="grid-template-rows:auto repeat(${unidades}, 3px)">
      ${cabecera}
      ${fondo}
      ${bloques}
    </div>
    <p class="portal-leyenda"><span class="marca-mia">●</span> Tu sesión &nbsp; <span class="marca-ocupada">▪</span> Ocupado &nbsp; <span class="marca-libre">▫</span> Disponible &nbsp; <span class="marca-pasada">▫</span> Ya pasó &nbsp; <span class="marca-viaje">✈</span> Día de viaje</p>
    <h4 class="portal-dia-titulo">${new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }).format(fechaElegida)}</h4>
    ${viajeDeFecha(portalSelectedDay) ? '<p class="portal-viaje-dia">✈ Estás de viaje este día. Si tienes clase, confirma tu rutina ese mismo día para que cuente.</p>' : ''}
    ${delDia.length ? delDia.map(o => portalSlotCard(o.slot, ownSessions)).join('') : '<p class="empty">Sin horarios ocupados este día.</p>'}`;

  // Fuera de la ventana que envía el servidor todo saldría vacío, y una semana
  // entera en blanco se lee como "todo libre" cuando en realidad es "no lo sé".
  const limiteAtras = new Date(today); limiteAtras.setDate(limiteAtras.getDate() - 60);
  const limiteAdelante = new Date(today); limiteAdelante.setDate(limiteAdelante.getDate() + 90);
  contenedor.querySelectorAll('[data-portal-semana]').forEach(boton => {
    const salto = Number(boton.dataset.portalSemana);
    const destino = new Date(portalWeekStart); destino.setDate(destino.getDate() + 7 * salto);
    if (destino < startOfWeek(limiteAtras) || destino > startOfWeek(limiteAdelante)) { boton.disabled = true; return; }
    boton.onclick = () => {
      portalWeekStart = destino;
      renderPortalCalendar(ownSessions);
    };
  });
  contenedor.querySelectorAll('[data-portal-dia]').forEach(boton => {
    boton.onclick = () => { portalSelectedDay = boton.dataset.portalDia; renderPortalCalendar(ownSessions); };
  });
}

const portalWeightValue = (entry, unit = portalWeightUnit) => {
  const kg = Number(entry.weight_kg);
  return Number.isFinite(kg) ? (unit === 'lb' ? kg * 2.20462262 : kg) : null;
};
const portalWeightLabel = (entry, unit = portalWeightUnit) => {
  const value = portalWeightValue(entry, unit);
  return value === null ? '—' : `${value.toFixed(1)} ${unit}`;
};
function portalWeightLineChart(entries) {
  const points = entries.slice().sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
  if (points.length < 2) return `<p class="empty">Registra al menos dos pesos para ver tu evolución.</p>`;
  const width = 640; const height = 190; const pad = 28;
  const values = points.map(item => portalWeightValue(item));
  const min = Math.min(...values); const max = Math.max(...values); const span = Math.max(0.1, max - min);
  const x = index => pad + (index * (width - pad * 2) / Math.max(1, points.length - 1));
  const y = value => height - pad - ((value - min) / span) * (height - pad * 2);
  const line = points.map((item, index) => `${x(index).toFixed(1)},${y(portalWeightValue(item)).toFixed(1)}`).join(' ');
  const dots = points.map((item, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(portalWeightValue(item)).toFixed(1)}" r="4" fill="#b86e8d"><title>${String(item.measured_at).slice(0, 10)} · ${portalWeightLabel(item)}</title></circle>`).join('');
  const labels = points.map((item, index) => index === 0 || index === points.length - 1 ? `<text x="${x(index).toFixed(1)}" y="${height - 7}" text-anchor="middle">${String(item.measured_at).slice(5, 10)}</text>` : '').join('');
  return `<svg class="portal-weight-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolución de peso en ${portalWeightUnit}"><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}"/><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/><polyline points="${line}" fill="none" stroke="#b86e8d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}</svg>`;
}
function portalWeightModal() {
  const box = document.createElement('div');
  box.innerHTML = `<form id="portal-weight-form"><p class="eyebrow">SEGUIMIENTO PERSONAL</p><h2>Registrar peso</h2><p class="form-summary">Es voluntario. Puedes registrar tu peso cuando quieras.</p><div class="form-row"><label>Peso<input name="weight" type="number" min="1" max="1100" step="0.1" required placeholder="Ej. 72.5" /></label><label>Unidad<select name="unit"><option value="kg" ${portalWeightUnit === 'kg' ? 'selected' : ''}>Kilogramos (kg)</option><option value="lb" ${portalWeightUnit === 'lb' ? 'selected' : ''}>Libras (lb)</option></select></label></div><label>Fecha<input name="date" type="date" value="${dateKey(today)}" max="${dateKey(today)}" required /></label><label>Nota (opcional)<textarea name="note" rows="2" maxlength="300" placeholder="Ej. medición en ayunas"></textarea></label><button class="primary wide-button">Guardar peso</button></form>`;
  openModal(box);
  box.querySelector('#portal-weight-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const unit = String(form.get('unit')); const value = Number(form.get('weight'));
    try {
      event.target.classList.add('loading-state');
      await api('/api/portal/weight-logs', { method: 'POST', body: { weight: value, unit, measuredAt: new Date(`${form.get('date')}T12:00:00-05:00`).toISOString(), note: String(form.get('note') || '').trim() || undefined } });
      modal.close(); await loadPortalData(); portalNavigate('portal-reports'); toast('Peso registrado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function portalAttendanceReport(sessions = portalPeriodSessions()) {
  const period = portalPeriod();
  const past = sessions.filter(item => new Date(item.starts_at) <= today);
  const measuredIds = new Set((portalData?.complianceSessions || [])
    .filter(item => portalSessionInPeriod(item.starts_at, period)).map(item => item.id));
  const measured = past.filter(item => measuredIds.has(item.id));
  const completed = measured.filter(item => item.status === 'completed').length;
  // Para el cliente, una inasistencia tiene el mismo resultado operativo que
  // una cancelación: la sesión no se cumple y cuenta dentro de las clases
  // perdidas. Se presenta como una sola categoría para no duplicar el dato.
  const cancelled = measured.filter(item => item.status === 'no_show'
    || (item.status === 'cancelled' && item.cancellation_kind === 'not_rescheduled' && (item.cancelled_by || 'client') === 'client')).length;
  const reprogrammed = past.filter(item => item.reprogramada).length;
  // "Pendientes" mantiene el significado operativo de la tabla: son sesiones
  // pasadas que vencieron sin marcar. Las futuras permanecen agendadas y no se
  // mezclan en este contador.
  const pending = past.filter(item => item.status === 'scheduled').length;
  const denominator = measured.length;
  const points = measured.reduce((sum, item) => sum + (item.status === 'completed' ? Number(item.completion_percent || 0) : 0), 0);
  const percent = denominator ? Math.round(points / denominator) : 0;
  const cancelledPercent = denominator ? Math.round(cancelled / denominator * 100) : 0;
  const rows = past.slice().sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at)).slice(0, 30).map(item => {
    const estado = item.reprogramada ? 'Reprogramada' : item.credit_charge ? 'Cancelación cobrada' : item.status === 'completed' ? 'Asistió' : item.status === 'cancelled' || item.status === 'no_show' ? 'Cancelada' : 'Pendiente';
    const detalle = item.credit_charge ? ` · ${money.format(Number(portalData.client?.credit_session_price || 25))}` : '';
    return `<tr><td data-label="Fecha">${fechaHoraPanama(item.starts_at, false)}</td><td data-label="Hora">${horaPanama(item.starts_at)}</td><td data-label="Sesión">${escapeHtml(item.routine_title || 'Entrenamiento')}</td><td data-label="Estado"><span class="payment-status ${item.status}">${estado}${detalle}</span></td></tr>`;
  }).join('');
  return `<section class="portal-report-section"><div class="card-head"><div><h3>Asistencia y cancelaciones</h3><p>${period.label} · ${fechaCorta(period.labelFrom || period.from)} al ${fechaCorta(period.to)}</p></div><span class="portal-report-period"><b>${completed}/${denominator || 0} · ${percent}% cumplimiento</b><small>${cancelled}/${denominator || 0} · ${cancelledPercent}% cancelaciones</small></span></div><div class="portal-report-stats"><article><strong>${completed}</strong><span>Asistencias</span></article><article><strong>${cancelled}</strong><span>Cancelaciones cliente</span></article><article><strong>${reprogrammed}</strong><span>Reprogramadas</span></article><article><strong>${pending}</strong><span>Pendientes</span></article></div><div class="table-wrap"><table class="stack-mobile portal-attendance-table"><thead><tr><th>Fecha</th><th>Hora</th><th>Sesión</th><th>Estado</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Todavía no hay sesiones registradas en este período.</td></tr>'}</tbody></table></div></section>`;
}
function renderPortalReports() {
  const informes = document.getElementById('portal-reports-list'); if (!informes) return;
  const weights = Array.isArray(portalData.weightLogs) ? portalData.weightLogs : [];
  const history = weights.slice().sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at));
  const weightRows = history.slice(0, 20).map(item => `<tr><td data-label="Fecha">${String(item.measured_at).slice(0, 10)}</td><td data-label="Peso">${portalWeightLabel(item)}</td><td data-label="Origen">Registro personal</td><td data-label="Acciones"><button type="button" class="secondary" data-delete-weight="${item.id}">Eliminar</button></td></tr>`).join('');
  informes.innerHTML = `${portalPeriodControlsMarkup()}${portalAttendanceReport()}<section class="portal-report-section"><div class="card-head"><div><h3>Evolución de peso</h3><p>Registros personales, separados de tus InBody.</p></div><label class="portal-unit-select">Mostrar en<select id="portal-weight-unit"><option value="kg" ${portalWeightUnit === 'kg' ? 'selected' : ''}>kg</option><option value="lb" ${portalWeightUnit === 'lb' ? 'selected' : ''}>lb</option></select></label></div>${portalWeightLineChart(weights)}${history.length ? `<div class="table-wrap"><table class="stack-mobile portal-weight-table"><thead><tr><th>Fecha</th><th>Peso</th><th>Origen</th><th>Acciones</th></tr></thead><tbody>${weightRows}</tbody></table></div>` : '<p class="empty">Aún no tienes registros de peso.</p>'}</section><section class="portal-report-downloads"><article class="card portal-report"><div><h3>Mi cumplimiento</h3><p>Descarga un PDF con tu avance.</p></div><button class="secondary" data-portal-report="compliance">Descargar PDF</button></article><article class="card portal-report"><div><h3>Estado de cuenta</h3><p>Lo facturado, pagado y pendiente.</p></div><button class="secondary" data-portal-report="statement">Descargar PDF</button></article></section>`;
  bindPortalPeriodControls('portal-report-period');
  document.getElementById('portal-weight-unit').onchange = event => { portalWeightUnit = event.target.value; renderPortalReports(); };
  informes.querySelectorAll('[data-delete-weight]').forEach(button => button.onclick = async () => { if (!confirm('¿Eliminar este registro de peso?')) return; try { await api(`/api/portal/weight-logs/${button.dataset.deleteWeight}`, { method: 'DELETE' }); await loadPortalData(); toast('Registro eliminado'); } catch (error) { toast(error.message, true); } });
  informes.querySelectorAll('[data-portal-report]').forEach(button => button.onclick = async () => {
    const cual = button.dataset.portalReport; const ruta = cual === 'compliance' ? '/api/portal/reports/compliance.pdf' : '/api/portal/reports/account-statement.pdf'; const texto = button.textContent; button.disabled = true; button.textContent = 'Preparando…';
    try { const response = await fetch(`${API_BASE}${ruta}`, { headers: { Authorization: `Bearer ${authToken}` } }); if (!response.ok) throw new Error('No se pudo generar el informe'); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = cual === 'compliance' ? 'mi-cumplimiento.pdf' : 'mi-estado-de-cuenta.pdf'; link.click(); URL.revokeObjectURL(url); } catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = texto; }
  });
}
function clientWeightLogsSection(target, clientId) {
  if (!target) return;
  api(`/api/clients/${clientId}/weight-logs`).then(entries => {
    const rows = entries.slice(0, 30).map(item => `<tr><td>${String(item.measured_at).slice(0, 10)}</td><td>${Number(item.weight_value).toFixed(1)} ${item.unit === 'lb' ? 'lb' : 'kg'}</td><td>Registro personal</td><td>${item.note ? escapeHtml(item.note) : '—'}</td></tr>`).join('');
    target.innerHTML = entries.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Peso</th><th>Origen</th><th>Nota</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">El cliente todavía no ha registrado su peso voluntariamente.</p>';
  }).catch(error => { target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

// ── Rutina ofrecida y cronómetro (J-102) ────────────────────────────────────────
const duracionLegible = segundos => {
  const total = Math.max(0, Math.round(segundos));
  const horas = Math.floor(total / 3600); const minutos = Math.floor((total % 3600) / 60);
  return horas ? `${horas} h ${minutos} min` : `${Math.max(1, minutos)} min`;
};
const relojTexto = segundos => {
  const total = Math.max(0, Math.floor(segundos));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const ofertaDeRutina = routineId => (portalData?.routineOffers || []).find(item => item.routine_id === routineId);

// ── Días de viaje en el portal del cliente (J-114) ───────────────────────────────────────────────
const viajeDeFecha = clave => (portalData?.travel || []).find(item => item.starts_on <= clave && (!item.ends_on || item.ends_on >= clave));
const diasDeViaje = viaje => viaje.ends_on ? Math.round((new Date(`${viaje.ends_on}T12:00:00`) - new Date(`${viaje.starts_on}T12:00:00`)) / 86400000) + 1 : null;
function renderViajePortal() {
  const raiz = document.getElementById('portal-dashboard'); if (!raiz) return;
  let contenedor = document.getElementById('portal-travel-dashboard');
  if (!contenedor) { contenedor = document.createElement('div'); contenedor.id = 'portal-travel-dashboard'; const ofertas = document.getElementById('portal-offers-dashboard'); if (ofertas) ofertas.after(contenedor); else raiz.prepend(contenedor); }
  const hoy = dateKey(today);
  const viajes = (portalData?.travel || []).filter(item => !item.ends_on || item.ends_on >= hoy).sort((x, y) => x.starts_on.localeCompare(y.starts_on)).slice(0, 2);
  contenedor.innerHTML = viajes.map(viaje => {
    const enCurso = viaje.starts_on <= hoy; const dias = diasDeViaje(viaje);
    return `<article class="portal-viaje-card"><span class="portal-offer-tag portal-viaje-tag">✈ ${enCurso ? 'Estás de viaje' : 'Tu próximo viaje'}</span>
      <h3>${fechaViaje(viaje.starts_on)} → ${viaje.ends_on ? fechaViaje(viaje.ends_on) : 'regreso por definir'}${viaje.destination ? ` · ${escapeHtml(viaje.destination)}` : ''}</h3>
      <p>${dias ? `${dias} ${dias === 1 ? 'día' : 'días'} de viaje. ` : ''}Tu plan sigue igual. Si tienes clase durante el viaje, <b>confirma la rutina que Eileen te envíe el mismo día</b> para que cuente; si no, esa clase se cancela.</p></article>`;
  }).join('');
}

// Tarjeta de cada rutina en el portal del cliente. Volvió a ser una función propia porque la versión 286 llamaba a `portalRoutineCard` sin que existiera: renderPortal se caía y a todos los clientes
// les salía "La sesión venció". Lleva el cronómetro con su aviso de rutina ofrecida, los bloques con sus rondas, los pesos y las demostraciones.
const portalRoutineCompletion = routineId => (portalData?.routineCompletions || []).find(item => item.routine_id === routineId && String(item.completed_on).slice(0, 10) === dateKey(today));
function portalRoutineHistoryMarkup() {
  const target = document.getElementById('portal-routine-history'); if (!target) return;
  const history = Array.isArray(portalData?.routineHistory) ? portalData.routineHistory : [];
  const statusText = { active: 'Activa', completed: 'Cumplida', expired: 'Expirada' };
  const cards = history.map(item => {
    const status = item.delivery_status || 'active';
    const sentAt = fechaHoraPanama(item.sent_at, true);
    const due = item.due_on ? fechaCorta(item.due_on) : null;
    let detail = '';
    if (status === 'active') {
      detail = item.days_remaining === 0
        ? `Último día para completarla${due ? ` · vence el ${due}` : ''}.`
        : item.days_remaining == null
          ? 'Disponible mientras esté asignada.'
          : `Te quedan ${item.days_remaining} días para completarla${due ? ` · vence el ${due}` : ''}.`;
    } else if (status === 'completed') {
      detail = `Cumplida${item.completed_on ? ` el ${fechaCorta(item.completed_on)}` : ''}.`;
    } else {
      detail = item.expiration_billing === 'credit'
        ? `Esta clase expiró${due ? ` el ${due}` : ''}. Cuenta como no cumplida y se sumó a tu factura a crédito.`
        : item.expiration_billing === 'monthly'
          ? `Esta clase expiró${due ? ` el ${due}` : ''}. Cuenta como no cumplida y fue descontada de tu plan mensual.`
          : `Esta rutina expiró${due ? ` el ${due}` : ''} y quedó registrada como no cumplida.`;
    }
    return `<article class="portal-routine-history-item ${status}"><div class="portal-routine-history-main"><div class="portal-routine-history-title"><strong>${escapeHtml(item.routine_title || 'Rutina')}</strong><span class="routine-history-status ${status}">${statusText[status] || status}</span></div><small>Enviada ${escapeHtml(sentAt)}</small><p>${detail}</p></div></article>`;
  }).join('');
  target.innerHTML = `<section class="portal-routine-history card"><div class="card-head"><div><h3>Historial de rutinas enviadas</h3><p>Consulta cuándo recibiste cada rutina y qué pasó con ella.</p></div></div>${cards || '<p class="empty">Todavía no tienes rutinas enviadas.</p>'}</section>`;
}
function portalRoutineCard(routine) {
  const todayCompletion = portalRoutineCompletion(routine.id);
  const oferta = ofertaDeRutina(routine.id);
  const exercises = Array.isArray(routine.exercises) ? routine.exercises : [];
  const elapsedBase = Number(todayCompletion?.elapsed_seconds || 0);
  const timer = routineTimerState(routine.id, elapsedBase);
  const elapsed = routineElapsed(routine.id, elapsedBase);
  const started = Boolean(timer) || elapsed > 0;
  const completed = Number(todayCompletion?.completion_percent || 0) >= 100;
  const completedCount = exercises.reduce((total, _, index) => total + (portalExerciseCompleted(routine.id, index, todayCompletion) ? 1 : 0), 0);
  const hoyIso = dateKey(today);
  const feedback = completed ? `<form data-portal-routine-feedback="${routine.id}" class="routine-feedback-form"><strong>¿Cómo te sentiste?</strong><div class="routine-feedback-options"><label>Sensación<select name="feeling"><option value="">Selecciona</option><option value="excelente" ${todayCompletion?.feeling === 'excelente' ? 'selected' : ''}>Excelente</option><option value="bien" ${todayCompletion?.feeling === 'bien' ? 'selected' : ''}>Bien</option><option value="dificil" ${todayCompletion?.feeling === 'dificil' ? 'selected' : ''}>Difícil</option><option value="muy_dificil" ${todayCompletion?.feeling === 'muy_dificil' ? 'selected' : ''}>Muy difícil</option></select></label><label>Dificultad<select name="difficulty"><option value="">Selecciona</option><option value="facil" ${todayCompletion?.difficulty === 'facil' ? 'selected' : ''}>Fácil</option><option value="bien" ${todayCompletion?.difficulty === 'bien' ? 'selected' : ''}>Bien</option><option value="dificil" ${todayCompletion?.difficulty === 'dificil' ? 'selected' : ''}>Difícil</option></select></label></div><label>Comentario <textarea name="feedback" maxlength="500" placeholder="Cuéntale a Eileen cómo fue tu entrenamiento">${escapeHtml(todayCompletion?.feedback || '')}</textarea></label><button type="submit" class="secondary">${todayCompletion?.feedback || todayCompletion?.feeling || todayCompletion?.difficulty ? 'Actualizar feedback' : 'Enviar feedback (opcional)'}</button></form>` : '';
  return `<article class="card portal-routine-card" data-portal-routine-card="${routine.id}"><div class="card-head"><div><h3>${escapeHtml(routine.title)}</h3><p><span class="routine-descripcion">${escapeHtml(routine.description || '')}</span> · ${routine.sessions_per_week} veces por semana</p>${routine.due_on ? `<p class="routine-due${dateOnly(routine.due_on) < hoyIso ? ' overdue' : ''}">${dateOnly(routine.due_on) < hoyIso ? 'Venció el' : 'Para cumplirla antes del'} ${fechaCorta(routine.due_on)}</p>` : ''}</div></div>${oferta ? `<p class="portal-offer-inline">Rutina de hoy en lugar de tu clase: si la cumples hoy, cuenta como clase${oferta.origin === 'client' ? '; si no, la clase se da por perdida' : ''}.</p>` : ''}<div class="routine-round-summary"><strong>${completedCount} de ${exercises.length} ejercicios</strong><span>${completed ? 'Rutina completada hoy' : 'Marca cada ejercicio al terminarlo'}</span></div><div class="routine-timer-row${timer && !timer.paused && timer.startedAt ? ' is-running' : ''}" data-routine-timer="${routine.id}"><span>Tiempo activo <b class="routine-timer-clock" data-timer-display>${formatRoutineElapsed(elapsed)}</b></span><div class="routine-timer-actions"><button type="button" class="primary routine-timer-button" data-start-routine-timer="${routine.id}" data-timer-toggle>${timer && !timer.paused ? 'Cronómetro activo' : started ? '▶ Reanudar entrenamiento' : '▶ Iniciar entrenamiento'}</button><button type="button" class="secondary" data-pause-routine-timer="${routine.id}" ${timer && !timer.paused ? '' : 'hidden'}>⏸ Pausar</button></div></div><div class="routine-countdown" hidden><span>Prepárate</span><strong>3</strong><small>El cronómetro comenzará después de la cuenta regresiva</small></div>${!started && !completed ? '<p class="routine-timer-required">Primero toca “Iniciar entrenamiento”. El tiempo activo se guarda para Eileen.</p>' : ''}<div class="exercise-preview routine-exercise-checks">${portalExerciseRows(exercises, routine.id, todayCompletion)}</div><button type="button" class="primary routine-complete-button" data-complete-routine="${routine.id}" data-completed="${completed}" ${!started || completed ? 'disabled' : ''}>${completed ? 'Rutina completada' : 'Completar rutina'}</button>${feedback}</article>`;
}

function renderOfertasRutina() {
  const ofertas = portalData?.routineOffers || [];
  // Un solo contenedor por vista: encima de las tarjetas del Progreso y encima de la lista de rutinas.
  // Arriba de todo en el Progreso (es lo primero que debe ver); en Rutinas la propia tarjeta de la rutina lo dice.
  for (const [destino, ancla, alInicio] of [['portal-offers-dashboard', document.getElementById('portal-dashboard'), true]]) {
    if (!ancla) continue;
    let contenedor = document.getElementById(destino);
    if (!contenedor) { contenedor = document.createElement('div'); contenedor.id = destino; if (alInicio) ancla.prepend(contenedor); else ancla.before(contenedor); }
    contenedor.innerHTML = ofertas.map(oferta => {
      const hora = new Intl.DateTimeFormat('es-PA', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Panama' }).format(new Date(oferta.starts_at));
            return `<article class="portal-offer-card"><span class="portal-offer-tag">Eileen te dejó una rutina</span><h3>${escapeHtml(oferta.routine_title)}</h3><p>${oferta.origin === 'client' ? `Cancelaste tu clase de hoy (${hora}). Si haces esta rutina <b>hoy</b>, cuenta como tu clase; si no, <b>la clase se da por perdida</b>.` : `En lugar de tu clase de hoy (${hora}), que Eileen no pudo dar. Si la cumples <b>hoy</b>, cuenta como tu clase; mañana ya no vale.`}</p><button type="button" class="primary" data-ir-rutina="${oferta.routine_id}">Ver la rutina e iniciar</button></article>`;
    }).join('');
  }
}

document.addEventListener('click', async event => {
  const ir = event.target.closest('[data-ir-rutina]');
  if (ir) { location.hash = '#portal-routines'; setTimeout(() => document.querySelector(`[data-routine-timer="${ir.dataset.irRutina}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250); return; }
});

function renderPortal() {
  const client = portalData.client;
  const period = portalPeriod();
  const billingPeriodControls = document.getElementById('portal-billing-period');
  if (billingPeriodControls) {
    billingPeriodControls.innerHTML = portalPeriodControlsMarkup('portal-billing-period');
    bindPortalPeriodControls('portal-billing-period');
  }
  const periodMonthInput = document.getElementById('portal-period-month');
  const periodLabel = document.getElementById('portal-period-label');
  const periodDates = document.getElementById('portal-period-dates');
  const periodCutoffButton = document.getElementById('portal-period-cutoff');
  const periodPrevious = document.getElementById('portal-period-previous');
  const periodCurrent = document.getElementById('portal-period-current');
  const periodNext = document.getElementById('portal-period-next');
  if (periodMonthInput) periodMonthInput.value = portalPeriodMonth;
  if (periodLabel) periodLabel.textContent = period.kind === 'cutoff' ? `${period.label} · día ${client.billing_cutoff_day}` : period.label;
  if (periodDates) periodDates.textContent = `${fechaCorta(period.labelFrom || period.from)} al ${fechaCorta(period.to)}`;
  if (periodCutoffButton) {
    periodCutoffButton.textContent = portalPeriodMode === 'cutoff' ? 'Volver al mes' : 'Ver corte actual';
    periodCutoffButton.classList.toggle('active-filter', portalPeriodMode === 'cutoff');
  }
  if (periodPrevious) periodPrevious.textContent = portalPeriodMode === 'cutoff' ? '‹ Corte anterior' : '‹ Mes anterior';
  if (periodNext) {
    periodNext.textContent = portalPeriodMode === 'cutoff' ? 'Corte siguiente ›' : 'Mes siguiente ›';
    periodNext.disabled = portalPeriodMode === 'cutoff' ? portalCutOffset === 0 : portalPeriodMonth >= dateKey(today).slice(0, 7);
  }
  if (periodCurrent) periodCurrent.textContent = portalPeriodMode === 'cutoff' && portalCutOffset === 0 ? 'Corte actual' : 'Período actual';
  const periodSessions = portalPeriodSessions(period);
  const periodComplianceSessions = (portalData.complianceSessions || []).filter(item => portalSessionInPeriod(item.starts_at, period));
  const activities = portalActivities(periodComplianceSessions, period);
  const overall = activities.length ? Math.round(activities.reduce((sum, item) => sum + item.percent, 0) / activities.length) : 0;
  // La tarjeta de saludo sigue el período elegido (mes o corte): antes quedaba fija en "Hola" y 0% porque nada la actualizaba.
  const welcomeName = String(portalData.client?.full_name || '').trim().split(/\s+/)[0];
  const welcomeTitle = document.getElementById('portal-welcome'); if (welcomeTitle) welcomeTitle.textContent = welcomeName ? `Hola, ${welcomeName}` : 'Hola';
  const complianceHero = document.getElementById('portal-compliance'); if (complianceHero) complianceHero.textContent = `${overall}%`;
  const periodMeasured = periodComplianceSessions.filter(item => new Date(item.starts_at) <= today);
  const periodClientCancellations = periodMeasured.filter(item => item.status === 'cancelled' || item.status === 'no_show').length;
  const periodCancellationPercent = periodMeasured.length ? Math.round(periodClientCancellations / periodMeasured.length * 100) : 0;
  const periodReprogrammed = periodSessions.filter(item => item.reprogramada).length;
  const periodInvoices = portalPeriodInvoices(period);
  const periodPackages = portalPeriodPackages(period);
  const monthlyPackages = periodPackages.filter(pack => pack.kind === 'monthly');
  const packagePackages = periodPackages.filter(pack => pack.kind === 'package');
  const principalPackages = monthlyPackages.length ? monthlyPackages : packagePackages;
  const principal = principalPackages.length ? {
    total: principalPackages.reduce((sum, pack) => sum + Number(pack.total_sessions || 0), 0),
    used: principalPackages.reduce((sum, pack) => sum + Number(pack.used_sessions || 0), 0),
    expires: principalPackages.map(pack => pack.expires_on).filter(Boolean).sort()[0] || ''
  } : null;
  const upcoming = periodSessions.filter(item => new Date(item.starts_at) >= today && item.status === 'scheduled').length;
  // El servidor ya manda en balance lo que falta por pagar de verdad: aquí
  // sólo se suma. Antes se sumaba la columna cruda, que en un cobro local vale
  // 0, y el portal decía "estás al día" con la mensualidad sin pagar.
  const pending = periodInvoices.filter(item => item.status === 'pending').reduce((sum, item) => sum + Number(item.balance || 0), 0);
  // Lo primero que quiere saber quien entrena: cuántas clases le quedan. Antes
  // el portal no lo decía en ninguna parte y había que preguntárselo a Eileen.
  const reposicion = periodPackages.find(pack => pack.kind === 'makeup');
  const quedan = pack => Math.max(0, Number(pack.total_sessions) - Number(pack.used_sessions));
  const venceEl = pack => pack.expires_on
    ? `vencen el ${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short', timeZone: 'America/Panama' }).format(new Date(`${String(pack.expires_on).slice(0, 10)}T12:00:00-05:00`))}`
    : 'sin fecha de vencimiento';
  const credito = (portalData.credits || []).reduce((total, item) => total + Number(item.amount), 0);

  const tarjetas = [];
  if (principal) {
    // Las clases están ahí aunque el cobro esté sin pagar: no se le cierra la
    // puerta a nadie. Pero decirlo junto a las clases —y no sólo en Pagos— es
    // lo que hace que se entere quien tiene que enterarse.
    const sinPagar = pending > 0
      ? `<small class="aviso-pago">Pendiente de pago: ${money.format(pending)}</small>` : '';
    tarjetas.push(`<article class="portal-balance-card${pending > 0 ? ' con-aviso' : ''}"><span>${period.kind === 'cutoff' ? 'Saldo del corte' : 'Saldo del mes'}</span><strong>${Math.max(0, principal.total - principal.used)}<em> de ${principal.total}</em></strong><small>${principal.expires ? venceEl({ expires_on: principal.expires }) : 'sin fecha de vencimiento'}</small>${sinPagar}</article>`);
  }
  if (reposicion) {
    tarjetas.push(`<article class="destacada"><span>Clases por reponer</span><strong>${quedan(reposicion)}</strong><small>${venceEl(reposicion)}</small></article>`);
  }
  tarjetas.push(`<article><span>Próximas sesiones</span><strong>${upcoming}</strong><small>en tu agenda</small></article>`);
  tarjetas.push(`<article class="portal-cancel-card${periodClientCancellations ? ' con-aviso' : ''}"><span>Cancelaciones cliente</span><strong>${periodClientCancellations}<em> de ${periodMeasured.length}</em></strong><small>${periodCancellationPercent}% de las sesiones medidas</small></article>`);
  tarjetas.push(`<article class="portal-reprogram-card"><span>Reprogramadas</span><strong>${periodReprogrammed}</strong><small>${period.kind === 'cutoff' ? 'en este corte' : 'en este mes'}</small></article>`);
  if (portalData.routines.length) tarjetas.push(`<article><span>Rutinas activas</span><strong>${portalData.routines.length}</strong><small>asignadas</small></article>`);
  // Rutinas cumplidas en el período elegido (mes o corte), con el tiempo que entrenó cuando usó el cronómetro.
  const rutinasDelPeriodo = (portalData.routineCompletions || []).filter(item => Number(item.completion_percent) > 0 && portalSessionInPeriod(`${String(item.completed_on).slice(0, 10)}T12:00:00-05:00`, period));
  const segundosRutinas = rutinasDelPeriodo.reduce((total, item) => total + Number(item.duration_seconds || 0), 0);
  tarjetas.push(`<article class="portal-routines-done-card"><span>Rutinas cumplidas</span><strong>${rutinasDelPeriodo.length}</strong><small>${period.kind === 'cutoff' ? 'en este corte' : 'en este mes'}${segundosRutinas ? ` · ${duracionLegible(segundosRutinas)} entrenando` : ''}</small></article>`);
  tarjetas.push(`<article class="portal-debt-card${pending > 0 ? ' pendiente' : ' pagado'}"><span>Saldo pendiente</span><strong>${money.format(pending)}</strong><small>${pending > 0 ? `por pagar · ${period.label}` : 'estás al día'}</small></article>`);
  if (credito > 0) tarjetas.push(`<article class="destacada"><span>A tu favor</span><strong>${money.format(credito)}</strong><small>se descuenta del próximo cobro</small></article>`);
  document.getElementById('portal-metrics').innerHTML = tarjetas.join('');
  renderOfertasRutina();
  renderViajePortal();

  renderPortalReports();
  const allActivities = portalActivities();
  const buckets = Array.from({ length: 6 }, (_, index) => { const date = new Date(today.getFullYear(), today.getMonth() - 5 + index, 1, 12); return { key: `${date.getFullYear()}-${date.getMonth()}`, date, values: [] }; });
  allActivities.forEach(item => buckets.find(bucket => bucket.key === `${item.date.getFullYear()}-${item.date.getMonth()}`)?.values.push(item));
  document.getElementById('portal-chart').innerHTML = buckets.map(bucket => {
    const measured = bucket.values.length;
    const completed = bucket.values.filter(item => item.completed).length;
    const percent = measured ? Math.round(bucket.values.reduce((sum, value) => sum + value.percent, 0) / measured) : null;
    const label = measured ? `<b>${percent}%</b><small>${completed}/${measured} cumplidas</small>` : '<b>—</b><small>sin datos</small>';
    return `<div class="chart-column" title="${completed} de ${measured} sesiones medibles · ${percent === null ? 'sin datos' : `${percent}% promedio`}"><span>${label}</span><i style="height:${Math.max(4, percent || 0)}%"></i><small>${monthLabel(bucket.date)}</small></div>`;
  }).join('');
  document.getElementById('portal-inbody').innerHTML = portalData.assessments.length ? `<div class="portal-inbody-grid">${portalData.assessments.slice(-4).reverse().map(item => `<article><span>${String(item.tested_at).slice(0, 10)}</span><b>${Number(item.values.weightKg || 0).toFixed(1)} kg</b><small>${Number(item.values.percentBodyFat || 0).toFixed(1)}% grasa · ${Number(item.values.skeletalMuscleMassKg || 0).toFixed(1)} kg músculo</small></article>`).join('')}</div>` : '<p class="empty">Todavía no hay evaluaciones confirmadas.</p>';
  document.getElementById('portal-routines-list').innerHTML = portalData.routines.length ? portalData.routines.map(portalRoutineCard).join('') : '<p class="empty">La entrenadora todavía no te ha asignado una rutina.</p>';
  portalRoutineHistoryMarkup();
  const ownSessions = new Map(portalData.sessions.map(item => [item.id, portalSession(item)]));
  renderPortalCalendar(ownSessions);
  document.getElementById('portal-plan').innerHTML = `<span class="commercial-label ${client.billing_model === 'package' ? 'package-label' : ''}">${client.payment_mode === 'no_anticipado' ? 'Crédito por sesión' : client.billing_model === 'package' ? 'Paquete' : 'Mensualidad'}</span><div><h3>${escapeHtml(client.plan_name || 'Plan personalizado')}</h3><p>${client.payment_mode === 'no_anticipado' ? `${money.format(Number(client.credit_session_price || 25))} por sesión · corte día ${client.billing_cutoff_day}` : `${money.format(Number(client.standard_price))}${client.billing_model === 'monthly' ? ` · corte día ${client.billing_cutoff_day}` : ` · ${client.sessions_included || 0} sesiones`}`}</p></div>`;
  // Pagos usa el mismo período elegido en el portal. En modo corte, la fecha
  // de inicio es inclusiva: una factura emitida exactamente en el corte
  // pertenece a ese ciclo, igual que los demás datos de facturación.
  const historyInvoices = periodInvoices.slice().sort((a, b) => new Date(b.issued_on || b.due_on) - new Date(a.issued_on || a.due_on));
  // El aviso de deuda es global: cambiar el período de consulta no debe
  // ocultar una factura pendiente de un ciclo anterior.
  const pendingInvoices = (portalData.invoices || []).filter(invoice => invoice.status === 'pending');
  document.getElementById('portal-pending-payment').innerHTML = pendingInvoices.length ? `<div class="portal-payment-alert"><strong>Pago pendiente</strong><span>${pendingInvoices.length === 1 ? `Tienes 1 factura pendiente por ${money.format(Number(pendingInvoices[0].balance || pendingInvoices[0].amount))}.` : `Tienes ${pendingInvoices.length} facturas pendientes por ${money.format(pendingInvoices.reduce((sum, invoice) => sum + Number(invoice.balance || invoice.amount), 0))}.`}</span></div>` : '<div class="portal-payment-ok">No tienes pagos pendientes.</div>';
  // Beneficiario que no paga (módulo nuevo, tras el corte): solo ve si su plan está cubierto o si hay un pago pendiente de quien lo paga;
  // nunca montos, saldos ni el nombre del pagador.
  if (portalData.billingNotice) {
    const pendiente = portalData.billingNotice.kind === 'pago_pendiente';
    const card = `<div class="${pendiente ? 'portal-payment-alert' : 'portal-payment-ok'}">${pendiente ? '<strong>Pago pendiente</strong><span>' : '<span>'}${escapeHtml(portalData.billingNotice.message)}</span></div>`;
    // Sin facturas propias, el aviso REEMPLAZA el "No tienes pagos pendientes" (dos mensajes seguidos se contradecirían).
    if (pendingInvoices.length) document.getElementById('portal-pending-payment').insertAdjacentHTML('beforeend', `<div style="margin-top:10px">${card}</div>`);
    else document.getElementById('portal-pending-payment').innerHTML = card;
  }
  const invoicesSorted = historyInvoices;
  const invoiceDate = invoice => { const raw = invoice.issued_on || invoice.due_on; return raw ? fechaCorta(raw) : '—'; };
  document.getElementById('portal-invoices').innerHTML = invoicesSorted.length ? invoicesSorted.map(invoice => { const lines = (invoice.line_items || invoice.lineItems || []).map(line => `${escapeHtml(line.name || 'Sesión')} · ${money.format(Number(line.item_total || line.amount || 0))}`).join('<br>'); const estado = Number(invoice.amount) === 0 ? 'Sin cargo' : invoice.status === 'confirmed' ? 'Pagada' : invoice.status === 'void' ? 'Anulada' : 'Pago pendiente'; return `<tr><td data-label="Concepto"><b>${escapeHtml(invoice.concept)}</b>${lines ? `<br><small class="invoice-line-detail">${lines}</small>` : ''}${invoice.invoice_number ? `<br><small>${escapeHtml(invoice.invoice_number)}</small>` : ''}</td><td data-label="Fecha">${invoiceDate(invoice)}</td><td data-label="Monto">${money.format(Number(invoice.amount))}</td><td data-label="Estado"><span class="estado-chip ${Number(invoice.amount) === 0 ? 'anulada' : invoice.status === 'confirmed' ? 'pagada' : invoice.status === 'void' ? 'anulada' : 'pago-pendiente'}">${estado}</span></td><td data-label="Comprobante"><button class="secondary session-use" data-invoice-pdf="${invoice.id}" data-invoice-number="${escapeHtml(invoice.invoice_number || invoice.id.slice(0, 8))}">Ver PDF</button></td></tr>`; }).join('') : '<tr><td colspan="5" class="empty">No hay facturas registradas.</td></tr>';
  const portalCount = document.getElementById('portal-notification-count'); portalCount.textContent = portalData.notifications.length; portalCount.hidden = !portalData.notifications.length;
}
async function loadPortalData() {
  const [summary, notifications, routineOffers] = await Promise.all([api('/api/portal/summary'), api('/api/notifications'), api('/api/portal/routine-offers').catch(() => [])]);
  portalData = { ...summary, notifications, routineOffers };
  // El expediente es la fuente de verdad del nombre. El usuario del portal
  // puede conservar un nombre antiguo, por eso se actualiza también el menú y
  // el avatar después de leer el expediente.
  if (currentUser && portalData.client?.full_name) {
    currentUser.fullName = portalData.client.full_name;
    currentUser.full_name = portalData.client.full_name;
    document.getElementById('portal-account-button').textContent = initials(portalData.client.full_name);
  }
  renderPortal(); showPendingBrowserNotification(notifications);
}
async function enterPortal(user) {
  const restoredView = portalViewFromHash(); currentUser = user; portalView(restoredView);
  document.getElementById('auth-screen').hidden = true; document.getElementById('app-shell').hidden = true; document.getElementById('portal-shell').hidden = false;
  document.getElementById('portal-account-button').textContent = initials(user.fullName || user.full_name || user.email);
  await loadPortalData(); portalNavigate(restoredView, { replace: true });
}
document.querySelectorAll('[data-portal-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); portalNavigate(link.dataset.portalView); }));
document.querySelectorAll('[data-portal-view-go]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); portalNavigate(link.dataset.portalViewGo); }));
document.getElementById('portal-notification-button').addEventListener('click', () => notificationCenter(true));
document.getElementById('portal-add-weight').addEventListener('click', portalWeightModal);
bindPortalPeriodControls('portal-period');
async function savePortalRoutineExercise(card, routineId, exerciseIndex, completed, completeAll = false) {
  const completion = portalRoutineCompletion(routineId);
  const elapsedBase = Number(completion?.elapsed_seconds || 0);
  const boxes = [...card.querySelectorAll('[data-portal-routine-exercise]')];
  const willComplete = completeAll || (completed && boxes.length > 0 && boxes.every(box => box.checked));
  const timerStarted = Boolean(routineTimerState(routineId, elapsedBase)) || elapsedBase > 0;
  if (willComplete && !timerStarted) {
    toast('Inicia el cronómetro antes de completar esta rutina', true);
    return;
  }
  const elapsedSeconds = routineElapsed(routineId, elapsedBase);
  card.classList.add('loading-state');
  try {
    const resultado = await api('/api/portal/routine-exercise-completions', { method: 'POST', body: {
      routineId, completedOn: dateKey(today), exerciseIndex, completed, completeAll, elapsedSeconds
    } });
    if (resultado.routineCompleted) stopRoutineTimer(routineId, elapsedSeconds);
    await loadPortalData();
    if (resultado.routineCompleted) showRoutineCelebration(card.querySelector('h3')?.textContent || 'Rutina', resultado.completedCount, resultado.totalExercises, elapsedSeconds);
    toast(resultado.routineCompleted ? `Ronda completada · ${formatRoutineElapsed(elapsedSeconds)}` : 'Ejercicio guardado');
  } catch (error) {
    card.classList.remove('loading-state');
    toast(error.message, true);
  }
}
document.addEventListener('click', event => {
  const start = event.target.closest('[data-start-routine-timer]');
  if (start) {
    const card = start.closest('[data-portal-routine-card]');
    if (card) void runRoutineCountdown(card, start.dataset.startRoutineTimer, Number(start.dataset.elapsedSeconds || 0)).then(started => {
      if (started) {
        start.disabled = true; start.textContent = 'Cronómetro activo'; card.querySelector('.routine-timer-row')?.classList.add('is-running');
        // La tarjeta no se vuelve a dibujar al arrancar: sin esto, "Pausar" y "Completar rutina" no aparecían hasta marcar un ejercicio.
        const pausa = card.querySelector('[data-pause-routine-timer]'); if (pausa) { pausa.hidden = false; pausa.disabled = false; }
        const completar = card.querySelector('[data-complete-routine]'); if (completar && completar.dataset.completed !== 'true') completar.disabled = false;
        card.querySelector('.routine-timer-required')?.remove();
      }
    });
    return;
  }
  const pause = event.target.closest('[data-pause-routine-timer]');
  if (pause) {
    const routineId = pause.dataset.pauseRoutineTimer; pause.disabled = true;
    pauseRoutineTimer(routineId, Number(portalRoutineCompletion(routineId)?.elapsed_seconds || 0));
    void loadPortalData();
    return;
  }
  const complete = event.target.closest('[data-complete-routine]');
  if (complete && !complete.disabled) {
    const card = complete.closest('[data-portal-routine-card]');
    if (card) void savePortalRoutineExercise(card, complete.dataset.completeRoutine, undefined, true, true);
  }
});
document.addEventListener('change', event => {
  const checkbox = event.target.closest('[data-portal-routine-exercise]');
  if (!checkbox) return;
  const card = checkbox.closest('[data-portal-routine-card]');
  if (!card) return;
  const routineId = checkbox.dataset.portalRoutineExercise;
  const completion = portalRoutineCompletion(routineId);
  if (checkbox.checked && !routineTimerState(routineId, completion?.elapsed_seconds || 0) && !(Number(completion?.elapsed_seconds) > 0)) {
    checkbox.checked = false;
    toast('Inicia el cronómetro antes de marcar ejercicios', true);
    return;
  }
  void savePortalRoutineExercise(card, routineId, Number(checkbox.dataset.exerciseIndex), checkbox.checked);
});
document.addEventListener('submit', async event => {
  const feedbackForm = event.target.closest('[data-portal-routine-feedback]');
  if (feedbackForm) {
    event.preventDefault(); const form = new FormData(feedbackForm);
    try {
      feedbackForm.classList.add('loading-state');
      await api('/api/portal/routine-feedback', { method: 'POST', body: { routineId: feedbackForm.dataset.portalRoutineFeedback, completedOn: dateKey(today), feeling: form.get('feeling') || undefined, difficulty: form.get('difficulty') || undefined, feedback: form.get('feedback') || undefined } });
      await loadPortalData(); toast('Feedback enviado a Eileen');
    } catch (error) { toast(error.message, true); feedbackForm.classList.remove('loading-state'); }
    return;
  }
  const sessionForm = event.target.closest('[data-portal-session]'); if (!sessionForm) return;
  event.preventDefault(); const form = sessionForm; const completed = form.elements.completed.checked; const completionPercent = completed ? Number(form.elements.completionPercent.value) : 0;
  try {
    form.classList.add('loading-state');
    const resultado = await api(`/api/portal/sessions/${sessionForm.dataset.portalSession}/compliance`, { method: 'PATCH', body: { completed, completionPercent } });
    await loadPortalData(); toast(mensajeDeSaldo(resultado, 'Cumplimiento actualizado'));
  } catch (error) { toast(error.message, true); form.classList.remove('loading-state'); }
});
window.addEventListener('popstate', () => { if (currentUser?.role === 'client') portalView(portalViewFromHash()); });
window.addEventListener('hashchange', () => { if (currentUser?.role === 'client') portalView(portalViewFromHash()); });

function showAuth(setupRequired) {
  document.getElementById('auth-screen').hidden = false; document.getElementById('app-shell').hidden = true; document.getElementById('portal-shell').hidden = true;
  document.getElementById('setup-form').hidden = !setupRequired; document.getElementById('login-form').hidden = setupRequired; document.getElementById('reset-form').hidden = true;
  document.getElementById('access-link-form').hidden = true;
  document.getElementById('auth-title').textContent = setupRequired ? 'Preparemos tu espacio' : 'Bienvenida de nuevo';
  document.getElementById('auth-copy').textContent = setupRequired ? 'Crea la primera cuenta administradora de Eileen Lifestyle.' : 'Accede al centro de control de clientes, sesiones y facturación.';
}
async function enterApp(user) {
  if (user.role === 'client') return enterPortal(user);
  const restoredView = viewFromHash();
  currentUser = user; view(restoredView); document.getElementById('auth-screen').hidden = true; document.getElementById('portal-shell').hidden = true; document.getElementById('app-shell').hidden = false;
  document.getElementById('account-button').textContent = initials(user.fullName || user.full_name || user.email);
  await loadData(); renderAll(); navigate(restoredView, { replace: true }); showGoogleCalendarReturn(); startCalendarSynchronization();
}
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.target); const errorBox = document.getElementById('login-error'); errorBox.textContent = '';
  try {
    event.target.classList.add('loading-state');
    const result = await api('/api/auth/login', { method: 'POST', auth: false, body: { email: form.get('email'), password: form.get('password') } });
    authToken = result.token; localStorage.setItem(authKey, authToken); await enterApp(result.user);
  } catch (error) { errorBox.textContent = error.message; } finally { event.target.classList.remove('loading-state'); }
});
document.getElementById('show-reset').addEventListener('click', () => {
  document.getElementById('login-form').hidden = true; document.getElementById('reset-form').hidden = false;
  document.getElementById('auth-title').textContent = 'Restablecer acceso'; document.getElementById('auth-copy').textContent = 'Define una contraseña nueva usando el token privado guardado en Railway.';
});
document.getElementById('cancel-reset').addEventListener('click', () => showAuth(false));
document.getElementById('reset-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.target); const errorBox = document.getElementById('reset-error'); errorBox.textContent = '';
  try {
    event.target.classList.add('loading-state');
    const result = await api('/api/auth/reset-password', { method: 'POST', auth: false, headers: { 'x-setup-token': form.get('setupToken') }, body: { email: form.get('email'), password: form.get('password') } });
    authToken = result.token; localStorage.setItem(authKey, authToken); await enterApp(result.user); toast('Contraseña actualizada');
  } catch (error) { errorBox.textContent = error.message; } finally { event.target.classList.remove('loading-state'); }
});
document.getElementById('setup-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.target); const errorBox = document.getElementById('setup-error'); errorBox.textContent = '';
  try {
    event.target.classList.add('loading-state');
    const result = await api('/api/auth/setup', { method: 'POST', auth: false, headers: { 'x-setup-token': form.get('setupToken') }, body: { fullName: form.get('fullName'), email: form.get('email'), password: form.get('password') } });
    authToken = result.token; localStorage.setItem(authKey, authToken); await enterApp(result.user); toast('Cuenta administradora creada');
  } catch (error) { errorBox.textContent = error.message; } finally { event.target.classList.remove('loading-state'); }
});
const logout = () => {
  stopCalendarSynchronization();
  localStorage.removeItem(authKey); localStorage.removeItem(legacyAuthKey); authToken = null; currentUser = null; portalData = null;
  data = { clients: [], invoices: [], packages: [], sessions: [], routines: [], plans: [], compliance: { compliancePercent: 0, activities: 0, clients: [] }, notifications: [], googleCalendar: { configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } } }; showAuth(false);
};
// El avatar cerraba la sesión de un toque, sin aviso: un roce al buscar el
// menú te sacaba de la aplicación. Ahora abre la cuenta y salir es explícito.
function accountMenu() {
  const nombre = currentUser?.fullName || currentUser?.full_name || '';
  const rol = currentUser?.role === 'client' ? 'Cliente' : currentUser?.role === 'admin' ? 'Administradora' : 'Entrenadora';
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">TU CUENTA</p><h2>${escapeHtml(nombre || 'Sesión activa')}</h2>
    <div class="account-card"><div><b>${escapeHtml(currentUser?.email || '')}</b><small>${rol}</small></div><span class="initials">${initials(nombre || currentUser?.email || '')}</span></div>
    <button class="secondary wide-button" id="account-logout">Cerrar sesión</button>`;
  openModal(box);
  document.getElementById('account-logout').onclick = () => { modal.close(); logout(); };
}
document.getElementById('account-button').addEventListener('click', accountMenu);
document.getElementById('portal-account-button').addEventListener('click', accountMenu);
document.getElementById('google-calendar-connect').addEventListener('click', googleCalendarAction);
document.getElementById('google-calendar-disconnect').addEventListener('click', disconnectGoogleCalendar);
// El token viaja en el fragmento y no en la ruta: lo que va después de # no
// llega al servidor ni queda en sus registros.
const accessTokenFromHash = () => (location.hash.match(/^#acceso=([A-Za-z0-9]+)$/) || [])[1] || null;

async function showAccessLink(token) {
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app-shell').hidden = true; document.getElementById('portal-shell').hidden = true;
  for (const id of ['login-form', 'setup-form', 'reset-form']) document.getElementById(id).hidden = true;
  const form = document.getElementById('access-link-form'); form.hidden = false;
  const errorBox = document.getElementById('access-link-error');

  try {
    const info = await api(`/api/auth/access-link/${token}`, { auth: false });
    document.getElementById('auth-title').textContent = 'Define tu contraseña';
    document.getElementById('auth-copy').textContent = 'Elige una contraseña para entrar a tu portal. Solo tú la conocerás.';
    document.getElementById('access-link-greeting').textContent = `${info.clientName} · ${info.email}`;
    // La sesión guardada se cierra sólo ahora, con el enlace ya confirmado.
    // Hacerlo antes sacaba de su cuenta a quien tocara un enlace vencido, que
    // suele ser la entrenadora volviendo a un mensaje viejo.
    if (authToken) { localStorage.removeItem(authKey); authToken = null; }
  } catch (error) {
    form.hidden = true;
    document.getElementById('auth-title').textContent = 'Enlace no válido';
    document.getElementById('auth-copy').textContent = error.message;
    document.getElementById('login-form').hidden = false;
    // El enlace inservible se limpia de la barra para que recargar no repita
    // el error, y quede la pantalla normal de acceso.
    history.replaceState(null, '', location.pathname);
    // Si había sesión, no se perdió: se continúa con ella.
    if (authToken) {
      const actual = await api('/api/me').catch(() => null);
      if (actual) { form.hidden = true; return enterApp(actual.user); }
    }
    return;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault(); errorBox.textContent = '';
    const values = new FormData(event.target);
    if (values.get('password') !== values.get('confirm')) { errorBox.textContent = 'Las dos contraseñas no coinciden.'; return; }
    try {
      event.target.classList.add('loading-state');
      const result = await api(`/api/auth/access-link/${token}`, { method: 'POST', auth: false, body: { password: values.get('password') } });
      authToken = result.token; localStorage.setItem(authKey, authToken);
      history.replaceState(null, '', location.pathname);
      form.hidden = true;
      await enterApp(result.user);
      toast('Contraseña guardada');
    } catch (error) { errorBox.textContent = error.message; event.target.classList.remove('loading-state'); }
  }, { once: false });
}

// ── Rutina por enlace (página pública, sin cuenta) ──────────────────────────────────────────────
const rutinaPublicaDelHash = () => (location.hash.match(/^#rutina=([A-Za-z0-9_-]{30,80})$/) || [])[1] || null;
async function mostrarRutinaPublica(token) {
  publicRoutineToken = token;
  for (const id of ['auth-screen', 'app-shell', 'portal-shell']) document.getElementById(id).hidden = true;
  const raiz = document.getElementById('public-routine'); raiz.hidden = false;
  const claveReloj = `eileen-cronometro-enlace-${token.slice(0, 12)}`;
  const marca = '<div class="public-brand"><span class="brand-mark">EL</span><span>Eileen <b>Lifestyle</b></span></div>';
  try {
    const vista = await api(`/api/public/routine/${token}`, { auth: false });
    const rutina = vista.routine; const ejercicios = Array.isArray(rutina.exercises) ? rutina.exercises : [];
    const catalogo = (vista.exercises || []).map(item => ({ ...item, hasVideo: item.has_video }));
    const hoyClase = (vista.classes || []).find(item => item.dia === vista.today && item.status === 'scheduled');
    const proximas = (vista.classes || []).filter(item => item.status === 'scheduled' && item.dia !== vista.today);
    raiz.innerHTML = `${marca}
      <article class="public-card"><p class="eyebrow">TU RUTINA</p><h1>Hola, ${escapeHtml(vista.clientFirstName)}</h1><h2>${escapeHtml(rutina.title)}</h2>
        ${rutina.description ? `<p class="public-instrucciones routine-descripcion">${escapeHtml(rutina.description)}</p>` : ''}
        ${hoyClase ? `<p class="portal-offer-inline">Hoy tienes clase a las ${escapeHtml(hoyClase.hora)}: <b>si confirmas esta rutina hoy, cuenta como tu clase</b>.</p>`
          : proximas.length ? `<p class="portal-offer-inline">Tus próximas clases durante el viaje: ${proximas.slice(0, 4).map(item => `${fechaCorta(`${item.dia}T12:00:00-05:00`)} ${escapeHtml(item.hora)}`).join(' · ')}. Confirma tu rutina <b>el día de cada clase</b> para que cuente.</p>` : ''}
        <div class="routine-timer" id="public-timer"><span class="routine-timer-display" id="public-reloj">00:00</span><button type="button" class="primary routine-timer-button" id="public-toggle">▶ Iniciar rutina</button></div>
        <div class="exercise-preview">${exerciseRows(ejercicios, catalogo, 'pub')}</div>
        <div id="public-final">${vista.completedToday ? '<p class="portal-payment-ok">Ya confirmaste esta rutina hoy. ¡Gracias!</p>' : ''}
          <label class="completion-percent public-porcentaje"><input id="public-pct" type="number" min="1" max="100" value="100" /><span>% completado</span></label>
          <button type="button" class="primary wide-button" id="public-terminar">Terminé mi rutina</button></div>
        <small class="public-vigencia">Este enlace vale hasta el ${venceTexto(vista.expiresAt)}</small>
      </article>`;
    const reloj = () => { try { return JSON.parse(localStorage.getItem(claveReloj) || 'null'); } catch { return null; } };
    const pintar = () => {
      const r = reloj(); const caja = document.getElementById('public-timer'); if (!caja) return;
      document.getElementById('public-reloj').textContent = r ? relojTexto((Date.now() - r.startedAt) / 1000) : '00:00';
      const boton = document.getElementById('public-toggle'); boton.textContent = r ? '■ Detener cronómetro' : '▶ Iniciar rutina';
      boton.classList.toggle('en-marcha', Boolean(r)); caja.classList.toggle('corriendo', Boolean(r));
    };
    pintar(); const reloj1 = setInterval(pintar, 1000);
    document.getElementById('public-toggle').onclick = () => {
      if (reloj()) localStorage.removeItem(claveReloj); else localStorage.setItem(claveReloj, JSON.stringify({ startedAt: Date.now() }));
      pintar();
    };
    document.getElementById('public-terminar').onclick = async event => {
      const boton = event.currentTarget; boton.disabled = true;
      const r = reloj(); const segundos = r ? Math.min(21600, Math.max(1, Math.floor((Date.now() - r.startedAt) / 1000))) : undefined;
      try {
        const resultado = await api(`/api/public/routine/${token}/complete`, { method: 'POST', auth: false, body: { completionPercent: Number(document.getElementById('public-pct').value) || 100, durationSeconds: segundos } });
        localStorage.removeItem(claveReloj); clearInterval(reloj1);
        document.getElementById('public-timer').hidden = true;
        document.getElementById('public-final').innerHTML = `<p class="portal-payment-ok"><b>¡Listo!</b> Eileen ya sabe que terminaste${segundos ? ` en ${duracionLegible(segundos)}` : ''}.${resultado.sessionCompleted ? ' Cuenta como tu clase de hoy.' : ''}</p>`;
      } catch (error) { toast(error.message, true); boton.disabled = false; }
    };
  } catch (error) {
    raiz.innerHTML = `${marca}<article class="public-card"><p class="eyebrow">ENLACE</p><h2>No se puede abrir la rutina</h2><p class="public-instrucciones">${escapeHtml(error.message)}</p></article>`;
  }
}

async function start() {
  const accessToken = accessTokenFromHash();
  // Se atiende antes que la sesión guardada: quien abre un enlace de acceso
  // quiere entrar como el cliente del enlace, no como quien quedó logueado en
  // ese teléfono —que muy probablemente sea la entrenadora.
  if (accessToken) return showAccessLink(accessToken);
  const rutinaPublica = rutinaPublicaDelHash();
  if (rutinaPublica) return mostrarRutinaPublica(rutinaPublica);
  try {
    const status = await api('/api/auth/setup-status', { auth: false });
    if (!authToken) return showAuth(status.required);
    const result = await api('/api/me');
    // La sesión se renueva sola al abrir la aplicación: sólo caduca tras 30
    // días sin usarla.
    if (result.token) { authToken = result.token; localStorage.setItem(authKey, authToken); }
    await enterApp(result.user);
  } catch (error) { showAuth(false); document.getElementById('login-error').textContent = authToken ? 'La sesión venció. Inicia sesión nuevamente.' : 'No fue posible conectar con el servidor.'; }
}
start();
