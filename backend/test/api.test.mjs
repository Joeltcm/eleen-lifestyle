import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor;
let api;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
}, { timeout: 90_000 });

after(async () => { await servidor?.parar(); });

describe('migraciones y arranque', () => {
  test('la base vacía queda utilizable y el servicio responde', async () => {
    const { estado, datos } = await api.get('/health');
    assert.equal(estado, 200);
    assert.equal(datos.status, 'ok');
    assert.ok(datos.databaseTime, 'debe poder consultar la base');
  });
});

describe('autenticación', () => {
  test('sin token no se llega a los datos', async () => {
    assert.equal((await api.get('/api/clients')).estado, 401);
  });

  test('el setup exige el token de configuración', async () => {
    const { estado } = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': 'equivocado' });
    assert.equal(estado, 403);
  });

  test('crea la cuenta administradora y devuelve sesión', async () => {
    const { estado, datos } = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
    assert.equal(estado, 201);
    assert.equal(datos.user.role, 'admin');
    assert.ok(datos.token);
    api.usarToken(datos.token);
  });

  test('la cuenta administradora no se crea dos veces', async () => {
    const { estado } = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
    assert.equal(estado, 409);
  });

  test('entra con la contraseña correcta', async () => {
    const { estado, datos } = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
    assert.equal(estado, 200);
    assert.ok(datos.token);
  });

  test('rechaza la contraseña equivocada sin decir si el correo existe', async () => {
    const malo = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: 'no-es' });
    const inexistente = await api.post('/api/auth/login', { email: 'nadie@prueba.test', password: 'no-es' });
    assert.equal(malo.estado, 401);
    assert.equal(inexistente.estado, 401);
    assert.equal(malo.datos.error, inexistente.datos.error, 'el mensaje no debe delatar la cuenta');
  });
});

describe('freno a la fuerza bruta', () => {
  test('bloquea tras varios fallos y lo dice con Retry-After', async () => {
    const correo = 'objetivo@prueba.test';
    let bloqueado = null;
    for (let intento = 1; intento <= 12; intento++) {
      const { estado, cabeceras } = await api.post('/api/auth/login', { email: correo, password: 'mal' });
      if (estado === 429) { bloqueado = { intento, retry: cabeceras.get('retry-after') }; break; }
      assert.equal(estado, 401);
    }
    assert.ok(bloqueado, 'debería haber bloqueado');
    assert.equal(bloqueado.intento, 9, 'bloquea al noveno intento');
    assert.ok(Number(bloqueado.retry) > 0, 'debe indicar cuánto esperar');
  });

  test('no salpica a otras cuentas', async () => {
    const { estado } = await api.post('/api/auth/login', { email: 'ajeno@prueba.test', password: 'mal' });
    assert.equal(estado, 401, 'otra cuenta debe poder seguir intentando');
  });

  test('entrar bien limpia el contador de esa cuenta', async () => {
    for (let i = 0; i < 5; i++) await api.post('/api/auth/login', { email: CREDENCIALES.email, password: 'mal' });
    const bien = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
    assert.equal(bien.estado, 200);
    const despues = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: 'mal' });
    assert.equal(despues.estado, 401, 'no debe arrastrar los fallos anteriores');
  });
});

describe('planes comerciales', () => {
  test('la mensualidad exige sesiones por mes', async () => {
    const { estado } = await api.post('/api/plans', { name: 'Sin sesiones', billingModel: 'monthly', price: 100 });
    assert.equal(estado, 400);
  });

  test('las sesiones individuales no las exigen', async () => {
    const { estado, datos } = await api.post('/api/plans', { name: 'Suelta', billingModel: 'single', price: 35 });
    assert.equal(estado, 201);
    assert.equal(datos.billing_model, 'single');
    assert.equal(datos.sessions_included, null, 'no hay bolsa de sesiones');
    assert.equal(datos.validity_days, null, 'no hay vigencia');
  });

  test('el paquete guarda sesiones y vigencia', async () => {
    const { estado, datos } = await api.post('/api/plans', { name: 'Paquete 8', billingModel: 'package', price: 240, sessionsIncluded: 8, validityDays: 60 });
    assert.equal(estado, 201);
    assert.equal(Number(datos.sessions_included), 8);
    assert.equal(Number(datos.validity_days), 60);
  });
});

describe('clientes y cumplimiento', () => {
  let planMensual;
  let cliente1;

  test('el plan mensual fija la meta de cumplimiento del cliente', async () => {
    const plan = await api.post('/api/plans', { name: 'Mensualidad 12', billingModel: 'monthly', price: 300, sessionsIncluded: 12 });
    assert.equal(plan.estado, 201);
    planMensual = plan.datos;

    const creado = await api.post('/api/clients', { fullName: 'Ana Prueba', planId: planMensual.id, cutoffDay: 1 });
    assert.equal(creado.estado, 201);
    cliente1 = creado.datos;

    const lista = await api.get('/api/clients');
    const guardado = lista.datos.find(c => c.id === cliente1.id);
    assert.equal(Number(guardado.monthly_session_target), 12,
      'las sesiones del plan y la meta de cumplimiento deben ser el mismo número');
  });

  test('la asistencia usa esa meta', async () => {
    const { estado, datos } = await api.get(`/api/clients/${cliente1.id}/attendance`);
    assert.equal(estado, 200);
    assert.equal(Number(datos.monthlySessionTarget), 12);
  });
});

describe('agenda por lotes', () => {
  let clienteId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Julio Prueba', billingModel: 'single', standardPrice: 35, cutoffDay: 1 });
    clienteId = c.datos.id;
  });

  test('crea una sesión por fecha', async () => {
    const fechas = ['2026-09-07T13:00:00.000Z', '2026-09-09T13:00:00.000Z', '2026-09-11T13:00:00.000Z'];
    const { estado, datos } = await api.post('/api/sessions/batch', { clientId: clienteId, startsAt: fechas, durationMinutes: 60, mode: 'Presencial' });
    assert.equal(estado, 201);
    assert.equal(datos.creadas, 3);
    assert.equal(datos.omitidas, 0);
  });

  test('repetir la misma petición no duplica el calendario', async () => {
    const fechas = ['2026-09-07T13:00:00.000Z', '2026-09-09T13:00:00.000Z', '2026-09-11T13:00:00.000Z'];
    const { datos } = await api.post('/api/sessions/batch', { clientId: clienteId, startsAt: fechas, durationMinutes: 60, mode: 'Presencial' });
    assert.equal(datos.creadas, 0);
    assert.equal(datos.omitidas, 3);
  });
});

describe('gastos y ámbito', () => {
  test('las categorías nacen sin ámbito y se pueden clasificar', async () => {
    const creada = await api.post('/api/expense-categories', { name: 'Gasolina' });
    assert.equal(creada.estado, 201);
    assert.equal(creada.datos.ambito, null, 'clasificarla es decisión de la entrenadora');

    const marcada = await api.patch(`/api/expense-categories/${creada.datos.id}`, { ambito: 'negocio' });
    assert.equal(marcada.datos.ambito, 'negocio');

    const desmarcada = await api.patch(`/api/expense-categories/${creada.datos.id}`, { ambito: null });
    assert.equal(desmarcada.datos.ambito, null, 'debe poder volver a sin clasificar');
  });

  test('el margen del negocio no se anuncia con gasto sin clasificar', async () => {
    // Hace falta un ingreso cobrado: sin ingresos el margen es nulo de todas
    // formas y la prueba pasaría sin comprobar nada. Lo descubrió una prueba
    // de mutación —se rompió el código a propósito y esto no se enteró—.
    const pagador = await api.post('/api/clients', { fullName: 'Ingreso Prueba', billingModel: 'monthly', standardPrice: 200, cutoffDay: 1 });
    const cobro = await api.post('/api/invoices', { clientId: pagador.datos.id, concept: 'Mensualidad', amount: 200, dueOn: '2026-08-05' });
    await api.post(`/api/invoices/${cobro.datos.id}/confirm`, { method: 'Efectivo', paidOn: '2026-08-05' });

    const cat = await api.post('/api/expense-categories', { name: 'Sin clasificar aún' });
    await api.post('/api/expenses', { description: 'Compra', amount: 50, spentOn: '2026-08-10', categoryId: cat.datos.id });

    const { datos } = await api.get('/api/finance/summary?rango=todo');
    assert.ok(datos.totales.ingresos > 0, 'debe haber ingresos para que el margen signifique algo');
    assert.ok(datos.totales.gastosSinClasificar > 0, 'debe haber gasto sin clasificar');
    assert.equal(datos.totales.margenNegocio, null,
      'con gasto sin clasificar el margen sería un 100% falso');
  });

  test('el rango "todo" no revienta con datos reales', async () => {
    const { estado, datos } = await api.get('/api/finance/summary?rango=todo');
    assert.equal(estado, 200);
    assert.ok(Array.isArray(datos.timeline));
  });
});

describe('saldos de sesiones', () => {
  let clienteId;
  let saldoId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Saldo Prueba', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clienteId = c.datos.id;
    const p = await api.post('/api/packages', { clientId: clienteId, totalSessions: 8, amount: 240, kind: 'package' });
    saldoId = p.datos.id;
    // Un saldo nace 'pending' hasta que se cobra su factura, y la edición
    // respeta ese estado a propósito. Para probar el recálculo hay que
    // cobrarlo primero.
    await api.post(`/api/invoices/${p.datos.invoice_id}/confirm`, { method: 'Efectivo', paidOn: '2026-08-05' });
  });

  test('subir las contratadas revive un saldo agotado', async () => {
    // El estado se compara con ::int a propósito: sin el cast, Postgres lo
    // resuelve como texto y '8' resulta mayor que '12', así que un saldo con 8
    // de 12 usadas se quedaba agotado.
    const agotado = await api.patch(`/api/packages/${saldoId}`, { usedSessions: 8 });
    assert.equal(agotado.datos.status, 'exhausted');

    const revivido = await api.patch(`/api/packages/${saldoId}`, { totalSessions: 12 });
    assert.equal(Number(revivido.datos.total_sessions), 12);
    assert.equal(revivido.datos.status, 'active', '8 usadas de 12 no es un saldo agotado');
  });

  test('bajar las contratadas lo agota', async () => {
    const { datos } = await api.patch(`/api/packages/${saldoId}`, { totalSessions: 8 });
    assert.equal(datos.status, 'exhausted');
  });

  test('no deja usar más sesiones de las contratadas', async () => {
    const { estado } = await api.patch(`/api/packages/${saldoId}`, { usedSessions: 99 });
    assert.equal(estado, 400, 'dejaría al cliente con saldo negativo');
  });
});

describe('cobros', () => {
  let clienteId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Pagador Prueba', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clienteId = c.datos.id;
  });

  test('un cobro pendiente se borra sin ceremonia', async () => {
    const cobro = await api.post('/api/invoices', { clientId: clienteId, concept: 'Mensualidad', amount: 100, dueOn: '2026-09-01' });
    assert.equal(cobro.estado, 201);
    const borrado = await api.delete(`/api/invoices/${cobro.datos.id}/permanent`);
    assert.equal(borrado.estado, 200);
  });

  test('un cobro pagado exige el borrado definitivo, y entonces se lleva el pago', async () => {
    const cobro = await api.post('/api/invoices', { clientId: clienteId, concept: 'Mensualidad septiembre', amount: 100, dueOn: '2026-09-01' });
    const confirmado = await api.post(`/api/invoices/${cobro.datos.id}/confirm`, { method: 'Efectivo', paidOn: '2026-09-01' });
    assert.equal(confirmado.estado, 200);

    const suave = await api.delete(`/api/invoices/${cobro.datos.id}/permanent`);
    assert.equal(suave.estado, 409, 'no se borra un cobro pagado por accidente');

    const forzado = await api.delete(`/api/invoices/${cobro.datos.id}/permanent?force=true`);
    assert.equal(forzado.estado, 200);
    assert.equal(forzado.datos.pagosBorrados, 1, 'el ingreso desaparece con el cobro');
  });
});

describe('cancelar afecta o no el cumplimiento', () => {
  let clientId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Cancela Prueba', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clientId = c.datos.id;
  });

  const agendarAyer = async () => {
    const ayer = new Date(Date.now() - 24 * 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [ayer], durationMinutes: 60, mode: 'Presencial' });
    return lote.datos.sesiones[0].id;
  };

  test('cancelar sin reprogramar cuenta como incumplida', async () => {
    const id = await agendarAyer();
    const antes = await api.get('/api/compliance/summary?period=month');
    const previo = antes.datos.clients.find(c => c.clientId === clientId);

    await api.delete(`/api/sessions/${id}?rescheduled=false`);

    const despues = await api.get('/api/compliance/summary?period=month');
    const ahora = despues.datos.clients.find(c => c.clientId === clientId);
    assert.ok(ahora, 'el cliente debe seguir apareciendo en el cumplimiento');
    assert.equal(ahora.activities, (previo?.activities ?? 0), 'la sesión sigue contando, ahora como incumplida');
    assert.ok(ahora.missed >= 1, 'debe figurar como incumplida');
    assert.equal(ahora.compliancePercent, 0, 'una sesión perdida no puntúa');
  });

  test('cancelar para reprogramar no penaliza', async () => {
    const id = await agendarAyer();
    const antes = await api.get('/api/compliance/summary?period=month');
    const previo = antes.datos.clients.find(c => c.clientId === clientId);

    await api.delete(`/api/sessions/${id}?rescheduled=true`);

    const despues = await api.get('/api/compliance/summary?period=month');
    const ahora = despues.datos.clients.find(c => c.clientId === clientId);
    assert.equal(ahora.activities, previo.activities - 1,
      'la reprogramada sale del cálculo: contará la sesión nueva');
    assert.equal(ahora.missed, previo.missed, 'no suma incumplimientos');
  });
});

describe('horarios fijos indefinidos', () => {
  let clientId;
  let reglaId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Fijo Prueba', billingModel: 'monthly', standardPrice: 200, cutoffDay: 1, planId: undefined });
    clientId = c.datos.id;
  });

  test('guarda la regla y llena el horizonte de una vez', async () => {
    const { estado, datos } = await api.post('/api/session-recurrences', {
      clientId, weekdays: [1, 3], timeOfDay: '05:30', durationMinutes: 60, mode: 'Presencial'
    });
    assert.equal(estado, 201);
    assert.equal(datos.recurrence.ends_on, null, 'indefinido es el caso normal');
    reglaId = datos.recurrence.id;
    // Ocho semanas con dos días por semana: unas dieciséis sesiones.
    assert.ok(datos.creadas >= 14 && datos.creadas <= 18, `esperaba ~16 sesiones, hubo ${datos.creadas}`);
  });

  test('las agenda en los días correctos y a la hora de Panamá', async () => {
    const sesiones = (await api.get('/api/sessions')).datos.filter(s => s.client_id === clientId);
    assert.ok(sesiones.length > 0);
    for (const sesion of sesiones.slice(0, 6)) {
      const cuando = new Date(sesion.starts_at);
      // Panamá es UTC-5 todo el año: las 05:30 locales son las 10:30 UTC.
      assert.equal(cuando.getUTCHours(), 10, 'la hora local debe conservarse');
      assert.equal(cuando.getUTCMinutes(), 30);
      const diaPanama = new Date(cuando.getTime() - 5 * 3600_000).getUTCDay();
      assert.ok([1, 3].includes(diaPanama), `día inesperado: ${diaPanama}`);
    }
  });

  test('volver a extender no duplica nada', async () => {
    const antes = (await api.get('/api/sessions')).datos.filter(s => s.client_id === clientId).length;
    await api.post('/api/session-recurrences', { clientId, weekdays: [1, 3], timeOfDay: '05:30' });
    const despues = (await api.get('/api/sessions')).datos.filter(s => s.client_id === clientId).length;
    assert.equal(despues, antes, 'una segunda regla igual no debe duplicar las sesiones');
  });

  test('detenerlo retira las futuras y conserva el historial', async () => {
    const { estado, datos } = await api.delete(`/api/session-recurrences/${reglaId}`);
    assert.equal(estado, 200);
    assert.ok(datos.sesionesRetiradas > 0, 'debe limpiar la agenda por delante');

    const activas = await api.get('/api/session-recurrences');
    assert.ok(!activas.datos.find(r => r.id === reglaId), 'ya no figura entre los activos');
  });

  test('no se detiene dos veces', async () => {
    const { estado } = await api.delete(`/api/session-recurrences/${reglaId}`);
    assert.equal(estado, 404);
  });
});

describe('quitar sesiones canceladas de la agenda', () => {
  let clienteId;
  let sesionId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Agenda Prueba', billingModel: 'single', standardPrice: 30, cutoffDay: 1 });
    clienteId = c.datos.id;
    const lote = await api.post('/api/sessions/batch', { clientId: clienteId, startsAt: ['2026-10-05T13:00:00.000Z'], durationMinutes: 60, mode: 'Presencial' });
    sesionId = lote.datos.sesiones[0].id;
  });

  test('una sesión en pie no se borra: primero se cancela', async () => {
    const { estado } = await api.delete(`/api/sessions/${sesionId}/permanent`);
    assert.equal(estado, 409, 'no se pierde por accidente una sesión que estaba agendada');
  });

  test('una vez cancelada, se puede quitar del todo', async () => {
    await api.delete(`/api/sessions/${sesionId}`);
    const borrada = await api.delete(`/api/sessions/${sesionId}/permanent`);
    assert.equal(borrada.estado, 200);

    const sesiones = await api.get('/api/sessions');
    assert.ok(!sesiones.datos.find(s => s.id === sesionId), 'no debe quedar en la agenda');
  });
});

describe('desactivar clientes', () => {
  let clienteId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Se va de viaje', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clienteId = c.datos.id;
  });

  test('se puede desactivar y volver a activar', async () => {
    const baja = await api.patch(`/api/clients/${clienteId}`, { fullName: 'Se va de viaje', status: 'inactive' });
    assert.equal(baja.estado, 200);
    assert.equal(baja.datos.status, 'inactive');

    const alta = await api.patch(`/api/clients/${clienteId}`, { fullName: 'Se va de viaje', status: 'active' });
    assert.equal(alta.datos.status, 'active');
  });

  test('desactivar no borra el expediente', async () => {
    await api.patch(`/api/clients/${clienteId}`, { fullName: 'Se va de viaje', status: 'inactive' });
    const lista = await api.get('/api/clients');
    assert.ok(lista.datos.find(c => c.id === clienteId), 'el cliente sigue existiendo, sólo inactivo');
  });

  test('editar sin tocar el estado lo respeta', async () => {
    const { datos } = await api.patch(`/api/clients/${clienteId}`, { fullName: 'Nombre nuevo' });
    assert.equal(datos.status, 'inactive', 'no debe reactivarse por editar el nombre');
  });
});

describe('borrado definitivo de planes', () => {
  test('un plan sin usar se borra del todo', async () => {
    const plan = await api.post('/api/plans', { name: 'Plan efímero', billingModel: 'single', price: 20 });
    const borrado = await api.delete(`/api/plans/${plan.datos.id}/permanent`);
    assert.equal(borrado.estado, 200);
    const quedan = await api.get('/api/plans');
    assert.ok(!quedan.datos.find(p => p.id === plan.datos.id), 'no debe quedar rastro');
  });

  test('un plan asignado a alguien no se borra', async () => {
    const plan = await api.post('/api/plans', { name: 'Plan en uso', billingModel: 'monthly', price: 150, sessionsIncluded: 8 });
    await api.post('/api/clients', { fullName: 'Con plan', planId: plan.datos.id, cutoffDay: 1 });

    const { estado, datos } = await api.delete(`/api/plans/${plan.datos.id}/permanent`);
    assert.equal(estado, 409, 'borrarlo dejaría al cliente sin plan y sin saber cuál tenía');
    assert.match(datos.error, /asignado a 1 cliente/);
  });
});

describe('bitácora', () => {
  test('deja constancia de lo borrado, con quién y qué era', async () => {
    const cat = await api.post('/api/expense-categories', { name: 'Categoría efímera' });
    await api.delete(`/api/expense-categories/${cat.datos.id}`);

    const { estado, datos } = await api.get('/api/audit-log?limit=20');
    assert.equal(estado, 200);
    const entrada = datos.find(f => f.route === '/api/expense-categories/:id');
    assert.ok(entrada, 'el borrado debe quedar registrado');
    assert.equal(entrada.user_email, CREDENCIALES.email);
    assert.equal(typeof entrada.detail, 'object', 'el detalle debe ser un objeto, no una cadena escapada');
    assert.equal(entrada.detail.categoria.name, 'Categoría efímera');
  });
});
