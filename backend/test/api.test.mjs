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

describe('el saldo sale del plan sin tener que teclearlo', () => {
  let clientId;
  before(async () => {
    const plan = await api.post('/api/plans', { name: 'Mensual con saldo', billingModel: 'monthly', price: 175, sessionsIncluded: 12 });
    // El corte se pone a tres días vista para que la generación lo alcance.
    const dia = new Date(Date.now() + 3 * 24 * 3600_000).getDate();
    const c = await api.post('/api/clients', { fullName: 'Hereda del plan', planId: plan.datos.id, cutoffDay: dia });
    clientId = c.datos.id;
  });

  test('la primera renovación crea el saldo con las sesiones del plan', async () => {
    const antes = (await api.get('/api/packages')).datos.filter(p => p.client_id === clientId);
    assert.equal(antes.length, 0, 'arranca sin saldo');

    await api.post('/api/billing/recurring/generate', {});

    const despues = (await api.get('/api/packages')).datos.filter(p => p.client_id === clientId);
    assert.equal(despues.length, 1, 'la mensualidad debe traer su saldo');
    assert.equal(Number(despues[0].total_sessions), 12,
      'declarar las sesiones en el plan no serviría de nada si hubiera que teclearlas otra vez');
  });

  test('un cobro que ya existía también estrena su saldo', async () => {
    // El caso que se colaba: el cobro se emitió ayer, o llegó importado de
    // Zoho. Nunca vuelve a salir del INSERT de generación, así que su cliente
    // se quedaba sin saldo para siempre y nadie lo decía.
    // A 25 días vista: fuera de la ventana de generación, que sólo emite
    // cobros de la semana siguiente. El saldo no debe esperar a esa ventana,
    // o el cliente entrena sin de dónde descontar durante tres semanas.
    const dia = new Date(Date.now() + 25 * 24 * 3600_000);
    const vence = dia.toISOString().slice(0, 10);
    const plan = await api.post('/api/plans', { name: 'Mensual ya cobrada', billingModel: 'monthly', price: 150, sessionsIncluded: 8 });
    const c = await api.post('/api/clients', { fullName: 'Cobro previo', planId: plan.datos.id, cutoffDay: dia.getDate() });
    await api.post('/api/invoices', { clientId: c.datos.id, concept: 'Mensualidad de antes', amount: 150, dueOn: vence });

    await api.post('/api/billing/recurring/generate', {});

    const saldos = (await api.get('/api/packages')).datos.filter(p => p.client_id === c.datos.id);
    assert.equal(saldos.length, 1, 'el cobro vigente debe traer saldo aunque no naciera en esta generación');
    assert.equal(Number(saldos[0].total_sessions), 8);
  });

  test('un cobro con vencimiento futuro cubre ese mes', async () => {
    const finDeMes = new Date();
    finDeMes.setMonth(finDeMes.getMonth() + 1, 15);
    const vence = finDeMes.toISOString().slice(0, 10);
    const p = await api.post('/api/packages', { clientId, totalSessions: 12, amount: 175, kind: 'monthly', dueOn: vence });
    const factura = (await api.get('/api/invoices')).datos.find(i => i.id === p.datos.invoice_id);
    assert.equal(String(factura.billing_period).slice(0, 7), vence.slice(0, 7),
      'cubre el mes en que vence, no el mes en que se creó');
  });
});

describe('descuento de clases individual', () => {
  let pagador, dependiente;
  before(async () => {
    const a = await api.post('/api/clients', { fullName: 'Paga por los dos', billingModel: 'monthly', standardPrice: 200, cutoffDay: 1 });
    const b = await api.post('/api/clients', { fullName: 'Entrena tambien', billingModel: 'monthly', standardPrice: 200, cutoffDay: 1 });
    pagador = a.datos.id; dependiente = b.datos.id;
    await api.patch(`/api/clients/${dependiente}`, { fullName: 'Entrena tambien', billingResponsibleClientId: pagador });
    // Cada uno con su propio saldo, como los configura Eileen.
    for (const id of [pagador, dependiente]) {
      const p = await api.post('/api/packages', { clientId: id, totalSessions: 8, amount: 200, kind: 'monthly' });
      await api.post(`/api/invoices/${p.datos.invoice_id}/confirm`, { method: 'Efectivo', paidOn: '2026-08-01' });
    }
  });

  test('entrenar juntos descuenta una clase a cada uno', async () => {
    // Dentro de la vigencia del saldo: una clase de dentro de dos meses no
    // puede pagarse con un saldo que vence en el próximo corte.
    const cuando = new Date(Date.now() - 3600_000).toISOString();
    const s1 = await api.post('/api/sessions/batch', { clientId: pagador, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });
    const s2 = await api.post('/api/sessions/batch', { clientId: dependiente, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });

    await api.patch(`/api/sessions/${s1.datos.sesiones[0].id}/compliance`, { completed: true, completionPercent: 100 });
    await api.patch(`/api/sessions/${s2.datos.sesiones[0].id}/compliance`, { completed: true, completionPercent: 100 });

    const saldos = (await api.get('/api/packages')).datos;
    const delPagador = saldos.find(p => p.client_id === pagador);
    const delOtro = saldos.find(p => p.client_id === dependiente);
    assert.equal(Number(delPagador.used_sessions), 1, 'el pagador gasta una de las suyas');
    assert.equal(Number(delOtro.used_sessions), 1,
      'y el otro también: entrenar juntos no hace que consuman una sola clase');
  });
});

describe('la pareja que paga uno y entrenan los dos', () => {
  // El caso real: Eduardo paga $350 —$175 por cabeza— y cada uno tiene su
  // plan de 12 sesiones. Si hoy entrena sólo Beatris, sólo a ella le baja.
  let eduardo, beatris;
  before(async () => {
    const plan = await api.post('/api/plans', { name: 'Mensualidad en pareja (por persona)', billingModel: 'monthly', price: 175, sessionsIncluded: 12 });
    const corte = new Date(Date.now() + 4 * 24 * 3600_000).getDate();
    const a = await api.post('/api/clients', { fullName: 'Eduardo', planId: plan.datos.id, cutoffDay: corte });
    const b = await api.post('/api/clients', { fullName: 'Beatris', planId: plan.datos.id, cutoffDay: corte });
    eduardo = a.datos.id; beatris = b.datos.id;
    await api.patch(`/api/clients/${beatris}`, { fullName: 'Beatris', billingResponsibleClientId: eduardo });
    await api.post('/api/billing/recurring/generate', {});
  });

  test('cada uno estrena sus 12 sesiones, no 12 entre los dos', async () => {
    const clientes = (await api.get('/api/clients')).datos;
    assert.equal(Number(clientes.find(c => c.id === eduardo).available_sessions), 12);
    assert.equal(Number(clientes.find(c => c.id === beatris).available_sessions), 12,
      'quien no paga también entrena: su saldo es suyo');
  });

  test('si entrena sólo ella, sólo a ella le baja', async () => {
    const cuando = new Date(Date.now() - 3600_000).toISOString();
    const s = await api.post('/api/sessions/batch', { clientId: beatris, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });
    await api.patch(`/api/sessions/${s.datos.sesiones[0].id}/compliance`, { completed: true, completionPercent: 100 });

    const clientes = (await api.get('/api/clients')).datos;
    assert.equal(Number(clientes.find(c => c.id === beatris).available_sessions), 11, 'ella gastó una');
    assert.equal(Number(clientes.find(c => c.id === eduardo).available_sessions), 12, 'él no entrenó');
  });
});

describe('aplicar un cobro a las mensualidades que cubre', () => {
  // El caso de Zoho: una sola línea de $350 a nombre de quien paga. La factura
  // no dice que son dos mensualidades de $175, y no se puede editar.
  let eduardo, beatris, ajena, factura;
  const mesQueCubre = (() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1, 1);
    return d.toISOString().slice(0, 10);
  })();

  before(async () => {
    const plan = await api.post('/api/plans', { name: 'Pareja por persona', billingModel: 'monthly', price: 175, sessionsIncluded: 12 });
    const a = await api.post('/api/clients', { fullName: 'Paga los dos', planId: plan.datos.id, cutoffDay: 28 });
    const b = await api.post('/api/clients', { fullName: 'La cubierta', planId: plan.datos.id, cutoffDay: 28 });
    const c = await api.post('/api/clients', { fullName: 'Ajena a la pareja', planId: plan.datos.id, cutoffDay: 28 });
    eduardo = a.datos.id; beatris = b.datos.id; ajena = c.datos.id;
    await api.patch(`/api/clients/${beatris}`, { fullName: 'La cubierta', billingResponsibleClientId: eduardo });
    const f = await api.post('/api/invoices', { clientId: eduardo, concept: 'Mensualidad', amount: 350, dueOn: new Date().toISOString().slice(0, 10) });
    factura = f.datos.id;
  });

  test('propone a quién cubre y con qué plan', async () => {
    const { estado, datos } = await api.get(`/api/invoices/${factura}/coverage`);
    assert.equal(estado, 200);
    const nombres = datos.candidates.map(c => c.full_name);
    assert.ok(nombres.includes('Paga los dos'), 'quien paga también entrena');
    assert.ok(nombres.includes('La cubierta'), 'y la persona a su cargo');
    assert.ok(!nombres.includes('Ajena a la pareja'), 'nadie más');
    assert.equal(Number(datos.candidates[0].suggested_sessions), 12, 'las sesiones salen del plan');
    assert.equal(Number(datos.candidates[0].suggested_amount), 175);
  });

  test('abre el saldo de cada uno sin emitir cobros nuevos', async () => {
    const antes = (await api.get('/api/invoices')).datos.length;
    const { estado } = await api.post(`/api/invoices/${factura}/coverage`, {
      billingPeriod: mesQueCubre,
      entries: [{ clientId: eduardo, amount: 175, sessions: 12 }, { clientId: beatris, amount: 175, sessions: 12 }]
    });
    assert.equal(estado, 201);
    const clientes = (await api.get('/api/clients')).datos;
    assert.equal(Number(clientes.find(c => c.id === eduardo).available_sessions), 12);
    assert.equal(Number(clientes.find(c => c.id === beatris).available_sessions), 12);
    assert.equal((await api.get('/api/invoices')).datos.length, antes, 'la cobertura no cobra nada nuevo');
  });

  test('aplicarlo dos veces no regala clases', async () => {
    await api.post(`/api/invoices/${factura}/coverage`, {
      billingPeriod: mesQueCubre,
      entries: [{ clientId: beatris, amount: 175, sessions: 12 }]
    });
    const clientes = (await api.get('/api/clients')).datos;
    assert.equal(Number(clientes.find(c => c.id === beatris).available_sessions), 12,
      'la segunda vez no abre otro saldo');
  });

  test('no deja cubrir a quien no depende de quien paga', async () => {
    const { estado } = await api.post(`/api/invoices/${factura}/coverage`, {
      billingPeriod: mesQueCubre,
      entries: [{ clientId: ajena, amount: 175, sessions: 12 }]
    });
    assert.equal(estado, 400, 'sería mover dinero de un expediente a otro');
  });

  test('a quien ya está cubierto no se le vuelve a cobrar el mes', async () => {
    // Con el corte dentro de la ventana de generación, a esta persona sí se le
    // emitiría su mensualidad. Lo único que lo impide es la cobertura.
    const corte = new Date(Date.now() + 4 * 24 * 3600_000).getDate();
    const mesEnCurso = new Date().toISOString().slice(0, 8) + '01';
    const plan = await api.post('/api/plans', { name: 'Pareja en ventana', billingModel: 'monthly', price: 175, sessionsIncluded: 12 });
    const p = await api.post('/api/clients', { fullName: 'Paga ya', planId: plan.datos.id, cutoffDay: corte });
    const d = await api.post('/api/clients', { fullName: 'Cubierta ya', planId: plan.datos.id, cutoffDay: corte });
    await api.patch(`/api/clients/${d.datos.id}`, { fullName: 'Cubierta ya', billingResponsibleClientId: p.datos.id });
    const t = await api.post('/api/clients', { fullName: 'Sin cobertura', planId: plan.datos.id, cutoffDay: corte });
    const suelta = t.datos.id;
    const f = await api.post('/api/invoices', { clientId: p.datos.id, concept: 'Mensualidad de los dos', amount: 350, dueOn: new Date().toISOString().slice(0, 10) });
    await api.post(`/api/invoices/${f.datos.id}/coverage`, {
      billingPeriod: mesEnCurso,
      entries: [{ clientId: d.datos.id, amount: 175, sessions: 12 }]
    });

    await api.post('/api/billing/recurring/generate', {});

    const facturas = (await api.get('/api/invoices')).datos;
    const suyas = facturas.filter(i => i.billed_for_client_id === d.datos.id && i.auto_generated
      && String(i.billing_period).slice(0, 7) === mesEnCurso.slice(0, 7));
    assert.equal(suyas.length, 0,
      'su mensualidad ya entró dentro de los $350: cobrarla otra vez la daría por impaga');
    // Un testigo con el mismo corte y sin cobertura: si a él tampoco se le
    // emitiera nada, la prueba de arriba no estaría demostrando nada.
    const testigo = facturas.filter(i => i.billed_for_client_id === suelta && i.auto_generated
      && String(i.billing_period).slice(0, 7) === mesEnCurso.slice(0, 7));
    assert.equal(testigo.length, 1, 'a quien no está cubierto sí se le emite');
  });

  test('el saldo se hace cargo de las clases ya dadas del ciclo', async () => {
    // El orden real: la clase se marcó dada esta mañana, cuando todavía no
    // existía el saldo, y la cobertura se aplicó después. Sin esto el saldo
    // nace en 12 y esa clase no se le descuenta a nadie nunca.
    const plan = await api.post('/api/plans', { name: 'Mensual con clase previa', billingModel: 'monthly', price: 175, sessionsIncluded: 12 });
    const c = await api.post('/api/clients', { fullName: 'Entrenó antes del saldo', planId: plan.datos.id, cutoffDay: 28 });
    const f = await api.post('/api/invoices', { clientId: c.datos.id, concept: 'Mensualidad', amount: 175, dueOn: new Date().toISOString().slice(0, 10) });

    const s = await api.post('/api/sessions/batch', { clientId: c.datos.id, startsAt: [new Date(Date.now() - 3600_000).toISOString()], durationMinutes: 60, mode: 'Presencial' });
    await api.patch(`/api/sessions/${s.datos.sesiones[0].id}/compliance`, { completed: true, completionPercent: 100 });
    const sinSaldo = (await api.get('/api/clients')).datos.find(x => x.id === c.datos.id);
    assert.equal(Number(sinSaldo.available_sessions), 0, 'todavía no hay de dónde descontar');

    // El mes en curso, no el siguiente: la clase de hoy pertenece a este ciclo
    // y con el mes siguiente quedaría fuera de la ventana según el día del mes
    // en que corra la prueba.
    const mesEnCurso = new Date().toISOString().slice(0, 8) + '01';
    await api.post(`/api/invoices/${f.datos.id}/coverage`, {
      billingPeriod: mesEnCurso,
      entries: [{ clientId: c.datos.id, amount: 175, sessions: 12 }]
    });

    const despues = (await api.get('/api/clients')).datos.find(x => x.id === c.datos.id);
    assert.equal(Number(despues.available_sessions), 11,
      'la clase de esta mañana ya se dio: el saldo nace con 11, no con 12');
  });

  test('pero no de las de un ciclo ya cerrado', async () => {
    // El límite importa: si alcanzara hacia atrás sin fin, un saldo nuevo
    // nacería consumido por clases de meses que ya se cobraron y se cerraron.
    const plan = await api.post('/api/plans', { name: 'Mensual con clase vieja', billingModel: 'monthly', price: 175, sessionsIncluded: 12 });
    const c = await api.post('/api/clients', { fullName: 'Entrenó hace meses', planId: plan.datos.id, cutoffDay: 28 });
    const f = await api.post('/api/invoices', { clientId: c.datos.id, concept: 'Mensualidad', amount: 175, dueOn: new Date().toISOString().slice(0, 10) });
    const haceTresMeses = new Date(); haceTresMeses.setMonth(haceTresMeses.getMonth() - 3);
    const s = await api.post('/api/sessions/batch', { clientId: c.datos.id, startsAt: [haceTresMeses.toISOString()], durationMinutes: 60, mode: 'Presencial' });
    await api.patch(`/api/sessions/${s.datos.sesiones[0].id}/compliance`, { completed: true, completionPercent: 100 });

    await api.post(`/api/invoices/${f.datos.id}/coverage`, {
      billingPeriod: mesQueCubre,
      entries: [{ clientId: c.datos.id, amount: 175, sessions: 12 }]
    });

    const despues = (await api.get('/api/clients')).datos.find(x => x.id === c.datos.id);
    assert.equal(Number(despues.available_sessions), 12,
      'una clase de hace tres meses no sale del saldo de este mes');
  });

  test('quitar la cobertura se lleva el saldo que nadie usó', async () => {
    const { datos } = await api.get(`/api/invoices/${factura}/coverage`);
    const suya = datos.applied.find(a => a.client_id === beatris);
    const { estado } = await api.delete(`/api/invoices/${factura}/coverage/${suya.id}`);
    assert.equal(estado, 200);
    const clientes = (await api.get('/api/clients')).datos;
    assert.equal(Number(clientes.find(c => c.id === beatris).available_sessions), 0,
      'sin cobertura no hay sesiones: dejarlas sueltas sería regalarlas');
  });
});

describe('editar una sesión de un horario indefinido', () => {
  let clientId, otro, sesion;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Entrena fijo', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    const o = await api.post('/api/clients', { fullName: 'El otro fijo', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clientId = c.datos.id; otro = o.datos.id;
    // Todos los días de la semana, para que siempre haya una sesión cercana.
    await api.post('/api/session-recurrences', {
      clientId, weekdays: [0, 1, 2, 3, 4, 5, 6], timeOfDay: '05:30', durationMinutes: 60, mode: 'Presencial'
    });
    const suyas = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === clientId && new Date(x.starts_at) > new Date());
    sesion = suyas[0];
  });

  // Extender otra regla cualquiera vuelve a pasar por todas las del dueño, que
  // es lo que hace el proceso periódico cada seis horas.
  const volverAExtender = async () => {
    await api.post('/api/session-recurrences', {
      clientId: otro, weekdays: [3], timeOfDay: '19:15', durationMinutes: 60, mode: 'Presencial'
    });
  };

  test('mover la hora no hace reaparecer la vieja', async () => {
    const movida = new Date(sesion.starts_at); movida.setUTCMinutes(movida.getUTCMinutes() + 45);
    await api.patch(`/api/sessions/${sesion.id}`, { startsAt: movida.toISOString(), durationMinutes: 60, mode: 'Presencial' });

    await volverAExtender();

    const suyas = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === clientId && x.status !== 'cancelled');
    const mismoDia = suyas.filter(x => String(x.starts_at).slice(0, 10) === String(movida.toISOString()).slice(0, 10));
    assert.equal(mismoDia.length, 1,
      'el hueco que deja la sesión movida no es una sesión que falte: recrearla deja dos');
  });

  test('cancelarla no la hace reaparecer', async () => {
    const suyas = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === clientId && x.status === 'scheduled' && new Date(x.starts_at) > new Date());
    const objetivo = suyas.at(-1);
    await api.delete(`/api/sessions/${objetivo.id}?rescheduled=false`);

    await volverAExtender();

    const despues = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === clientId && x.status === 'scheduled'
        && String(x.starts_at).slice(0, 10) === String(objetivo.starts_at).slice(0, 10));
    assert.equal(despues.length, 0,
      'una clase cancelada que vuelve sola es una clase que la entrenadora ya dijo que no daba');
  });
});

describe('el resultado de una sesión se dice, no se deduce', () => {
  let clientId, sesion;
  before(async () => {
    const plan = await api.post('/api/plans', { name: 'Mensual para marcar', billingModel: 'monthly', price: 100, sessionsIncluded: 8 });
    const c = await api.post('/api/clients', { fullName: 'Se marcó por error', planId: plan.datos.id, cutoffDay: 1 });
    clientId = c.datos.id;
    const p = await api.post('/api/packages', { clientId, totalSessions: 8, amount: 100, kind: 'monthly' });
    await api.post(`/api/invoices/${p.datos.invoice_id}/confirm`, { method: 'Efectivo', paidOn: '2026-08-01' });
    // Mañana: todavía no ha ocurrido, así que no puede haberse incumplido.
    const manana = new Date(Date.now() + 24 * 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [manana], durationMinutes: 60, mode: 'Presencial' });
    sesion = lote.datos.sesiones[0];
  });

  test('desmarcar por error la devuelve a programada, no a incumplida', async () => {
    await api.patch(`/api/sessions/${sesion.id}/compliance`, { outcome: 'completed', completionPercent: 100 });
    const marcada = (await api.get('/api/packages')).datos.find(p => p.client_id === clientId);
    assert.equal(Number(marcada.used_sessions), 1, 'marcarla descuenta');

    const { datos } = await api.patch(`/api/sessions/${sesion.id}/compliance`, { outcome: 'scheduled', completionPercent: 0 });
    assert.equal(datos.status, 'scheduled',
      'quitar la marca de una clase que aún no ha ocurrido no puede dejarla incumplida');
    const devuelta = (await api.get('/api/packages')).datos.find(p => p.client_id === clientId);
    assert.equal(Number(devuelta.used_sessions), 0, 'y le devuelve la sesión al saldo');
  });

  test('y no cumplió sigue estando, cuando se quiere decir eso', async () => {
    const { datos } = await api.patch(`/api/sessions/${sesion.id}/compliance`, { outcome: 'no_show', completionPercent: 0 });
    assert.equal(datos.status, 'no_show');
  });

  test('el contrato viejo sigue funcionando', async () => {
    // El registro diario y el portal siguen mandando 'completed'.
    const { datos } = await api.patch(`/api/sessions/${sesion.id}/compliance`, { completed: true, completionPercent: 100 });
    assert.equal(datos.status, 'completed');
  });
});

describe('rellenar los días que le falten a un horario fijo', () => {
  test('vuelve a poner el día que se borró a mano', async () => {
    const c = await api.post('/api/clients', { fullName: 'Horario con hueco', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    await api.post('/api/session-recurrences', {
      clientId: c.datos.id, weekdays: [0, 1, 2, 3, 4, 5, 6], timeOfDay: '06:15', durationMinutes: 60, mode: 'Presencial'
    });
    const suyas = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && new Date(x.starts_at) > new Date());
    const victima = suyas[2];
    await api.delete(`/api/sessions/${victima.id}?rescheduled=false`);
    await api.delete(`/api/sessions/${victima.id}/permanent`);

    const { estado, datos } = await api.post('/api/session-recurrences/extend', {});
    assert.equal(estado, 200);
    assert.ok(datos.creadas >= 1, 'el día vacío se vuelve a llenar en el momento');

    const despues = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && String(x.starts_at).slice(0, 10) === String(victima.starts_at).slice(0, 10)
        && x.status === 'scheduled');
    assert.equal(despues.length, 1);
  });
});

describe('rellenar repone el día aunque la marca se haya quedado colgada', () => {
  // El caso de Beatris: el martes lleva semanas sin aparecer y el proceso
  // automático no lo repone porque la ocurrencia figura como atendida. El
  // botón lo pulsa una persona diciendo "rellena": ahí manda ella.
  test('el día vacío se crea, y el que tiene clase no se duplica', async () => {
    const c = await api.post('/api/clients', { fullName: 'Marca colgada', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    await api.post('/api/session-recurrences', {
      clientId: c.datos.id, weekdays: [0, 1, 2, 3, 4, 5, 6], timeOfDay: '06:20', durationMinutes: 60, mode: 'Presencial'
    });
    const suyas = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && new Date(x.starts_at) > new Date())
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    // Se mueve a OTRO día: el suyo queda del todo vacío y la marca, colgada
    // apuntando a un día en el que ya no hay nada. Es el caso de los martes.
    const movida = suyas[4];
    const diaVacio = String(movida.starts_at).slice(0, 10);
    const otroDia = new Date(movida.starts_at); otroDia.setUTCDate(otroDia.getUTCDate() + 14); otroDia.setUTCHours(otroDia.getUTCHours() + 6);
    await api.patch(`/api/sessions/${movida.id}`, { startsAt: otroDia.toISOString(), durationMinutes: 60, mode: 'Presencial' });

    const antes = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && x.status !== 'cancelled' && String(x.starts_at).slice(0, 10) === diaVacio);
    assert.equal(antes.length, 0, 'el día quedó vacío del todo');

    await api.post('/api/session-recurrences/extend', {});

    const despues = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && x.status !== 'cancelled');
    const enSuHora = despues.filter(x => String(x.starts_at).slice(0, 10) === diaVacio && String(x.starts_at).slice(11, 16) === '11:20');
    assert.equal(enSuHora.length, 1, 'el botón repone la clase del día vacío');

    // Y los días que sí tenían clase siguen con una sola.
    const diaIntacto = String(suyas[6].starts_at).slice(0, 10);
    const delOtro = despues.filter(x => String(x.starts_at).slice(0, 10) === diaIntacto);
    assert.equal(delOtro.length, 1, 'forzar no puede duplicar lo que ya estaba');
  });
});

describe('editar un horario fijo sin desmontarlo', () => {
  // El caso real: el horario se guardó sin el martes —la fila de días son
  // siete letras sueltas y en español martes y miércoles empiezan por M— y
  // para añadirlo había que tirar abajo el horario entero.
  let clientId, reglaId;
  const diasDe = async () => {
    const reglas = (await api.get('/api/session-recurrences')).datos;
    return reglas.find(r => r.id === reglaId).weekdays.map(Number).sort();
  };
  const suyasFuturas = async () => (await api.get('/api/sessions')).datos
    .filter(x => x.client_id === clientId && x.status === 'scheduled' && new Date(x.starts_at) > new Date());

  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Le faltó el martes', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clientId = c.datos.id;
    const r = await api.post('/api/session-recurrences', {
      clientId, weekdays: [1, 3, 4], timeOfDay: '07:00', durationMinutes: 60, mode: 'Presencial'
    });
    reglaId = r.datos.recurrence.id;
  });

  test('arranca sin martes, como se guardó', async () => {
    assert.deepEqual(await diasDe(), [1, 3, 4]);
    const martes = (await suyasFuturas()).filter(x => new Date(x.starts_at).getUTCDay() === 2);
    assert.equal(martes.length, 0);
  });

  test('añadir el martes lo agenda sin tocar los demás días', async () => {
    const lunesAntes = (await suyasFuturas()).filter(x => new Date(x.starts_at).getUTCDay() === 1).length;

    const { estado } = await api.patch(`/api/session-recurrences/${reglaId}`, {
      weekdays: [1, 2, 3, 4], timeOfDay: '07:00', durationMinutes: 60, mode: 'Presencial'
    });
    assert.equal(estado, 200);

    assert.deepEqual(await diasDe(), [1, 2, 3, 4]);
    const despues = await suyasFuturas();
    assert.ok(despues.filter(x => new Date(x.starts_at).getUTCDay() === 2).length >= 4, 'los martes ya están agendados');
    assert.equal(despues.filter(x => new Date(x.starts_at).getUTCDay() === 1).length, lunesAntes,
      'los lunes que ya estaban no se tocan');
  });

  test('quitar un día retira sus clases futuras', async () => {
    await api.patch(`/api/session-recurrences/${reglaId}`, {
      weekdays: [1, 2, 3], timeOfDay: '07:00', durationMinutes: 60, mode: 'Presencial'
    });
    const jueves = (await suyasFuturas()).filter(x => new Date(x.starts_at).getUTCDay() === 4);
    assert.equal(jueves.length, 0, 'quien quita el jueves no quiere seguir viendo jueves');
  });

  test('cambiar la hora mueve el horario entero', async () => {
    await api.patch(`/api/session-recurrences/${reglaId}`, {
      weekdays: [1, 2, 3], timeOfDay: '06:00', durationMinutes: 60, mode: 'Presencial'
    });
    const horas = new Set((await suyasFuturas()).map(x => String(x.starts_at).slice(11, 16)));
    assert.deepEqual([...horas], ['11:00'], 'las 06:00 de Panamá, y ninguna suelta a la hora vieja');
  });
});

describe('rellenar no resucita una clase que se movió dentro del mismo día', () => {
  test('si ese día ya entrena, el día está atendido', async () => {
    const c = await api.post('/api/clients', { fullName: 'Movida el mismo día', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    await api.post('/api/session-recurrences', {
      clientId: c.datos.id, weekdays: [0, 1, 2, 3, 4, 5, 6], timeOfDay: '13:40', durationMinutes: 60, mode: 'Presencial'
    });
    const suyas = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && new Date(x.starts_at) > new Date())
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    const movida = suyas[3];
    const dia = String(movida.starts_at).slice(0, 10);
    // Misma fecha, dos horas más tarde: la entrenadora la corrió a propósito.
    const masTarde = new Date(movida.starts_at); masTarde.setUTCHours(masTarde.getUTCHours() + 2);
    await api.patch(`/api/sessions/${movida.id}`, { startsAt: masTarde.toISOString(), durationMinutes: 60, mode: 'Presencial' });

    await api.post('/api/session-recurrences/extend', {});

    const eseDia = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && x.status !== 'cancelled' && String(x.starts_at).slice(0, 10) === dia);
    assert.equal(eseDia.length, 1,
      'correr una clase de hora no es dejar el día libre: rellenar no puede ponerle otra');
  });
});

describe('por qué un día del horario fijo sigue vacío', () => {
  test('después de forzar no queda ningún día sin explicar', async () => {
    // Tras rellenar, un día vacío sólo puede seguir vacío por algo que la
    // aplicación no sabe nombrar, y eso es justo lo que hay que ver.
    const c = await api.post('/api/clients', { fullName: 'Nada sin explicar', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    await api.post('/api/session-recurrences', {
      clientId: c.datos.id, weekdays: [0, 1, 2, 3, 4, 5, 6], timeOfDay: '21:35', durationMinutes: 60, mode: 'Presencial'
    });
    const suyas = (await api.get('/api/sessions')).datos
      .filter(x => x.client_id === c.datos.id && new Date(x.starts_at) > new Date())
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    const movida = suyas[2];
    const otraHora = new Date(movida.starts_at); otraHora.setUTCHours(otraHora.getUTCHours() + 3);
    await api.patch(`/api/sessions/${movida.id}`, { startsAt: otraHora.toISOString(), durationMinutes: 60, mode: 'Presencial' });

    const { datos } = await api.post('/api/session-recurrences/extend', {});
    const suyos = (datos.saltados || []).filter(f => f.full_name === 'Nada sin explicar');
    assert.equal(suyos.length, 0, 'forzar repuso el día, así que no queda nada que explicar');
  });

  test('y no inventa motivos donde no los hay', async () => {
    const c = await api.post('/api/clients', { fullName: 'Sin huecos', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    await api.post('/api/session-recurrences', {
      clientId: c.datos.id, weekdays: [0, 1, 2, 3, 4, 5, 6], timeOfDay: '20:45', durationMinutes: 60, mode: 'Presencial'
    });
    const { datos } = await api.post('/api/session-recurrences/extend', {});
    const suyos = (datos.saltados || []).filter(f => f.full_name === 'Sin huecos');
    assert.equal(suyos.length, 0, 'un horario completo no tiene nada que explicar');
  });
});

describe('avisar de las clases que se quedaron sin marcar', () => {
  let clientId, pasada, futura;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Entrenó y nadie marcó', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clientId = c.datos.id;
    const haceDosHoras = new Date(Date.now() - 2 * 3600_000).toISOString();
    const enDosHoras = new Date(Date.now() + 2 * 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [haceDosHoras, enDosHoras], durationMinutes: 60, mode: 'Presencial' });
    [pasada, futura] = lote.datos.sesiones.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  });

  test('avisa de la que ya terminó, no de la que viene', async () => {
    // Otras pruebas dejan sesiones sueltas del mismo dueño, así que se mira
    // sólo a este cliente.
    const avisos = (await api.get('/api/notifications')).datos
      .filter(n => n.type === 'pending' && /Entrenó y nadie marcó/.test(n.title));
    assert.equal(avisos.length, 1, 'sólo la que ya pasó necesita decisión');
    assert.equal(String(avisos[0].sessionId), String(pasada.id));
    assert.ok(!avisos.some(a => String(a.sessionId) === String(futura.id)), 'la que viene no se pregunta');
  });

  test('no avisa de una clase en curso', async () => {
    // Empezó hace diez minutos y dura una hora: todavía está pasando.
    const enCurso = new Date(Date.now() - 10 * 60_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [enCurso], durationMinutes: 60, mode: 'Presencial' });
    const avisos = (await api.get('/api/notifications')).datos.filter(n => n.type === 'pending');
    assert.ok(!avisos.some(a => String(a.sessionId) === String(lote.datos.sesiones[0].id)),
      'avisar antes de que acabe la clase es avisar de nada');
  });

  test('al marcarla, el aviso desaparece', async () => {
    await api.patch(`/api/sessions/${pasada.id}/compliance`, { outcome: 'completed', completionPercent: 100 });
    const avisos = (await api.get('/api/notifications')).datos.filter(n => n.type === 'pending');
    assert.ok(!avisos.some(a => String(a.sessionId) === String(pasada.id)));
  });

  test('y cancelarla también lo quita', async () => {
    const ayer = new Date(Date.now() - 26 * 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [ayer], durationMinutes: 60, mode: 'Presencial' });
    const suelta = lote.datos.sesiones[0];
    const antes = (await api.get('/api/notifications')).datos.filter(n => n.type === 'pending');
    assert.ok(antes.some(a => String(a.sessionId) === String(suelta.id)), 'la de ayer sí pide decisión');

    await api.delete(`/api/sessions/${suelta.id}?rescheduled=false`);

    const despues = (await api.get('/api/notifications')).datos.filter(n => n.type === 'pending');
    assert.ok(!despues.some(a => String(a.sessionId) === String(suelta.id)),
      'cancelarla es decidir: ya no hay nada que preguntar');
  });
});

describe('con dos saldos, se gasta el que vence antes', () => {
  // El caso de Ernesto: su mensualidad la paga otro, y él se compra aparte un
  // paquete de clases sueltas que no caduca. Al mes siguiente ese paquete es
  // el más antiguo, y gastarlo primero dejaría vencer sin usar las clases de
  // la mensualidad —que sí caducan— y se las contaría como incumplidas.
  let clientId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Mensualidad y extra', billingModel: 'monthly', standardPrice: 280, cutoffDay: 28 });
    clientId = c.datos.id;
    // Primero el paquete suelto, sin vencimiento.
    const extra = await api.post('/api/packages', { clientId, totalSessions: 4, amount: 140, kind: 'package' });
    await api.post(`/api/invoices/${extra.datos.invoice_id}/confirm`, { method: 'Efectivo', paidOn: '2026-08-01' });
    // Después la mensualidad, que vence en el corte.
    const vence = new Date(Date.now() + 10 * 24 * 3600_000).toISOString().slice(0, 10);
    const mensual = await api.post('/api/packages', { clientId, totalSessions: 8, amount: 280, kind: 'monthly', expiresOn: vence });
    await api.post(`/api/invoices/${mensual.datos.invoice_id}/confirm`, { method: 'Efectivo', paidOn: '2026-08-01' });
  });

  test('la clase sale de la mensualidad, no del paquete sin vencimiento', async () => {
    const cuando = new Date(Date.now() - 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });
    await api.patch(`/api/sessions/${lote.datos.sesiones[0].id}/compliance`, { outcome: 'completed', completionPercent: 100 });

    const saldos = (await api.get('/api/packages')).datos.filter(p => p.client_id === clientId);
    const mensual = saldos.find(p => p.kind === 'monthly');
    const extra = saldos.find(p => p.kind === 'package');
    assert.equal(Number(mensual.used_sessions), 1,
      'se gasta lo que caduca primero, o se pierde y encima cuenta como incumplida');
    assert.equal(Number(extra.used_sessions), 0, 'el paquete sin vencimiento puede esperar');
  });
});

describe('cancelar y reprogramar se cuentan por separado', () => {
  let clientId;
  const conteo = async () => {
    const c = (await api.get('/api/clients')).datos.find(x => x.id === clientId);
    return { reprogramaciones: Number(c.reprogramaciones_ciclo), canceladas: Number(c.canceladas_ciclo) };
  };
  const agendar = async desplazamientoDias => {
    // A media mañana de Panamá, no "ahora + N días": corriendo de noche,
    // sumarle 90 minutos cruzaría la medianoche y sí cambiaría de día.
    const dia = new Date(Date.now() + desplazamientoDias * 24 * 3600_000).toISOString().slice(0, 10);
    // Hora distinta por llamada: si dos caen en el mismo instante, la segunda
    // se omite por duplicada y la prueba se queda sin sesión.
    const hora = String(10 + desplazamientoDias).padStart(2, '0');
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [`${dia}T${hora}:00:00.000Z`], durationMinutes: 60, mode: 'Presencial' });
    return lote.datos.sesiones[0];
  };

  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Mueve y cancela', billingModel: 'monthly', standardPrice: 280, cutoffDay: 1 });
    clientId = c.datos.id;
  });

  test('arranca en cero', async () => {
    assert.deepEqual(await conteo(), { reprogramaciones: 0, canceladas: 0 });
  });

  test('cancelar sin reponer no cuenta como reprogramación', async () => {
    const s = await agendar(2);
    await api.delete(`/api/sessions/${s.id}?rescheduled=false`);
    assert.deepEqual(await conteo(), { reprogramaciones: 0, canceladas: 1 },
      'perder una clase mide el cumplimiento del cliente, no el desgaste de la agenda');
  });

  test('cancelar pidiendo otro día sí', async () => {
    const s = await agendar(3);
    await api.delete(`/api/sessions/${s.id}?rescheduled=true`);
    assert.deepEqual(await conteo(), { reprogramaciones: 1, canceladas: 1 });
  });

  test('correrla a otro día cuenta, aunque nadie cancele nada', async () => {
    // Es lo que hace la entrenadora al arrastrar la cita en Google.
    const s = await agendar(4);
    const otroDia = new Date(s.starts_at); otroDia.setUTCDate(otroDia.getUTCDate() + 2);
    await api.patch(`/api/sessions/${s.id}`, { startsAt: otroDia.toISOString(), durationMinutes: 60, mode: 'Presencial' });
    assert.deepEqual(await conteo(), { reprogramaciones: 2, canceladas: 1 });
  });

  test('pero correrla de hora dentro del mismo día no', async () => {
    const s = await agendar(6);
    const masTarde = new Date(s.starts_at); masTarde.setUTCMinutes(masTarde.getUTCMinutes() + 90);
    await api.patch(`/api/sessions/${s.id}`, { startsAt: masTarde.toISOString(), durationMinutes: 60, mode: 'Presencial' });
    const despues = await conteo();
    assert.equal(despues.reprogramaciones, 2, 'ajustar la hora no es reprogramar');
  });
});

describe('reposiciones: dos clases y una semana', () => {
  let clientId;
  const saldos = async () => (await api.get('/api/packages')).datos.filter(p => p.client_id === clientId);

  before(async () => {
    // Corte hoy: el ciclo acaba de empezar, así que estamos dentro de la
    // semana de gracia.
    const hoy = new Date().getDate();
    const plan = await api.post('/api/plans', { name: 'Mensual con reposiciones', billingModel: 'monthly', price: 280, sessionsIncluded: 8 });
    const c = await api.post('/api/clients', { fullName: 'Pidió mover tres', planId: plan.datos.id, cutoffDay: hoy });
    clientId = c.datos.id;
    // La mensualidad del ciclo que acaba de cerrar: 8 clases, 5 dadas.
    // Vencida hace días, sin ambigüedad de huso: si se pone "ayer", según la
    // hora a la que corra la prueba el día de Panamá puede ser todavía el
    // mismo y el saldo seguiría vivo.
    const ayer = new Date(); ayer.setDate(ayer.getDate() - 10);
    const p = await api.post('/api/packages', { clientId, totalSessions: 8, amount: 280, kind: 'monthly', expiresOn: ayer.toISOString().slice(0, 10) });
    await api.post(`/api/invoices/${p.datos.invoice_id}/confirm`, { method: 'Efectivo', paidOn: '2026-08-01' });
    await api.patch(`/api/packages/${p.datos.id}`, { label: 'Mensualidad cerrada', totalSessions: 8, usedSessions: 5, expiresOn: ayer.toISOString().slice(0, 10) });
    // Y tres de las que faltaron fueron porque pidió moverlas.
    for (let i = 1; i <= 3; i += 1) {
      const cuando = new Date(); cuando.setDate(cuando.getDate() - (i + 1));
      const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [cuando.toISOString()], durationMinutes: 60, mode: 'Presencial' });
      await api.delete(`/api/sessions/${lote.datos.sesiones[0].id}?rescheduled=true`);
    }
  });

  test('pidió mover tres, pero sólo cruzan dos', async () => {
    await api.post('/api/billing/recurring/generate', {});
    const reposicion = (await saldos()).find(p => p.kind === 'makeup');
    assert.ok(reposicion, 'las clases que pidió mover no se pierden sin más');
    assert.equal(Number(reposicion.total_sessions), 2, 'el tope son dos, pidiera las que pidiera');
    assert.equal(Number(reposicion.amount), 0, 'ya se cobraron dentro de la mensualidad del mes cerrado');
  });

  test('vencen a la semana del corte', async () => {
    const reposicion = (await saldos()).find(p => p.kind === 'makeup');
    const dias = Math.round((new Date(reposicion.expires_on) - new Date()) / 86400000);
    assert.ok(dias >= 6 && dias <= 8, `la semana de gracia, no más: ${dias} días`);
  });

  test('son extra, no salen de las del mes', async () => {
    const cliente = (await api.get('/api/clients')).datos.find(c => c.id === clientId);
    const mensual = (await saldos()).find(p => p.kind === 'monthly');
    const quedaban = Number(mensual.total_sessions) - Number(mensual.used_sessions);
    assert.equal(Number(cliente.available_sessions), quedaban + 2,
      'si se comieran dos de las del mes, cruzarlas no serviría de nada');
  });

  test('la clase que da se descuenta de la reposición, que vence antes', async () => {
    const cuando = new Date(Date.now() - 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });
    await api.patch(`/api/sessions/${lote.datos.sesiones[0].id}/compliance`, { outcome: 'completed', completionPercent: 100 });
    const despues = await saldos();
    assert.equal(Number(despues.find(p => p.kind === 'makeup').used_sessions), 1);
    assert.equal(Number(despues.find(p => p.kind === 'monthly').used_sessions), 5,
      'la mensualidad cerrada no se toca: está vencida y ya no se gasta');
  });

  test('generar dos veces no le regala más reposiciones', async () => {
    await api.post('/api/billing/recurring/generate', {});
    const cuantas = (await saldos()).filter(p => p.kind === 'makeup').length;
    assert.equal(cuantas, 1, 'una por ciclo, por mucho que el proceso repita');
  });
});

describe('huecos libres de la entrenadora', () => {
  let clientId;
  // El día se cuenta en Panamá, no en UTC: de madrugada en UTC allí es todavía
  // la tarde anterior, y "hoy" señalaría al día equivocado.
  const enPanama = fecha => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
  const dia = n => { const d = new Date(); d.setDate(d.getDate() + n); return enPanama(d); };

  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Ocupa la mañana', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clientId = c.datos.id;
    // Dentro de 70 días: la base es compartida con las demás pruebas y los
    // días cercanos ya tienen clases de otros clientes que también ocupan.
    await api.post('/api/sessions', { clientId, startsAt: `${dia(70)}T17:00:00.000Z`, durationMinutes: 60, mode: 'Presencial' });
    await api.post('/api/sessions', { clientId, startsAt: `${dia(70)}T19:00:00.000Z`, durationMinutes: 60, mode: 'Presencial' });
  });

  test('no ofrece las horas que ya están ocupadas', async () => {
    const { estado, datos } = await api.get(`/api/availability?from=${dia(70)}&to=${dia(70)}&durationMinutes=60`);
    assert.equal(estado, 200);
    const suyo = datos.dias.find(d => d.date === dia(70));
    assert.ok(suyo, 'el día pedido tiene que venir');
    assert.ok(!suyo.libres.includes('12:00'), 'las 12:00 están dadas');
    assert.ok(!suyo.libres.includes('14:00'), 'las 14:00 también');
    assert.ok(!suyo.libres.includes('11:30'), 'ni el hueco que se solaparía con las 12:00');
    // Propiedad, no un hueco concreto: la base es compartida y cualquier otra
    // prueba puede tener una clase justo ahí. Lo que debe cumplirse siempre es
    // que ningún hueco ofrecido se solape con nada ocupado.
    const aMin = h => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
    const solapa = suyo.libres.find(libre => suyo.ocupadas.some(ocupada =>
      aMin(ocupada.hora) < aMin(libre) + 60 && aMin(ocupada.hora) + 60 > aMin(libre)));
    assert.equal(solapa, undefined, `ofrece ${solapa} y ahí ya hay alguien`);
    assert.ok(suyo.libres.length, 'y algún hueco tiene que quedar');
  });

  test('la duración cambia lo que cabe', async () => {
    // Entre las 13:00 y las 14:00 hay una hora justa: 60 min entra, 90 no.
    const largo = await api.get(`/api/availability?from=${dia(70)}&to=${dia(70)}&durationMinutes=90`);
    const suyo = largo.datos.dias.find(d => d.date === dia(70));
    assert.ok(!suyo.libres.includes('13:00'), 'una clase de 90 no cabe en un hueco de 60');
  });

  test('no ofrece horas que ya pasaron hoy', async () => {
    const { datos } = await api.get(`/api/availability?from=${dia(0)}&to=${dia(0)}&durationMinutes=60`);
    const hoy = datos.dias[0];
    const ahora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Panama', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    assert.ok(hoy.libres.every(h => h > ahora), 'un hueco de esta mañana no es un hueco');
  });

  test('cubre todos los días del rango', async () => {
    const { datos } = await api.get(`/api/availability?from=${dia(1)}&to=${dia(7)}&durationMinutes=60`);
    assert.equal(datos.dias.length, 7, 'la semana de la reposición, entera');
  });
});

describe('horario de trabajo con turnos', () => {
  const enPanama = fecha => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
  const dia = n => { const d = new Date(); d.setDate(d.getDate() + n); return enPanama(d); };

  after(async () => {
    // Se deja como estaba: el resto de las pruebas cuenta con la franja
    // deducida, no con estos turnos.
    await api.put('/api/working-hours', { tramos: [] });
  });

  test('guarda dos turnos el mismo día', async () => {
    const tramos = [];
    for (let d = 0; d <= 6; d += 1) {
      tramos.push({ weekday: d, startsAt: '05:00', endsAt: '11:00' });
      tramos.push({ weekday: d, startsAt: '16:00', endsAt: '20:00' });
    }
    const { estado, datos } = await api.put('/api/working-hours', { tramos });
    assert.equal(estado, 200);
    assert.equal(datos.tramos.length, 14, 'siete días con turno de mañana y de tarde');
  });

  test('el corte del mediodía deja de ofrecerse', async () => {
    const { datos } = await api.get(`/api/availability?from=${dia(3)}&to=${dia(3)}&durationMinutes=60`);
    assert.equal(datos.configurado, true, 'manda lo configurado, no lo deducido');
    const horas = datos.dias[0].libres;
    // Propiedad y no horas concretas: la base es compartida y cualquier hueco
    // suelto puede estar ocupado por otra prueba. Lo que debe cumplirse
    // siempre es que ninguno caiga fuera de los turnos.
    const fuera = horas.filter(h => !((h >= '05:00' && h <= '10:00') || (h >= '16:00' && h <= '19:00')));
    assert.deepEqual(fuera, [], 'entre turno y turno no trabaja, y después de las 20:00 tampoco');
    assert.ok(horas.length, 'y algún hueco tiene que quedar dentro de los turnos');
  });

  test('rechaza dos turnos que se pisan', async () => {
    const { estado } = await api.put('/api/working-hours', {
      tramos: [{ weekday: 1, startsAt: '05:00', endsAt: '11:00' }, { weekday: 1, startsAt: '10:00', endsAt: '14:00' }]
    });
    assert.equal(estado, 400, 'un hueco saldría dos veces');
  });

  test('sin turnos vuelve a deducir la franja', async () => {
    await api.put('/api/working-hours', { tramos: [] });
    const { datos } = await api.get(`/api/availability?from=${dia(3)}&to=${dia(3)}&durationMinutes=60`);
    assert.equal(datos.configurado, false, 'quien no lo ha configurado no se queda sin huecos');
  });
});

describe('cuando cancela la entrenadora', () => {
  let clientId, planId;
  const suSaldo = async tipo => (await api.get('/api/packages')).datos.find(p => p.client_id === clientId && p.kind === tipo);
  const agendarPasada = async () => {
    const cuando = new Date(Date.now() - 2 * 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });
    return lote.datos.sesiones[0];
  };

  before(async () => {
    const plan = await api.post('/api/plans', { name: 'Mensual 8 por 280', billingModel: 'monthly', price: 280, sessionsIncluded: 8 });
    planId = plan.datos.id;
    const c = await api.post('/api/clients', { fullName: 'No fue culpa suya', planId, cutoffDay: 1 });
    clientId = c.datos.id;
  });

  test('no le baja el cumplimiento al cliente', async () => {
    const s = await agendarPasada();
    await api.delete(`/api/sessions/${s.id}?rescheduled=false&by=trainer`);
    const fila = (await api.get('/api/compliance/summary?period=month')).datos.clients.find(x => x.clientId === clientId);
    const cuenta = fila ? fila.activities : 0;
    assert.equal(cuenta, 0, 'no puede apuntarse como incumplida una clase que canceló ella');
  });

  test('y la del cliente sí', async () => {
    const s = await agendarPasada();
    await api.delete(`/api/sessions/${s.id}?rescheduled=false&by=client`);
    const fila = (await api.get('/api/compliance/summary?period=month')).datos.clients.find(x => x.clientId === clientId);
    assert.equal(fila.activities, 1, 'la que perdió el cliente sí cuenta');
    assert.equal(fila.missed, 1);
  });

  test('ni en sus clases perdidas, que van aparte', async () => {
    const c = (await api.get('/api/clients')).datos.find(x => x.id === clientId);
    assert.equal(Number(c.canceladas_ciclo), 1, 'sólo la que perdió él');
    assert.equal(Number(c.canceladas_por_ella_ciclo), 1, 'la suya se cuenta aparte, no se esconde');
  });

  test('tampoco cuenta en sus reprogramaciones del mes', async () => {
    const antes = (await api.get('/api/clients')).datos.find(c => c.id === clientId).reprogramaciones_ciclo;
    const s = await agendarPasada();
    await api.delete(`/api/sessions/${s.id}?rescheduled=true&by=trainer`);
    const despues = (await api.get('/api/clients')).datos.find(c => c.id === clientId).reprogramaciones_ciclo;
    assert.equal(Number(despues), Number(antes), 'ese contador mide al cliente, no a ella');
  });

  test('reponer le abre una clase sin fecha límite', async () => {
    const s = await agendarPasada();
    const { datos } = await api.delete(`/api/sessions/${s.id}?rescheduled=true&by=trainer&resolution=makeup`);
    assert.equal(datos.compensacion.tipo, 'makeup');
    const saldo = await suSaldo('makeup');
    assert.ok(saldo, 'le queda una clase a favor');
    assert.equal(saldo.expires_on, null, 'sin fecha: el cliente no provocó el problema');
  });

  test('cancelar dos veces suma sobre el mismo saldo', async () => {
    const antes = Number((await suSaldo('makeup')).total_sessions);
    const s = await agendarPasada();
    await api.delete(`/api/sessions/${s.id}?rescheduled=true&by=trainer&resolution=makeup`);
    assert.equal(Number((await suSaldo('makeup')).total_sessions), antes + 1, 'no abre un saldo nuevo por cada clase');
  });

  test('el descuento baja el cobro del mes siguiente', async () => {
    // Corte a tres días vista para que la generación llegue a emitirlo.
    const corte = new Date(Date.now() + 3 * 24 * 3600_000).getDate();
    const c = await api.post('/api/clients', { fullName: 'Le deben dos clases', planId, cutoffDay: corte });
    for (let i = 1; i <= 2; i += 1) {
      const cuando = new Date(Date.now() - i * 2 * 3600_000).toISOString();
      const lote = await api.post('/api/sessions/batch', { clientId: c.datos.id, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });
      await api.delete(`/api/sessions/${lote.datos.sesiones[0].id}?rescheduled=false&by=trainer&resolution=discount`);
    }

    const { datos } = await api.post('/api/billing/recurring/generate', {});
    assert.equal(datos.descuentos, 2, 'los dos créditos se aplican');

    const suyas = (await api.get('/api/invoices')).datos.filter(x => x.client_id === c.datos.id);
    assert.equal(suyas.length, 1);
    assert.equal(Number(suyas[0].amount), 210, '280 menos dos clases de 35');
    assert.match(suyas[0].concept, /menos 2 clases no dadas/, 'y el cobro dice por qué es menor');

    // Y se consumen: un crédito que sigue pendiente después de aplicarse
    // volvería a bajar el cobro del mes siguiente, regalando el doble.
    const cliente = (await api.get('/api/clients')).datos.find(x => x.id === c.datos.id);
    assert.equal(Number(cliente.credito_pendiente), 0, 'aplicado es aplicado, no se cobra dos veces');
  });

  test('descontar deja el crédito por el valor de la clase', async () => {
    const otro = await api.post('/api/clients', { fullName: 'Prefiere descuento', planId, cutoffDay: 1 });
    const cuando = new Date(Date.now() - 2 * 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId: otro.datos.id, startsAt: [cuando], durationMinutes: 60, mode: 'Presencial' });
    const { datos } = await api.delete(`/api/sessions/${lote.datos.sesiones[0].id}?rescheduled=false&by=trainer&resolution=discount`);
    assert.equal(datos.compensacion.tipo, 'discount');
    // 280 entre 8 clases: 35 la clase.
    assert.match(datos.compensacion.detalle, /35\.00/, 'el valor sale del plan, no se teclea');
  });
});

describe('vencimiento de los paquetes', () => {
  let clientId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'Compra paquete', billingModel: 'monthly', standardPrice: 100, cutoffDay: 1 });
    clientId = c.datos.id;
  });

  test('con fecha, la respeta', async () => {
    const { datos } = await api.post('/api/packages', { clientId, totalSessions: 10, amount: 300, kind: 'package', expiresOn: '2026-12-31' });
    assert.equal(String(datos.expires_on).slice(0, 10), '2026-12-31');
  });

  test('sin fecha, el saldo no caduca', async () => {
    const { datos } = await api.post('/api/packages', { clientId, totalSessions: 10, amount: 300, kind: 'package' });
    assert.equal(datos.expires_on, null,
      'la interfaz decía "un mes después" y el servidor guardaba sin vencimiento: ahora la propone y la deja a la vista');
  });

  test('un paquete sin vencer no impone cuota mensual de cumplimiento', async () => {
    const { datos } = await api.get(`/api/clients/${clientId}/attendance`);
    const conCuota = datos.timeline.filter(m => m.basis === 'package');
    assert.equal(conCuota.length, 0,
      'sin plazo no hay ritmo pactado: repartir las clases entre meses le exigiría algo que nadie acordó');
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

  test('una cancelada se puede quitar del todo', async () => {
    await api.delete(`/api/sessions/${sesionId}?rescheduled=false`);
    const borrada = await api.delete(`/api/sessions/${sesionId}/permanent`);
    assert.equal(borrada.estado, 200);

    const sesiones = await api.get('/api/sessions');
    assert.ok(!sesiones.datos.find(s => s.id === sesionId), 'no debe quedar en la agenda');
  });

  test('una realizada no se borra: descontó del saldo', async () => {
    const lote = await api.post('/api/sessions/batch', { clientId: clienteId, startsAt: ['2026-10-12T13:00:00.000Z'], durationMinutes: 60, mode: 'Presencial' });
    const id = lote.datos.sesiones[0].id;
    await api.patch(`/api/sessions/${id}/compliance`, { completed: true, completionPercent: 100 });
    const { estado } = await api.delete(`/api/sessions/${id}/permanent`);
    assert.equal(estado, 409, 'borrarla descuadraría el saldo de sesiones');
  });
});

describe('corregir una sesión ya guardada', () => {
  let clientA, clientB, sesionId;
  before(async () => {
    const a = await api.post('/api/clients', { fullName: 'Destino A', billingModel: 'single', standardPrice: 30, cutoffDay: 1 });
    const b = await api.post('/api/clients', { fullName: 'Destino B', billingModel: 'single', standardPrice: 30, cutoffDay: 1 });
    clientA = a.datos.id; clientB = b.datos.id;
    const lote = await api.post('/api/sessions/batch', { clientId: clientA, startsAt: ['2026-11-05T13:00:00.000Z'], durationMinutes: 60, mode: 'Presencial' });
    sesionId = lote.datos.sesiones[0].id;
  });

  test('se puede cambiar el cliente agendado', async () => {
    const { estado, datos } = await api.patch(`/api/sessions/${sesionId}`, {
      startsAt: '2026-11-05T13:00:00.000Z', durationMinutes: 60, mode: 'Presencial', clientId: clientB
    });
    assert.equal(estado, 200);
    assert.equal(datos.client_id, clientB, 'la sesión debe quedar a nombre del cliente nuevo');
  });

  test('una sesión creada por error se borra sin pasar por cancelada', async () => {
    const lote = await api.post('/api/sessions/batch', { clientId: clientA, startsAt: ['2026-11-12T13:00:00.000Z'], durationMinutes: 60, mode: 'Presencial' });
    const id = lote.datos.sesiones[0].id;
    const { estado } = await api.delete(`/api/sessions/${id}/permanent`);
    assert.equal(estado, 200, 'programada se borra directamente: cancelarla la contaría como incumplida');
    const quedan = await api.get('/api/sessions');
    assert.ok(!quedan.datos.find(s => s.id === id));
  });

  test('borrarla no deja incumplimiento en el cumplimiento del cliente', async () => {
    const ayer = new Date(Date.now() - 24 * 3600_000).toISOString();
    const lote = await api.post('/api/sessions/batch', { clientId: clientA, startsAt: [ayer], durationMinutes: 60, mode: 'Presencial' });
    const id = lote.datos.sesiones[0].id;
    await api.delete(`/api/sessions/${id}/permanent`);
    const resumen = await api.get('/api/compliance/summary?period=month');
    const suyo = resumen.datos.clients.find(c => c.clientId === clientA);
    assert.ok(!suyo || suyo.missed === 0, 'una sesión borrada no debe figurar como incumplida');
  });
});

describe('un pagador que cubre a varias personas', () => {
  let pagador, esposa, yerno, plan;
  before(async () => {
    const p = await api.post('/api/plans', { name: 'Mensualidad familiar', billingModel: 'monthly', price: 120, sessionsIncluded: 8 });
    plan = p.datos.id;
    const a = await api.post('/api/clients', { fullName: 'El que paga', planId: plan, cutoffDay: 1 });
    const b = await api.post('/api/clients', { fullName: 'La esposa', planId: plan, cutoffDay: 1 });
    const c = await api.post('/api/clients', { fullName: 'El yerno', planId: plan, cutoffDay: 1 });
    pagador = a.datos.id; esposa = b.datos.id; yerno = c.datos.id;
    await api.patch(`/api/clients/${esposa}`, { fullName: 'La esposa', billingResponsibleClientId: pagador });
    await api.patch(`/api/clients/${yerno}`, { fullName: 'El yerno', billingResponsibleClientId: pagador });
  });

  test('un pagador puede cubrir a más de una persona', async () => {
    const lista = await api.get('/api/clients');
    const dependientes = lista.datos.filter(c => c.billing_responsible_client_id === pagador);
    assert.equal(dependientes.length, 2, 'esposa y yerno deben depender del mismo pagador');
  });

  test('se genera un cobro por persona, todos a nombre de quien paga', async () => {
    const { estado } = await api.post('/api/billing/recurring/generate', {});
    assert.equal(estado, 200);

    const facturas = (await api.get('/api/invoices')).datos
      .filter(i => i.client_id === pagador && i.auto_generated);
    assert.equal(facturas.length, 3, 'uno suyo y uno por cada persona que cubre');

    const cubiertos = facturas.map(f => f.billed_for_client_id).sort();
    assert.deepEqual(cubiertos.sort(), [pagador, esposa, yerno].sort(),
      'cada cobro debe recordar de quién es la mensualidad');
  });

  test('el concepto dice de quién es cada mensualidad', async () => {
    const facturas = (await api.get('/api/invoices')).datos
      .filter(i => i.client_id === pagador && i.auto_generated);
    const dela = facturas.find(f => f.billed_for_client_id === esposa);
    assert.match(dela.concept, /La esposa/, 'sin el nombre, tres cobros iguales serían indistinguibles');
    const suyo = facturas.find(f => f.billed_for_client_id === pagador);
    assert.ok(!/·.*·/.test(suyo.concept.replace(/ · \d{2}\/\d{4}/, '')), 'el suyo no lleva nombre repetido');
  });

  test('no duplica al volver a generar', async () => {
    await api.post('/api/billing/recurring/generate', {});
    const facturas = (await api.get('/api/invoices')).datos
      .filter(i => i.client_id === pagador && i.auto_generated);
    assert.equal(facturas.length, 3, 'el índice único va por persona, no sólo por cliente y mes');
  });

  test('a los dependientes no se les factura por su cuenta', async () => {
    const suyas = (await api.get('/api/invoices')).datos.filter(i => i.client_id === esposa);
    assert.equal(suyas.length, 0, 'quien no paga no recibe cobros');
  });
});

describe('no se agenda a quien ya no entrena', () => {
  let clientId;
  before(async () => {
    const c = await api.post('/api/clients', { fullName: 'De baja', billingModel: 'single', standardPrice: 30, cutoffDay: 1 });
    clientId = c.datos.id;
    await api.patch(`/api/clients/${clientId}`, { fullName: 'De baja', status: 'inactive' });
  });

  test('ni una sesión suelta', async () => {
    const { estado, datos } = await api.post('/api/sessions', { clientId, startsAt: '2026-12-01T13:00:00.000Z', durationMinutes: 60 });
    assert.equal(estado, 409);
    assert.match(datos.error, /inactivo/i);
  });

  test('ni por lotes', async () => {
    const { estado } = await api.post('/api/sessions/batch', { clientId, startsAt: ['2026-12-02T13:00:00.000Z'], durationMinutes: 60, mode: 'Presencial' });
    assert.equal(estado, 409);
  });

  test('ni un horario fijo', async () => {
    const { estado } = await api.post('/api/session-recurrences', { clientId, weekdays: [2], timeOfDay: '06:00' });
    assert.equal(estado, 409);
  });

  test('ni moviéndole la sesión de otra persona', async () => {
    const otro = await api.post('/api/clients', { fullName: 'Sigue activo', billingModel: 'single', standardPrice: 30, cutoffDay: 1 });
    const lote = await api.post('/api/sessions/batch', { clientId: otro.datos.id, startsAt: ['2026-12-03T13:00:00.000Z'], durationMinutes: 60, mode: 'Presencial' });
    const { estado } = await api.patch(`/api/sessions/${lote.datos.sesiones[0].id}`, {
      startsAt: '2026-12-03T13:00:00.000Z', durationMinutes: 60, mode: 'Presencial', clientId
    });
    assert.equal(estado, 409, 'la puerta de atrás también debe estar cerrada');
  });

  test('al reactivarlo vuelve a poderse', async () => {
    await api.patch(`/api/clients/${clientId}`, { fullName: 'De baja', status: 'active' });
    const { estado } = await api.post('/api/sessions/batch', { clientId, startsAt: ['2026-12-04T13:00:00.000Z'], durationMinutes: 60, mode: 'Presencial' });
    assert.equal(estado, 201);
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

describe('cambiar el plan de un cliente ya creado', () => {
  let clientId, planBarato, planCaro;
  before(async () => {
    const a = await api.post('/api/plans', { name: 'Plan de entrada', billingModel: 'monthly', price: 80, sessionsIncluded: 4 });
    const b = await api.post('/api/plans', { name: 'Plan completo', billingModel: 'monthly', price: 200, sessionsIncluded: 12 });
    planBarato = a.datos.id; planCaro = b.datos.id;
    const c = await api.post('/api/clients', { fullName: 'Sube de plan', planId: planBarato, cutoffDay: 1 });
    clientId = c.datos.id;
  });

  test('arrastra el precio y la meta de cumplimiento', async () => {
    const antes = (await api.get('/api/clients')).datos.find(c => c.id === clientId);
    assert.equal(Number(antes.standard_price), 80);
    assert.equal(Number(antes.monthly_session_target), 4);

    const { estado } = await api.patch(`/api/clients/${clientId}/plan`, { planId: planCaro, cutoffDay: 1 });
    assert.equal(estado, 200);

    const despues = (await api.get('/api/clients')).datos.find(c => c.id === clientId);
    assert.equal(Number(despues.standard_price), 200, 'el precio sigue al plan');
    assert.equal(Number(despues.monthly_session_target), 12, 'y la meta contra la que se mide su cumplimiento');
    assert.equal(despues.plan_id, planCaro);
  });

  test('un cliente sin plan puede recibir uno', async () => {
    const suelto = await api.post('/api/clients', { fullName: 'Nacio sin plan', billingModel: 'monthly', standardPrice: 0, cutoffDay: 1 });
    assert.equal(Number(suelto.datos.standard_price), 0, 'sin plan se queda en cero, que es lo que Joel veía');

    await api.patch(`/api/clients/${suelto.datos.id}/plan`, { planId: planCaro, cutoffDay: 5 });
    const ahora = (await api.get('/api/clients')).datos.find(c => c.id === suelto.datos.id);
    assert.equal(Number(ahora.standard_price), 200, 'deja de estar en cero');
    assert.equal(Number(ahora.billing_cutoff_day), 5);
  });

  test('un plan inactivo no se puede asignar', async () => {
    await api.delete(`/api/plans/${planBarato}`);
    const { estado } = await api.patch(`/api/clients/${clientId}/plan`, { planId: planBarato, cutoffDay: 1 });
    assert.equal(estado, 404, 'desactivar un plan es para dejar de usarlo');
  });
});

describe('cambiar el día de corte', () => {
  let clientId;
  before(async () => {
    const plan = await api.post('/api/plans', { name: 'Mensual corte', billingModel: 'monthly', price: 90, sessionsIncluded: 8 });
    const c = await api.post('/api/clients', { fullName: 'Cambia corte', planId: plan.datos.id, cutoffDay: 1 });
    clientId = c.datos.id;
  });

  test('se puede mover después de creado', async () => {
    const { estado, datos } = await api.patch(`/api/clients/${clientId}`, { fullName: 'Cambia corte', cutoffDay: 15 });
    assert.equal(estado, 200);
    assert.equal(Number(datos.billing_cutoff_day), 15);
  });

  test('editar otra cosa no lo mueve', async () => {
    const { datos } = await api.patch(`/api/clients/${clientId}`, { fullName: 'Cambia corte', goal: 'Otra meta' });
    assert.equal(Number(datos.billing_cutoff_day), 15, 'sin cutoffDay en el cuerpo, el día se respeta');
  });

  test('el cobro del mes usa el día nuevo', async () => {
    // El día se elige a tres días vista para que caiga dentro de la ventana de
    // generación y después del alta de la membresía. Fijar un 15 hacía que la
    // prueba dependiera del día en que se ejecutara.
    const objetivo = new Date(Date.now() + 3 * 24 * 3600_000).getDate();
    await api.patch(`/api/clients/${clientId}`, { fullName: 'Cambia corte', cutoffDay: objetivo });
    await api.post('/api/billing/recurring/generate', {});

    const facturas = (await api.get('/api/invoices')).datos.filter(i => i.client_id === clientId && i.auto_generated);
    assert.ok(facturas.length > 0, 'debe haberse generado su mensualidad');
    for (const f of facturas) {
      assert.equal(Number(String(f.due_on).slice(8, 10)), objetivo, 'el vencimiento sigue al día de corte');
    }
  });
});

describe('borrar un expediente duplicado', () => {
  test('se lleva al cliente y deja de aparecer', async () => {
    const c = await api.post('/api/clients', { fullName: 'Duplicado por error', billingModel: 'single', standardPrice: 30, cutoffDay: 1 });
    const id = c.datos.id;
    const borrado = await api.delete(`/api/clients/${id}`);
    assert.equal(borrado.estado, 200);
    const lista = await api.get('/api/clients');
    assert.ok(!lista.datos.find(x => x.id === id), 'no debe quedar en la lista');
  });

  test('queda registrado en la bitácora', async () => {
    const filas = await api.get('/api/audit-log?limit=30');
    const entrada = filas.datos.find(f => f.route === '/api/clients/:id');
    assert.ok(entrada, 'borrar un expediente es de lo más grave que se puede hacer: debe quedar constancia');
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
