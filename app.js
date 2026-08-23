const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const today = new Date();
const dateKey = date => date.toISOString().slice(0, 10);
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
const storeKey = 'eleen-lifestyle-data';
const previousStoreKey = 'momentum-coach-data';
let data = JSON.parse(localStorage.getItem(storeKey) || localStorage.getItem(previousStoreKey) || 'null') || seed;
if (!Array.isArray(data.packages)) data.packages = seed.packages;
if (!Array.isArray(data.sessions)) data.sessions = seed.sessions;
data.routines.forEach((routine, index) => { if (!routine.id) routine.id = `routine-${index}-${Date.now()}`; if (!Array.isArray(routine.exercises)) routine.exercises = []; });
data.clients.forEach(client => { if (!client.billingModel) client.billingModel = data.packages.some(pack => pack.client === client.name) ? 'package' : 'monthly'; });
localStorage.setItem(storeKey, JSON.stringify(data));
const save = () => localStorage.setItem(storeKey, JSON.stringify(data));
const initials = name => name.split(' ').slice(0, 2).map(word => word[0]).join('').toUpperCase();
const view = id => {
  document.querySelectorAll('.view').forEach(item => item.classList.toggle('active', item.id === id));
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item.dataset.view === id));
  document.getElementById('page-title').textContent = ({ dashboard: 'Buenos días', clients: 'Clientes', calendar: 'Agenda', routines: 'Rutinas', billing: 'Facturación' })[id];
  window.scrollTo(0, 0);
};
const monthInvoices = () => data.invoices.filter(invoice => { const date = new Date(`${invoice.due}T12:00:00`); return date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear(); });
const remainingSessions = pack => Math.max(0, pack.total - pack.used);
const clientPackage = name => data.packages.find(pack => pack.client === name && pack.status === 'confirmed' && remainingSessions(pack) > 0) || data.packages.find(pack => pack.client === name && pack.status === 'pending') || data.packages.find(pack => pack.client === name && pack.status !== 'expired');
const mondayFor = date => { const monday = new Date(date); monday.setDate(date.getDate() - ((date.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0); return monday; };
const sessionsThisWeek = () => { const start = mondayFor(today); const end = new Date(start); end.setDate(start.getDate() + 7); return data.sessions.filter(session => { const date = new Date(`${session.date}T12:00:00`); return date >= start && date < end; }); };
function renderDashboard() {
  const confirmed = monthInvoices().filter(item => item.status === 'confirmed').reduce((sum, item) => sum + item.amount, 0);
  const pending = data.invoices.filter(item => item.status === 'pending').reduce((sum, item) => sum + item.amount, 0);
  document.getElementById('active-clients').textContent = data.clients.filter(client => client.status === 'Activo').length;
  document.getElementById('client-trend').textContent = `${data.clients.length} expedientes registrados`;
  document.getElementById('week-sessions').textContent = sessionsThisWeek().length;
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
  document.getElementById('today-sessions').innerHTML = todaySessions.length ? todaySessions.map(session => `<div class="agenda-item"><span class="agenda-time">${session.time}</span><div><b>${session.client}</b><span>${session.routine} · ${session.mode.toLowerCase()}</span></div><span class="session-state ${session.status}">${session.status === 'completed' ? 'Realizada' : 'Programada'}</span></div>`).join('') : '<p class="empty">No hay sesiones para hoy.</p>';
  const noInbody = data.clients.filter(client => !client.inbody).map(client => `<div class="alert-item"><b>${client.name}</b><span>Sin evaluación InBody registrada.</span></div>`).join('');
  document.getElementById('alerts').innerHTML = `${noInbody || '<div class="alert-item"><b>Todo al día</b><span>No hay alertas de seguimiento.</span></div>'}<div class="alert-item"><b>${data.invoices.filter(item => item.status === 'pending').length} cobro pendiente</b><span>Revisa pagos y comprobantes.</span></div>`;
}
function renderClients(filter = '') {
  const clients = data.clients.filter(client => client.name.toLowerCase().includes(filter.toLowerCase()));
  document.getElementById('client-grid').innerHTML = clients.map(client => {
    const pack = clientPackage(client.name);
    const commercial = client.billingModel === 'package'
      ? `<span class="commercial-label package-label">Paquete</span><b>${pack?.status === 'pending' ? 'Pago pendiente' : `${pack ? remainingSessions(pack) : client.packageSessions || 0} sesiones disponibles`}</b><small>${money.format(client.plan)} por paquete</small>`
      : `<span class="commercial-label">Mensualidad</span><b>${money.format(client.plan)} / mes</b><small>Renovación recurrente</small>`;
    return `<article class="client-card"><header><span class="initials">${initials(client.name)}</span><div><h3>${client.name}</h3><small>${client.goal}</small></div><span class="status">${client.status}</span></header><p>${client.inbody ? `Último InBody: ${client.inbody.date}` : 'Aún no se ha cargado un InBody.'}</p><div class="commercial-summary">${commercial}</div><div class="mini-data">${client.inbody ? `<div><b>${client.inbody.weight} kg</b><span>Peso</span></div><div><b>${client.inbody.smm} kg</b><span>Músculo</span></div><div><b>${client.inbody.pbf}%</b><span>Grasa</span></div>` : `<div><b>—</b><span>Evaluación pendiente</span></div>`}</div><div class="client-actions"><button class="secondary" data-client="${client.id}">Ver expediente</button><button class="secondary" data-inbody="${client.id}">+ InBody</button></div></article>`;
  }).join('') || '<p class="empty">No se encontraron clientes.</p>';
}
function renderCalendar() {
  const monday = mondayFor(today);
  const names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  document.getElementById('week-calendar').innerHTML = names.map((name, index) => {
    const d = new Date(monday); d.setDate(monday.getDate() + index); const key = dateKey(d);
    const daySessions = data.sessions.filter(session => session.date === key).sort((a, b) => a.time.localeCompare(b.time));
    return `<div class="day-col ${key === dateKey(today) ? 'today' : ''}"><div class="day-name">${name}</div><div class="day-num">${d.getDate()}</div>${daySessions.map(session => `<div class="session-chip ${session.status}"><b>${session.time}</b> ${session.client.split(' ')[0]}</div>`).join('')}</div>`;
  }).join('');
  const weekly = sessionsThisWeek().sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  document.getElementById('session-list').innerHTML = weekly.length ? weekly.map(session => `<div class="session-row"><div class="session-date"><b>${new Intl.DateTimeFormat('es-PA', { weekday: 'short', day: 'numeric' }).format(new Date(`${session.date}T12:00:00`))}</b><span>${session.time}</span></div><div class="session-person"><b>${session.client}</b><span>${session.routine} · ${session.mode}</span></div><span class="session-state ${session.status}">${session.status === 'completed' ? 'Realizada' : 'Programada'}</span>${session.status === 'scheduled' ? `<button class="secondary session-complete" data-complete-session="${session.id}">Marcar realizada</button>` : '<span class="session-done">✓</span>'}</div>`).join('') : '<p class="empty">No hay sesiones programadas esta semana.</p>';
}
function renderRoutines() { document.getElementById('routine-grid').innerHTML = data.routines.map(routine => `<article class="routine-card"><span class="routine-icon">⌁</span><h3>${routine.title}</h3><p>${routine.description}</p>${routine.exercises.length ? `<div class="exercise-preview">${routine.exercises.slice(0, 3).map(exercise => `<span>${exercise}</span>`).join('')}</div>` : ''}<footer>${routine.clients} cliente${routine.clients !== 1 ? 's' : ''} asignado${routine.clients !== 1 ? 's' : ''} · ${routine.sessions} sesiones / semana</footer></article>`).join(''); }
function renderBilling() {
  const billed = monthInvoices().reduce((sum, item) => sum + item.amount, 0);
  const pending = data.invoices.filter(item => item.status === 'pending').reduce((sum, item) => sum + item.amount, 0);
  document.getElementById('month-billed').textContent = money.format(billed);
  document.getElementById('active-memberships').textContent = data.clients.filter(client => client.billingModel === 'monthly' && client.status === 'Activo').length;
  document.getElementById('active-packages').textContent = data.packages.filter(pack => pack.status === 'confirmed' && remainingSessions(pack) > 0).length;
  document.getElementById('billing-pending').textContent = money.format(pending);
  document.getElementById('invoice-table').innerHTML = data.invoices.map(invoice => `<tr><td><b>${invoice.client}</b></td><td>${invoice.concept}</td><td>${invoice.due}</td><td>${invoice.method === 'pending' ? '—' : invoice.method}</td><td>${money.format(invoice.amount)}</td><td><span class="payment-status ${invoice.status}">${invoice.status === 'confirmed' ? 'Confirmado' : 'Pendiente'}</span></td><td>${invoice.status === 'pending' ? `<button class="secondary session-use" data-confirm-invoice="${invoice.id}">Confirmar</button>` : ''}</td></tr>`).join('');
  document.getElementById('package-table').innerHTML = data.packages.length ? data.packages.map(pack => {
    const remaining = remainingSessions(pack);
    const state = pack.status === 'pending' ? 'Pendiente de pago' : remaining ? 'Activo' : 'Agotado';
    return `<tr><td><b>${pack.client}</b></td><td>${pack.label}</td><td>${pack.total}</td><td>${pack.used}</td><td><strong class="session-balance">${remaining}</strong></td><td><span class="payment-status ${pack.status === 'confirmed' && remaining ? 'confirmed' : ''}">${state}</span></td><td>${pack.status === 'confirmed' && remaining ? `<button class="secondary session-use" data-use-package="${pack.id}">Usar 1 sesión</button>` : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">Aún no hay paquetes de sesiones.</td></tr>';
}
function renderAll() { renderDashboard(); renderClients(); renderCalendar(); renderRoutines(); renderBilling(); }
const modal = document.getElementById('modal');
function openModal(content) { document.getElementById('modal-content').replaceChildren(content); modal.showModal(); }
function formFromTemplate(id) { return document.getElementById(id).content.cloneNode(true); }
function newClient() {
  const content = formFromTemplate('new-client-template'); openModal(content);
  const model = document.getElementById('client-billing-model'); const packageFields = document.getElementById('client-package-fields');
  const togglePackage = () => { packageFields.hidden = model.value !== 'package'; };
  model.addEventListener('change', togglePackage); togglePackage();
  document.getElementById('client-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.target); const billingModel = form.get('billingModel'); const name = form.get('name');
    const client = { id: crypto.randomUUID(), name, goal: form.get('goal'), billingModel, plan: Number(form.get('plan')), packageSessions: billingModel === 'package' ? Number(form.get('packageSessions')) : null, packageValidity: billingModel === 'package' ? Number(form.get('packageValidity')) : null, email: form.get('email'), status: 'Activo', inbody: null };
    data.clients.push(client);
    if (billingModel === 'package') {
      const invoiceId = crypto.randomUUID();
      data.invoices.unshift({ id: invoiceId, client: name, concept: 'Paquete de sesiones', amount: client.plan, due: dateKey(today), method: 'pending', status: 'pending' });
      data.packages.unshift({ id: crypto.randomUUID(), invoiceId, client: name, label: `Paquete ${client.packageSessions} sesiones`, total: client.packageSessions, used: 0, amount: client.plan, status: 'pending' });
    }
    save(); renderAll(); modal.close(); view('clients');
  });
}
function newInvoice() {
  const content = formFromTemplate('new-invoice-template'); openModal(content);
  const selection = document.getElementById('invoice-client'); data.clients.forEach(client => selection.add(new Option(client.name, client.name)));
  const concept = document.getElementById('invoice-concept'); const packageFields = document.getElementById('invoice-package-fields');
  const togglePackage = () => { packageFields.hidden = concept.value !== 'Paquete de sesiones'; };
  concept.addEventListener('change', togglePackage); togglePackage();
  const amountInput = document.querySelector('#invoice-form [name="amount"]'); const dueInput = document.querySelector('#invoice-form [name="due"]'); const sessionsInput = document.querySelector('#invoice-form [name="sessions"]');
  const fillClientPlan = () => { const client = data.clients.find(item => item.name === selection.value); if (!client) return; amountInput.value = client.plan; concept.value = client.billingModel === 'package' ? 'Paquete de sesiones' : 'Mensualidad'; if (client.packageSessions) sessionsInput.value = client.packageSessions; togglePackage(); };
  dueInput.value = dateKey(today); selection.addEventListener('change', fillClientPlan); fillClientPlan();
  document.getElementById('invoice-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.target); const method = form.get('method'); const status = method === 'pending' ? 'pending' : 'confirmed';
    const invoice = { id: crypto.randomUUID(), client: form.get('client'), concept: form.get('concept'), amount: Number(form.get('amount')), due: form.get('due'), method, reference: form.get('reference'), status };
    data.invoices.unshift(invoice);
    if (invoice.concept === 'Paquete de sesiones') {
      const sessions = Number(form.get('sessions'));
      data.packages.unshift({ id: crypto.randomUUID(), invoiceId: invoice.id, client: invoice.client, label: `Paquete ${sessions} sesiones`, total: sessions, used: 0, amount: invoice.amount, status });
      const client = data.clients.find(item => item.name === invoice.client); if (client) { client.billingModel = 'package'; client.plan = invoice.amount; client.packageSessions = sessions; }
    }
    save(); renderAll(); modal.close(); view('billing');
  });
}
function newSession() {
  const content = formFromTemplate('new-session-template'); openModal(content);
  const clientSelect = document.getElementById('session-client'); data.clients.filter(client => client.status === 'Activo').forEach(client => clientSelect.add(new Option(client.name, client.name)));
  const routineSelect = document.getElementById('session-routine'); data.routines.forEach(routine => routineSelect.add(new Option(routine.title, routine.title)));
  document.querySelector('#session-form [name="date"]').value = dateKey(today);
  document.getElementById('session-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.target);
    data.sessions.push({ id: crypto.randomUUID(), client: form.get('client'), date: form.get('date'), time: form.get('time'), routine: form.get('routine'), mode: form.get('mode'), notes: form.get('notes'), status: 'scheduled', packageDebited: false });
    save(); renderAll(); modal.close(); view('calendar');
  });
}
function newRoutine() {
  const content = formFromTemplate('new-routine-template'); openModal(content);
  const clientSelect = document.getElementById('routine-client'); data.clients.filter(client => client.status === 'Activo').forEach(client => clientSelect.add(new Option(client.name, client.name)));
  document.getElementById('routine-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.target); const assigned = form.get('client');
    data.routines.unshift({ id: crypto.randomUUID(), title: form.get('title'), description: form.get('description'), clients: assigned ? 1 : 0, assignedClients: assigned ? [assigned] : [], sessions: Number(form.get('sessions')), exercises: String(form.get('exercises') || '').split('\n').map(item => item.trim()).filter(Boolean) });
    save(); renderAll(); modal.close(); view('routines');
  });
}
function completeSession(id) {
  const session = data.sessions.find(item => item.id === id); if (!session || session.status === 'completed') return;
  session.status = 'completed';
  const pack = data.packages.find(item => item.client === session.client && item.status === 'confirmed' && remainingSessions(item) > 0);
  if (pack) { pack.used += 1; session.packageDebited = true; session.packageId = pack.id; }
  save(); renderAll();
}
function confirmInvoice(id) {
  const invoice = data.invoices.find(item => item.id === id); if (!invoice) return;
  const content = formFromTemplate('confirm-payment-template'); openModal(content);
  document.getElementById('payment-summary').textContent = `${invoice.client} · ${invoice.concept} · ${money.format(invoice.amount)}`;
  document.getElementById('payment-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.target); invoice.method = form.get('method'); invoice.reference = form.get('reference'); invoice.status = 'confirmed'; invoice.confirmedAt = new Date().toISOString();
    const pack = data.packages.find(item => item.invoiceId === invoice.id || (item.client === invoice.client && item.status === 'pending' && item.amount === invoice.amount)); if (pack) pack.status = 'confirmed';
    save(); renderAll(); modal.close(); view('billing');
  });
}
function clientDetail(id) {
  const client = data.clients.find(item => item.id === id); const inbody = client.inbody;
  const pack = clientPackage(client.name);
  const commercialDescription = client.billingModel === 'package'
    ? `${pack?.label || `Paquete ${client.packageSessions || 0} sesiones`} · ${pack ? remainingSessions(pack) : client.packageSessions || 0} disponibles · ${money.format(client.plan)}`
    : `Mensualidad · ${money.format(client.plan)} al mes`;
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">EXPEDIENTE</p><h2>${client.name}</h2><p style="color:#6f7b75;margin-top:-12px">${client.goal}<br>${commercialDescription}</p>${inbody ? `<div class="metrics" style="grid-template-columns:repeat(2,1fr)"><article><span>Peso</span><strong>${inbody.weight} kg</strong></article><article><span>Masa muscular</span><strong>${inbody.smm} kg</strong></article><article><span>Grasa corporal</span><strong>${inbody.pbf}%</strong></article><article><span>InBody Score</span><strong>${inbody.score}/100</strong></article></div><p class="eyebrow" style="margin-top:20px">HISTORIAL IMPORTADO</p><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Peso</th><th>Músculo</th><th>Grasa</th></tr></thead><tbody>${inbody.history.map(reading => `<tr><td>${reading.date}</td><td>${reading.weight} kg</td><td>${reading.smm} kg</td><td>${reading.pbf}%</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Aún no se ha importado una evaluación InBody.</p>'}<button class="primary wide-button" id="open-scan">${inbody ? 'Importar nuevo InBody' : 'Importar InBody'}</button>`;
  openModal(box); document.getElementById('open-scan').onclick = () => inbodyImport(client);
}
function inbodyImport(client) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="eyebrow">IMPORTACIÓN AUTOMÁTICA</p><h2>Analizar InBody</h2><p style="color:#6f7b75">Sube las páginas del reporte en PDF, JPG o PNG. El extractor identificará métricas y el historial sin digitación manual.</p><label style="border:2px dashed #b4cbbd;border-radius:9px;padding:24px;text-align:center;color:#42705f;cursor:pointer"><input id="inbody-file" type="file" accept="application/pdf,image/*" multiple hidden />Seleccionar reporte InBody<br><small style="color:#6f7b75;font-weight:400">PDF o imágenes del reporte completo</small></label><div id="scan-result"></div>`;
  openModal(box); document.getElementById('inbody-file').addEventListener('change', event => { if (!event.target.files.length) return; document.getElementById('scan-result').innerHTML = `<div class="alert-item" style="margin-top:15px"><b>Archivo recibido</b><span>El motor OCR se conectará al servicio de análisis en la siguiente etapa. La interfaz y el modelo de datos ya admiten la importación automática del InBody 580.</span></div>`; });
}
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => view(link.dataset.view)));
document.querySelectorAll('[data-view-go]').forEach(button => button.addEventListener('click', () => view(button.dataset.viewGo)));
document.addEventListener('click', event => {
  if (event.target.dataset.action === 'new-client') newClient();
  if (event.target.dataset.action === 'new-invoice') newInvoice();
  if (event.target.dataset.action === 'new-session') newSession();
  if (event.target.dataset.action === 'new-routine') newRoutine();
  if (event.target.dataset.client) clientDetail(event.target.dataset.client);
  if (event.target.dataset.inbody) inbodyImport(data.clients.find(client => client.id === event.target.dataset.inbody));
  if (event.target.dataset.usePackage) {
    const pack = data.packages.find(item => item.id === event.target.dataset.usePackage);
    if (pack && remainingSessions(pack) > 0) { pack.used += 1; save(); renderAll(); }
  }
  if (event.target.dataset.completeSession) completeSession(event.target.dataset.completeSession);
  if (event.target.dataset.confirmInvoice) confirmInvoice(event.target.dataset.confirmInvoice);
});
document.querySelector('.modal-close').addEventListener('click', () => modal.close());
document.getElementById('client-search').addEventListener('input', event => renderClients(event.target.value));
document.getElementById('today').textContent = new Intl.DateTimeFormat('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }).format(today);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}
renderAll();
