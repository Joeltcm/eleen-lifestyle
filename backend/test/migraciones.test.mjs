// Las migraciones sobre una base que YA tiene datos.
//
// El resto de las pruebas aplica las migraciones sobre una base vacía, y eso
// deja pasar justo lo que rompió el despliegue de esta función: un índice
// único que la base de producción no admitía porque el fallo ya había dejado
// duplicados dentro. Sobre una base vacía no hay nada que duplicar.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

const ejecutar = promisify(execFile);
const USUARIO = process.env.PGUSER || process.env.USER || 'postgres';
const HOST_PEDIDO = process.env.PGHOST || 'localhost';
const HOST = HOST_PEDIDO === 'localhost' ? '127.0.0.1' : HOST_PEDIDO;
const PUERTO = process.env.PGPORT || '5432';
const CLAVE = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';
const CARPETA = resolve(process.cwd(), 'migrations');

describe('migrar una base que ya trae datos', () => {
  let sql, nombreBase, archivos;

  before(async () => {
    nombreBase = `eileen_mig_${randomUUID().slice(0, 8)}`;
    await ejecutar('createdb', [nombreBase], { env: { ...process.env, PGHOST: HOST } });
    sql = postgres(`postgres://${USUARIO}${CLAVE}@${HOST}:${PUERTO}/${nombreBase}`, { onnotice: () => {} });
    archivos = (await readdir(CARPETA)).filter(f => f.endsWith('.sql')).sort();
  });

  after(async () => {
    await sql?.end();
    await ejecutar('dropdb', ['--if-exists', nombreBase], { env: { ...process.env, PGHOST: HOST } }).catch(() => {});
  });

  const aplicar = async archivo => {
    const texto = await readFile(resolve(CARPETA, archivo), 'utf8');
    await sql.begin(transaction => transaction.unsafe(texto));
  };

  test('031 sobrevive a los duplicados que el fallo dejó creados', async () => {
    for (const archivo of archivos.filter(f => f < '031')) await aplicar(archivo);

    const [duena] = await sql`
      INSERT INTO users (email, password_hash, full_name)
      VALUES ('migracion@prueba.test', 'x', 'Dueña') RETURNING id
    `;
    const [cliente] = await sql`
      INSERT INTO clients (owner_id, full_name) VALUES (${duena.id}, 'Con horario fijo') RETURNING id
    `;
    const [regla] = await sql`
      INSERT INTO session_recurrences (client_id, weekdays, time_of_day, duration_minutes, mode)
      VALUES (${cliente.id}, ARRAY[1], '05:30'::time, 60, 'Presencial') RETURNING id
    `;
    // El mismo día de la misma regla, tres veces: la original, la movida a
    // otra hora y una que se dio. Es lo que había en producción.
    await sql`
      INSERT INTO sessions (client_id, starts_at, duration_minutes, mode, recurrence_id, status)
      VALUES
        (${cliente.id}, '2026-09-08 10:30:00+00', 60, 'Presencial', ${regla.id}, 'scheduled'),
        (${cliente.id}, '2026-09-08 11:15:00+00', 60, 'Presencial', ${regla.id}, 'scheduled'),
        (${cliente.id}, '2026-09-08 12:00:00+00', 60, 'Presencial', ${regla.id}, 'completed')
    `;

    await aplicar('031_ocurrencia_del_horario.sql');

    const marcadas = await sql`
      SELECT status FROM sessions WHERE recurrence_id = ${regla.id} AND recurrence_on IS NOT NULL
    `;
    assert.equal(marcadas.length, 1, 'sólo una se queda con la ocurrencia');
    assert.equal(marcadas[0].status, 'completed', 'se queda la que pesa: la que se dio');

    const todas = await sql`SELECT count(*)::int AS n FROM sessions WHERE recurrence_id = ${regla.id}`;
    assert.equal(todas[0].n, 3, 'no se borra ninguna: puede haber asistencia o saldo detrás');
  });

  test('y volver a aplicarla no rompe nada', async () => {
    // El corredor lleva cuenta y no repite, pero una migración que sólo
    // funciona la primera vez es una trampa para el día que haya que restaurar.
    await aplicar('031_ocurrencia_del_horario.sql');
    for (const archivo of archivos.filter(f => f > '031_ocurrencia_del_horario.sql')) await aplicar(archivo);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM sessions`;
    assert.equal(n, 3);
  });
});
