// Humo de interfaz (J-116): abre la aplicación real, contra el API real de pruebas, y hace lo que hace una persona. Existe porque dos defectos llegaron a producción con todas las pruebas de servidor en verde:
//  · v286: el portal de los clientes se caía al dibujarse (se llamaba a una función que no existía).
//  · Editar una rutina guardada abría un editor muerto (el formulario se consultaba cuando ya estaba vacío).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';
import { abrirPantalla, esperar } from './ui-harness.mjs';

// La pantalla corre en este proceso y el negocio cuenta los días en hora de Panamá (el teléfono de la clienta está en Panamá): sin esto, de 19:00 a 24:00 de Panamá la prueba vería otro día que el servidor.
process.env.TZ = 'America/Panama';

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
  rutinaId = (await api.post('/api/routines', { title: 'Rutina en bloques', description: 'Calienta 5 minutos.', sessionsPerWeek: 3, exercises: ejercicios, clientId, dueOn: '2026-09-15' })).datos.id;
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
    assert.equal(f.elements.dueOn.disabled, false, 'la fecha límite se puede editar si hay asignación');
    assert.equal(f.elements.dueOn.value, '2026-09-15');
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
    // 6) Cambiar la fecha y guardar
    f.elements.dueOn.value = '2026-10-20';
    f.requestSubmit();
    await esperar(() => p.evaluar('modal.open') === false, { mensaje: 'el editor se cierra al guardar' });
    const guardada = (await api.get('/api/routines')).datos.find(r => r.id === rutinaId);
    assert.ok(guardada.exercises.every(e => e.block >= 1 && e.rounds >= 1), 'siguen en bloques');
    assert.ok(guardada.exercises.filter(e => e.block === 2).every(e => e.rounds === 4), 'las rondas editadas se guardaron');
    assert.equal(guardada.assigned_client_ids.length, 1, 'la asignación del cliente se conserva');
    assert.equal(String(guardada.due_on).slice(0, 10), '2026-10-20', 'la fecha límite nueva se guardó');
    p.clic(p.q(`[data-open-routine="${rutinaId}"]`));
    await esperar(() => /Fecha límite: 20-10-2026/.test(p.q('#modal-content')?.textContent || ''), { mensaje: 'fecha límite nueva en el detalle' });
    p.evaluar('modal.close()');
    p.clic(p.q(`[data-edit-routine="${rutinaId}"]`));
    const f2 = await esperar(() => p.q('#routine-form'), { mensaje: 'editor para borrar fecha' });
    f2.elements.dueOn.value = '';
    f2.requestSubmit();
    await esperar(() => p.evaluar('modal.open') === false, { mensaje: 'se borra la fecha límite' });
    assert.equal((await api.get('/api/routines')).datos.find(r => r.id === rutinaId).due_on, null);
    sinErrores(p, 'editar rutina');
  } finally { await p.cerrar(); }
});

test('Reutilizar una rutina y crear una nueva con IA (propuesta) también abren un editor vivo', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenStaff, hash: '#routines' });
  try {
    await esperar(() => p.evaluar('data.routines.length') >= 1, { mensaje: 'rutinas cargadas' });
    p.clic(p.q(`[data-duplicate-routine="${rutinaId}"]`));
    const f = await esperar(() => p.q('#routine-form'), { mensaje: 'editor de la copia' });
    assert.match(p.q('h2', f).textContent, /Reutilizar/); assert.equal(f.elements.title.value, 'Rutina en bloques', 'reutilizar conserva el título sin añadir copia');
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
    const iniciar = p.q('[data-start-routine-timer]', tarjeta);
    assert.ok(iniciar, 'el cronómetro');
    p.clic(iniciar);
    await esperar(() => p.q('.portal-routine-card [data-timer-display]').textContent !== '00:00', { ms: 7000, mensaje: 'el cronómetro corre después de la cuenta regresiva' });
    p.window.location.hash = '#portal-calendar'; await p.quieta(300);
    assert.ok(p.q('.portal-col-dia.viaje'), 'los días de viaje en la agenda del cliente');
    sinErrores(p, 'portal del cliente');
  } finally { await p.cerrar(); }
});

test('la página pública de la rutina (enlace) se abre sin sesión, muestra los bloques y permite confirmar', async () => {
  const rutinaViaje = (await api.post('/api/routines', { title: 'Rutina del enlace', description: 'Objetivo: movilidad.\nCalentamiento: 5 minutos.', sessionsPerWeek: 3, clientId, exercises: [{ name: 'Plancha', sets: 3, reps: '30 seg', block: 1, rounds: 3 }, { name: 'Flexiones', sets: 3, reps: '10', block: 1, rounds: 3 }] })).datos.id;
  const enlace = await api.post(`/api/routines/${rutinaViaje}/share-links`, { clientId, hours: 24, confirmRepeat: true });
  const token = String(enlace.datos.url).split('#rutina=')[1];
  const p = await abrirPantalla({ baseApi: servidor.base, hash: `#rutina=${token}` });
  try {
    await esperar(() => p.q('#public-routine .public-card h2') && !p.document.getElementById('public-routine').hidden, { mensaje: 'página pública' });
    assert.match(p.q('#public-routine').textContent, /Rutina del enlace/);
    assert.match(p.q('#public-routine').textContent, /Bloque 1 · 3 rondas/);
    assert.ok(p.q('.public-instrucciones.routine-descripcion'), 'la página pública conserva los saltos de la descripción');
    p.clic(p.q('#public-terminar'));
    await esperar(() => /Eileen ya sabe/.test(p.q('#public-final').textContent), { mensaje: 'confirmación' });
    sinErrores(p, 'página pública');
  } finally { await p.cerrar(); }
});

test('PORTAL: rutina ofrecida en lugar de la clase — cuenta regresiva, pausa y reanudación, checklist, completar cierra la clase, celebra y guarda el feedback', async () => {
  const ejercicios = [{ name: 'Plancha', sets: 3, reps: '30 seg' }, { name: 'Flexiones', sets: 3, reps: '10' }, { name: 'Sentadilla', sets: 3, reps: '12' }];
  const rid = (await api.post('/api/routines', { title: 'Rutina por oferta', sessionsPerWeek: 3, clientId, exercises: ejercicios })).datos.id;
  const oferta = await api.post(`/api/sessions/${sesionId}/routine-offer`, { routineId: rid, origin: 'trainer', confirmRepeat: true });
  assert.ok(oferta.estado < 300, JSON.stringify(oferta.datos));
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenPortal, hash: '#portal-routines' });
  try {
    await esperar(() => !p.document.getElementById('portal-shell').hidden, { mensaje: 'portal visible' });
    const tarjeta = () => p.q(`[data-portal-routine-card="${rid}"]`);
    await esperar(() => tarjeta(), { mensaje: 'tarjeta de la rutina ofrecida' });
    const boton = sel => p.q(sel, tarjeta());
    assert.match(boton('[data-start-routine-timer]').textContent, /Iniciar entrenamiento/);
    assert.ok(boton('[data-complete-routine]').disabled, 'no se puede completar sin iniciar');
    assert.equal(p.qa('[data-portal-routine-exercise]', tarjeta()).length, 3);
    // 1) marcar un ejercicio sin iniciar el cronómetro no se guarda
    const caja0 = p.qa('[data-portal-routine-exercise]', tarjeta())[0]; caja0.checked = true; caja0.dispatchEvent(new p.window.Event('change', { bubbles: true }));
    await p.quieta(300);
    assert.equal(p.qa('[data-portal-routine-exercise]', tarjeta())[0].checked, false, 'sin cronómetro el ejercicio no queda marcado');
    assert.equal((await db`SELECT count(*)::int AS n FROM routine_exercise_completions WHERE routine_id = ${rid}`)[0].n, 0);
    // 2) iniciar: cuenta regresiva 3-2-1 y luego corre
    p.clic(boton('[data-start-routine-timer]'));
    await esperar(() => !p.q('.routine-countdown', tarjeta()).hidden, { mensaje: 'se ve la cuenta regresiva' });
    await esperar(() => !boton('[data-pause-routine-timer]').hidden, { ms: 6000, mensaje: 'el cronómetro arranca tras la cuenta' });
    assert.ok(p.q('.routine-countdown', tarjeta()).hidden, 'la cuenta regresiva se oculta');
    assert.ok(!boton('[data-complete-routine]').disabled, '"Completar rutina" se habilita al iniciar, sin esperar a marcar un ejercicio');
    assert.equal(p.q('.routine-timer-required', tarjeta()), null, 'desaparece el aviso de iniciar primero');
    await p.quieta(1600);
    const relojCorriendo = boton('.routine-timer-clock').textContent;
    assert.notEqual(relojCorriendo, '00:00', 'el cronómetro avanza');
    // 3) pausar congela el reloj y deja "Reanudar"
    p.clic(boton('[data-pause-routine-timer]')); await p.quieta(250);
    const congelado = boton('.routine-timer-clock').textContent;
    await p.quieta(1300);
    assert.equal(boton('.routine-timer-clock').textContent, congelado, 'en pausa el tiempo no avanza');
    assert.match(boton('[data-start-routine-timer]').textContent, /Reanudar/); assert.ok(!boton('[data-start-routine-timer]').hidden);
    // 4) reanudar (otra cuenta regresiva) y seguir
    p.clic(boton('[data-start-routine-timer]'));
    await esperar(() => !boton('[data-pause-routine-timer]').hidden, { ms: 6000, mensaje: 'reanuda tras la cuenta' });
    // 5) marcar los ejercicios uno a uno
    for (let i = 0; i < 3; i += 1) {
      const caja = p.qa('[data-portal-routine-exercise]', tarjeta())[i]; caja.checked = true; caja.dispatchEvent(new p.window.Event('change', { bubbles: true }));
      await esperar(async () => (await db`SELECT count(*)::int AS n FROM routine_exercise_completions WHERE routine_id = ${rid} AND completed`)[0].n === i + 1, { ms: 5000, mensaje: `ejercicio ${i + 1} guardado` });
      await esperar(() => !tarjeta().classList.contains('loading-state'), { ms: 5000, mensaje: 'la tarjeta se vuelve a dibujar' });
    }
    // 6) completada: celebración, tarjeta cerrada, clase realizada y oferta cumplida
    await esperar(() => p.q('.routine-celebration'), { ms: 5000, mensaje: 'celebración' });
    assert.match(p.q('.routine-celebration').textContent, /3 de 3 ejercicios/);
    p.clic(p.q('.routine-celebration button')); assert.equal(p.q('.routine-celebration'), null);
    await esperar(async () => (await db`SELECT status FROM sessions WHERE id = ${sesionId}`)[0].status === 'completed', { ms: 5000, mensaje: 'la clase queda realizada' });
    assert.equal((await db`SELECT status FROM session_routine_offers WHERE session_id = ${sesionId}`)[0].status, 'completed');
    const [rc] = await db`SELECT completion_percent, duration_seconds FROM routine_completions WHERE routine_id = ${rid}`;
    assert.equal(rc.completion_percent, 100); assert.ok(rc.duration_seconds >= 1 && rc.duration_seconds <= 3, `duración = tiempo activo, sin contar la pausa ni la cuenta regresiva (${rc.duration_seconds} s; en la pantalla pasaron más de 6 s)`);
    await esperar(() => /Rutina completada/.test(boton('[data-complete-routine]').textContent) && boton('[data-complete-routine]').disabled, { mensaje: 'botón en "Rutina completada"' });
    // 7) feedback opcional
    const form = await esperar(() => p.q('[data-portal-routine-feedback]', tarjeta()), { mensaje: 'formulario de feedback' });
    form.elements.feeling.value = 'bien'; form.elements.difficulty.value = 'dificil'; form.elements.feedback.value = 'Me costó la sentadilla';
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await esperar(async () => (await db`SELECT feedback FROM routine_completions WHERE routine_id = ${rid}`)[0].feedback === 'Me costó la sentadilla', { ms: 5000, mensaje: 'feedback guardado' });
    sinErrores(p, 'rutina ofrecida en el portal');
  } finally { await p.cerrar(); }
});

test('la descripción de una rutina con secciones (Objetivo, Calentamiento…) se edita completa y se pinta con sus saltos de línea', async () => {
  const descripcion = 'Objetivo: fuerza de tren inferior.\nCalentamiento: 5 min de movilidad.\nEjercicios principales: ver lista.\nVuelta a la calma: respiración.\nEstiramientos: cadera y espalda.';
  const rid = (await api.post('/api/routines', { title: 'Rutina con secciones', description: descripcion, sessionsPerWeek: 2, clientId, exercises: [{ name: 'Sentadilla', sets: 3, reps: '12' }] })).datos.id;
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenStaff, hash: '#routines' });
  try {
    await esperar(() => p.evaluar('data.routines.length') >= 1, { mensaje: 'rutinas cargadas' });
    p.clic(p.q('[data-view="routines"]')); await p.quieta(200);
    p.clic(p.q(`[data-edit-routine="${rid}"]`));
    const f = await esperar(() => p.q('#routine-form'), { mensaje: 'editor' });
    assert.equal(f.elements.description.tagName, 'TEXTAREA', 'el campo admite varias líneas');
    assert.equal(f.elements.description.value, descripcion, 'el editor trae el texto completo, con sus saltos');
    const tarjetaLista = p.qa('.routine-card').find(x => x.textContent.includes('Rutina con secciones'));
    assert.ok(tarjetaLista && tarjetaLista.querySelector('.routine-descripcion'), 'la lista marca la descripción para respetar los saltos');
    sinErrores(p, 'descripción con secciones');
  } finally { await p.cerrar(); }
  assert.match(readFileSync(new URL('../../styles.css', import.meta.url), 'utf8'), /\.routine-descripcion\{white-space:pre-line\}/, 'la regla que conserva los saltos de línea existe');
});

test('AVISO DE REPETIDO en pantalla: reutilizar para la misma clienta pregunta; Cancelar no envía nada, Enviar de todos modos sí y queda registrado', async () => {
  const p = await abrirPantalla({ baseApi: servidor.base, token: tokenStaff, hash: '#routines' });
  try {
    await esperar(() => p.evaluar('data.routines.length') >= 1, { mensaje: 'rutinas cargadas' });
    p.clic(p.q('[data-view="routines"]')); await p.quieta(200);
    const mensajes = []; let respuesta = false;
    p.window.confirm = texto => { mensajes.push(String(texto)); return respuesta; };
    const antes = (await db`SELECT count(*)::int AS n FROM routines`)[0].n; const entregasAntes = (await db`SELECT count(*)::int AS n FROM routine_deliveries`)[0].n;
    // Reutilizar la rutina ya enviada a Sara y volver a asignársela a Sara: mismos ejercicios, hace 0 días
    p.clic(p.q(`[data-duplicate-routine="${rutinaId}"]`));
    const f = await esperar(() => p.q('#routine-form'), { mensaje: 'editor de la reutilización' });
    assert.equal(f.elements.title.value, 'Rutina en bloques', 'sin "(copia)"');
    f.elements.client.value = clientId;
    f.requestSubmit();
    await esperar(() => mensajes.length === 1, { mensaje: 'aparece el aviso' });
    assert.match(mensajes[0], /recibió recientemente una rutina igual/); assert.match(mensajes[0], /hace 0 días/); assert.match(mensajes[0], /enviarla de todos modos/i);
    await p.quieta(400);
    assert.equal((await db`SELECT count(*)::int AS n FROM routines`)[0].n, antes, 'Cancelar: no se creó ninguna rutina');
    assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries`)[0].n, entregasAntes, 'Cancelar: no se registró ningún envío');
    assert.ok(p.q('#routine-form'), 'el editor sigue abierto para corregir');
    assert.ok(!p.q('#routine-form').classList.contains('loading-state'), 'el formulario vuelve a estar disponible');
    // Enviar de todos modos
    respuesta = true;
    f.requestSubmit();
    await esperar(async () => (await db`SELECT count(*)::int AS n FROM routines`)[0].n === antes + 1, { ms: 6000, mensaje: 'se crea al confirmar' });
    const [entrega] = await db`SELECT repeat_confirmed, kind FROM routine_deliveries ORDER BY sent_at DESC LIMIT 1`;
    assert.equal(entrega.kind, 'assignment'); assert.equal(entrega.repeat_confirmed, true, 'queda registrado que se envió a pesar del aviso');
    assert.equal(mensajes.length, 2, 'al confirmar se volvió a preguntar una sola vez más');
    sinErrores(p, 'aviso de repetido');
  } finally { await p.cerrar(); }
});
