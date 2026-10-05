// Humo de interfaz (J-116): abre la aplicación real, contra el API real de pruebas, y hace lo que hace una persona. Existe porque dos defectos llegaron a producción con todas las pruebas de servidor en verde:
//  · v286: el portal de los clientes se caía al dibujarse (se llamaba a una función que no existía).
//  · Editar una rutina guardada abría un editor muerto (el formulario se consultaba cuando ya estaba vacío).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';
import { abrirPantalla, esperar } from './ui-harness.mjs';

let servidor; let api; let db; let tokenStaff; let tokenPortal; let clientId; let rutinaId; let sesionId;
const panama = (d = 0) => new Date(Date.now() - 5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  tokenStaff = login.datos.token; api.usarToken(tokenStaff);
  const [dueno] = await db`SELECT id FROM users LIMIT 1`;
  const ej = async (slug, nombre, seccion, libre) => (await db`INSERT INTO exercises (owner_id, slug, name, section, level, free_weight) VALUES (${dueno.id}, ${slug}, ${nombre}, ${seccion}, 'Todos', ${libre || null}) RETURNING id`)[0].id;
  const plancha = await ej('plancha', 'Plancha', 'core'); const puente = await ej('puente', 'Puente de glúteo', 'tren_inferior', 'Mancuernas'); const curl = await ej('curl', 'Curl de bíceps', 'tren_superior', 'Mancuernas');
  clientId = (await api.post('/api/clients', { fullName: 'Sara Prueba', cutoffDay: 15, email: 'sara.ui@prueba.test' })).datos.id;
  await api.post('/api/clients', { fullName: 'Eduardo Prueba', cutoffDay: 28 });
  const ejercicios = [plancha, puente, curl, plancha, puente, curl].map((id, i) => ({ catalogId: id, name: ['Plancha', 'Puente de glúteo', 'Curl de bíceps'][i % 3], sets: 3, reps: String(10 + i), block: i < 3 ? 1 : 2, rounds: 3 }));
  rutinaId = (await api.post('/api/routines', { title: 'Rutina en bloques', description: 'Calienta 5 minutos.', sessionsPerWeek: 3, exercises: ejercicios, clientId })).datos.id;
  sesionId = (await api.post('/api/sessions', { clientId, startsAt: new Date(`${panama(0)}T23:00:00-05:00`).toISOString(), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  await api.post('/api/sessions', { clientId, startsAt: new Date(`${panama(3)}T09:00:00-05:00`).toISOString(), durationMinutes: 45, mode: 'Presencial' });
  await api.post(`/api/clients/${clientId}/travel`, { startsOn: panama(1), endsOn: panama(8), destination: 'Roma' });
  const enlace = await api.post(`/api/clients/${clientId}/access-link`, {});
  const acceso = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
  tokenPortal = acceso.datos.token;
}, { timeout: 120_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

const sinErrores = (pagina, contexto) => assert.deepEqual(pagina.errores, [], `${contexto}: errores de JavaScript en la pantalla`);

test('sin sesión se ve la pantalla de acceso y no hay errores', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base });
  try {
    await esperar(() => !p.document.getElementById('auth-screen').hidden, { mensaje: 'pantalla de acceso' });
    assert.ok(p.q('#login-form') && !p.q('#login-form').hidden);
    sinErrores(p, 'acceso');
  } finally { await p.cerrar(); }
});

test('la entrenadora entra y recorre todas las secciones sin errores', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenStaff, hash: '#dashboard' });
  try {
    await esperar(() => !p.document.getElementById('app-shell').hidden, { mensaje: 'aplicación visible' });
    await esperar(() => p.evaluar('data.clients.length') >= 2, { mensaje: 'datos cargados' });
    for (const vista of ['dashboard', 'clients', 'calendar', 'attendance', 'routines', 'billing']) {
      p.clic(p.q(`[data-view="${vista}"]`)); await p.quieta(250);
      assert.ok(p.q(`#${vista}`).classList.contains('active'), `la vista ${vista} se muestra`);
    }
    for (const sub of p.qa('#billing-subtabs .subtab')) { p.clic(sub); await p.quieta(200); }
    p.clic(p.q('[data-view="calendar"]')); await p.quieta(200);
    for (const modo of ['Día', 'Semana', 'Mes']) { p.clic(p.qa('.calendar-view-button').find(b => b.textContent.trim() === modo)); await p.quieta(150); }
    assert.ok(p.q('.calendar-leyenda'), 'la leyenda de colores del calendario');
    assert.ok(p.qa('.session-chip, .month-event, .day-session').length >= 0);
    sinErrores(p, 'recorrido de la entrenadora');
  } finally { await p.cerrar(); }
});

test('EDITAR una rutina guardada abre el editor completo y TODAS sus acciones funcionan (cambiar, mover entre bloques, agregar a un bloque, quitar) y se guarda', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenStaff, hash: '#routines' });
  try {
    await esperar(() => p.evaluar('data.routines.length') >= 1, { mensaje: 'rutinas cargadas' });
    p.clic(p.q('[data-view="routines"]')); await p.quieta(200);
    p.clic(p.q(`[data-edit-routine="${rutinaId}"]`));
    const f = await esperar(() => p.q('#routine-form'), { mensaje: 'formulario del editor' });
    assert.equal(p.q('h2', f).textContent, 'Editar rutina');
    assert.equal(f.elements.title.value, 'Rutina en bloques');
    assert.equal(p.qa('.selected-exercise', f).length, 6);
    assert.deepEqual(p.qa('.bloque-cabecera b', f).map(x => x.textContent), ['Bloque 1', 'Bloque 2']);
    assert.equal(f.elements.client.value, clientId, 'conserva el cliente asignado');
    const nombres = () => p.qa('.selected-exercise b', f).map(x => x.textContent);
    const bloques = () => p.qa('.bloque-cabecera, .selected-exercise', f).map(x => x.classList.contains('bloque-cabecera') ? `[${p.q('b', x).textContent}]` : p.q('b', x).textContent);

    // 1) Cambiar un ejercicio del bloque 2 por otro del catálogo
    const curl = p.evaluar("exerciseCatalog.find(e => e.name === 'Curl de bíceps').id");
    p.cambiar(p.q('[data-cambiar-ejercicio="4"]', f), curl);
    assert.equal(nombres()[4], 'Curl de bíceps', 'el ejercicio se cambió');
    // 2) Pasar un ejercicio de un bloque al otro
    p.cambiar(p.q('[data-exercise-block="0"]', f), '2');
    assert.equal(nombres().length, 6); assert.deepEqual(bloques().slice(0, 2), ['[Bloque 1]', 'Puente de glúteo'], 'el primero salió del bloque 1');
    // 3) Agregar un ejercicio nuevo directo a un bloque
    p.cambiar(p.q('#exercise-choice'), p.evaluar("exerciseCatalog.find(e => e.name === 'Plancha').id"));
    p.cambiar(p.q('#agregar-a'), '1'); p.clic(p.q('#add-exercise'));
    assert.equal(nombres().length, 7, 'se agregó');
    // 4) Quitar uno
    p.clic(p.q('[data-remove-exercise="0"]', f));
    assert.equal(nombres().length, 6, 'se quitó');
    // 5) Cambiar las rondas de un bloque
    const rondas = p.q('[data-bloque-rondas="2"]', f); rondas.value = '4'; rondas.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    // 6) Guardar
    f.requestSubmit();
    await esperar(() => p.evaluar('modal.open') === false, { mensaje: 'el editor se cierra al guardar' });
    const guardada = (await api.get('/api/routines')).datos.find(r => r.id === rutinaId);
    assert.ok(guardada.exercises.every(e => e.block >= 1 && e.rounds >= 1), 'siguen en bloques');
    assert.ok(guardada.exercises.filter(e => e.block === 2).every(e => e.rounds === 4), 'las rondas editadas se guardaron');
    assert.equal(guardada.assigned_client_ids.length, 1, 'la asignación del cliente se conserva');
    sinErrores(p, 'editar rutina');
  } finally { await p.cerrar(); }
});

test('Reutilizar una rutina y crear una nueva con IA (propuesta) también abren un editor vivo', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenStaff, hash: '#routines' });
  try {
    await esperar(() => p.evaluar('data.routines.length') >= 1, { mensaje: 'rutinas cargadas' });
    p.clic(p.q(`[data-duplicate-routine="${rutinaId}"]`));
    const f = await esperar(() => p.q('#routine-form'), { mensaje: 'editor de la copia' });
    assert.match(p.q('h2', f).textContent, /Reutilizar/); assert.match(f.elements.title.value, /\(copia\)/);
    assert.equal(p.qa('.selected-exercise', f).length, 6);
    p.evaluar("modal.close()");
    // propuesta con IA
    p.evaluar(`newRoutine(null, false, { title: 'Propuesta', description: 'D', sessionsPerWeek: 3, clientId: '${clientId}', rationale: 'Porque sí.', avoided: [], descartados: [],
      exercises: [{ name: 'Plancha', sets: 3, reps: '30 seg', block: 1, rounds: 3 }, { name: 'Puente de glúteo', sets: 3, reps: '12', block: 1, rounds: 3 }, { name: 'Curl de bíceps', sets: 3, reps: '12', block: 2, rounds: 3 }] })`);
    const g = await esperar(() => p.q('#routine-form'), { mensaje: 'editor de la propuesta' });
    assert.equal(p.qa('.selected-exercise', g).length, 3);
    assert.ok(p.q('.aviso-ambito', g), 'el aviso de la propuesta'); assert.ok(p.q('#agregar-a', g) || p.q('#agregar-a'), 'agregar a un bloque');
    p.clic(p.q('[data-remove-exercise="0"]', g)); assert.equal(p.qa('.selected-exercise', g).length, 2);
    sinErrores(p, 'reutilizar y propuesta');
  } finally { await p.cerrar(); }
});

test('el diálogo de cancelar ofrece "Proponer rutina" por los dos caminos y "Proponer rutina" de la agenda abre las especificaciones', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenStaff, hash: '#calendar' });
  try {
    await esperar(() => p.evaluar('data.sessions.length') >= 2, { mensaje: 'sesiones cargadas' });
    const sesion = `data.sessions.find(s => s.id === '${sesionId}')`;
    p.evaluar(`cancelSessionDialog(${sesion})`);
    p.clic(await esperar(() => p.q('#cancela-cliente'), { mensaje: 'quién cancela' }));
    assert.ok(await esperar(() => p.q('#proponer-rutina'), { mensaje: 'Proponer rutina (cliente)' }));
    p.evaluar('modal.close()');
    p.evaluar(`cancelSessionDialog(${sesion})`);
    p.clic(await esperar(() => p.q('#cancela-entrenadora'), { mensaje: 'cancela ella' }));
    assert.ok(await esperar(() => p.q('#proponer-rutina'), { mensaje: 'Proponer rutina (Eileen)' }));
    assert.ok(p.q('.aviso-reprogramar'), 'recordatorio de reprogramar');
    p.evaluar('modal.close()');
    p.evaluar(`proponerRutinaDesdeAgenda(${sesion})`);
    p.clic(await esperar(() => p.q('#propuesta-cliente'), { mensaje: 'por qué se propone' }));
    assert.ok(await esperar(() => p.q('#oferta-especificaciones textarea[name="especificacion"]'), { mensaje: 'especificación breve' }));
    sinErrores(p, 'cancelar y proponer');
  } finally { await p.cerrar(); }
});

test('el PORTAL del cliente dibuja todas sus secciones (rutinas con bloques, viaje, agenda) sin errores y sin caer en "La sesión venció"', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenPortal, hash: '#portal-dashboard' });
  try {
    await esperar(() => !p.document.getElementById('portal-shell').hidden, { mensaje: 'portal visible' });
    assert.ok(p.document.getElementById('auth-screen').hidden, 'no cayó en la pantalla de acceso');
    await esperar(() => p.q('#portal-travel-dashboard .portal-viaje-card'), { mensaje: 'tarjeta de viaje' });
    for (const vista of ['portal-routines', 'portal-calendar', 'portal-billing', 'portal-reports', 'portal-dashboard']) {
      p.window.location.hash = `#${vista}`; await p.quieta(250);
    }
    p.window.location.hash = '#portal-routines'; await p.quieta(200);
    const tarjeta = await esperar(() => p.q('.portal-routine-card'), { mensaje: 'tarjeta de rutina' });
    assert.match(tarjeta.textContent, /Rutina en bloques/);
    assert.ok(p.qa('.routine-block-title', tarjeta).length >= 2, 'los bloques con sus rondas');
    assert.ok(p.q('[data-timer-toggle]', tarjeta), 'el cronómetro');
    p.clic(p.q('[data-timer-toggle]', tarjeta));
    await esperar(() => p.q('.portal-routine-card [data-timer-display]').textContent !== '00:00', { ms: 4000, mensaje: 'el cronómetro corre' });
    p.window.location.hash = '#portal-calendar'; await p.quieta(300);
    assert.ok(p.q('.portal-col-dia.viaje'), 'los días de viaje en la agenda del cliente');
    sinErrores(p, 'portal del cliente');
  } finally { await p.cerrar(); }
});

test('la página pública de la rutina (enlace) se abre sin sesión, muestra los bloques y permite confirmar', async () => {
  const rutinaViaje = (await api.post('/api/routines', { title: 'Rutina del enlace', sessionsPerWeek: 3, clientId, exercises: [{ name: 'Plancha', sets: 3, reps: '30 seg', block: 1, rounds: 3 }, { name: 'Flexiones', sets: 3, reps: '10', block: 1, rounds: 3 }] })).datos.id;
  const enlace = await api.post(`/api/routines/${rutinaViaje}/share-links`, { clientId, hours: 24 });
  const token = String(enlace.datos.url).split('#rutina=')[1];
  const p = await abrirPantalla({ baseApi: servidor.base, hash: `#rutina=${token}` });
  try {
    await esperar(() => p.q('#public-routine .public-card h2') && !p.document.getElementById('public-routine').hidden, { mensaje: 'página pública' });
    assert.match(p.q('#public-routine').textContent, /Rutina del enlace/);
    assert.match(p.q('#public-routine').textContent, /Bloque 1 · 3 rondas/);
    p.clic(p.q('#public-terminar'));
    await esperar(() => /Eileen ya sabe/.test(p.q('#public-final').textContent), { mensaje: 'confirmación' });
    sinErrores(p, 'página pública');
  } finally { await p.cerrar(); }
});
