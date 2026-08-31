const APP_VERSION = '109';
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
let data = { clients: [], invoices: [], packages: [], sessions: [], routines: [], plans: [], compliance: { compliancePercent: 0, activities: 0, clients: [] }, notifications: [], googleCalendar: { configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } } };
let portalData = null;
let compliancePeriod = 'week';
let billingMonth = String(today.getMonth() + 1);
let billingYear = String(today.getFullYear());
let billingSource = 'all';
let billingVisibleInvoices = 100;
let billingAnalytics = null;
let billingAnalyticsLoadingYear = null;
let billingAnalyticsRequest = 0;
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
      throw new Error(payload.error || 'No fue posible completar la solicitud');
    }
    return payload;
  })();

  if (clave) {
    peticionesEnVuelo.set(clave, enCurso);
    enCurso.catch(() => {}).finally(() => peticionesEnVuelo.delete(clave));
  }
  return enCurso;
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

const exerciseLabel = exercise => typeof exercise === 'string' ? exercise : [exercise.name, exercise.sets && setsLabel(exercise.sets), exercise.reps, exercise.weight].filter(Boolean).join(' · ');
const sessionFromApi = item => {
  const starts = panamaDateTimeParts(item.starts_at);
  return {
    id: item.id, clientId: item.client_id, client: item.full_name, routineId: item.routine_id,
    date: starts.date, time: starts.time, durationMinutes: Number(item.duration_minutes || 60),
    routine: item.routine_title || 'Evaluación / seguimiento', mode: item.mode, status: item.status,
    completionPercent: Number(item.completion_percent || 0), notes: item.notes || '',
    googleSynced: Boolean(item.google_event_id), googleEventLink: item.google_event_link || '',
    googleSyncError: item.google_sync_error || ''
  };
};
async function refreshSessions() {
  data.sessions = (await api('/api/sessions')).map(sessionFromApi);
}
async function refreshGoogleCalendarState() {
  data.googleCalendar = await api('/api/integrations/google-calendar/status').catch(() => ({ configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } }));
}
async function loadData() {
  const [clients, invoices, packages, sessions, routines, plans, compliance, notifications, googleCalendar, catalog] = await Promise.all([
    api('/api/clients'), api('/api/invoices'), api('/api/packages'), api('/api/sessions'), api('/api/routines'),
    api('/api/plans'),
    api(`/api/compliance/summary?period=${compliancePeriod}`).catch(() => ({ compliancePercent: 0, activities: 0, clients: [] })),
    api('/api/notifications').catch(() => []),
    api('/api/integrations/google-calendar/status').catch(() => ({ configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } })),
    // El catálogo iba en un segundo viaje, después de esperar a los otros
    // nueve: un viaje de ida y vuelta entero por nada.
    api('/api/exercises').catch(() => null)
  ]);
  exerciseCatalog = catalog ? catalog.map(exercise => ({
    id: exercise.id, slug: exercise.slug, name: exercise.name, english: exercise.english || '',
    section: exercise.section, pattern: exercise.pattern || '', level: exercise.level,
    machine: exercise.machine || 'No aplica', freeWeight: exercise.free_weight || 'No aplica',
    cues: exercise.cues || '', usesWeight: Boolean(exercise.uses_weight), hasVideo: Boolean(exercise.has_video),
    videoDurationSeconds: exercise.video_duration_seconds ? Number(exercise.video_duration_seconds) : null
  })) : fallbackCatalog;
  const assessments = await Promise.all(clients.map(client => api(`/api/clients/${client.id}/inbody`)));
  data.clients = clients.map((client, index) => {
    const readyAssessments = assessments[index].assessments.filter(item => item.extraction_status === 'ready');
    // El delta se calcula sobre el historial ya filtrado a 'ready'. El campo
    // changes que manda la API compara contra la medición inmediatamente
    // anterior aunque esté en revisión, y entonces no cuadraría con las filas
    // que la pantalla muestra.
    const history = readyAssessments.map((item, position, all) => {
      const previous = all[position - 1];
      const reading = {
        id: item.id, documentId: item.document_id || null,
        date: String(item.tested_at).slice(0, 10), weight: Number(item.values.weightKg), smm: Number(item.values.skeletalMuscleMassKg),
        fat: Number(item.values.bodyFatMassKg), pbf: Number(item.values.percentBodyFat), score: Number(item.values.inBodyScore)
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
    const inbodyReviews = assessments[index].assessments.filter(item => item.extraction_status === 'review');
    return { id: client.id, name: client.full_name, goal: client.goal || 'Sin meta definida', billingModel: client.billing_model, plan: Number(client.standard_price), planId: client.plan_id, planName: client.plan_name, cutoffDay: Number(client.billing_cutoff_day || 1), sessionsIncluded: Number(client.sessions_included || 0), validityDays: Number(client.validity_days || 0), email: client.email || '', phone: client.phone || '', notes: client.notes || '', monthlySessionTarget: client.monthly_session_target ?? null, paysForMeId: client.billing_responsible_client_id || null, portalActive: Boolean(client.portal_user_id), status: { active: 'Activo', paused: 'En pausa', inactive: 'Inactivo' }[client.status] || 'Inactivo', statusRaw: client.status, inbodyReviews, inbody: latest ? { ...latest, history } : null };
  });
  data.invoices = invoices.map(item => ({ id: item.id, clientId: item.client_id, client: item.full_name, concept: item.concept, amount: Number(item.amount), balance: item.source_system ? Number(item.balance) : item.status === 'pending' ? Number(item.amount) : 0, due: dateOnly(item.due_on), issued: dateOnly(item.issued_on || item.due_on), paidOn: item.confirmed_at ? String(item.confirmed_at).slice(0, 10) : '', method: item.payment_method || 'pending', reference: item.payment_reference, status: item.status, source: item.source_system || 'eileen', invoiceNumber: item.invoice_number || '', externalStatus: item.external_status || '' }));
  data.packages = packages.map(item => ({ id: item.id, clientId: item.client_id, client: item.full_name, label: item.label, total: item.total_sessions, used: item.used_sessions, amount: Number(item.amount), expiresOn: item.expires_on || '', status: item.status === 'active' ? 'confirmed' : item.status === 'pending' ? 'pending' : 'expired' }));
  data.sessions = sessions.map(sessionFromApi);
  data.routines = routines.map(item => ({ id: item.id, title: item.title, description: item.description || '', clients: (item.assigned_client_ids || []).length, assignedClientIds: item.assigned_client_ids || [], sessions: item.sessions_per_week, dueOn: item.due_on || null, exercises: item.exercises || [] }));
  data.plans = plans.map(item => ({ id: item.id, name: item.name, description: item.description || '', billingModel: item.billing_model, price: Number(item.price), sessionsIncluded: Number(item.sessions_included || 0), validityDays: Number(item.validity_days || 0), active: item.active }));
  data.compliance = compliance; data.notifications = notifications; data.googleCalendar = googleCalendar; billingAnalytics = null; billingAnalyticsLoadingYear = null; billingAnalyticsRequest += 1; showPendingBrowserNotification(notifications);
}
const initials = name => name.split(' ').slice(0, 2).map(word => word[0]).join('').toUpperCase();
const modalidadPlan = modelo => modelo === 'package' ? 'Paquete' : modelo === 'single' ? 'Sesión suelta' : 'Mensualidad';
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const viewTitles = { dashboard: 'Buenos días', clients: 'Clientes', calendar: 'Agenda', routines: 'Rutinas', billing: 'Facturación' };
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
  const hash = `#${target}`;
  if (window.location.hash !== hash) window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
};
const monthInvoices = () => data.invoices.filter(invoice => { const date = new Date(`${invoice.issued || invoice.due}T12:00:00`); return date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear(); });
const invoicePeriodDate = invoice => new Date(`${invoice.issued || invoice.due}T12:00:00`);
const billingPeriodInvoices = () => data.invoices.filter(invoice => {
  const date = invoicePeriodDate(invoice);
  const matchesYear = billingYear === 'all' || date.getFullYear() === Number(billingYear);
  const matchesMonth = billingMonth === 'all' || date.getMonth() + 1 === Number(billingMonth);
  const matchesSource = billingSource === 'all' || (billingSource === 'eileen' ? invoice.source !== 'zoho_invoice' : invoice.source === billingSource);
  return matchesYear && matchesMonth && matchesSource;
}).sort((a, b) => invoicePeriodDate(b) - invoicePeriodDate(a));
const remainingSessions = pack => Math.max(0, pack.total - pack.used);
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
const calendarPeriodLabel = ({ start, end }) => {
  if (calendarMode === 'day') return capitalized(new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }).format(start));
  if (calendarMode === 'month') return capitalized(new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(start));
  const last = addDays(end, -1);
  if (start.getMonth() === last.getMonth()) return `${start.getDate()}–${last.getDate()} de ${new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(last)}`;
  return `${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short' }).format(start)} – ${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short', year: 'numeric' }).format(last)}`;
};
const sessionsThisWeek = () => { const start = mondayFor(today); const end = new Date(start); end.setDate(start.getDate() + 7); return data.sessions.filter(session => { const date = new Date(`${session.date}T12:00:00`); return date >= start && date < end; }); };
const sessionStateLabel = session => session.status === 'completed' ? 'Realizada' : session.status === 'no_show' ? 'No cumplió' : session.status === 'cancelled' ? 'Cancelada' : 'Programada';
const sessionComplianceForm = session => `<form class="session-compliance" data-session-compliance="${session.id}"><label class="completion-check"><input name="completed" type="checkbox" ${session.status === 'completed' ? 'checked' : ''} /><span>Cumplió</span></label><label class="completion-percent"><input name="completionPercent" type="number" min="0" max="100" value="${session.status === 'completed' ? session.completionPercent || 100 : 0}" /><span>%</span></label><button class="secondary" title="Guardar cumplimiento">Guardar</button></form>`;
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
  document.getElementById('today-sessions').innerHTML = todaySessions.length ? todaySessions.map(session => `<div class="agenda-item"><span class="agenda-time">${session.time}</span><div><b>${escapeHtml(session.client)}</b><span>${session.routine} · ${session.mode.toLowerCase()}</span></div><span class="session-state ${session.status}">${sessionStateLabel(session)}</span></div>`).join('') : '<p class="empty">No hay sesiones para hoy.</p>';
  const noInbody = data.clients.filter(client => !client.inbody).map(client => `<div class="alert-item"><b>${escapeHtml(client.name)}</b><span>Sin evaluación InBody registrada.</span></div>`).join('');
  document.getElementById('alerts').innerHTML = `${noInbody || '<div class="alert-item"><b>Todo al día</b><span>No hay alertas de seguimiento.</span></div>'}<div class="alert-item"><b>${data.invoices.filter(item => item.status === 'pending').length} cobro pendiente</b><span>Revisa pagos y comprobantes.</span></div>`;
  document.getElementById('compliance-list').innerHTML = data.compliance.clients.length ? data.compliance.clients.map(client => `<div class="compliance-row"><span class="initials">${escapeHtml(initials(client.name))}</span><div><b>${escapeHtml(client.name)}</b><small>${client.completed} de ${client.activities} actividades con avance${client.late ? ` · ${client.late} fuera de fecha` : ''}${client.missed ? ` · ${client.missed} sin hacer` : ''}</small><span class="compliance-track"><i style="width:${client.compliancePercent}%"></i></span></div><strong>${client.compliancePercent}%</strong></div>`).join('') : '<p class="empty">Aún no hay entrenamientos vencidos en este período.</p>';
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
    const commercial = client.billingModel === 'package'
      ? `<span class="commercial-label package-label">Paquete</span><b>${pack?.status === 'pending' ? 'Pago pendiente' : `${pack ? remainingSessions(pack) : client.sessionsIncluded || 0} sesiones disponibles`}</b><small>${escapeHtml(client.planName || 'Plan por sesiones')} · ${money.format(client.plan)}</small>`
      : client.billingModel === 'single'
      ? `<span class="commercial-label single-label">Sesión suelta</span><b>${escapeHtml(client.planName || 'Sesiones individuales')} · ${money.format(client.plan)}</b><small>Por sesión, sin corte mensual</small>`
      : `<span class="commercial-label">Mensualidad</span><b>${escapeHtml(client.planName || 'Mensualidad')} · ${money.format(client.plan)}</b><small>Corte día ${client.cutoffDay}</small>`;
    return `<article class="client-card"><header><span class="initials">${escapeHtml(initials(client.name))}</span><div><h3>${escapeHtml(client.name)}</h3><small>${escapeHtml(client.goal)}</small></div><span class="status estado-${client.statusRaw}">${client.status}</span></header><p>${client.inbody ? `Último InBody: ${client.inbody.date}` : 'Aún no se ha cargado un InBody.'}${client.portalActive ? ' · Portal activo' : ''}</p><div class="commercial-summary">${commercial}</div><div class="mini-data">${client.inbody ? `<div><b>${client.inbody.weight} kg</b><span>Peso</span></div><div><b>${client.inbody.smm} kg</b><span>Músculo</span></div><div><b>${client.inbody.pbf}%</b><span>Grasa</span></div>` : `<div><b>—</b><span>Evaluación pendiente</span></div>`}</div><div class="client-actions"><button class="secondary" data-client="${client.id}">Ver expediente</button><button class="secondary" data-edit-client="${client.id}">Editar</button><button class="secondary" data-inbody="${client.id}">+ InBody</button></div></article>`;
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
function renderCalendar() {
  const grid = document.getElementById('week-calendar');
  const range = calendarRange();
  const visibleSessions = sessionsBetween(range.start, range.end);
  document.getElementById('calendar-period').textContent = calendarPeriodLabel(range);
  document.querySelectorAll('[data-calendar-mode]').forEach(button => {
    const active = button.dataset.calendarMode === calendarMode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  if (calendarMode === 'day') {
    const key = dateKey(range.start);
    const sessions = visibleSessions.filter(session => session.date === key);
    grid.className = 'calendar-grid calendar-day';
    grid.innerHTML = `<div class="day-focus"><span>${new Intl.DateTimeFormat('es-PA', { weekday: 'long' }).format(range.start)}</span><strong>${range.start.getDate()}</strong><small>${capitalized(new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(range.start))}</small></div><div class="day-timeline">${sessions.length ? sessions.map(session => `<article class="day-session ${session.status}"><time>${session.time}</time><div><b>${escapeHtml(session.client)}</b><span>${session.routine}</span><small>${session.mode}</small></div><span class="session-state ${session.status}">${sessionStateLabel(session)}</span></article>`).join('') : '<div class="calendar-empty"><b>Día disponible</b><span>No hay sesiones programadas.</span><button class="secondary" data-action="new-session">+ Agendar sesión</button></div>'}</div>`;
  } else if (calendarMode === 'week') {
    const names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    grid.className = 'calendar-grid calendar-week';
    grid.innerHTML = names.map((name, index) => {
      const date = addDays(range.start, index); const key = dateKey(date);
      const sessions = visibleSessions.filter(session => session.date === key);
      return `<button type="button" class="day-col ${key === dateKey(today) ? 'today' : ''} ${key === dateKey(calendarCursor) ? 'selected' : ''}" data-calendar-date="${key}"><span class="day-name">${name}</span><span class="day-num">${date.getDate()}</span>${sessions.map(session => `<span class="session-chip ${session.status}"><b>${session.time}</b> ${session.client.split(' ')[0]}</span>`).join('')}</button>`;
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
      return `<button type="button" class="month-day ${date.getMonth() !== calendarCursor.getMonth() ? 'outside' : ''} ${key === dateKey(today) ? 'today' : ''}" data-calendar-date="${key}"><span class="month-day-number">${date.getDate()}</span><span class="month-events">${sessions.slice(0, 2).map(session => `<span class="month-event ${session.status}"><i></i><b>${session.time}</b> ${session.client.split(' ')[0]}</span>`).join('')}${sessions.length > 2 ? `<small>+${sessions.length - 2} más</small>` : ''}</span></button>`;
    }).join('')}`;
  }
  const periodName = calendarMode === 'day' ? 'del día' : calendarMode === 'week' ? 'de la semana' : 'del mes';
  document.getElementById('session-control-title').textContent = `Sesiones ${periodName}`;
  document.getElementById('session-control-copy').textContent = visibleSessions.length ? `${visibleSessions.length} sesión${visibleSessions.length !== 1 ? 'es' : ''} en el período visible` : 'No hay sesiones en el período visible';
  document.getElementById('session-list').innerHTML = visibleSessions.length ? visibleSessions.map(session => `<div class="session-row"><div class="session-date"><b>${new Intl.DateTimeFormat('es-PA', { weekday: 'short', day: 'numeric' }).format(new Date(`${session.date}T12:00:00`))}</b><span>${session.time} · ${session.durationMinutes} min</span></div><div class="session-person"><b>${escapeHtml(session.client)}</b><span>${session.routine} · ${session.mode}</span>${data.googleCalendar.connected ? `<small class="google-session-state ${session.googleSyncError ? 'error' : session.googleSynced ? 'synced' : ''}">${session.googleSyncError ? 'Google pendiente' : session.googleSynced ? 'Google Calendar ✓' : 'Por sincronizar'}</small>` : ''}</div><span class="session-state ${session.status}">${sessionStateLabel(session)}</span>${session.status === 'cancelled' ? `<div class="session-management"><button type="button" class="secondary" data-purge-session="${session.id}">Quitar de la agenda</button></div>` : `<div class="session-management"><button type="button" class="secondary edit-session" data-edit-session="${session.id}">Editar horario</button><button type="button" class="secondary" data-cancel-session="${session.id}">Cancelar</button><button type="button" class="secondary" data-purge-session="${session.id}">Eliminar</button>${sessionComplianceForm(session)}</div>`}</div>`).join('') : `<p class="empty">No hay sesiones programadas ${periodName}.</p>`;
}
const routineVideoCount = routine => (routine.exercises || []).filter(exercise => {
  const entry = exerciseCatalog.find(item => item.id === exercise.catalogId || item.slug === exercise.catalogId);
  return entry?.hasVideo;
}).length;

function renderRoutines() {
  document.getElementById('routine-grid').innerHTML = data.routines.map(routine => `<article class="routine-card"><span class="routine-icon">⌁</span><h3>${escapeHtml(routine.title)}</h3><p>${escapeHtml(routine.description)}</p>${routine.exercises.length ? `<div class="exercise-preview">${routine.exercises.slice(0, 4).map(exercise => `<span>${exerciseLabel(exercise)}</span>`).join('')}${routine.exercises.length > 4 ? `<span class="exercise-more">+${routine.exercises.length - 4} más</span>` : ''}</div>` : ''}<footer>${routine.clients} cliente${routine.clients !== 1 ? 's' : ''} asignado${routine.clients !== 1 ? 's' : ''} · ${routine.sessions} sesiones / semana · ${routine.exercises.length} ejercicio${routine.exercises.length !== 1 ? 's' : ''} · ${routineVideoCount(routine)} con video${routine.dueOn ? `<br><span class="routine-due${dateOnly(routine.dueOn) < new Date().toISOString().slice(0, 10) ? ' overdue' : ''}">Fecha límite: ${dateOnly(routine.dueOn)}</span>` : ''}</footer><div class="client-actions"><button class="secondary" data-open-routine="${routine.id}">Ver rutina</button><button class="secondary" data-edit-routine="${routine.id}">Editar</button><button class="secondary" data-duplicate-routine="${routine.id}">Reutilizar</button><button class="secondary" data-delete-routine="${routine.id}">Eliminar</button></div></article>`).join('');
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
  chart.innerHTML = `<svg viewBox="0 0 720 235" role="img" aria-label="Facturación mensual de ${billingYear}"><g class="billing-chart-grid">${grid}${labels}</g><polygon class="billing-chart-area" points="${area}"/><polyline class="billing-chart-line" points="${line}"/>${dots}</svg>`;
  document.getElementById('billing-chart-summary').textContent = `${money.format(Number(billingAnalytics.totalBilled || 0))} facturado en ${billingYear}`;
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
function renderBilling() {
  const yearSelect = document.getElementById('billing-year');
  const availableYears = [...new Set([today.getFullYear(), ...data.invoices.map(invoice => invoicePeriodDate(invoice).getFullYear()).filter(Number.isFinite)])].sort((a, b) => b - a);
  yearSelect.replaceChildren(new Option('Todos los años', 'all'), ...availableYears.map(year => new Option(String(year), String(year))));
  if (billingYear !== 'all' && !availableYears.includes(Number(billingYear))) billingYear = String(availableYears[0]);
  yearSelect.value = billingYear;
  document.getElementById('billing-month').value = billingMonth;
  document.getElementById('billing-month').disabled = billingYear === 'all';
  document.getElementById('billing-source').value = billingSource;
  const periodInvoices = billingPeriodInvoices();
  const visibleInvoices = periodInvoices.slice(0, billingVisibleInvoices);
  const billed = periodInvoices.filter(item => item.status !== 'void').reduce((sum, item) => sum + item.amount, 0);
  const pending = periodInvoices.filter(item => item.status === 'pending').reduce((sum, item) => sum + Number(item.balance ?? item.amount ?? 0), 0);
  const periodTitle = billingYear === 'all'
    ? 'Histórico completo'
    : billingMonth === 'all'
    ? `Año ${billingYear}`
    : new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(new Date(Number(billingYear), Number(billingMonth) - 1, 1));
  document.getElementById('billing-period-title').textContent = periodTitle.charAt(0).toUpperCase() + periodTitle.slice(1);
  document.getElementById('billed-period-label').textContent = billingYear === 'all' ? 'Facturado en el histórico' : billingMonth === 'all' ? 'Facturado en el año' : 'Facturado en el mes';
  const sourceName = billingSource === 'zoho_invoice' ? 'Zoho Invoice' : billingSource === 'eileen' ? 'Eileen' : 'todos los orígenes';
  document.getElementById('billing-table-summary').textContent = `${periodInvoices.length} factura${periodInvoices.length !== 1 ? 's' : ''} de ${sourceName} · Mostrando ${Math.min(visibleInvoices.length, periodInvoices.length)}`;
  document.getElementById('month-billed').textContent = money.format(billed);
  document.getElementById('active-memberships').textContent = data.clients.filter(client => client.billingModel === 'monthly' && client.status === 'Activo').length;
  document.getElementById('active-packages').textContent = data.packages.filter(pack => pack.status === 'confirmed' && remainingSessions(pack) > 0).length;
  document.getElementById('billing-pending').textContent = money.format(pending);
  document.getElementById('plan-grid').innerHTML = data.plans.length ? data.plans.map(plan => `<article class="plan-card ${plan.active ? '' : 'inactive'}"><div><span class="commercial-label ${plan.billingModel === 'package' ? 'package-label' : ''}${plan.billingModel === 'single' ? ' single-label' : ''}">${modalidadPlan(plan.billingModel)}</span><h4>${escapeHtml(plan.name)}</h4><p>${escapeHtml(plan.description || (plan.billingModel === 'package' ? `${plan.sessionsIncluded} sesiones · ${plan.validityDays} días` : plan.billingModel === 'single' ? 'Se cobra por sesión' : `${plan.sessionsIncluded} sesiones / mes`))}</p></div><div class="plan-price"><strong>${money.format(plan.price)}</strong><small>${plan.active ? 'Disponible' : 'Inactivo'}</small></div><button class="text-button" data-edit-plan="${plan.id}">Editar</button></article>`).join('') : '<p class="empty">Crea el primer plan para asignarlo a tus clientes.</p>';
  document.getElementById('invoice-table').innerHTML = visibleInvoices.length ? visibleInvoices.map(invoice => { const label = invoice.status === 'confirmed' ? 'Confirmado' : invoice.status === 'void' ? 'Anulada' : 'Pendiente'; const concept = invoice.invoiceNumber ? `<small>${invoice.source === 'zoho_invoice' ? 'Zoho' : 'Eileen'} · ${escapeHtml(invoice.invoiceNumber)}</small><br>${escapeHtml(invoice.concept)}` : escapeHtml(invoice.concept); const local = invoice.source !== 'zoho_invoice'; return `<tr><td data-label="Cliente"><b>${escapeHtml(invoice.client)}</b></td><td data-label="Concepto">${concept}</td><td data-label="Vence">${invoice.due}</td><td data-label="Método">${invoice.method === 'pending' ? '—' : escapeHtml(invoice.method)}</td><td data-label="Monto">${money.format(invoice.amount)}${invoice.status === 'pending' && invoice.balance !== invoice.amount ? `<br><small>Saldo ${money.format(invoice.balance)}</small>` : ''}</td><td data-label="Estado"><span class="payment-status ${invoice.status}">${label}</span></td><td data-label="Acciones"><div class="invoice-actions"><button class="secondary session-use" data-invoice-pdf="${invoice.id}" data-invoice-number="${escapeHtml(invoice.invoiceNumber || invoice.id.slice(0, 8))}">Ver PDF</button>${invoice.status === 'pending' && local ? `<button class="secondary session-use" data-confirm-invoice="${invoice.id}">Confirmar pago</button><button class="secondary session-use" data-edit-invoice="${invoice.id}">Editar</button><button class="secondary session-use" data-delete-invoice="${invoice.id}">Anular</button><button class="secondary session-use" data-purge-invoice="${invoice.id}">Borrar</button>` : ''}${invoice.status === 'void' && local ? `<button class="secondary session-use" data-purge-invoice="${invoice.id}">Borrar definitivamente</button>` : ''}${invoice.status === 'confirmed' && local ? `<button class="secondary session-use" data-edit-payment="${invoice.id}">Editar pago</button><button class="secondary session-use" data-purge-invoice="${invoice.id}">Borrar definitivamente</button>` : ''}</div></td></tr>`; }).join('') : '<tr><td colspan="7" class="empty">No hay facturas con estos filtros.</td></tr>';
  const loadMore = document.getElementById('billing-load-more'); loadMore.hidden = visibleInvoices.length >= periodInvoices.length; loadMore.textContent = `Mostrar más facturas (${periodInvoices.length - visibleInvoices.length} restantes)`;
  document.getElementById('package-table').innerHTML = data.packages.length ? data.packages.map(pack => {
    const remaining = remainingSessions(pack);
    const state = pack.status === 'pending' ? 'Pendiente de pago' : remaining ? 'Activo' : 'Agotado';
    const borrable = Number(pack.used) === 0
      ? `<button class="secondary session-use" data-borrar-paquete="${pack.id}">Eliminar</button>` : '';
    return `<tr><td data-label="Cliente"><b>${escapeHtml(pack.client)}</b></td><td data-label="Paquete">${escapeHtml(pack.label)}</td><td data-label="Compradas">${pack.total}</td><td data-label="Usadas">${pack.used}</td><td data-label="Disponibles"><strong class="session-balance">${remaining}</strong></td><td data-label="Estado"><span class="payment-status ${pack.status === 'confirmed' && remaining ? 'confirmed' : ''}">${state}</span></td><td data-label="Acciones"><div class="invoice-actions"><button class="secondary session-use" data-editar-paquete="${pack.id}">Editar</button>${borrable}</div><small>${pack.status === 'confirmed' && remaining ? 'Descuento automático' : '—'}</small></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">Aún no hay paquetes de sesiones.</td></tr>';
  void ensureBillingAnalytics();
}
function renderAll() { renderDashboard(); renderClients(); renderGoogleCalendar(); renderCalendar(); renderRoutines(); renderBilling(); }
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
    const blob = await protectedBlob(path); const url = URL.createObjectURL(blob); const content = document.createElement('div'); content.className = 'pdf-preview';
    content.innerHTML = `<div class="pdf-preview-head"><div><p class="eyebrow">DOCUMENTO PDF</p><h2>${escapeHtml(title)}</h2></div><div class="pdf-actions"><a class="secondary" href="${url}" target="_blank" rel="noopener">Abrir PDF</a><a class="primary" href="${url}" download="${escapeHtml(fileName)}">Descargar</a></div></div><iframe src="${url}" title="${escapeHtml(title)}"></iframe><p class="pdf-mobile-note">Si la vista no aparece en iPhone o iPad, toca “Abrir PDF”.</p>`;
    openModal(content, true); modal.addEventListener('close', () => URL.revokeObjectURL(url), { once: true });
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
    try {
      event.target.classList.add('loading-state');
      await api('/api/clients', { method: 'POST', body: { fullName: form.get('name'), goal: form.get('goal'), planId: form.get('planId'), cutoffDay: Number(form.get('cutoffDay')), billingModel: selectedPlan?.billingModel || 'monthly', standardPrice: selectedPlan?.price || 0, packageSessions: selectedPlan?.sessionsIncluded || undefined, email: form.get('email') } });
      await loadData(); renderAll(); modal.close(); navigate('clients'); toast('Cliente creado y sincronizado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function editClient(client) {
  const box = document.createElement('div');
  box.innerHTML = `<form id="edit-client-form"><p class="eyebrow">CONTACTO Y EXPEDIENTE</p><h2>Editar cliente</h2><label>Nombre completo<input name="fullName" required value="${escapeHtml(client.name)}" /></label><label>Correo electrónico<input name="email" type="email" value="${escapeHtml(client.email)}" /></label><label>Teléfono<input name="phone" value="${escapeHtml(client.phone)}" /></label><label>Meta principal<input name="goal" value="${escapeHtml(client.goal)}" /></label><label>Sesiones esperadas al mes<input name="monthlySessionTarget" type="number" min="1" max="31" value="${client.monthlySessionTarget ?? ''}" placeholder="Sin meta pactada" /></label><label>Quién paga<select name="billingResponsibleClientId" id="client-payer"><option value="">Paga por sí mismo</option></select><small>Para parejas: el saldo de sesiones y los cobros van a nombre de quien paga. El progreso y la asistencia siguen siendo de cada uno.</small></label><p class="section-note">Meta contra la cual se mide el cumplimiento mensual. Déjala vacía para derivarla del paquete o de la rutina activa.</p><label>Notas privadas<textarea name="notes" rows="3">${escapeHtml(client.notes)}</textarea></label><label>Estado<select name="status">${[['active', 'Activo'], ['paused', 'En pausa'], ['inactive', 'Inactivo']].map(([valor, texto]) => `<option value="${valor}"${client.statusRaw === valor ? ' selected' : ''}>${texto}</option>`).join('')}</select><small>Un cliente inactivo conserva su expediente, su historial y sus cobros, pero desaparece de la agenda y de los listados del día a día.</small></label><button class="primary wide-button">Guardar cambios</button>
    <button type="button" class="secondary wide-button" id="borrar-expediente">Eliminar expediente</button>
    <p class="section-note">Para expedientes duplicados o creados por error. Se lleva su historial, mediciones, documentos y cobros. Si simplemente dejó de entrenar, ponlo Inactivo.</p></form>`;
  openModal(box);
  // Sólo pueden ser pagadores quienes no dependen de otro: encadenar dejaría el
  // saldo en un tercero imposible de rastrear.
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
    try { event.target.classList.add('loading-state'); await api(`/api/clients/${client.id}`, { method: 'PATCH', body: Object.fromEntries(values) }); await loadData(); renderAll(); modal.close(); toast('Cliente actualizado'); }
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
    document.getElementById('plan-form-title').textContent = 'Editar plan';
    form.elements.name.value = plan.name; form.elements.description.value = plan.description; form.elements.billingModel.value = plan.billingModel; form.elements.price.value = plan.price;
    form.elements.sessionsIncluded.value = plan.sessionsIncluded || ''; form.elements.validityDays.value = plan.validityDays || 30; form.elements.active.checked = plan.active;
  }
  togglePackage();
  form.addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(event.target); const billingModel = values.get('billingModel');
    try {
      event.target.classList.add('loading-state');
      await api(plan ? `/api/plans/${plan.id}` : '/api/plans', { method: plan ? 'PATCH' : 'POST', body: { name: values.get('name'), description: values.get('description'), billingModel, price: Number(values.get('price')), sessionsIncluded: billingModel === 'single' ? undefined : Number(values.get('sessionsIncluded')), validityDays: billingModel === 'package' ? Number(values.get('validityDays')) : undefined, active: Boolean(values.get('active')) } });
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
  box.innerHTML = `<form id="client-plan-form"><p class="eyebrow">CONDICIONES COMERCIALES</p><h2>Plan y día de corte</h2><p class="form-summary">${escapeHtml(client.name)}</p><label>Plan<select name="planId" required>${availablePlans.map(plan => `<option value="${plan.id}" ${plan.id === client.planId ? 'selected' : ''}>${escapeHtml(plan.name)} · ${money.format(plan.price)}</option>`).join('')}</select></label><label>Día de corte<input name="cutoffDay" type="number" min="1" max="31" value="${client.cutoffDay}" required /><small>Para meses cortos, el recordatorio se ajusta al último día disponible.</small></label><button class="primary wide-button">Guardar condiciones</button></form>`;
  openModal(box);
  document.getElementById('client-plan-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try { event.target.classList.add('loading-state'); await api(`/api/clients/${client.id}/plan`, { method: 'PATCH', body: { planId: form.get('planId'), cutoffDay: Number(form.get('cutoffDay')) } }); await loadData(); renderAll(); modal.close(); toast('Plan del cliente actualizado'); }
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
  const box = document.createElement('div'); box.innerHTML = `<form id="notification-form"><p class="eyebrow">RECORDATORIOS</p><h2>Notificaciones</h2><div class="notification-list">${notifications.length ? notifications.map(item => `<div class="notification-item ${item.type}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.body)}</span></div>`).join('') : '<p class="empty">No hay recordatorios pendientes.</p>'}</div><div class="notification-settings"><label class="checkbox-line"><input name="inAppEnabled" type="checkbox" ${preferences.in_app_enabled ? 'checked' : ''} /> Mostrar dentro de la aplicación</label><label class="checkbox-line"><input name="browserEnabled" type="checkbox" ${preferences.browser_enabled ? 'checked' : ''} /> Notificaciones push en este dispositivo</label><p class="section-note">Hay que activarlas en cada teléfono o computadora por separado. En iPhone sólo funcionan con la aplicación instalada en la pantalla de inicio.</p>${preferences.browser_enabled ? '<button type="button" class="secondary wide-button" id="push-test">Enviar notificación de prueba</button>' : ''}<div class="form-row"><label>Avisar sesión con horas de anticipación<input name="sessionReminderHours" type="number" min="1" max="168" value="${preferences.session_reminder_hours}" /></label><label>Avisar pago con días de anticipación<input name="paymentReminderDays" type="number" min="0" max="30" value="${preferences.payment_reminder_days}" /></label></div></div><button class="primary wide-button">Guardar preferencias</button></form>`;
  openModal(box, true);
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
    const rotulo = packageFields.querySelector('label');
    if (rotulo) rotulo.childNodes[0].nodeValue = concept.value === 'Mensualidad' ? 'Sesiones incluidas al mes' : 'Sesiones incluidas';
    const nota = document.getElementById('invoice-sessions-note');
    if (nota) nota.textContent = concept.value === 'Mensualidad'
      ? 'Vence en el próximo corte del cliente. Déjalo en 0 si esta mensualidad no limita sesiones.'
      : 'Se descuentan al completar cada sesión.';
  };
  concept.addEventListener('change', togglePackage); togglePackage();
  const amountInput = document.querySelector('#invoice-form [name="amount"]'); const dueInput = document.querySelector('#invoice-form [name="due"]'); const sessionsInput = document.querySelector('#invoice-form [name="sessions"]');
  const fillClientPlan = () => { const client = data.clients.find(item => item.id === selection.value); if (!client) return; amountInput.value = client.plan; concept.value = client.billingModel === 'package' ? 'Paquete de sesiones' : client.billingModel === 'single' ? 'Sesión individual' : 'Mensualidad'; sessionsInput.value = client.packageSessions || client.sessionsIncluded || 0; togglePackage(); };
  dueInput.value = dateKey(today); selection.addEventListener('change', fillClientPlan); fillClientPlan();
  document.getElementById('invoice-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const method = form.get('method');
    try {
      event.target.classList.add('loading-state');
      let invoice;
      const concepto = form.get('concept');
      const sesiones = Number(form.get('sessions')) || 0;
      // Con sesiones se crea un saldo que se descuenta y vence; sin ellas, la
      // mensualidad sigue siendo un cobro simple como hasta ahora.
      if (concepto === 'Paquete de sesiones' || (concepto === 'Mensualidad' && sesiones > 0)) {
        const pack = await api('/api/packages', { method: 'POST', body: { clientId: form.get('client'), totalSessions: sesiones, amount: Number(form.get('amount')), kind: concepto === 'Mensualidad' ? 'monthly' : 'package' } });
        invoice = { id: pack.invoice_id };
      } else {
        invoice = await api('/api/invoices', { method: 'POST', body: { clientId: form.get('client'), concept: concepto, amount: Number(form.get('amount')), dueOn: form.get('due') } });
      }
      if (invoice && method !== 'pending') await api(`/api/invoices/${invoice.id}/confirm`, { method: 'POST', body: { method, reference: form.get('reference') || undefined, paidOn: dateKey(today) } });
      await loadData(); renderAll(); modal.close(); navigate('billing'); toast('Cobro registrado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
// Horarios fijos: verlos y detenerlos. Un horario indefinido sin un sitio
// visible donde pararlo sería una trampa —seguiría llenando la agenda de
// alguien que ya no entrena—, así que esto no es opcional.
const DIAS_CORTOS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
// Cancelar preguntando si se reprograma. No es un detalle de formulario: una
// clase movida a otro día no debe penalizar al cliente, y una que simplemente
// no se dio, sí. Antes ninguna de las dos contaba, así que cancelar salía
// gratis y quien cancelaba media agenda seguía apareciendo al 100%.
function cancelSessionDialog(sesion) {
  if (!sesion) return;
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">AGENDA</p><h2>Cancelar sesión</h2>
    <p class="form-summary"><b>${escapeHtml(sesion.client)}</b><br>${sesion.date} · ${sesion.time}</p>
    <p style="color:#6f7b75">En Google Calendar quedará en rojo como CANCELADA, no desaparecerá.</p>
    <button class="secondary wide-button" id="cancelar-reprogramada">Se reprogramará a otro día</button>
    <p class="section-note">No afecta el cumplimiento: contará la sesión nueva.</p>
    <button class="secondary wide-button" id="cancelar-perdida">No se reprograma</button>
    <p class="section-note">Cuenta como sesión incumplida y baja su porcentaje.</p>
    <p class="section-note">Si la agendaste por error, ciérra esto y usa <b>Eliminar</b>: desaparece sin contar como incumplida.</p>`;
  openModal(box, true);
  const cancelar = async reprogramada => {
    try {
      await api(`/api/sessions/${sesion.id}?rescheduled=${reprogramada}`, { method: 'DELETE' });
      await loadData(); renderAll(); modal.close();
      toast(reprogramada ? 'Sesión cancelada para reprogramar' : 'Sesión cancelada · cuenta como incumplida');
    } catch (error) { toast(error.message, true); }
  };
  document.getElementById('cancelar-reprogramada').onclick = () => cancelar(true);
  document.getElementById('cancelar-perdida').onclick = () => cancelar(false);

}

async function recurrenceManager() {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">AGENDA</p><h2>Horarios fijos</h2>
    <p style="color:#6f7b75;margin-top:-12px">Se repiten solos hasta que los detengas. Detener uno retira sus sesiones futuras y deja intactas las pasadas.</p>
    <div id="recurrencias-lista"><p class="empty">Cargando…</p></div>`;
  openModal(box, true);
  const pintar = async () => {
    const destino = document.getElementById('recurrencias-lista');
    try {
      const reglas = await api('/api/session-recurrences');
      if (!destino?.isConnected) return;
      destino.innerHTML = reglas.length ? `<div class="gasto-lista">${reglas.map(regla => {
        const dias = (regla.weekdays || []).map(d => DIAS_CORTOS[d]).join(' · ');
        const hora = String(regla.time_of_day).slice(0, 5);
        return `<article class="gasto-item">
          <div><b>${escapeHtml(regla.full_name)}</b><small>${dias} · ${hora} · ${regla.duration_minutes} min${regla.routine_title ? ` · ${escapeHtml(regla.routine_title)}` : ''}<br>${regla.proximas} sesion${regla.proximas === 1 ? '' : 'es'} ya agendada${regla.proximas === 1 ? '' : 's'}${regla.ends_on ? ` · hasta ${dateOnly(regla.ends_on)}` : ' · sin fecha de fin'}</small></div>
          <button class="secondary session-use" data-detener-horario="${regla.id}" data-nombre="${escapeHtml(regla.full_name)}">Detener</button>
        </article>`;
      }).join('')}</div>` : '<p class="empty">No hay horarios fijos activos.</p>';
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
  };
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
  document.getElementById('edit-session-form').addEventListener('submit', async event => {
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
          <span class="daily-name"><b>${escapeHtml(row.full_name)}</b><small>${agendada ? `Sesión agendada${row.routine_title ? `: ${escapeHtml(row.routine_title)}` : ''} · se marca desde la agenda` : row.billing_model === 'package' ? `${row.available_sessions} sesiones disponibles` : 'Mensualidad'}</small></span>
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
      <span class="catalog-video ${exercise.hasVideo ? 'ready' : ''}">${exercise.hasVideo ? `▶ ${exercise.videoDurationSeconds ? `${Math.round(exercise.videoDurationSeconds)} s` : 'con video'}` : 'sin video'}</span>
      <div class="catalog-item-actions">
        <button class="secondary session-use" data-edit-exercise="${exercise.id}">Editar</button>
        ${exercise.hasVideo ? `<button class="secondary session-use" data-preview-exercise="${exercise.id}">Ver video</button>` : ''}
        <button class="secondary session-use" data-video-exercise="${exercise.id}">${exercise.hasVideo ? 'Reemplazar video' : 'Subir video'}</button>
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

// La entrenadora necesita ver lo que subió —comprobar el encuadre, si se
// entiende el movimiento— sin tener que entrar como cliente.
// La rutina como la ve el cliente, para que la entrenadora pueda revisar los
// videos de sus ejercicios sin entrar al portal ni buscarlos en el catálogo.
function routineDetail(routine) {
  const asignados = (routine.assignedClientIds || []).map(id => data.clients.find(client => client.id === id)?.name).filter(Boolean);
  const conVideo = (routine.exercises || []).filter(exercise => {
    const entry = exerciseCatalog.find(item => item.id === exercise.catalogId || item.slug === exercise.catalogId);
    return entry?.hasVideo;
  }).length;
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">PLAN DE ENTRENAMIENTO</p><h2>${escapeHtml(routine.title)}</h2>
    <p style="color:#6f7b75;margin-top:-12px">${escapeHtml(routine.description || '')}<br>${asignados.length ? escapeHtml(asignados.join(', ')) : 'Sin asignar'} · ${routine.sessions} veces por semana</p>
    ${routine.dueOn ? `<p class="routine-due${dateOnly(routine.dueOn) < new Date().toISOString().slice(0, 10) ? ' overdue' : ''}">Fecha límite: ${dateOnly(routine.dueOn)}</p>` : ''}
    <p class="section-note">${routine.exercises.length} ejercicio${routine.exercises.length === 1 ? '' : 's'} · ${conVideo} con video. Esto es lo que ve el cliente en su portal.</p>
    <div class="exercise-preview">${exerciseRows(routine.exercises || [], exerciseCatalog, 'coachvideo')}</div>
    <button class="secondary wide-button" id="routine-detail-edit">Editar rutina</button>`;
  openModal(box, true);
  document.getElementById('routine-detail-edit').onclick = () => newRoutine(routine);
}

async function previewExerciseVideo(exercise) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">DEMOSTRACIÓN</p><h2>${escapeHtml(exercise.name)}</h2>
    <p style="color:#6f7b75;margin-top:-12px">Así lo ve el cliente en su rutina.</p>
    <div id="preview-video"><p class="empty">Cargando video…</p></div>
    <button class="secondary wide-button" id="preview-replace">Reemplazar este video</button>`;
  openModal(box);
  document.getElementById('preview-replace').onclick = () => exerciseVideoUploader(exercise);
  try {
    const fuente = await api(`/api/exercises/${exercise.id}/video-url`);
    const target = document.getElementById('preview-video');
    if (!target || !modal.open) return;
    // En bucle: son clips de pocos segundos y se revisan mirando el movimiento
    // repetido, no una sola vez.
    // Silenciado por necesidad, no por gusto: sin muted el navegador no deja
    // que un video arranque solo, y el clip no empezaría hasta pulsar play.
    target.innerHTML = `<div class="exercise-video"><video controls loop muted autoplay playsinline preload="auto" src="${escapeHtml(fuente.videoUrl)}"></video></div>`;
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

function exerciseVideoUploader(exercise) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">DEMOSTRACIÓN</p><h2>Video de ${escapeHtml(exercise.name)}</h2>
    <p style="color:#6f7b75">Un clip corto ejecutando el ejercicio. El cliente lo verá en su rutina para hacerlo sin asistencia.</p>
    <p class="section-note">Se comprime en tu teléfono antes de subir y se le quita el audio: pesa mucho menos y el cliente lo abre sin gastar sus datos. Máximo 90 segundos.</p>
    <label style="border:2px dashed #d8a7bc;border-radius:9px;padding:24px;text-align:center;color:#8c5870;cursor:pointer">
      <input id="video-file" type="file" accept="video/*" hidden />${exercise.hasVideo ? 'Seleccionar un video nuevo' : 'Seleccionar video'}<br><small style="color:#6f7b75;font-weight:400">Se acepta lo que grabe tu teléfono</small></label>
    <div id="video-result"></div>
    ${exercise.hasVideo ? '<button type="button" class="secondary wide-button" id="remove-video">Quitar el video actual</button>' : ''}`;
  openModal(box);
  const result = document.getElementById('video-result');

  if (exercise.hasVideo) document.getElementById('remove-video').onclick = async () => {
    if (!confirm(`¿Quitar el video de "${exercise.name}"?`)) return;
    try { await api(`/api/exercises/${exercise.id}/video`, { method: 'DELETE' }); await reloadCatalog(); modal.close(); toast('Video eliminado'); exerciseCatalogManager(); }
    catch (error) { toast(error.message, true); }
  };

  document.getElementById('video-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    const say = (title, detail) => { result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div>`; };
    try {
      say('Comprimiendo…', `${file.name} · ${megabytes(file.size)} de origen. Toma más o menos lo que dura el clip.`);
      const compressed = await VideoCompressor.compress(file, {
        onProgress: fraction => say('Comprimiendo…', `${Math.round(fraction * 100)}% de ${file.name}`)
      });
      if (compressed.blob.size > 40 * 1024 * 1024) throw new Error(`Aun comprimido pesa ${megabytes(compressed.blob.size)} y el máximo son 40 MB. Graba un clip más corto.`);

      const ahorro = compressed.finalSize && compressed.originalSize && compressed.finalSize < compressed.originalSize
        ? ` (de ${megabytes(compressed.originalSize)} a ${megabytes(compressed.finalSize)})` : '';
      say('Subiendo…', `${megabytes(compressed.blob.size)}${ahorro}`);

      const target = await api(`/api/exercises/${exercise.id}/video-upload-url`, { method: 'POST', body: { contentType: compressed.contentType, sizeBytes: compressed.blob.size } });
      // Va directo a R2 con la URL firmada; sin el encabezado de autorización,
      // que R2 rechazaría por no venir en la firma.
      const upload = await fetch(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': compressed.contentType }, body: compressed.blob });
      if (!upload.ok) throw new Error(`El almacenamiento rechazó la subida (${upload.status})`);

      await api(`/api/exercises/${exercise.id}/video`, { method: 'POST', body: { objectKey: target.objectKey, durationSeconds: compressed.durationSeconds || undefined } });
      await reloadCatalog(); modal.close(); toast(`Video de ${exercise.name} guardado`); exerciseCatalogManager();
    } catch (error) {
      say('No se pudo guardar el video', error.message);
      event.target.value = '';
    }
  });
}

// duplicate = true reutiliza una rutina existente como punto de partida para
// otro cliente: copia los ejercicios pero nace sin asignar y se guarda como
// rutina nueva, sin tocar la original.
function newRoutine(routine = null, duplicate = false, propuesta = null) {
  const editing = Boolean(routine) && !duplicate;
  const content = formFromTemplate('new-routine-template'); openModal(content, true);
  if (routine) {
    content.querySelector('h2').textContent = editing ? 'Editar rutina' : 'Reutilizar rutina';
    content.querySelector('[name="title"]').value = editing ? routine.title : `${routine.title} (copia)`;
    content.querySelector('[name="description"]').value = routine.description;
    content.querySelector('[name="sessions"]').value = routine.sessions;
    content.querySelector('button.primary').textContent = editing ? 'Guardar cambios' : 'Guardar rutina completa';
  }
  const clientSelect = document.getElementById('routine-client');
  data.clients.forEach(client => clientSelect.add(new Option(`${client.name}${client.status === 'Activo' ? '' : ` · ${client.status}`}`, client.id)));
  // Una copia nace sin cliente a propósito: se está reutilizando justamente
  // porque va para otra persona, y heredar al cliente original invitaría a
  // pisarle la rutina sin darse cuenta.
  if (editing && routine?.assignedClientIds?.[0]) clientSelect.value = routine.assignedClientIds[0];
  // La copia tampoco hereda la fecha: se cumple en otro momento para otra persona.
  if (editing && routine?.dueOn) document.getElementById('routine-due').value = dateOnly(routine.dueOn);
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
        <label>Qué quieres para esta rutina<textarea name="description" rows="3" required minlength="10" maxlength="600" placeholder="Ej. Fuerza de tren inferior, nivel intermedio, sin saltos por su rodilla"></textarea></label>
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
        const propuesta = await api('/api/routines/suggest', { method: 'POST', body: {
          description: valores.get('description'),
          clientId: valores.get('clientId') || undefined,
          repeatMuscleGroups: Boolean(valores.get('repeat'))
        } });
        modal.close();
        // Se pasa como argumento y no por un evento en window: cada apertura
        // del formulario registraba un escucha que sólo se retiraba al
        // dispararse, así que los de las veces anteriores seguían vivos y la
        // nota de la propuesta salía repetida una vez por cada uno.
        newRoutine(null, false, { ...propuesta, clientId: valores.get('clientId') || '' });
      } catch (error) { toast(error.message, true); boton.disabled = false; boton.textContent = 'Proponer'; }
    });
  };
  // Se aplica al final del montaje, cuando renderSelected y la lista ya existen.
  const aplicarPropuesta = () => {
    selectedExercises.splice(0, selectedExercises.length);
    for (const sugerido of propuesta.exercises) {
      const enCatalogo = exerciseCatalog.find(item => item.name.toLowerCase() === sugerido.name.toLowerCase());
      selectedExercises.push({
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
    if (avisos.length) {
      const nota = document.createElement('p');
      nota.className = 'section-note aviso-ambito';
      nota.textContent = `${avisos.join(' ')} Revísala antes de guardar.`;
      document.getElementById('routine-form').prepend(nota);
    }
    toast('Propuesta lista · revísala antes de guardar');
  };

  const renderSelected = () => {
    selectedList.replaceChildren();
    exerciseCount.textContent = `${selectedExercises.length} ejercicio${selectedExercises.length !== 1 ? 's' : ''}`;
    if (!selectedExercises.length) {
      const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Todavía no has agregado ejercicios. Usa el selector superior para construir la rutina.'; selectedList.append(empty); return;
    }
    selectedExercises.forEach((exercise, index) => {
      const row = document.createElement('div'); row.className = 'selected-exercise';
      const order = document.createElement('span'); order.className = 'selected-exercise-number'; order.textContent = String(index + 1);
      const copy = document.createElement('div'); const name = document.createElement('b'); const details = document.createElement('span');
      name.textContent = exercise.name; details.textContent = [exercise.category, exercise.level].filter(Boolean).join(' · '); copy.append(name, details);
      const dose = document.createElement('div'); dose.className = 'selected-exercise-dose';
      const setsLabel = document.createElement('label'); setsLabel.className = 'selected-exercise-field'; const setsTitle = document.createElement('span'); setsTitle.textContent = 'Series'; const sets = document.createElement('input'); sets.type = 'number'; sets.min = '1'; sets.max = '20'; sets.value = exercise.sets; sets.dataset.exerciseSets = String(index); setsLabel.append(setsTitle, sets);
      const repsLabel = document.createElement('label'); repsLabel.className = 'selected-exercise-field'; const repsTitle = document.createElement('span'); repsTitle.textContent = 'Repeticiones / tiempo'; const reps = document.createElement('input'); reps.value = exercise.reps; reps.dataset.exerciseReps = String(index); repsLabel.append(repsTitle, reps); dose.append(setsLabel, repsLabel);
      // El peso sólo se pide donde tiene sentido: una plancha o la caminadora
      // no llevan kilos, y pedirlos en todos llenaría la rutina de huecos.
      const enCatalogo = exerciseCatalog.find(item => item.id === exercise.catalogId || item.name === exercise.name);
      if (enCatalogo?.usesWeight) {
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
      row.append(order, copy, dose, remove); selectedList.append(row);
    });
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
  document.getElementById('add-exercise').addEventListener('click', () => { const exercise = currentExercise(); if (!exercise) return; selectedExercises.push(prescription(exercise)); renderSelected(); selectedList.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  document.getElementById('add-custom-exercise').addEventListener('click', () => {
    const input = document.getElementById('custom-exercise'); const name = input.value.trim(); if (!name) return;
    selectedExercises.push({ name, category: 'Personalizado', level: 'Personalizado', sets: Number(document.getElementById('exercise-sets').value) || 3, reps: document.getElementById('exercise-reps').value.trim() || '10' });
    input.value = ''; renderSelected();
  });
  selectedList.addEventListener('click', event => { const button = event.target.closest('[data-remove-exercise]'); if (!button) return; selectedExercises.splice(Number(button.dataset.removeExercise), 1); renderSelected(); });
  selectedList.addEventListener('input', event => {
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
    form.elements.title.value = propuesta.title;
    form.elements.description.value = propuesta.description || propuesta.title;
    form.elements.sessions.value = propuesta.sessionsPerWeek;
    if (propuesta.clientId) { clientSelect.value = propuesta.clientId; void cargarPesosPrevios(); }
    aplicarPropuesta();
  }
  document.getElementById('routine-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const assigned = form.get('client');
    if (!selectedExercises.length) { toast('Agrega al menos un ejercicio a la rutina', true); return; }
    try {
      event.target.classList.add('loading-state');
      await api(editing ? `/api/routines/${routine.id}` : '/api/routines', { method: editing ? 'PATCH' : 'POST', body: { title: form.get('title'), description: form.get('description'), sessionsPerWeek: Number(form.get('sessions')), clientId: assigned || undefined, dueOn: form.get('dueOn') || null, exercises: selectedExercises } });
      await loadData(); renderAll(); modal.close(); navigate('routines'); toast('Rutina guardada');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
async function completeSession(id) {
  try { await api(`/api/sessions/${id}/complete`, { method: 'POST' }); await loadData(); renderAll(); toast('Sesión completada'); }
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

function financeDashboard(rango = 'meses:12') {
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
  openModal(box, true);
  document.getElementById('fin-meses').onchange = event => financeDashboard(event.target.value);
  api(`/api/finance/summary?${consulta}`).then(datos => {
    const target = document.getElementById('fin-cuerpo');
    if (!target?.isConnected || !modal.open) return;
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
function linkPackages(origen = 'zoho_invoice') {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">CIERRE DE MIGRACIÓN</p><h2>Vincular cobros con sus sesiones</h2>
    <p style="color:#6f7b75;margin-top:-12px">Cobros sin saldo de sesiones. Al vincularlos, el cliente recupera sus sesiones en la app sin volver a pagarlos.</p>
    <label>Origen<select id="link-origen">
      <option value="zoho_invoice"${origen === 'zoho_invoice' ? ' selected' : ''}>Cobros de Zoho</option>
      <option value="eileen"${origen === 'eileen' ? ' selected' : ''}>Cobros de Eileen</option>
      <option value="all"${origen === 'all' ? ' selected' : ''}>Todos</option>
    </select></label>
    <div id="link-lista"><p class="empty">Buscando cobros…</p></div>`;
  openModal(box, true);
  document.getElementById('link-origen').onchange = event => linkPackages(event.target.value);
  renderLinkPackages(origen);
}

function renderLinkPackages(origen) {
  const target = document.getElementById('link-lista');
  api(`/api/invoices/unlinked?source=${origen}`).then(cobros => {
    if (!target?.isConnected || !modal.open) return;
    target.innerHTML = cobros.length ? `<p class="section-note">${cobros.length} cobro${cobros.length === 1 ? '' : 's'} sin saldo vinculado. Vincula sólo los que corresponden a paquetes o mensualidades con sesiones.</p>
      <div class="gasto-lista">${cobros.slice(0, 200).map(cobro => `<article class="gasto-item">
        <div><b>${escapeHtml(cobro.full_name)}</b><small>${escapeHtml(cobro.concept)} · ${cobro.due_on ? dateOnly(cobro.due_on) : ''}${cobro.invoice_number ? ` · ${escapeHtml(cobro.invoice_number)}` : ''}</small></div>
        <span class="gasto-monto">${money.format(cobro.amount)}</span>
        <div class="gasto-acciones"><button class="secondary session-use" data-vincular="${cobro.id}">Vincular sesiones</button></div>
      </article>`).join('')}</div>
      ${cobros.length > 200 ? '<p class="section-note">Se muestran los 200 más recientes.</p>' : ''}` : '<p class="empty">No hay cobros sin vincular en este origen.</p>';
    target.querySelectorAll('[data-vincular]').forEach(b => {
      b.onclick = () => linkPackageEditor(cobros.find(c => c.id === b.dataset.vincular), origen);
    });
  }).catch(error => { if (target?.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

function linkPackageEditor(cobro, origen) {
  const vencido = cobro.due_on && dateOnly(cobro.due_on) < dateKey(today);
  const box = document.createElement('div');
  box.innerHTML = `<form id="link-form"><p class="eyebrow">VINCULAR SESIONES</p><h2>${escapeHtml(cobro.full_name)}</h2>
    <p class="form-summary">${escapeHtml(cobro.concept)} · ${money.format(cobro.amount)}${cobro.due_on ? ` · ${dateOnly(cobro.due_on)}` : ''}</p>
    <div class="form-row">
      <label>Sesiones del cobro<input name="totalSessions" type="number" min="1" max="500" required value="8" /></label>
      <label>Ya usadas<input name="usedSessions" type="number" min="0" max="500" required value="8" /></label>
    </div>
    <label>Tipo<select name="kind"><option value="monthly">Mensualidad</option><option value="package">Paquete</option></select></label>
    <label>Vence el<input name="expiresOn" type="date" /><small>Vacío: un mes después de emitido el cobro.</small></label>
    ${vencido ? `<p class="section-note"><b>Este cobro es de un período pasado.</b> Deja "ya usadas" igual al total si esas sesiones se dieron. Si pones menos, las restantes contarán como incumplidas y bajarán el cumplimiento de ${escapeHtml(cobro.full_name)}.</p>` : '<p class="section-note">Si el período sigue vigente, pon en "ya usadas" las que realmente se dieron.</p>'}
    <button class="primary wide-button">Vincular</button></form>`;
  openModal(box);
  const form = document.getElementById('link-form');
  // Al cambiar el total, las usadas lo siguen mientras no se toquen a mano:
  // el caso normal en un cobro viejo es que se dieron todas.
  let usadasTocadas = false;
  form.elements.usedSessions.oninput = () => { usadasTocadas = true; };
  form.elements.totalSessions.oninput = event => { if (!usadasTocadas) form.elements.usedSessions.value = event.target.value; };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const v = new FormData(event.target);
    try {
      event.target.classList.add('loading-state');
      await api(`/api/invoices/${cobro.id}/link-package`, { method: 'POST', body: {
        totalSessions: Number(v.get('totalSessions')), usedSessions: Number(v.get('usedSessions')),
        kind: v.get('kind'), expiresOn: v.get('expiresOn') || null } });
      await loadData(); renderAll(); modal.close(); toast('Sesiones vinculadas'); linkPackages(origen);
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}

// Gastos: la otra mitad de las finanzas. En lista y no en tabla, por el
// teléfono.
function expensesManager(desde = null, hasta = null) {
  // Desde enero y no desde el primero del mes: con el historial importado de
  // Zoho, abrir en el mes en curso mostraba "no hay gastos" aunque hubiera
  // cientos registrados. El año entero cabe de sobra en el tope de la consulta.
  const primeroDelAnio = new Date(today.getFullYear(), 0, 1).toISOString().slice(0, 10);
  const rango = { desde: desde || primeroDelAnio, hasta: hasta || dateKey(today) };
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">FINANZAS</p><h2>Gastos</h2>
    <div class="form-row"><label>Desde<input type="date" id="gasto-desde" value="${rango.desde}" /></label><label>Hasta<input type="date" id="gasto-hasta" value="${rango.hasta}" /></label></div>
    <div class="catalog-toolbar"><button class="secondary" id="gasto-nuevo">+ Registrar gasto</button><button class="secondary" id="gasto-categorias">Categorías</button></div>
    <div id="gasto-lista"><p class="empty">Cargando gastos…</p></div>`;
  openModal(box, true);
  const recargar = () => expensesManager(document.getElementById('gasto-desde').value, document.getElementById('gasto-hasta').value);
  document.getElementById('gasto-desde').onchange = recargar;
  document.getElementById('gasto-hasta').onchange = recargar;
  document.getElementById('gasto-nuevo').onclick = () => expenseEditor(null, rango);
  document.getElementById('gasto-categorias').onclick = () => expenseCategories(rango);
  renderExpenses(rango);
}

function renderExpenses(rango) {
  const target = document.getElementById('gasto-lista');
  api(`/api/expenses?from=${rango.desde}&to=${rango.hasta}`).then(gastos => {
    if (!target?.isConnected || !modal.open) return;
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
        <div><b>${escapeHtml(gasto.description)}</b><small>${gasto.spent_on ? dateOnly(gasto.spent_on) : ''} · ${escapeHtml(gasto.category_name || 'Sin categoría')}${gasto.client_name ? ` · ${escapeHtml(gasto.client_name)}` : ''}${gasto.source_system ? ' · importado de Zoho' : ''}</small></div>
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
  document.getElementById('volver-gastos').onclick = () => expensesManager(rango.desde, rango.hasta);
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

// Editar un saldo desde el control de paquetes. Antes sólo se podía borrar —y
// sólo si no tenía uso—, así que un error al teclear las sesiones obligaba a
// rehacer el cobro entero.
function packageEditor(pack) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">CONTROL DE PAQUETES</p><h2>Editar saldo</h2>
    <p class="form-summary">${escapeHtml(pack.client)}</p>
    <form id="paquete-form">
      <label>Etiqueta<input name="label" required minlength="2" maxlength="120" value="${escapeHtml(pack.label)}" /></label>
      <div class="form-row">
        <label>Sesiones contratadas<input name="totalSessions" type="number" min="1" max="400" required value="${pack.total}" /></label>
        <label>Sesiones usadas<input name="usedSessions" type="number" min="0" max="400" required value="${pack.used}" /></label>
      </div>
      <label>Vence<input name="expiresOn" type="date" value="${dateOnly(pack.expiresOn)}" /><small>Vacío = sin vencimiento.</small></label>
      <button class="primary wide-button">Guardar cambios</button>
    </form>`;
  openModal(box);
  document.getElementById('paquete-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.target);
    const total = Number(values.get('totalSessions'));
    const usadas = Number(values.get('usedSessions'));
    // Se avisa aquí además de en el servidor: es un error de dedo frecuente y
    // no hace falta un viaje a la API para decirlo.
    if (usadas > total) return toast('Las sesiones usadas no pueden superar las contratadas', true);
    try {
      event.target.classList.add('loading-state');
      await api(`/api/packages/${pack.id}`, { method: 'PATCH', body: {
        label: values.get('label'), totalSessions: total, usedSessions: usadas, expiresOn: values.get('expiresOn') || null
      } });
      await loadData(); renderAll(); modal.close(); toast('Saldo actualizado');
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
        await api(`/api/invoices/${event.target.dataset.quickCollect}/confirm`, { method: 'POST', body: { method: metodo, paidOn: dateKey(today) } });
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
  document.getElementById('payment-summary').textContent = `${invoice.client} · ${invoice.concept} · ${money.format(invoice.amount)}`;
  const paymentForm = document.getElementById('payment-form');
  paymentForm.elements.paidOn.value = invoice.paidOn || dateKey(today);
  paymentForm.elements.method.value = invoice.method === 'pending' ? 'Efectivo' : invoice.method;
  paymentForm.elements.reference.value = invoice.reference || '';
  if (editing) { content.querySelector('h2').textContent = 'Editar pago recibido'; content.querySelector('button').textContent = 'Guardar pago'; }
  document.getElementById('payment-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try {
      event.target.classList.add('loading-state');
      await api(`/api/invoices/${id}${editing ? '/payment' : '/confirm'}`, { method: editing ? 'PATCH' : 'POST', body: { method: form.get('method'), reference: form.get('reference') || undefined, paidOn: form.get('paidOn') } });
      await loadData(); renderAll(); modal.close(); navigate('billing'); toast('Pago confirmado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function editInvoice(id) {
  const invoice = data.invoices.find(item => item.id === id); if (!invoice) return;
  const box = document.createElement('div');
  box.innerHTML = `<form id="edit-invoice-form"><p class="eyebrow">COBRO LOCAL</p><h2>Editar cobro</h2><label>Concepto<input name="concept" required value="${escapeHtml(invoice.concept)}" /></label><div class="form-row"><label>Monto (USD)<input name="amount" type="number" min="0" step="0.01" required value="${invoice.amount}" /></label><label>Vencimiento<input name="dueOn" type="date" required value="${invoice.due}" /></label></div><button class="primary wide-button">Guardar cobro</button></form>`;
  openModal(box);
  document.getElementById('edit-invoice-form').addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(event.target);
    try { event.target.classList.add('loading-state'); await api(`/api/invoices/${id}`, { method: 'PATCH', body: { concept: values.get('concept'), amount: Number(values.get('amount')), dueOn: values.get('dueOn') } }); await loadData(); renderAll(); modal.close(); toast('Cobro actualizado'); }
    catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
// Postgres devuelve las columnas date como Date, y al serializarse a JSON
// llegan en ISO largo. Un input[type=date] rechaza ese formato y se queda en
// blanco, así que la fecha guardada desaparecía al abrir el formulario.
const dateOnly = value => value ? String(value).slice(0, 10) : '';
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
        <div><b>${escapeHtml(saldo.label)}</b><small>${saldo.kind === 'monthly' ? 'Mensualidad' : 'Paquete'} · ${saldo.used_sessions} de ${saldo.total_sessions} usadas${saldo.expires_on ? ` · ${vencido ? 'venció' : 'vence'} ${dateOnly(saldo.expires_on)}` : ' · sin vencimiento'}</small>
          ${vencido ? `<small class="balance-warning">${restantes} sesión${restantes === 1 ? '' : 'es'} sin dar · cuenta como incumplimiento</small>` : ''}</div>
        <span class="session-balance">${restantes}</span>
        ${saldo.expires_on ? `<button class="secondary session-use" data-reschedule="${saldo.id}">Reprogramar</button>` : ''}
        ${Number(saldo.used_sessions) === 0 ? `<button class="secondary session-use" data-borrar-paquete="${saldo.id}">Eliminar</button>` : ''}
      </article>`;
    }).join('')}</div>` : '<p class="empty">Este cliente no tiene saldos de sesiones.</p>'}`;
    target.querySelectorAll('[data-reschedule]').forEach(button => {
      button.onclick = () => reschedulePackage(saldos.find(saldo => saldo.id === button.dataset.reschedule), client);
    });
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
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

function complianceReport(client = null, months = 6) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">INFORME DE CUMPLIMIENTO</p><h2>${client ? escapeHtml(client.name) : 'Todos los clientes'}</h2>
    <label>Meses a comparar<select id="report-months">${[3, 6, 12, 24].map(n => `<option value="${n}"${n === months ? ' selected' : ''}>Últimos ${n} meses</option>`).join('')}</select></label>
    <div id="report-body"><p class="empty">Calculando…</p></div>`;
  openModal(box, true);
  document.getElementById('report-months').onchange = event => complianceReport(client, Number(event.target.value));
  renderComplianceReport(client, months);
}

function renderComplianceReport(client, months) {
  const target = document.getElementById('report-body');
  const query = `months=${months}${client ? `&clientId=${encodeURIComponent(client.id)}` : ''}`;
  api(`/api/compliance/monthly?${query}`).then(informe => {
    if (!target?.isConnected || !modal.open) return;
    const filas = informe.timeline.map(mes => `<tr><td>${attendanceMonthLabel(mes.month)}</td><td>${mes.activities || '—'}</td><td>${mes.completed || '—'}</td><td>${mes.late || '—'}</td><td>${mes.missed || '—'}</td><td>${mes.compliancePercent === null ? '<span class="delta neutral">sin actividad</span>' : `<span class="delta ${mes.compliancePercent >= 90 ? 'good' : mes.compliancePercent >= 70 ? 'neutral' : 'bad'}">${mes.compliancePercent}%</span>`}</td></tr>`).join('');
    target.innerHTML = `<div class="metrics" style="grid-template-columns:repeat(2,1fr)">
        <article><span>Promedio</span><strong>${informe.promedio === null ? '—' : `${informe.promedio}%`}</strong></article>
        <article><span>Actividades</span><strong>${informe.totalActividades}</strong></article>
        <article><span>Fuera de fecha</span><strong>${informe.totalTardias}</strong></article>
        <article><span>Sin hacer</span><strong>${informe.totalIncumplidas}</strong></article></div>
      ${complianceChartSvg(informe.timeline)}
      <div class="table-wrap"><table><thead><tr><th>Mes</th><th>Act.</th><th>Cumpl.</th><th>Tarde</th><th>Sin hacer</th><th>%</th></tr></thead><tbody>${filas}</tbody></table></div>
      <button class="primary wide-button" id="report-pdf">Ver PDF para enviar</button>
      <p class="section-note">El PDF trae la gráfica y el detalle mes a mes con la marca de Eileen Lifestyle. Desde ahí lo descargas y lo compartes por WhatsApp o correo.</p>`;
    document.getElementById('report-pdf').onclick = () => previewProtectedPdf(`/api/compliance/report.pdf?${query}`, `Cumplimiento · ${client ? client.name : 'Todos los clientes'}`, `cumplimiento-${client ? client.name.replace(/\s+/g, '-').toLowerCase() : 'todos'}.pdf`);
  }).catch(error => { if (target?.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
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
      : basis === 'routine' ? `Sin vencimiento en el paquete, la meta usa la cadencia de la rutina activa: ${report.sessionsPerWeek} por semana.`
      : 'Sin meta pactada, ni paquete con vencimiento, ni rutina activa. Fija las sesiones esperadas al mes en “Editar contacto” para medir el cumplimiento.';
    target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Mes</th><th>Cumplidas</th><th>Cumplimiento</th><th>Faltas</th><th>Canceladas</th></tr></thead><tbody>${rows}</tbody></table></div><p class="section-note">${escapeHtml(note)}</p>`;
  }).catch(error => { if (target.isConnected) target.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
}

function conditionsSection(target, client) {
  api(`/api/clients/${encodeURIComponent(client.id)}/conditions`).then(items => {
    if (!target.isConnected || !modal.open) return;
    target.innerHTML = `${items.length ? `<div class="condition-list">${items.map(item => `<article class="condition-item ${item.status}">
      <header><b>${escapeHtml(item.title)}</b><span class="condition-tag ${item.severity}">${severityLabels[item.severity]}</span></header>
      <small>${conditionKindLabels[item.kind]}${item.body_area ? ` · ${escapeHtml(item.body_area)}` : ''} · ${conditionStatusLabels[item.status]}${item.started_on ? ` · desde ${dateOnly(item.started_on)}` : ' · antecedente sin fecha'}${item.resolved_on ? ` · resuelta ${dateOnly(item.resolved_on)}` : ''}</small>
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
      return `<figure class="photo-card">${photo.viewUrl ? `<img src="${escapeHtml(photo.viewUrl)}" alt="Foto de progreso del ${dateOnly(photo.taken_on)}" loading="lazy" />` : '<div class="photo-missing">Archivo no disponible</div>'}
        <figcaption><b>${dateOnly(photo.taken_on)}</b><span>${poseLabels[photo.pose]}</span>${linked}${photo.notes ? `<small>${escapeHtml(photo.notes)}</small>` : ''}
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
    : `${client.planName || 'Mensualidad'} · ${money.format(client.plan)} al mes · corte día ${client.cutoffDay}`;
  const box = document.createElement('div');
  const reviewNotice = client.inbodyReviews.length ? `<button class="secondary wide-button" id="review-inbody">Revisar ${client.inbodyReviews.length} evaluación${client.inbodyReviews.length > 1 ? 'es' : ''} pendiente${client.inbodyReviews.length > 1 ? 's' : ''}</button>` : '';
  box.innerHTML = `<p class="eyebrow">EXPEDIENTE</p><h2>${escapeHtml(client.name)}</h2><p style="color:#6f7b75;margin-top:-12px">${escapeHtml(client.goal)}<br>${commercialDescription}${notaPago}</p>${inbody ? `<div class="metrics" style="grid-template-columns:repeat(2,1fr)"><article><span>Peso</span><strong>${inbody.weight} kg</strong></article><article><span>Masa muscular</span><strong>${inbody.smm} kg</strong></article><article><span>Grasa corporal</span><strong>${inbody.pbf}%</strong></article><article><span>InBody Score</span><strong>${inbody.score}/100</strong></article></div><p class="eyebrow" style="margin-top:20px">CAMBIO DESDE LA MEDICIÓN ANTERIOR</p>${inbodyComparison(inbody)}<p class="eyebrow" style="margin-top:20px">HISTORIAL IMPORTADO</p><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Peso</th><th>Músculo</th><th>Grasa</th><th>vs. anterior</th><th></th></tr></thead><tbody>${inbody.history.slice().reverse().map(reading => `<tr><td>${reading.date}</td><td>${reading.weight} kg</td><td>${reading.smm} kg</td><td>${reading.pbf}%</td><td class="delta-cell">${reading.delta ? `${deltaChip('weight', reading.delta.weight)}${deltaChip('smm', reading.delta.smm)}${deltaChip('pbf', reading.delta.pbf)}` : '<span class="delta neutral">primera</span>'}</td><td>${reading.documentId ? `<button class="secondary session-use" data-view-inbody="${reading.documentId}" data-inbody-client="${client.id}">Ver reporte</button>` : ''}<button class="secondary session-use" data-delete-inbody="${reading.id}">Eliminar</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Aún no se ha confirmado una evaluación InBody.</p>'}${reviewNotice}<p class="eyebrow" style="margin-top:20px">SALDO DE SESIONES</p><div id="client-balances"><p class="empty">Cargando saldos…</p></div><p class="eyebrow" style="margin-top:20px">ASISTENCIA MENSUAL</p><div id="client-attendance"><p class="empty">Calculando cumplimiento…</p></div><p class="eyebrow" style="margin-top:20px">LESIONES Y PADECIMIENTOS</p><div id="client-conditions"><p class="empty">Cargando expediente clínico…</p></div><p class="eyebrow" style="margin-top:20px">FOTOS DE PROGRESO</p><div id="client-photos"><p class="empty">Cargando fotos…</p></div><p class="eyebrow" style="margin-top:20px">DOCUMENTOS PRIVADOS</p><div id="client-documents"><p class="empty">Cargando documentos del expediente…</p></div><div class="detail-actions"><button class="secondary" id="edit-client-contact">Editar contacto</button><button class="secondary" id="edit-client-plan">Editar plan y corte</button><button class="secondary" id="client-report">Informe de cumplimiento</button><button class="secondary" id="portal-link">${client.portalActive ? 'Enviar enlace de acceso' : 'Activar portal con enlace'}</button><button class="secondary" id="portal-access">${client.portalActive ? 'Poner contraseña a mano' : 'Activar con contraseña'}</button><button class="secondary" id="delete-client">Eliminar cliente</button></div><button class="primary wide-button" id="open-scan">${inbody ? 'Importar nuevo InBody' : 'Importar InBody'}</button>`;
  openModal(box); document.getElementById('open-scan').onclick = () => inbodyImport(client); document.getElementById('edit-client-contact').onclick = () => editClient(client); document.getElementById('edit-client-plan').onclick = () => clientPlanEditor(client); document.getElementById('portal-access').onclick = () => portalAccessEditor(client); document.getElementById('portal-link').onclick = () => portalAccessLink(client); document.getElementById('client-report').onclick = () => complianceReport(client); document.getElementById('delete-client').onclick = () => deleteResource(`/api/clients/${client.id}`, `¿Eliminar a ${client.name}? También se eliminarán sus documentos, sesiones y cobros asociados.`, 'Cliente eliminado');
  if (client.inbodyReviews.length) document.getElementById('review-inbody').onclick = () => inbodyReview(client, client.inbodyReviews);
  balancesSection(document.getElementById('client-balances'), client);
  attendanceSection(document.getElementById('client-attendance'), client.id);
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
  ['percentBodyFat', 'Grasa', '%'], ['bmi', 'IMC', ''], ['visceralFatLevel', 'Grasa visceral', 'nivel'],
  ['ecwRatio', 'ECW', ''], ['inBodyScore', 'Score', '']
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
    const latest = documents.find(document => document.kind === 'inbody' && document.upload_status === 'ready');
    if (!latest || result.children.length) return;
    result.innerHTML = `<div class="alert-item inbody-retry" style="margin-top:15px"><b>Archivo guardado disponible</b><span>${escapeHtml(latest.original_name)} ya está en el expediente. Puedes analizarlo sin volver a subirlo.</span><button class="secondary" id="retry-saved-inbody">Analizar último archivo guardado</button></div>`;
    document.getElementById('retry-saved-inbody').addEventListener('click', () => analyzeDocuments([latest.id]));
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
window.addEventListener('popstate', () => { if (currentUser?.role !== 'client') view(viewFromHash()); });
window.addEventListener('hashchange', () => { if (currentUser?.role !== 'client') view(viewFromHash()); });
document.addEventListener('click', event => {
  const actionButton = event.target.closest('[data-action]');
  const invoicePdfButton = event.target.closest('[data-invoice-pdf]');
  const editSessionButton = event.target.closest('[data-edit-session]');
  const calendarModeButton = event.target.closest('[data-calendar-mode]');
  const calendarShiftButton = event.target.closest('[data-calendar-shift]');
  const calendarDateButton = event.target.closest('[data-calendar-date]');
  if (calendarModeButton) { calendarMode = calendarModeButton.dataset.calendarMode; renderCalendar(); }
  if (calendarShiftButton) {
    const amount = Number(calendarShiftButton.dataset.calendarShift);
    if (calendarMode === 'month') { calendarCursor.setDate(1); calendarCursor.setMonth(calendarCursor.getMonth() + amount); }
    else calendarCursor.setDate(calendarCursor.getDate() + amount * (calendarMode === 'week' ? 7 : 1));
    renderCalendar();
  }
  if (event.target.closest('[data-calendar-today]')) { calendarCursor = new Date(today); calendarCursor.setHours(12, 0, 0, 0); renderCalendar(); }
  if (calendarDateButton) { calendarCursor = new Date(`${calendarDateButton.dataset.calendarDate}T12:00:00`); calendarMode = 'day'; renderCalendar(); }
  if (actionButton?.dataset.action === 'new-client') newClient();
  if (actionButton?.dataset.action === 'new-invoice') newInvoice();
  if (actionButton?.dataset.action === 'new-session') newSession();
  if (actionButton?.dataset.action === 'new-routine') newRoutine();
  if (actionButton?.dataset.action === 'exercise-catalog') exerciseCatalogManager();
  if (actionButton?.dataset.action === 'daily-log') dailyTrainingLog();
  if (actionButton?.dataset.action === 'recurrences') recurrenceManager();
  if (actionButton?.dataset.action === 'pending-collections') pendingCollections();
  if (actionButton?.dataset.action === 'expenses') expensesManager();
  if (actionButton?.dataset.action === 'link-packages') linkPackages();
  if (actionButton?.dataset.action === 'finance') financeDashboard();
  if (actionButton?.dataset.action === 'audit-log') auditLog();
  if (actionButton?.dataset.action === 'compliance-report') complianceReport();
  if (actionButton?.dataset.action === 'new-plan') planEditor();
  if (actionButton?.dataset.action === 'export-compliance') exportCompliance();
  if (actionButton?.dataset.action === 'account-statement') financialReportDialog('account-statement');
  if (actionButton?.dataset.action === 'accounts-receivable') financialReportDialog('accounts-receivable');
  if (invoicePdfButton) previewProtectedPdf(`/api/invoices/${invoicePdfButton.dataset.invoicePdf}/pdf`, `Comprobante ${invoicePdfButton.dataset.invoiceNumber}`, `comprobante-${invoicePdfButton.dataset.invoiceNumber}.pdf`);
  if (editSessionButton) editSessionSchedule(data.sessions.find(session => session.id === editSessionButton.dataset.editSession));
  if (event.target.dataset.editPlan) planEditor(data.plans.find(plan => plan.id === event.target.dataset.editPlan));
  if (event.target.dataset.editarPaquete) {
    const pack = data.packages.find(item => item.id === event.target.dataset.editarPaquete);
    if (pack) packageEditor(pack);
  }
  if (event.target.dataset.client) clientDetail(event.target.dataset.client);
  if (event.target.dataset.editClient) editClient(data.clients.find(client => client.id === event.target.dataset.editClient));
  if (event.target.dataset.editRoutine) newRoutine(data.routines.find(routine => routine.id === event.target.dataset.editRoutine));
  if (event.target.dataset.duplicateRoutine) newRoutine(data.routines.find(routine => routine.id === event.target.dataset.duplicateRoutine), true);
  if (event.target.dataset.openRoutine) routineDetail(data.routines.find(routine => routine.id === event.target.dataset.openRoutine));
  if (event.target.dataset.deleteRoutine) deleteResource(`/api/routines/${event.target.dataset.deleteRoutine}`, '¿Eliminar esta rutina? Las sesiones ya realizadas conservarán su historial.', 'Rutina eliminada');
  if (event.target.dataset.inbody) inbodyImport(data.clients.find(client => client.id === event.target.dataset.inbody));
  if (event.target.dataset.completeSession) completeSession(event.target.dataset.completeSession);
  if (event.target.dataset.confirmInvoice) confirmInvoice(event.target.dataset.confirmInvoice);
  if (event.target.dataset.editPayment) confirmInvoice(event.target.dataset.editPayment, true);
  if (event.target.dataset.editInvoice) editInvoice(event.target.dataset.editInvoice);
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
});
document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-session-compliance]'); if (!form) return;
  event.preventDefault(); const completed = form.elements.completed.checked; const completionPercent = completed ? Number(form.elements.completionPercent.value) : 0;
  try { form.classList.add('loading-state'); await api(`/api/sessions/${form.dataset.sessionCompliance}/compliance`, { method: 'PATCH', body: { completed, completionPercent } }); await loadData(); renderAll(); toast('Cumplimiento actualizado'); }
  catch (error) { toast(error.message, true); form.classList.remove('loading-state'); }
});
document.addEventListener('change', event => {
  const checkbox = event.target.matches('input[name="completed"]') ? event.target : null;
  if (checkbox && checkbox.closest('[data-session-compliance], [data-portal-routine], [data-portal-session]')) { const percent = checkbox.closest('form').elements.completionPercent; percent.value = checkbox.checked ? (Number(percent.value) || 100) : 0; }
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
document.getElementById('billing-current-period').addEventListener('click', () => {
  billingMonth = String(today.getMonth() + 1); billingYear = String(today.getFullYear()); billingSource = 'all'; resetBillingList(); renderBilling(); notifyBillingPeriodChange();
});
document.getElementById('billing-load-more').addEventListener('click', () => { billingVisibleInvoices += 100; renderBilling(); });
document.getElementById('show-zoho-invoices').addEventListener('click', () => {
  billingMonth = 'all'; billingYear = 'all'; billingSource = 'zoho_invoice'; resetBillingList(); renderBilling(); notifyBillingPeriodChange();
  document.getElementById('billing-invoices-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

const portalViewTitles = { 'portal-dashboard': 'Mi progreso', 'portal-routines': 'Mis rutinas', 'portal-calendar': 'Mi agenda', 'portal-billing': 'Facturación' };

// La rutina guarda una copia del ejercicio en JSON; el video vive en el
// catálogo. catalogId es lo que une a los dos. Un ejercicio personalizado, o
// uno cuyo ejercicio de catálogo se borró después, simplemente no ofrece video.
// Se usa con dos catálogos distintos: el que recibe el cliente en su portal
// (has_video, tal como llega de la API) y el que tiene la entrenadora en
// memoria (hasVideo, ya mapeado). Por eso se leen las dos formas.
function exerciseRows(exercises, catalog, prefix = 'video') {
  return exercises.map((exercise, position) => {
    if (typeof exercise === 'string') return `<span>${escapeHtml(exercise)}</span>`;
    // Las rutinas creadas antes de mover el catálogo a la base guardaron el
    // slug del archivo estático como catalogId; las nuevas guardan el uuid. La
    // siembra conservó esos mismos slugs, así que buscar por ambos hace que las
    // rutinas viejas también muestren video.
    const catalogEntry = (catalog || []).find(item => item.id === exercise.catalogId || item.slug === exercise.catalogId);
    const tieneVideo = Boolean(catalogEntry?.has_video ?? catalogEntry?.hasVideo);
    const dose = [exercise.sets && setsLabel(exercise.sets), exercise.reps].filter(Boolean).join(' · ');
    // La posición entra en el id porque una rutina puede repetir el mismo
    // ejercicio —el mismo movimiento en dos rangos de repeticiones es normal— y
    // dos contenedores con el mismo id harían que el segundo botón abriera el
    // video del primero.
    const videoId = `${prefix}-${catalogEntry?.id}-${position}`;
    return `<div class="portal-exercise">
      <b>${escapeHtml(exercise.name)}</b>
      ${dose ? `<small>${escapeHtml(dose)}</small>` : ''}
      ${catalogEntry?.cues ? `<small>${escapeHtml(catalogEntry.cues)}</small>` : ''}
      ${tieneVideo
        ? `<button type="button" class="secondary session-use exercise-video-toggle" data-play-exercise="${catalogEntry.id}" data-video-target="${videoId}">▶ Ver cómo se hace</button><div class="exercise-video" id="${videoId}" hidden></div>`
        // Decir "sin video" en vez de no mostrar nada: la ausencia de botón se
        // veía idéntica a que la función estuviera rota, y hoy sólo un
        // ejercicio de 77 tiene video.
        : `<small class="sin-video">${catalogEntry ? 'Sin video todavía' : 'Ejercicio fuera del catálogo · no admite video'}</small>`}
    </div>`;
  }).join('');
}

function portalExerciseRows(exercises) {
  return exerciseRows(exercises, portalData?.exercises || []);
}

// La URL firmada se pide al darle reproducir, no al cargar la pantalla: dura
// cinco minutos y pedir cuarenta de golpe las vencería antes de usarlas.
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
    button.textContent = visible ? '▶ Ver cómo se hace' : 'Ocultar video';
    return;
  }
  button.disabled = true; button.textContent = 'Cargando…';
  try {
    const source = await api(`/api/exercises/${exerciseId}/video-url`);
    // loop porque el cliente necesita ver el movimiento varias veces mientras
    // entrena, y muted porque este reproductor arranca solo: los navegadores
    // bloquean el autoplay con sonido, y un gimnasio de fondo no aporta nada.
    // Con los controles a la vista, quien quiera oírlo puede quitar el silencio.
    container.innerHTML = `<video controls loop muted autoplay playsinline preload="auto" src="${escapeHtml(source.videoUrl)}"></video>`;
    container.dataset.loaded = 'true'; container.hidden = false;
    button.textContent = 'Ocultar video';
    container.querySelector('video').play().catch(() => {});
  } catch (error) {
    toast(error.message, true);
    button.textContent = '▶ Ver cómo se hace';
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
const portalSession = item => ({ id: item.id, startsAt: new Date(item.starts_at), status: item.status, completionPercent: Number(item.completion_percent || 0), routine: item.routine_title || 'Evaluación / seguimiento', mode: item.mode });
const monthLabel = date => new Intl.DateTimeFormat('es-PA', { month: 'short' }).format(date).replace('.', '');
function portalActivities() {
  const sessionActivities = portalData.sessions.filter(item => new Date(item.starts_at) <= today && item.status !== 'cancelled').map(item => ({ date: new Date(item.starts_at), percent: Number(item.completion_percent || 0) }));
  const routineActivities = portalData.routineCompletions.map(item => ({ date: new Date(`${item.completed_on}T12:00:00`), percent: Number(item.completion_percent || 0) }));
  return [...sessionActivities, ...routineActivities];
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

function startOfWeek(fecha) {
  const inicio = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 12);
  // Semana de lunes a domingo.
  inicio.setDate(inicio.getDate() - ((inicio.getDay() + 6) % 7));
  return inicio;
}

function portalSlotCard(slot, ownSessions) {
  const date = new Date(slot.starts_at);
  const own = slot.is_mine ? ownSessions.get(slot.id) : null;
  return `<article class="portal-slot ${own ? 'mine' : 'busy'}"><time><b>${new Intl.DateTimeFormat('es-PA', { weekday: 'short', day: 'numeric', month: 'short' }).format(date)}</b><span>${new Intl.DateTimeFormat('es-PA', { hour: 'numeric', minute: '2-digit' }).format(date)}</span></time><div><b>${own ? escapeHtml(own.routine) : 'Ocupado'}</b><span>${own ? escapeHtml(own.mode) : 'Horario no disponible'}</span></div>${own ? `<form data-portal-session="${own.id}" class="portal-session-form"><label class="completion-check"><input name="completed" type="checkbox" ${own.status === 'completed' ? 'checked' : ''} /><span>Cumplí</span></label><label class="completion-percent"><input name="completionPercent" type="number" min="0" max="100" value="${own.status === 'completed' ? own.completionPercent || 100 : 0}" /><span>%</span></label><button class="secondary">Guardar</button></form>` : ''}</article>`;
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
    return `<button type="button" class="portal-col-dia ${clave === hoyClave ? 'hoy' : ''}" style="grid-row:1;grid-column:${clavesSemana.indexOf(clave) + 2}" data-portal-dia="${clave}">
      <b>${['L', 'M', 'X', 'J', 'V', 'S', 'D'][(fecha.getDay() + 6) % 7]}</b>
      <i>${fecha.getDate()}</i>
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
      return `<span class="portal-tramo ${yaPaso ? 'pasado' : 'libre'}" style="grid-row:${filaInicio} / span ${unidadesPorBanda};grid-column:${columna + 2}" title="${yaPaso ? 'Ya pasó' : 'Disponible'}"></span>`;
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
    <p class="portal-leyenda"><span class="marca-mia">●</span> Tu sesión &nbsp; <span class="marca-ocupada">▪</span> Ocupado &nbsp; <span class="marca-libre">▫</span> Disponible &nbsp; <span class="marca-pasada">▫</span> Ya pasó</p>
    <h4 class="portal-dia-titulo">${new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }).format(fechaElegida)}</h4>
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

function renderPortal() {
  const client = portalData.client; const activities = portalActivities(); const overall = activities.length ? Math.round(activities.reduce((sum, item) => sum + item.percent, 0) / activities.length) : 0;
  document.getElementById('portal-welcome').textContent = `Hola, ${client.full_name.split(' ')[0]}`; document.getElementById('portal-compliance').textContent = `${overall}%`;
  const upcoming = portalData.sessions.filter(item => new Date(item.starts_at) >= today && item.status === 'scheduled').length;
  const pending = portalData.invoices.filter(item => item.status === 'pending').reduce((sum, item) => sum + Number(item.balance ?? item.amount), 0);
  document.getElementById('portal-metrics').innerHTML = `<article><span>Próximas sesiones</span><strong>${upcoming}</strong><small>en tu agenda</small></article><article><span>Rutinas activas</span><strong>${portalData.routines.length}</strong><small>asignadas</small></article><article><span>Saldo pendiente</span><strong>${money.format(pending)}</strong><small>facturación</small></article>`;
  const buckets = Array.from({ length: 6 }, (_, index) => { const date = new Date(today.getFullYear(), today.getMonth() - 5 + index, 1, 12); return { key: `${date.getFullYear()}-${date.getMonth()}`, date, values: [] }; });
  activities.forEach(item => buckets.find(bucket => bucket.key === `${item.date.getFullYear()}-${item.date.getMonth()}`)?.values.push(item.percent));
  document.getElementById('portal-chart').innerHTML = buckets.map(bucket => { const percent = bucket.values.length ? Math.round(bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length) : 0; return `<div class="chart-column"><span>${percent}%</span><i style="height:${Math.max(4, percent)}%"></i><small>${monthLabel(bucket.date)}</small></div>`; }).join('');
  document.getElementById('portal-inbody').innerHTML = portalData.assessments.length ? `<div class="portal-inbody-grid">${portalData.assessments.slice(-4).reverse().map(item => `<article><span>${String(item.tested_at).slice(0, 10)}</span><b>${Number(item.values.weightKg || 0).toFixed(1)} kg</b><small>${Number(item.values.percentBodyFat || 0).toFixed(1)}% grasa · ${Number(item.values.skeletalMuscleMassKg || 0).toFixed(1)} kg músculo</small></article>`).join('')}</div>` : '<p class="empty">Todavía no hay evaluaciones confirmadas.</p>';
  document.getElementById('portal-routines-list').innerHTML = portalData.routines.length ? portalData.routines.map(routine => { const todayCompletion = portalData.routineCompletions.find(item => item.routine_id === routine.id && item.completed_on === dateKey(today)); return `<article class="card portal-routine-card"><div class="card-head"><div><h3>${escapeHtml(routine.title)}</h3><p>${escapeHtml(routine.description || '')} · ${routine.sessions_per_week} veces por semana</p>${routine.due_on ? `<p class="routine-due${dateOnly(routine.due_on) < new Date().toISOString().slice(0, 10) ? ' overdue' : ''}">${dateOnly(routine.due_on) < new Date().toISOString().slice(0, 10) ? 'Venció el' : 'Para cumplirla antes del'} ${dateOnly(routine.due_on)}</p>` : ''}</div></div><div class="exercise-preview">${portalExerciseRows(routine.exercises || [])}</div><form data-portal-routine="${routine.id}" class="portal-completion-form"><label class="completion-check"><input name="completed" type="checkbox" ${todayCompletion && Number(todayCompletion.completion_percent) > 0 ? 'checked' : ''} /><span>Entrenamiento realizado hoy</span></label><label class="completion-percent"><input name="completionPercent" type="number" min="0" max="100" value="${Number(todayCompletion?.completion_percent || 100)}" /><span>% completado</span></label><button class="primary">Guardar cumplimiento</button></form></article>`; }).join('') : '<p class="empty">La entrenadora todavía no te ha asignado una rutina.</p>';
  const ownSessions = new Map(portalData.sessions.map(item => [item.id, portalSession(item)]));
  renderPortalCalendar(ownSessions);
  document.getElementById('portal-plan').innerHTML = `<span class="commercial-label ${client.billing_model === 'package' ? 'package-label' : ''}">${client.billing_model === 'package' ? 'Paquete' : 'Mensualidad'}</span><div><h3>${escapeHtml(client.plan_name || 'Plan personalizado')}</h3><p>${money.format(Number(client.standard_price))}${client.billing_model === 'monthly' ? ` · corte día ${client.billing_cutoff_day}` : ` · ${client.sessions_included || 0} sesiones`}</p></div>`;
  document.getElementById('portal-invoices').innerHTML = portalData.invoices.length ? portalData.invoices.map(invoice => `<tr><td><b>${escapeHtml(invoice.concept)}</b>${invoice.invoice_number ? `<br><small>${escapeHtml(invoice.invoice_number)}</small>` : ''}</td><td>${invoice.issued_on || invoice.due_on}</td><td>${money.format(Number(invoice.amount))}</td><td><span class="payment-status ${invoice.status}">${invoice.status === 'confirmed' ? 'Pagada' : invoice.status === 'void' ? 'Anulada' : 'Pendiente'}</span></td><td><button class="secondary session-use" data-invoice-pdf="${invoice.id}" data-invoice-number="${escapeHtml(invoice.invoice_number || invoice.id.slice(0, 8))}">Ver PDF</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">No hay facturas registradas.</td></tr>';
  const portalCount = document.getElementById('portal-notification-count'); portalCount.textContent = portalData.notifications.length; portalCount.hidden = !portalData.notifications.length;
}
async function loadPortalData() {
  const [summary, notifications] = await Promise.all([api('/api/portal/summary'), api('/api/notifications')]); portalData = { ...summary, notifications }; renderPortal(); showPendingBrowserNotification(notifications);
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
document.addEventListener('submit', async event => {
  const routineForm = event.target.closest('[data-portal-routine]'); const sessionForm = event.target.closest('[data-portal-session]'); if (!routineForm && !sessionForm) return;
  event.preventDefault(); const form = routineForm || sessionForm; const completed = form.elements.completed.checked; const completionPercent = completed ? Number(form.elements.completionPercent.value) : 0;
  try {
    form.classList.add('loading-state');
    if (routineForm) await api('/api/portal/routine-completions', { method: 'POST', body: { routineId: routineForm.dataset.portalRoutine, completedOn: dateKey(today), completionPercent } });
    else await api(`/api/portal/sessions/${sessionForm.dataset.portalSession}/compliance`, { method: 'PATCH', body: { completed, completionPercent } });
    await loadPortalData(); toast('Cumplimiento actualizado');
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

async function start() {
  const accessToken = accessTokenFromHash();
  // Se atiende antes que la sesión guardada: quien abre un enlace de acceso
  // quiere entrar como el cliente del enlace, no como quien quedó logueado en
  // ese teléfono —que muy probablemente sea la entrenadora.
  if (accessToken) return showAccessLink(accessToken);
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
