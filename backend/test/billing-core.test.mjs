// Etapa 1B-1: el modelo de facturación nuevo (migración 051).
//
// Estas pruebas hablan directo con la base: lo que se comprueba aquí son reglas
// que Postgres mismo debe hacer cumplir (numeración sin huecos, facturas
// inmutables, total = suma de líneas, aplicaciones válidas, aislamiento por
// dueño), con independencia de la API. Todas las fechas son literales: no
// dependen del reloj ni del mes en curso.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor;
let api;
let db;
let ownerId;
let otroDueno;
let pagador;
let otroPagador;
let beneficiario;

const rechaza = async (promesa, patron) => {
  await assert.rejects(promesa, error => {
    assert.match(String(error.message), patron);
    return true;
  });
};

// Crea una factura completa (cabecera + líneas) en UNA transacción, como lo hará la API.
async function crearFactura(sql, dueno, payer, { cicloInicio = '2026-09-15', total = 300, lineas, kind = 'mensual', origin = 'manual' } = {}) {
  const partes = lineas || [{ beneficiary: payer, amount: total }];
  return sql.begin(async tx => {
    const [{ n }] = await tx`SELECT billing_next_number(${dueno}) AS n`;
    const [factura] = await tx`
      INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day, issued_on, due_on, total)
      VALUES (${dueno}, ${n}, ${payer}, ${kind}, ${origin}, ${cicloInicio}::date, (${cicloInicio}::date + interval '1 month')::date, 15, ${cicloInicio}::date, ${cicloInicio}::date, ${total})
      RETURNING *`;
    for (const linea of partes) {
      await tx`
        INSERT INTO billing_invoice_lines (invoice_id, beneficiary_client_id, description, unit_amount, amount)
        VALUES (${factura.id}, ${linea.beneficiary}, 'Plan', ${linea.amount}, ${linea.amount})`;
    }
    return factura;
  });
}

async function crearCobro(sql, dueno, payer, monto = 300) {
  const [cobro] = await sql`
    INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method)
    VALUES (${dueno}, ${payer}, '2026-09-16', ${monto}, 'Yappy') RETURNING *`;
  return cobro;
}

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 8 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  [{ id: ownerId }] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  // Un segundo dueño, para probar el aislamiento.
  [{ id: otroDueno }] = await db`
    INSERT INTO users (email, password_hash, full_name, role) VALUES ('otra@prueba.test', 'x', 'Otra entrenadora', 'trainer') RETURNING id`;
  const nuevo = async (dueno, nombre) => (await db`INSERT INTO clients (owner_id, full_name) VALUES (${dueno}, ${nombre}) RETURNING id`)[0].id;
  pagador = await nuevo(ownerId, 'Pagador Uno');
  otroPagador = await nuevo(ownerId, 'Pagador Dos');
  beneficiario = await nuevo(ownerId, 'Beneficiario');
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

describe('migración 051: el modelo existe', () => {
  test('las tablas nuevas y la función de numeración están creadas', async () => {
    const tablas = await db`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'billing\_%' ORDER BY table_name`;
    const nombres = tablas.map(t => t.table_name);
    for (const esperada of ['billing_adjustments', 'billing_audit', 'billing_counters', 'billing_invoice_lines',
      'billing_invoices', 'billing_payment_applications', 'billing_payments', 'billing_subscriptions']) {
      assert.ok(nombres.includes(esperada), `falta ${esperada}`);
    }
    const [{ existe }] = await db`SELECT to_regprocedure('billing_next_number(uuid, text)') IS NOT NULL AS existe`;
    assert.equal(existe, true);
  });

  test('la migración no tocó las tablas del sistema anterior', async () => {
    const [{ n }] = await db`SELECT count(*)::int AS n FROM invoices`;
    assert.equal(n, 0);
  });
});

describe('numeración FAC sin huecos, por dueño', () => {
  test('los números son consecutivos desde 1', async () => {
    const a = await crearFactura(db, ownerId, pagador, { cicloInicio: '2026-01-15' });
    const b = await crearFactura(db, ownerId, pagador, { cicloInicio: '2026-02-15' });
    assert.deepEqual([a.number, b.number], [1, 2]);
  });

  test('si la transacción falla, el número no se consume', async () => {
    const [{ ultimo }] = await db`SELECT last_number AS ultimo FROM billing_counters WHERE owner_id = ${ownerId}`;
    await rechaza(db.begin(async tx => {
      await tx`SELECT billing_next_number(${ownerId})`;
      throw new Error('falla a propósito');
    }), /falla a propósito/);
    const [{ despues }] = await db`SELECT last_number AS despues FROM billing_counters WHERE owner_id = ${ownerId}`;
    assert.equal(despues, ultimo);
    const c = await crearFactura(db, ownerId, pagador, { cicloInicio: '2026-03-15' });
    assert.equal(c.number, ultimo + 1);
  });

  test('veinte altas simultáneas no duplican ni dejan huecos', async () => {
    const [{ antes }] = await db`SELECT last_number AS antes FROM billing_counters WHERE owner_id = ${ownerId}`;
    const hechas = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      crearFactura(db, ownerId, otroPagador, { cicloInicio: `2027-${String((i % 12) + 1).padStart(2, '0')}-${i < 12 ? '10' : '11'}` })));
    const numeros = hechas.map(f => f.number).sort((x, y) => x - y);
    assert.deepEqual(numeros, Array.from({ length: 20 }, (_, i) => antes + 1 + i));
  });

  test('cada dueño tiene su propia serie', async () => {
    const ajeno = (await db`INSERT INTO clients (owner_id, full_name) VALUES (${otroDueno}, 'Cliente ajeno') RETURNING id`)[0].id;
    const f = await crearFactura(db, otroDueno, ajeno, { cicloInicio: '2026-09-15' });
    assert.equal(f.number, 1);
  });

  test('el número es único por dueño aunque se fuerce', async () => {
    await rechaza(db`
      INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day, issued_on, due_on, total)
      VALUES (${ownerId}, 1, ${pagador}, 'manual', 'manual', '2030-01-01', '2030-02-01', 1, '2030-01-01', '2030-01-01', 0)`, /billing_invoices_number_idx|duplicate/i);
  });
});

describe('facturas: reglas de integridad', () => {
  test('una mensualidad por pagador y ciclo; una anulada libera el ciclo', async () => {
    const primera = await crearFactura(db, ownerId, beneficiario, { cicloInicio: '2026-09-15' });
    await rechaza(crearFactura(db, ownerId, beneficiario, { cicloInicio: '2026-09-15' }), /billing_invoices_cycle_idx|duplicate/i);
    await db`UPDATE billing_invoices SET status = 'anulada', void_reason = 'Error de captura', voided_at = now() WHERE id = ${primera.id}`;
    const reemplazo = await crearFactura(db, ownerId, beneficiario, { cicloInicio: '2026-09-15' });
    assert.ok(reemplazo.number > primera.number);
  });

  test('las facturas manuales sueltas no se limitan por ciclo', async () => {
    await crearFactura(db, ownerId, beneficiario, { cicloInicio: '2026-09-20', kind: 'clase_suelta' });
    await crearFactura(db, ownerId, beneficiario, { cicloInicio: '2026-09-20', kind: 'clase_suelta' });
  });

  test('el total debe coincidir con la suma de las líneas (se comprueba al cierre)', async () => {
    await rechaza(db.begin(async tx => {
      const [{ n }] = await tx`SELECT billing_next_number(${ownerId}) AS n`;
      const [f] = await tx`
        INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day, issued_on, due_on, total)
        VALUES (${ownerId}, ${n}, ${pagador}, 'manual', 'manual', '2031-01-01', '2031-02-01', 1, '2031-01-01', '2031-01-01', 500) RETURNING id`;
      await tx`INSERT INTO billing_invoice_lines (invoice_id, beneficiary_client_id, description, unit_amount, amount) VALUES (${f.id}, ${pagador}, 'Plan', 300, 300)`;
    }), /no coincide con la suma/);
  });

  test('una factura sin líneas se rechaza', async () => {
    await rechaza(db.begin(async tx => {
      const [{ n }] = await tx`SELECT billing_next_number(${ownerId}) AS n`;
      await tx`
        INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day, issued_on, due_on, total)
        VALUES (${ownerId}, ${n}, ${pagador}, 'manual', 'manual', '2031-02-01', '2031-03-01', 1, '2031-02-01', '2031-02-01', 0)`;
    }), /al menos una línea/);
  });

  test('una familia: una cabecera y una línea por beneficiario, sin repetir persona', async () => {
    const f = await crearFactura(db, ownerId, pagador, {
      cicloInicio: '2026-10-15', total: 900,
      lineas: [{ beneficiary: pagador, amount: 450 }, { beneficiary: otroPagador, amount: 300 }, { beneficiary: beneficiario, amount: 150 }]
    });
    const lineas = await db`SELECT amount FROM billing_invoice_lines WHERE invoice_id = ${f.id}`;
    assert.equal(lineas.length, 3);
    await rechaza(db`
      INSERT INTO billing_invoice_lines (invoice_id, beneficiary_client_id, description, unit_amount, amount)
      VALUES (${f.id}, ${pagador}, 'Duplicada', 1, 1)`, /billing_invoice_lines_plan_idx|duplicate|inmutable|no se editan/i);
  });

  test('no se borra, no se renumera, no se edita el total ni las líneas', async () => {
    const f = await crearFactura(db, ownerId, pagador, { cicloInicio: '2026-11-15' });
    await rechaza(db`DELETE FROM billing_invoices WHERE id = ${f.id}`, /no se borra/);
    await rechaza(db`DELETE FROM billing_invoice_lines WHERE invoice_id = ${f.id}`, /no se borra/);
    await rechaza(db`UPDATE billing_invoices SET number = 9999 WHERE id = ${f.id}`, /no se edita ni se renumera/);
    await rechaza(db`UPDATE billing_invoices SET total = 1 WHERE id = ${f.id}`, /no se edita ni se renumera/);
    await rechaza(db`UPDATE billing_invoice_lines SET amount = 1 WHERE invoice_id = ${f.id}`, /no se editan/);
  });

  test('anular exige motivo; una anulada no se reactiva', async () => {
    const f = await crearFactura(db, ownerId, pagador, { cicloInicio: '2026-12-15' });
    await rechaza(db`UPDATE billing_invoices SET status = 'anulada' WHERE id = ${f.id}`, /billing_invoices_check|check/i);
    await rechaza(db`UPDATE billing_invoices SET status = 'anulada', void_reason = '   ', voided_at = now() WHERE id = ${f.id}`, /check/i);
    await db`UPDATE billing_invoices SET status = 'anulada', void_reason = 'Duplicada', voided_at = now() WHERE id = ${f.id}`;
    await rechaza(db`UPDATE billing_invoices SET status = 'pendiente', void_reason = NULL, voided_at = NULL WHERE id = ${f.id}`, /no se reactiva/);
  });

  test('no se puede borrar a un cliente que tiene facturas', async () => {
    const c = (await db`INSERT INTO clients (owner_id, full_name) VALUES (${ownerId}, 'Con facturas') RETURNING id`)[0].id;
    await crearFactura(db, ownerId, c, { cicloInicio: '2026-09-01' });
    await rechaza(db`DELETE FROM clients WHERE id = ${c}`, /violates foreign key|restrict|billing_invoices/i);
  });
});

describe('cobros y aplicaciones', () => {
  test('un cobro se aplica a una factura de su mismo pagador', async () => {
    const f = await crearFactura(db, ownerId, pagador, { cicloInicio: '2027-05-15', total: 300 });
    const cobro = await crearCobro(db, ownerId, pagador, 300);
    await db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f.id}, 300, '2026-09-16')`;
  });

  test('no se aplica a la factura de otro pagador', async () => {
    const f = await crearFactura(db, ownerId, otroPagador, { cicloInicio: '2027-06-15', total: 100 });
    const cobro = await crearCobro(db, ownerId, pagador, 100);
    await rechaza(db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f.id}, 100, '2026-09-16')`, /mismo pagador/);
  });

  test('no se aplica entre dueños distintos', async () => {
    const ajeno = (await db`INSERT INTO clients (owner_id, full_name) VALUES (${otroDueno}, 'Ajeno 2') RETURNING id`)[0].id;
    const f = await crearFactura(db, otroDueno, ajeno, { cicloInicio: '2027-01-15', total: 100 });
    const cobro = await crearCobro(db, ownerId, pagador, 100);
    await rechaza(db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f.id}, 100, '2026-09-16')`, /dueños distintos|mismo pagador/);
  });

  test('no supera lo disponible del cobro ni el saldo de la factura', async () => {
    const f1 = await crearFactura(db, ownerId, pagador, { cicloInicio: '2027-07-15', total: 200 });
    const f2 = await crearFactura(db, ownerId, pagador, { cicloInicio: '2027-08-15', total: 200 });
    const cobro = await crearCobro(db, ownerId, pagador, 250);
    await db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f1.id}, 200, '2026-09-16')`;
    await rechaza(db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f2.id}, 100, '2026-09-16')`, /supera lo disponible del cobro/);
    await db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f2.id}, 50, '2026-09-16')`;
    const otro = await crearCobro(db, ownerId, pagador, 500);
    await rechaza(db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${otro.id}, ${f1.id}, 1, '2026-09-16')`, /supera el saldo de la factura/);
  });

  test('una aplicación revertida libera el cobro y la factura; no se edita ni se borra', async () => {
    const f = await crearFactura(db, ownerId, pagador, { cicloInicio: '2027-09-15', total: 100 });
    const cobro = await crearCobro(db, ownerId, pagador, 100);
    const [ap] = await db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f.id}, 100, '2026-09-16') RETURNING id`;
    await rechaza(db`UPDATE billing_payment_applications SET amount = 50 WHERE id = ${ap.id}`, /no se edita/);
    await rechaza(db`DELETE FROM billing_payment_applications WHERE id = ${ap.id}`, /no se borra/);
    await db`UPDATE billing_payment_applications SET reversed_at = now(), reversal_reason = 'Pago aplicado a la factura equivocada' WHERE id = ${ap.id}`;
    await db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f.id}, 100, '2026-09-17')`;
    await rechaza(db`UPDATE billing_payment_applications SET reversed_at = NULL, reversal_reason = NULL WHERE id = ${ap.id}`, /no se reactiva|check/i);
  });

  test('un cobro no se borra y su monto debe ser positivo', async () => {
    const cobro = await crearCobro(db, ownerId, pagador, 10);
    await rechaza(db`DELETE FROM billing_payments WHERE id = ${cobro.id}`, /no se borra/);
    await rechaza(db`INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method) VALUES (${ownerId}, ${pagador}, '2026-09-16', 0, 'Yappy')`, /check/i);
    await rechaza(db`INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method) VALUES (${ownerId}, ${pagador}, '2026-09-16', 5, 'Trueque')`, /check/i);
  });

  test('la importación es idempotente por origen e identificador', async () => {
    await db`INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method, source_system, external_id) VALUES (${ownerId}, ${pagador}, '2026-09-16', 5, 'Yappy', 'legacy', 'pago-1')`;
    await rechaza(db`INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method, source_system, external_id) VALUES (${ownerId}, ${pagador}, '2026-09-16', 5, 'Yappy', 'legacy', 'pago-1')`, /billing_payments_external_idx|duplicate/i);
  });
});
