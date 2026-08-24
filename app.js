const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const today = new Date();
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const API_BASE = 'https://api-production-b417f.up.railway.app';
const authKey = 'eileen-lifestyle-session';
const legacyAuthKey = 'eleen-lifestyle-session';
const exerciseCatalog = window.EXERCISE_CATALOG || [];
let authToken = localStorage.getItem(authKey) || localStorage.getItem(legacyAuthKey);
if (authToken && !localStorage.getItem(authKey)) {
  localStorage.setItem(authKey, authToken);
  localStorage.removeItem(legacyAuthKey);
}
let currentUser = null;
const seed = {
  clients: [
    { id: 'c1', name: 'Cliente de prueba', goal: 'Ganar masa muscular', billingModel: 'monthly', plan: 150, email: '', status: 'Activo', inbody: { date: '2026-07-12', weight: 71.1, smm: 31.2, fat: 15.6, pbf: 21.9, score: 74, history: [{ date: '2025-10-04', weight: 65.1, smm: 29.6, fat: 12.3, pbf: 18.9 }, { date: '2025-11-07', weight: 67.5, smm: 29.7, fat: 14.7, pbf: 21.8 }, { date: '2026-07-12', weight: 71.1, smm: 31.2, fat: 15.6, pbf: 21.9 }] } },
    { id: 'c2', name: 'Sofía Morales', goal: 'Reducir grasa corporal', billingModel: 'monthly', plan: 130, email: 'sofia@ejemplo.com', status: 'Activo', inbody: { date: '2026-07-28', weight: 62.4, smm: 24.3, fat: 16.1, pbf: 25.8, score: 77, history: [{ date: '2026-06-01', weight: 64.2, smm: 23.9, fat: 18.4, pbf: 28.7 }, { date: '2026-07-28', weight: 62.4, smm: 24.3, fat: 16.1, pbf: 25.8 }] } },
    { id: 'c3', name: 'Carlos Pérez', goal: 'Mejorar condición física', billingModel: 'package', plan: 100, packageSessions: 8, email: 'carlos@ejemplo.com', status: 'Activo', inbody: null }
  ],
  invoices: [
    { id: 'i1', client: 'Sofía Morales', concept: 'Mensualidad', amount: 130, due: dateKey(today), method: 'Yappy', status: 'confirmed' },
    { id: 'i2', client: 'Carlos Pérez', concept: 'Paquete de sesiones', amount: 100, due: dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2)), method: 'pending', status: 'pending' },
    { id: 'i3', client: 'Cliente de prueba', concept: 'Mensualidad', amount: 150, due: dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3)), method: 'Transferencia bancaria', status: 'confirmed' }
  ],
  packages: [
    { id: 'p1', client: 'Carlos Pérez', label: 'Paquete 8 sesiones', total: 8, used: 3, amount: 100, status: 'confirmed' }
  ],
  sessions: [
    { id: 's1', client: 'Sofía Morales', date: dateKey(today), time: '08:00', routine: 'Fuerza funcional', mode: 'Presencial', status: 'scheduled', notes: '' },
    { id: 's2', client: 'Cliente de prueba', date: dateKey(today), time: '10:30', routine: 'Hipertrofia · 4 días', mode: 'Presencial', status: 'scheduled', notes: '' },
    { id: 's3', client: 'Carlos Pérez', date: dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)), time: '16:00', routine: 'Evaluación / seguimiento', mode: 'Presencial', status: 'scheduled', notes: '' }
  ],
  routines: [
    { id: 'r1', title: 'Hipertrofia · 4 días', description: 'Rutina de fuerza y volumen progresivo.', clients: 1, sessions: 4, exercises: ['Sentadilla · 4 × 8', 'Hip thrust · 4 × 10', 'Peso muerto rumano · 3 × 10'] },
    { id: 'r2', title: 'Fuerza funcional', description: 'Movilidad, estabilidad y acondicionamiento.', clients: 2, sessions: 3, exercises: ['Goblet squat · 3 × 12', 'Remo con banda · 3 × 15', 'Plancha · 3 × 40 s'] },
    { id: 'r3', title: 'Recomposición corporal', description: 'Entrenamiento de fuerza con cardio estratégico.', clients: 1, sessions: 4, exercises: ['Prensa · 4 × 10', 'Press de pecho · 3 × 10', 'Intervalos · 8 × 30 s'] }
  ]
};
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
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isPassThroughBody = options.body instanceof FormData || (typeof Blob !== 'undefined' && options.body instanceof Blob);
  if (authToken && options.auth !== false) headers.Authorization = `Bearer ${authToken}`;
  if (options.body !== undefined && !isPassThroughBody) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API_BASE}${path}`, { method: options.method || 'GET', headers, body: options.body === undefined || isPassThroughBody ? options.body : JSON.stringify(options.body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && options.auth !== false) { localStorage.removeItem(authKey); authToken = null; }
    throw new Error(payload.error || 'No fue posible completar la solicitud');
  }
  return payload;
}
const exerciseLabel = exercise => typeof exercise === 'string' ? exercise : [exercise.name, exercise.sets && `${exercise.sets} series`, exercise.reps].filter(Boolean).join(' · ');
async function loadData() {
  const [clients, invoices, packages, sessions, routines, plans, compliance, notifications, googleCalendar] = await Promise.all([
    api('/api/clients'), api('/api/invoices'), api('/api/packages'), api('/api/sessions'), api('/api/routines'),
    api('/api/plans'),
    api(`/api/compliance/summary?period=${compliancePeriod}`).catch(() => ({ compliancePercent: 0, activities: 0, clients: [] })),
    api('/api/notifications').catch(() => []),
    api('/api/integrations/google-calendar/status').catch(() => ({ configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } }))
  ]);
  const assessments = await Promise.all(clients.map(client => api(`/api/clients/${client.id}/inbody`)));
  data.clients = clients.map((client, index) => {
    const readyAssessments = assessments[index].assessments.filter(item => item.extraction_status === 'ready');
    const history = readyAssessments.map(item => ({
      date: String(item.tested_at).slice(0, 10), weight: Number(item.values.weightKg), smm: Number(item.values.skeletalMuscleMassKg),
      fat: Number(item.values.bodyFatMassKg), pbf: Number(item.values.percentBodyFat), score: Number(item.values.inBodyScore)
    }));
    const latest = history.at(-1);
    const inbodyReviews = assessments[index].assessments.filter(item => item.extraction_status === 'review');
    return { id: client.id, name: client.full_name, goal: client.goal || 'Sin meta definida', billingModel: client.billing_model, plan: Number(client.standard_price), planId: client.plan_id, planName: client.plan_name, cutoffDay: Number(client.billing_cutoff_day || 1), sessionsIncluded: Number(client.sessions_included || 0), validityDays: Number(client.validity_days || 0), email: client.email || '', portalActive: Boolean(client.portal_user_id), status: client.status === 'active' ? 'Activo' : 'Inactivo', inbodyReviews, inbody: latest ? { ...latest, history } : null };
  });
  data.invoices = invoices.map(item => ({ id: item.id, clientId: item.client_id, client: item.full_name, concept: item.concept, amount: Number(item.amount), balance: item.source_system ? Number(item.balance) : item.status === 'pending' ? Number(item.amount) : 0, due: item.due_on, issued: item.issued_on || item.due_on, method: item.payment_method || 'pending', reference: item.payment_reference, status: item.status, source: item.source_system || 'eileen', invoiceNumber: item.invoice_number || '', externalStatus: item.external_status || '' }));
  data.packages = packages.map(item => ({ id: item.id, clientId: item.client_id, client: item.full_name, label: item.label, total: item.total_sessions, used: item.used_sessions, amount: Number(item.amount), status: item.status === 'active' ? 'confirmed' : item.status === 'pending' ? 'pending' : 'expired' }));
  data.sessions = sessions.map(item => { const starts = new Date(item.starts_at); return { id: item.id, clientId: item.client_id, client: item.full_name, routineId: item.routine_id, date: dateKey(starts), time: `${String(starts.getHours()).padStart(2, '0')}:${String(starts.getMinutes()).padStart(2, '0')}`, routine: item.routine_title || 'Evaluación / seguimiento', mode: item.mode, status: item.status, completionPercent: Number(item.completion_percent || 0), notes: item.notes || '', googleSynced: Boolean(item.google_event_id), googleEventLink: item.google_event_link || '', googleSyncError: item.google_sync_error || '' }; });
  data.routines = routines.map(item => ({ id: item.id, title: item.title, description: item.description || '', clients: 0, sessions: item.sessions_per_week, exercises: item.exercises || [] }));
  data.plans = plans.map(item => ({ id: item.id, name: item.name, description: item.description || '', billingModel: item.billing_model, price: Number(item.price), sessionsIncluded: Number(item.sessions_included || 0), validityDays: Number(item.validity_days || 0), active: item.active }));
  data.compliance = compliance; data.notifications = notifications; data.googleCalendar = googleCalendar; billingAnalytics = null; billingAnalyticsLoadingYear = null; billingAnalyticsRequest += 1; showPendingBrowserNotification(notifications);
}
const initials = name => name.split(' ').slice(0, 2).map(word => word[0]).join('').toUpperCase();
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
    return `<div class="progress-item"><span class="initials">${initials(client.name)}</span><div><b>${client.name}</b><small>${client.goal} · InBody ${client.inbody.date}</small></div><span class="delta ${Number(fatDelta) > 0 ? 'warn' : ''}">Músculo ${muscleDelta > 0 ? '+' : ''}${muscleDelta} kg<br>Grasa ${fatDelta > 0 ? '+' : ''}${fatDelta} kg</span></div>`;
  }).join('') : '<p class="empty">Aún no hay evaluaciones InBody.</p>';
  const todaySessions = data.sessions.filter(session => session.date === dateKey(today)).sort((a, b) => a.time.localeCompare(b.time));
  document.getElementById('today-sessions').innerHTML = todaySessions.length ? todaySessions.map(session => `<div class="agenda-item"><span class="agenda-time">${session.time}</span><div><b>${session.client}</b><span>${session.routine} · ${session.mode.toLowerCase()}</span></div><span class="session-state ${session.status}">${sessionStateLabel(session)}</span></div>`).join('') : '<p class="empty">No hay sesiones para hoy.</p>';
  const noInbody = data.clients.filter(client => !client.inbody).map(client => `<div class="alert-item"><b>${client.name}</b><span>Sin evaluación InBody registrada.</span></div>`).join('');
  document.getElementById('alerts').innerHTML = `${noInbody || '<div class="alert-item"><b>Todo al día</b><span>No hay alertas de seguimiento.</span></div>'}<div class="alert-item"><b>${data.invoices.filter(item => item.status === 'pending').length} cobro pendiente</b><span>Revisa pagos y comprobantes.</span></div>`;
  document.getElementById('compliance-list').innerHTML = data.compliance.clients.length ? data.compliance.clients.map(client => `<div class="compliance-row"><span class="initials">${initials(client.name)}</span><div><b>${escapeHtml(client.name)}</b><small>${client.completed} de ${client.activities} actividades con avance</small><span class="compliance-track"><i style="width:${client.compliancePercent}%"></i></span></div><strong>${client.compliancePercent}%</strong></div>`).join('') : '<p class="empty">Aún no hay entrenamientos vencidos en este período.</p>';
  const notificationCount = document.getElementById('notification-count'); notificationCount.textContent = data.notifications.length; notificationCount.hidden = !data.notifications.length;
}
function renderClients(filter = '') {
  const clients = data.clients.filter(client => client.name.toLowerCase().includes(filter.toLowerCase()));
  document.getElementById('client-grid').innerHTML = clients.map(client => {
    const pack = clientPackage(client.name);
    const commercial = client.billingModel === 'package'
      ? `<span class="commercial-label package-label">Paquete</span><b>${pack?.status === 'pending' ? 'Pago pendiente' : `${pack ? remainingSessions(pack) : client.sessionsIncluded || 0} sesiones disponibles`}</b><small>${escapeHtml(client.planName || 'Plan por sesiones')} · ${money.format(client.plan)}</small>`
      : `<span class="commercial-label">Mensualidad</span><b>${escapeHtml(client.planName || 'Mensualidad')} · ${money.format(client.plan)}</b><small>Corte día ${client.cutoffDay}</small>`;
    return `<article class="client-card"><header><span class="initials">${initials(client.name)}</span><div><h3>${client.name}</h3><small>${client.goal}</small></div><span class="status">${client.status}</span></header><p>${client.inbody ? `Último InBody: ${client.inbody.date}` : 'Aún no se ha cargado un InBody.'}${client.portalActive ? ' · Portal activo' : ''}</p><div class="commercial-summary">${commercial}</div><div class="mini-data">${client.inbody ? `<div><b>${client.inbody.weight} kg</b><span>Peso</span></div><div><b>${client.inbody.smm} kg</b><span>Músculo</span></div><div><b>${client.inbody.pbf}%</b><span>Grasa</span></div>` : `<div><b>—</b><span>Evaluación pendiente</span></div>`}</div><div class="client-actions"><button class="secondary" data-client="${client.id}">Ver expediente</button><button class="secondary" data-inbody="${client.id}">+ InBody</button></div></article>`;
  }).join('') || '<p class="empty">No se encontraron clientes.</p>';
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
    copy.textContent = 'Faltan las credenciales OAuth de Google en Railway.';
    connect.textContent = 'Configuración pendiente'; connect.disabled = true; disconnect.hidden = true;
  } else if (!integration.connected) {
    status.textContent = 'Sin conectar';
    copy.textContent = 'Autoriza el calendario principal para enviar allí las sesiones de entrenamiento.';
    connect.textContent = 'Conectar calendario'; connect.disabled = false; disconnect.hidden = true;
  } else {
    status.textContent = integration.connection?.status === 'error' ? 'Requiere atención' : 'Conectado';
    const lastSync = integration.connection?.last_sync_at ? ` · última sincronización ${new Intl.DateTimeFormat('es-PA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(integration.connection.last_sync_at))}` : '';
    copy.textContent = integration.connection?.last_error || `${counts.synced} sesión${counts.synced !== 1 ? 'es' : ''} sincronizada${counts.synced !== 1 ? 's' : ''}${counts.pending ? ` · ${counts.pending} pendiente${counts.pending !== 1 ? 's' : ''}` : ''}${lastSync}`;
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
    grid.innerHTML = `<div class="day-focus"><span>${new Intl.DateTimeFormat('es-PA', { weekday: 'long' }).format(range.start)}</span><strong>${range.start.getDate()}</strong><small>${capitalized(new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric' }).format(range.start))}</small></div><div class="day-timeline">${sessions.length ? sessions.map(session => `<article class="day-session ${session.status}"><time>${session.time}</time><div><b>${session.client}</b><span>${session.routine}</span><small>${session.mode}</small></div><span class="session-state ${session.status}">${sessionStateLabel(session)}</span></article>`).join('') : '<div class="calendar-empty"><b>Día disponible</b><span>No hay sesiones programadas.</span><button class="secondary" data-action="new-session">+ Agendar sesión</button></div>'}</div>`;
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
  document.getElementById('session-list').innerHTML = visibleSessions.length ? visibleSessions.map(session => `<div class="session-row"><div class="session-date"><b>${new Intl.DateTimeFormat('es-PA', { weekday: 'short', day: 'numeric' }).format(new Date(`${session.date}T12:00:00`))}</b><span>${session.time}</span></div><div class="session-person"><b>${session.client}</b><span>${session.routine} · ${session.mode}</span>${data.googleCalendar.connected ? `<small class="google-session-state ${session.googleSyncError ? 'error' : session.googleSynced ? 'synced' : ''}">${session.googleSyncError ? 'Google pendiente' : session.googleSynced ? 'Google Calendar ✓' : 'Por sincronizar'}</small>` : ''}</div><span class="session-state ${session.status}">${sessionStateLabel(session)}</span>${session.status === 'cancelled' ? '<span class="session-done">—</span>' : sessionComplianceForm(session)}</div>`).join('') : `<p class="empty">No hay sesiones programadas ${periodName}.</p>`;
}
function renderRoutines() {
  document.getElementById('routine-grid').innerHTML = data.routines.map(routine => `<article class="routine-card"><span class="routine-icon">⌁</span><h3>${routine.title}</h3><p>${routine.description}</p>${routine.exercises.length ? `<div class="exercise-preview">${routine.exercises.slice(0, 4).map(exercise => `<span>${exerciseLabel(exercise)}</span>`).join('')}${routine.exercises.length > 4 ? `<span class="exercise-more">+${routine.exercises.length - 4} más</span>` : ''}</div>` : ''}<footer>${routine.clients} cliente${routine.clients !== 1 ? 's' : ''} asignado${routine.clients !== 1 ? 's' : ''} · ${routine.sessions} sesiones / semana · ${routine.exercises.length} ejercicio${routine.exercises.length !== 1 ? 's' : ''}</footer></article>`).join('');
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
  document.getElementById('plan-grid').innerHTML = data.plans.length ? data.plans.map(plan => `<article class="plan-card ${plan.active ? '' : 'inactive'}"><div><span class="commercial-label ${plan.billingModel === 'package' ? 'package-label' : ''}">${plan.billingModel === 'package' ? 'Paquete' : 'Mensualidad'}</span><h4>${escapeHtml(plan.name)}</h4><p>${escapeHtml(plan.description || (plan.billingModel === 'package' ? `${plan.sessionsIncluded} sesiones · ${plan.validityDays} días` : 'Cobro mensual'))}</p></div><div class="plan-price"><strong>${money.format(plan.price)}</strong><small>${plan.active ? 'Disponible' : 'Inactivo'}</small></div><button class="text-button" data-edit-plan="${plan.id}">Editar</button></article>`).join('') : '<p class="empty">Crea el primer plan para asignarlo a tus clientes.</p>';
  document.getElementById('invoice-table').innerHTML = visibleInvoices.length ? visibleInvoices.map(invoice => { const label = invoice.status === 'confirmed' ? 'Confirmado' : invoice.status === 'void' ? 'Anulada' : 'Pendiente'; const concept = invoice.invoiceNumber ? `<small>${invoice.source === 'zoho_invoice' ? 'Zoho' : 'Eileen'} · ${escapeHtml(invoice.invoiceNumber)}</small><br>${escapeHtml(invoice.concept)}` : escapeHtml(invoice.concept); return `<tr><td><b>${escapeHtml(invoice.client)}</b></td><td>${concept}</td><td>${invoice.due}</td><td>${invoice.method === 'pending' ? '—' : escapeHtml(invoice.method)}</td><td>${money.format(invoice.amount)}${invoice.status === 'pending' && invoice.balance !== invoice.amount ? `<br><small>Saldo ${money.format(invoice.balance)}</small>` : ''}</td><td><span class="payment-status ${invoice.status}">${label}</span></td><td><div class="invoice-actions"><button class="secondary session-use" data-invoice-pdf="${invoice.id}" data-invoice-number="${escapeHtml(invoice.invoiceNumber || invoice.id.slice(0, 8))}">Ver PDF</button>${invoice.status === 'pending' && invoice.source !== 'zoho_invoice' ? `<button class="secondary session-use" data-confirm-invoice="${invoice.id}">Confirmar</button>` : ''}</div></td></tr>`; }).join('') : '<tr><td colspan="7" class="empty">No hay facturas con estos filtros.</td></tr>';
  const loadMore = document.getElementById('billing-load-more'); loadMore.hidden = visibleInvoices.length >= periodInvoices.length; loadMore.textContent = `Mostrar más facturas (${periodInvoices.length - visibleInvoices.length} restantes)`;
  document.getElementById('package-table').innerHTML = data.packages.length ? data.packages.map(pack => {
    const remaining = remainingSessions(pack);
    const state = pack.status === 'pending' ? 'Pendiente de pago' : remaining ? 'Activo' : 'Agotado';
    return `<tr><td><b>${pack.client}</b></td><td>${pack.label}</td><td>${pack.total}</td><td>${pack.used}</td><td><strong class="session-balance">${remaining}</strong></td><td><span class="payment-status ${pack.status === 'confirmed' && remaining ? 'confirmed' : ''}">${state}</span></td><td><small>${pack.status === 'confirmed' && remaining ? 'Descuento automático' : '—'}</small></td></tr>`;
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
function financialReportDialog(kind) {
  const isStatement = kind === 'account-statement'; const dates = selectedReportDates(); const box = document.createElement('div');
  if (isStatement && !data.clients.length) { toast('Agrega un cliente antes de crear un estado de cuenta', true); return; }
  box.innerHTML = `<form id="financial-report-form"><p class="eyebrow">REPORTES FINANCIEROS</p><h2>${isStatement ? 'Estado de cuenta' : 'Cuentas por cobrar'}</h2><p class="report-form-copy">${isStatement ? 'Selecciona el cliente y período que deseas compartir.' : 'Obtén el detalle de saldos vigentes y su antigüedad a una fecha de corte.'}</p>${isStatement ? `<label>Cliente<select name="clientId" required>${data.clients.map(client => `<option value="${client.id}">${escapeHtml(client.name)}</option>`).join('')}</select></label><div class="form-row"><label>Desde<input name="from" type="date" value="${dates.from}" required /></label><label>Hasta<input name="to" type="date" value="${dates.to}" required /></label></div>` : `<label>Fecha de corte<input name="asOf" type="date" value="${dateKey(today)}" required /></label>`}<div class="report-format-actions"><button class="primary" type="submit" data-format="pdf">Previsualizar PDF</button><button class="secondary" type="submit" data-format="csv">Exportar CSV</button></div></form>`;
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
  const planSelect = document.getElementById('client-plan'); availablePlans.forEach(plan => planSelect.add(new Option(`${plan.name} · ${money.format(plan.price)}${plan.billingModel === 'package' ? ` · ${plan.sessionsIncluded} sesiones` : '/mes'}`, plan.id)));
  document.getElementById('client-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const selectedPlan = data.plans.find(plan => plan.id === form.get('planId'));
    try {
      event.target.classList.add('loading-state');
      await api('/api/clients', { method: 'POST', body: { fullName: form.get('name'), goal: form.get('goal'), planId: form.get('planId'), cutoffDay: Number(form.get('cutoffDay')), billingModel: selectedPlan?.billingModel || 'monthly', standardPrice: selectedPlan?.price || 0, packageSessions: selectedPlan?.sessionsIncluded || undefined, email: form.get('email') } });
      await loadData(); renderAll(); modal.close(); navigate('clients'); toast('Cliente creado y sincronizado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function planEditor(plan = null) {
  const content = formFromTemplate('plan-template'); openModal(content);
  const form = document.getElementById('plan-form'); const model = document.getElementById('plan-billing-model'); const packageFields = document.getElementById('plan-package-fields');
  const togglePackage = () => { packageFields.hidden = model.value !== 'package'; };
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
      await api(plan ? `/api/plans/${plan.id}` : '/api/plans', { method: plan ? 'PATCH' : 'POST', body: { name: values.get('name'), description: values.get('description'), billingModel, price: Number(values.get('price')), sessionsIncluded: billingModel === 'package' ? Number(values.get('sessionsIncluded')) : undefined, validityDays: billingModel === 'package' ? Number(values.get('validityDays')) : undefined, active: Boolean(values.get('active')) } });
      await loadData(); renderAll(); modal.close(); toast(plan ? 'Plan actualizado' : 'Plan creado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
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
  const box = document.createElement('div'); box.innerHTML = `<form id="notification-form"><p class="eyebrow">RECORDATORIOS</p><h2>Notificaciones</h2><div class="notification-list">${notifications.length ? notifications.map(item => `<div class="notification-item ${item.type}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.body)}</span></div>`).join('') : '<p class="empty">No hay recordatorios pendientes.</p>'}</div><div class="notification-settings"><label class="checkbox-line"><input name="inAppEnabled" type="checkbox" ${preferences.in_app_enabled ? 'checked' : ''} /> Mostrar dentro de la aplicación</label><label class="checkbox-line"><input name="browserEnabled" type="checkbox" ${preferences.browser_enabled ? 'checked' : ''} /> Notificaciones del navegador</label><div class="form-row"><label>Avisar sesión con horas de anticipación<input name="sessionReminderHours" type="number" min="1" max="168" value="${preferences.session_reminder_hours}" /></label><label>Avisar pago con días de anticipación<input name="paymentReminderDays" type="number" min="0" max="30" value="${preferences.payment_reminder_days}" /></label></div></div><button class="primary wide-button">Guardar preferencias</button></form>`;
  openModal(box, true);
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
    if (data.googleCalendar.connected) {
      button.textContent = 'Sincronizando…';
      const result = await api('/api/integrations/google-calendar/sync', { method: 'POST' });
      data.googleCalendar = await api('/api/integrations/google-calendar/status');
      renderGoogleCalendar(); renderCalendar();
      toast(result.failed ? `${result.synced} sesiones sincronizadas; ${result.failed} requieren revisión` : `${result.synced} sesiones sincronizadas con Google`, Boolean(result.failed));
    } else {
      button.textContent = 'Abriendo Google…';
      const result = await api('/api/integrations/google-calendar/authorize');
      window.location.assign(result.authorizationUrl);
    }
  } catch (error) {
    toast(error.message, true); button.disabled = false; button.textContent = original;
  }
}
async function disconnectGoogleCalendar() {
  if (!window.confirm('Se detendrá la sincronización. Los eventos que ya existen en Google Calendar se conservarán.')) return;
  const button = document.getElementById('google-calendar-disconnect');
  try {
    button.disabled = true; button.textContent = 'Desconectando…';
    await api('/api/integrations/google-calendar/disconnect', { method: 'POST' });
    data.googleCalendar = await api('/api/integrations/google-calendar/status');
    data.sessions.forEach(session => { session.googleSynced = false; session.googleEventLink = ''; session.googleSyncError = ''; });
    renderGoogleCalendar(); renderCalendar(); toast('Google Calendar desconectado');
  } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = 'Desconectar'; }
}
function showGoogleCalendarReturn() {
  const url = new URL(window.location.href); const result = url.searchParams.get('google');
  if (!result) return;
  if (result === 'connected') toast('Google Calendar conectado y sesiones sincronizadas');
  else if (result === 'partial') toast('Google Calendar se conectó; algunas sesiones requieren otra sincronización', true);
  else if (result === 'denied') toast('La autorización de Google fue cancelada', true);
  else toast('No fue posible completar la conexión con Google Calendar', true);
  url.searchParams.delete('google');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function newInvoice() {
  const content = formFromTemplate('new-invoice-template'); openModal(content);
  const selection = document.getElementById('invoice-client'); data.clients.forEach(client => selection.add(new Option(client.name, client.id)));
  const concept = document.getElementById('invoice-concept'); const packageFields = document.getElementById('invoice-package-fields');
  const togglePackage = () => { packageFields.hidden = concept.value !== 'Paquete de sesiones'; };
  concept.addEventListener('change', togglePackage); togglePackage();
  const amountInput = document.querySelector('#invoice-form [name="amount"]'); const dueInput = document.querySelector('#invoice-form [name="due"]'); const sessionsInput = document.querySelector('#invoice-form [name="sessions"]');
  const fillClientPlan = () => { const client = data.clients.find(item => item.id === selection.value); if (!client) return; amountInput.value = client.plan; concept.value = client.billingModel === 'package' ? 'Paquete de sesiones' : 'Mensualidad'; if (client.packageSessions) sessionsInput.value = client.packageSessions; togglePackage(); };
  dueInput.value = dateKey(today); selection.addEventListener('change', fillClientPlan); fillClientPlan();
  document.getElementById('invoice-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const method = form.get('method');
    try {
      event.target.classList.add('loading-state');
      let invoice;
      if (form.get('concept') === 'Paquete de sesiones') {
        const pack = await api('/api/packages', { method: 'POST', body: { clientId: form.get('client'), totalSessions: Number(form.get('sessions')), amount: Number(form.get('amount')) } });
        invoice = { id: pack.invoice_id };
      } else {
        invoice = await api('/api/invoices', { method: 'POST', body: { clientId: form.get('client'), concept: form.get('concept'), amount: Number(form.get('amount')), dueOn: form.get('due') } });
      }
      if (invoice && method !== 'pending') await api(`/api/invoices/${invoice.id}/confirm`, { method: 'POST', body: { method, reference: form.get('reference') || undefined } });
      await loadData(); renderAll(); modal.close(); navigate('billing'); toast('Cobro registrado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function newSession() {
  const content = formFromTemplate('new-session-template'); openModal(content);
  const clientSelect = document.getElementById('session-client'); data.clients.filter(client => client.status === 'Activo').forEach(client => clientSelect.add(new Option(client.name, client.id)));
  const routineSelect = document.getElementById('session-routine'); data.routines.forEach(routine => routineSelect.add(new Option(routine.title, routine.id)));
  document.querySelector('#session-form [name="date"]').value = dateKey(calendarCursor);
  document.getElementById('session-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try {
      event.target.classList.add('loading-state');
      const routineId = form.get('routine');
      await api('/api/sessions', { method: 'POST', body: { clientId: form.get('client'), routineId: routineId === 'Evaluación / seguimiento' ? undefined : routineId, startsAt: new Date(`${form.get('date')}T${form.get('time')}:00`).toISOString(), durationMinutes: 60, mode: form.get('mode'), notes: form.get('notes') || undefined } });
      await loadData(); renderAll(); modal.close(); navigate('calendar'); toast('Sesión agendada');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function newRoutine() {
  const content = formFromTemplate('new-routine-template'); openModal(content, true);
  const clientSelect = document.getElementById('routine-client');
  data.clients.forEach(client => clientSelect.add(new Option(`${client.name}${client.status === 'Activo' ? '' : ' · Inactivo'}`, client.id)));
  const categorySelect = document.getElementById('exercise-category');
  const levelSelect = document.getElementById('exercise-level');
  const exerciseSelect = document.getElementById('exercise-choice');
  const reference = document.getElementById('exercise-reference');
  const selectedList = document.getElementById('selected-exercises');
  const exerciseCount = document.getElementById('exercise-count');
  const selectedExercises = [];
  [...new Set(exerciseCatalog.map(exercise => exercise.category))].forEach(category => categorySelect.add(new Option(category, category)));
  [...new Set(exerciseCatalog.map(exercise => exercise.level))].forEach(level => levelSelect.add(new Option(level, level)));

  const currentExercise = () => exerciseCatalog.find(exercise => exercise.id === exerciseSelect.value);
  const renderReference = () => {
    const exercise = currentExercise();
    reference.innerHTML = exercise ? `<div><b>${exercise.name}</b><span>${exercise.english}</span></div><span class="exercise-level">${exercise.level}</span><small><b>Con máquina:</b> ${exercise.machine}<br><b>Sin máquina:</b> ${exercise.freeWeight}</small>` : '<p class="empty">No hay ejercicios con estos filtros.</p>';
  };
  const renderChoices = () => {
    const choices = exerciseCatalog.filter(exercise => exercise.category === categorySelect.value && (!levelSelect.value || exercise.level === levelSelect.value));
    exerciseSelect.replaceChildren(...choices.map(exercise => new Option(`${exercise.name} · ${exercise.english}`, exercise.id)));
    renderReference();
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
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'exercise-remove'; remove.dataset.removeExercise = String(index); remove.setAttribute('aria-label', `Quitar ${exercise.name}`); remove.textContent = '×';
      row.append(order, copy, dose, remove); selectedList.append(row);
    });
  };
  const prescription = exercise => ({
    ...exercise,
    catalogId: exercise.id,
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
  });
  renderChoices(); renderSelected();
  document.getElementById('routine-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const assigned = form.get('client');
    if (!selectedExercises.length) { toast('Agrega al menos un ejercicio a la rutina', true); return; }
    try {
      event.target.classList.add('loading-state');
      await api('/api/routines', { method: 'POST', body: { title: form.get('title'), description: form.get('description'), sessionsPerWeek: Number(form.get('sessions')), clientId: assigned || undefined, exercises: selectedExercises } });
      await loadData(); renderAll(); modal.close(); navigate('routines'); toast('Rutina guardada');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
async function completeSession(id) {
  try { await api(`/api/sessions/${id}/complete`, { method: 'POST' }); await loadData(); renderAll(); toast('Sesión completada'); }
  catch (error) { toast(error.message, true); }
}
function confirmInvoice(id) {
  const invoice = data.invoices.find(item => item.id === id); if (!invoice) return;
  const content = formFromTemplate('confirm-payment-template'); openModal(content);
  document.getElementById('payment-summary').textContent = `${invoice.client} · ${invoice.concept} · ${money.format(invoice.amount)}`;
  document.getElementById('payment-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target);
    try {
      event.target.classList.add('loading-state');
      await api(`/api/invoices/${id}/confirm`, { method: 'POST', body: { method: form.get('method'), reference: form.get('reference') || undefined } });
      await loadData(); renderAll(); modal.close(); navigate('billing'); toast('Pago confirmado');
    } catch (error) { toast(error.message, true); event.target.classList.remove('loading-state'); }
  });
}
function clientDetail(id) {
  const client = data.clients.find(item => item.id === id); const inbody = client.inbody;
  const pack = clientPackage(client.name);
  const commercialDescription = client.billingModel === 'package'
    ? `${client.planName || pack?.label || `Paquete ${client.sessionsIncluded || 0} sesiones`} · ${pack ? remainingSessions(pack) : client.sessionsIncluded || 0} disponibles · ${money.format(client.plan)}`
    : `${client.planName || 'Mensualidad'} · ${money.format(client.plan)} al mes · corte día ${client.cutoffDay}`;
  const box = document.createElement('div');
  const reviewNotice = client.inbodyReviews.length ? `<button class="secondary wide-button" id="review-inbody">Revisar ${client.inbodyReviews.length} evaluación${client.inbodyReviews.length > 1 ? 'es' : ''} pendiente${client.inbodyReviews.length > 1 ? 's' : ''}</button>` : '';
  box.innerHTML = `<p class="eyebrow">EXPEDIENTE</p><h2>${client.name}</h2><p style="color:#6f7b75;margin-top:-12px">${client.goal}<br>${commercialDescription}</p>${inbody ? `<div class="metrics" style="grid-template-columns:repeat(2,1fr)"><article><span>Peso</span><strong>${inbody.weight} kg</strong></article><article><span>Masa muscular</span><strong>${inbody.smm} kg</strong></article><article><span>Grasa corporal</span><strong>${inbody.pbf}%</strong></article><article><span>InBody Score</span><strong>${inbody.score}/100</strong></article></div><p class="eyebrow" style="margin-top:20px">HISTORIAL IMPORTADO</p><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Peso</th><th>Músculo</th><th>Grasa</th></tr></thead><tbody>${inbody.history.map(reading => `<tr><td>${reading.date}</td><td>${reading.weight} kg</td><td>${reading.smm} kg</td><td>${reading.pbf}%</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Aún no se ha confirmado una evaluación InBody.</p>'}${reviewNotice}<div class="detail-actions"><button class="secondary" id="edit-client-plan">Editar plan y corte</button><button class="secondary" id="portal-access">${client.portalActive ? 'Actualizar portal' : 'Activar portal cliente'}</button></div><button class="primary wide-button" id="open-scan">${inbody ? 'Importar nuevo InBody' : 'Importar InBody'}</button>`;
  openModal(box); document.getElementById('open-scan').onclick = () => inbodyImport(client); document.getElementById('edit-client-plan').onclick = () => clientPlanEditor(client); document.getElementById('portal-access').onclick = () => portalAccessEditor(client);
  if (client.inbodyReviews.length) document.getElementById('review-inbody').onclick = () => inbodyReview(client, client.inbodyReviews);
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
  box.innerHTML = `<p class="eyebrow">IMPORTACIÓN AUTOMÁTICA</p><h2>Analizar InBody</h2><p style="color:#6f7b75">Sube las páginas del reporte en PDF, JPG o PNG. Se guardarán en el expediente privado antes de iniciar el análisis.</p><p id="inbody-quota" class="inbody-review-note">Consultando el límite diario de análisis…</p><label style="border:2px dashed #d8a7bc;border-radius:9px;padding:24px;text-align:center;color:#8c5870;cursor:pointer"><input id="inbody-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple hidden />Seleccionar reporte InBody<br><small style="color:#6f7b75;font-weight:400">Máximo 20 MB por archivo</small></label><div id="scan-result"></div>`;
  openModal(box);
  api('/api/inbody/quota').then(quota => { document.getElementById('inbody-quota').textContent = `Protección de costo: ${quota.remaining} de ${quota.limit} unidades disponibles hoy.`; }).catch(() => {});
  document.getElementById('inbody-file').addEventListener('change', async event => {
    const files = [...event.target.files]; if (!files.length) return;
    const result = document.getElementById('scan-result'); result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>Subiendo ${files.length} archivo${files.length > 1 ? 's' : ''}…</b><span>Conexión privada con el expediente de ${client.name}.</span></div>`;
    try {
      const documentIds = [];
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} supera el límite de 20 MB`);
        const extension = file.name.split('.').pop()?.toLowerCase();
        const contentType = file.type || ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[extension];
        if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new Error(`${file.name} no es un PDF, JPG, PNG o WebP válido`);
        const created = await api('/api/documents/upload-url', { method: 'POST', body: { clientId: client.id, kind: 'inbody', fileName: file.name, contentType, sizeBytes: file.size } });
        await api(`/api/documents/${created.document.id}/content`, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
        documentIds.push(created.document.id);
      }
      result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>Analizando el reporte…</b><span>Leyendo métricas, fechas e historial y comprobando la coherencia de los resultados.</span></div>`;
      try {
        const analyzed = await api('/api/inbody/analyze', { method: 'POST', body: { clientId: client.id, documentIds } });
        inbodyReview(client, analyzed.assessments, analyzed.pageErrors, analyzed.skippedPages);
      } catch (analysisError) {
        result.innerHTML = `<div class="alert-item" style="margin-top:15px"><b>Reporte guardado; análisis pendiente</b><span>${escapeHtml(analysisError.message)}. El archivo está seguro y podrás reintentar cuando el lector automático esté configurado.</span></div>`;
      }
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
  if (actionButton?.dataset.action === 'new-plan') planEditor();
  if (actionButton?.dataset.action === 'export-compliance') exportCompliance();
  if (actionButton?.dataset.action === 'account-statement') financialReportDialog('account-statement');
  if (actionButton?.dataset.action === 'accounts-receivable') financialReportDialog('accounts-receivable');
  if (invoicePdfButton) previewProtectedPdf(`/api/invoices/${invoicePdfButton.dataset.invoicePdf}/pdf`, `Comprobante ${invoicePdfButton.dataset.invoiceNumber}`, `comprobante-${invoicePdfButton.dataset.invoiceNumber}.pdf`);
  if (event.target.dataset.editPlan) planEditor(data.plans.find(plan => plan.id === event.target.dataset.editPlan));
  if (event.target.dataset.client) clientDetail(event.target.dataset.client);
  if (event.target.dataset.inbody) inbodyImport(data.clients.find(client => client.id === event.target.dataset.inbody));
  if (event.target.dataset.completeSession) completeSession(event.target.dataset.completeSession);
  if (event.target.dataset.confirmInvoice) confirmInvoice(event.target.dataset.confirmInvoice);
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
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

const portalViewTitles = { 'portal-dashboard': 'Mi progreso', 'portal-routines': 'Mis rutinas', 'portal-calendar': 'Mi agenda', 'portal-billing': 'Facturación' };
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
  document.getElementById('portal-routines-list').innerHTML = portalData.routines.length ? portalData.routines.map(routine => { const todayCompletion = portalData.routineCompletions.find(item => item.routine_id === routine.id && item.completed_on === dateKey(today)); return `<article class="card portal-routine-card"><div class="card-head"><div><h3>${escapeHtml(routine.title)}</h3><p>${escapeHtml(routine.description || '')} · ${routine.sessions_per_week} veces por semana</p></div></div><div class="exercise-preview">${(routine.exercises || []).map(exercise => `<span>${escapeHtml(exerciseLabel(exercise))}</span>`).join('')}</div><form data-portal-routine="${routine.id}" class="portal-completion-form"><label class="completion-check"><input name="completed" type="checkbox" ${todayCompletion && Number(todayCompletion.completion_percent) > 0 ? 'checked' : ''} /><span>Entrenamiento realizado hoy</span></label><label class="completion-percent"><input name="completionPercent" type="number" min="0" max="100" value="${Number(todayCompletion?.completion_percent || 100)}" /><span>% completado</span></label><button class="primary">Guardar cumplimiento</button></form></article>`; }).join('') : '<p class="empty">La entrenadora todavía no te ha asignado una rutina.</p>';
  const ownSessions = new Map(portalData.sessions.map(item => [item.id, portalSession(item)]));
  document.getElementById('portal-calendar-list').innerHTML = portalData.busySlots.length ? portalData.busySlots.map(slot => { const date = new Date(slot.starts_at); const own = slot.is_mine ? ownSessions.get(slot.id) : null; return `<article class="portal-slot ${own ? 'mine' : 'busy'}"><time><b>${new Intl.DateTimeFormat('es-PA', { weekday: 'short', day: 'numeric', month: 'short' }).format(date)}</b><span>${new Intl.DateTimeFormat('es-PA', { hour: 'numeric', minute: '2-digit' }).format(date)}</span></time><div><b>${own ? escapeHtml(own.routine) : 'Ocupado'}</b><span>${own ? escapeHtml(own.mode) : 'Horario no disponible'}</span></div>${own ? `<form data-portal-session="${own.id}" class="portal-session-form"><label class="completion-check"><input name="completed" type="checkbox" ${own.status === 'completed' ? 'checked' : ''} /><span>Cumplí</span></label><label class="completion-percent"><input name="completionPercent" type="number" min="0" max="100" value="${own.status === 'completed' ? own.completionPercent || 100 : 0}" /><span>%</span></label><button class="secondary">Guardar</button></form>` : ''}</article>`; }).join('') : '<p class="empty">No hay horarios ocupados en los próximos 90 días.</p>';
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
  document.getElementById('auth-title').textContent = setupRequired ? 'Preparemos tu espacio' : 'Bienvenida de nuevo';
  document.getElementById('auth-copy').textContent = setupRequired ? 'Crea la primera cuenta administradora de Eileen Lifestyle.' : 'Accede al centro de control de clientes, sesiones y facturación.';
}
async function enterApp(user) {
  if (user.role === 'client') return enterPortal(user);
  const restoredView = viewFromHash();
  currentUser = user; view(restoredView); document.getElementById('auth-screen').hidden = true; document.getElementById('portal-shell').hidden = true; document.getElementById('app-shell').hidden = false;
  document.getElementById('account-button').textContent = initials(user.fullName || user.full_name || user.email);
  await loadData(); renderAll(); navigate(restoredView, { replace: true }); showGoogleCalendarReturn();
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
  localStorage.removeItem(authKey); localStorage.removeItem(legacyAuthKey); authToken = null; currentUser = null; portalData = null;
  data = { clients: [], invoices: [], packages: [], sessions: [], routines: [], plans: [], compliance: { compliancePercent: 0, activities: 0, clients: [] }, notifications: [], googleCalendar: { configured: false, connected: false, sessions: { synced: 0, pending: 0, failed: 0 } } }; showAuth(false);
};
document.getElementById('account-button').addEventListener('click', logout);
document.getElementById('portal-account-button').addEventListener('click', logout);
document.getElementById('google-calendar-connect').addEventListener('click', googleCalendarAction);
document.getElementById('google-calendar-disconnect').addEventListener('click', disconnectGoogleCalendar);
async function start() {
  try {
    const status = await api('/api/auth/setup-status', { auth: false });
    if (!authToken) return showAuth(status.required);
    const result = await api('/api/me'); await enterApp(result.user);
  } catch (error) { showAuth(false); document.getElementById('login-error').textContent = authToken ? 'La sesión venció. Inicia sesión nuevamente.' : 'No fue posible conectar con el servidor.'; }
}
start();
