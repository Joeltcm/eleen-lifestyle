#!/usr/bin/env node

import postgres from 'postgres';
import { config } from '../config.js';
import { exercisesHash, routineSummaryText, type RoutineExerciseForSummary } from '../routine-utils.js';

type RoutineRow = {
  id: string;
  owner_id: string;
  title: string;
  version: number;
  root_routine_id: string | null;
  exercises_hash: string | null;
  sessions_per_week: number;
  exercises: RoutineExerciseForSummary[];
};

type SourceRow = {
  kind: 'assignment' | 'link' | 'travel_link' | 'offer';
  source_id: string;
  routine_id: string;
  owner_id: string;
  client_id: string;
  client_name: string;
  sent_at: Date | string;
  sent_by_user_id: string | null;
  due_on: string | null;
  assignment_id: string | null;
  share_link_id: string | null;
  offer_id: string | null;
  title: string;
  version: number;
  sessions_per_week: number;
  exercises: RoutineExerciseForSummary[];
};

const MODES = ['--dry-run', '--aplicar', '--revertir'];
const args = new Set(process.argv.slice(2));
const selected = MODES.filter(mode => args.has(mode));
const mode = selected[0] || '--dry-run';
const target = mode === '--revertir'
  ? (process.argv[process.argv.indexOf(mode) + 1] && !process.argv[process.argv.indexOf(mode) + 1].startsWith('--')
    ? process.argv[process.argv.indexOf(mode) + 1]
    : 'ultimo')
  : null;

function usage() {
  console.error('Uso: node dist/scripts/rellenar-envios-rutinas.js [--dry-run|--aplicar|--revertir [id|ultimo]]');
}

function sourceLabel(kind: SourceRow['kind']) {
  return kind === 'travel_link' ? 'enlace de viaje' : kind === 'link' ? 'enlace' : kind === 'offer' ? 'oferta' : 'asignación';
}

function routineSummary(row: SourceRow) {
  return routineSummaryText({
    title: row.title,
    version: row.version,
    sessionsPerWeek: row.sessions_per_week,
    dueOn: row.due_on,
    exercises: Array.isArray(row.exercises) ? row.exercises : []
  });
}

async function routines(sql: postgres.Sql) {
  return sql<RoutineRow[]>`
    SELECT id::text, owner_id::text, title, version, root_routine_id::text,
      exercises_hash, sessions_per_week, exercises
    FROM routines
    ORDER BY created_at, id
  `;
}

async function sources(sql: postgres.Sql) {
  return sql<SourceRow[]>`
    WITH assignment_dates AS (
      SELECT DISTINCT ON (routine_id, client_id)
        routine_id, client_id, due_on, id AS assignment_id
      FROM routine_assignments
      ORDER BY routine_id, client_id, active DESC, starts_on DESC, id DESC
    )
    SELECT 'assignment'::text AS kind, ra.id::text AS source_id,
      r.id::text AS routine_id, r.owner_id::text AS owner_id,
      c.id::text AS client_id, c.full_name AS client_name,
      ((ra.starts_on::text || ' 12:00:00-05:00')::timestamptz) AS sent_at,
      r.owner_id::text AS sent_by_user_id, ra.due_on::text AS due_on,
      ra.id::text AS assignment_id, NULL::text AS share_link_id, NULL::text AS offer_id,
      r.title, r.version, r.sessions_per_week, r.exercises
    FROM routine_assignments ra
    JOIN routines r ON r.id = ra.routine_id
    JOIN clients c ON c.id = ra.client_id

    UNION ALL

    SELECT CASE WHEN sl.travel_id IS NULL THEN 'link' ELSE 'travel_link' END::text AS kind,
      sl.id::text AS source_id, r.id::text AS routine_id, r.owner_id::text AS owner_id,
      c.id::text AS client_id, c.full_name AS client_name, sl.created_at AS sent_at,
      COALESCE(sl.created_by, r.owner_id)::text AS sent_by_user_id,
      ad.due_on::text AS due_on, ad.assignment_id::text AS assignment_id,
      sl.id::text AS share_link_id, NULL::text AS offer_id,
      r.title, r.version, r.sessions_per_week, r.exercises
    FROM routine_share_links sl
    JOIN routines r ON r.id = sl.routine_id
    JOIN clients c ON c.id = sl.client_id
    LEFT JOIN assignment_dates ad ON ad.routine_id = sl.routine_id AND ad.client_id = sl.client_id

    UNION ALL

    SELECT 'offer'::text AS kind, o.id::text AS source_id,
      r.id::text AS routine_id, r.owner_id::text AS owner_id,
      c.id::text AS client_id, c.full_name AS client_name, o.offered_at AS sent_at,
      COALESCE(o.offered_by_user_id, r.owner_id)::text AS sent_by_user_id,
      ad.due_on::text AS due_on, ad.assignment_id::text AS assignment_id,
      NULL::text AS share_link_id, o.id::text AS offer_id,
      r.title, r.version, r.sessions_per_week, r.exercises
    FROM session_routine_offers o
    JOIN routines r ON r.id = o.routine_id
    JOIN clients c ON c.id = o.client_id
    LEFT JOIN assignment_dates ad ON ad.routine_id = o.routine_id AND ad.client_id = o.client_id

    ORDER BY sent_at, source_id
  `;
}

function sourceReference(row: SourceRow) {
  return row.kind === 'assignment' ? `assignment_id = '${row.source_id}'`
    : row.kind === 'offer' ? `offer_id = '${row.source_id}'`
      : `share_link_id = '${row.source_id}'`;
}

async function pendingSources(sql: postgres.Sql, rows: SourceRow[]) {
  const pending: SourceRow[] = [];
  for (const row of rows) {
    const existing = row.kind === 'assignment'
      ? await sql`SELECT 1 FROM routine_deliveries WHERE backfilled = true AND assignment_id = ${row.source_id}::uuid LIMIT 1`
      : row.kind === 'offer'
        ? await sql`SELECT 1 FROM routine_deliveries WHERE backfilled = true AND offer_id = ${row.source_id}::uuid LIMIT 1`
        : await sql`SELECT 1 FROM routine_deliveries WHERE backfilled = true AND share_link_id = ${row.source_id}::uuid LIMIT 1`;
    if (!existing.length) pending.push(row);
  }
  return pending;
}

async function printPlan(sql: postgres.Sql) {
  const allRoutines = await routines(sql);
  const allSources = await sources(sql);
  const pending = await pendingSources(sql, allSources);
  const missingHashes = allRoutines.filter(row => !row.exercises_hash);
  const missingRoots = allRoutines.filter(row => !row.root_routine_id);
  const byKind = new Map<string, number>();
  for (const row of pending) byKind.set(row.kind, (byKind.get(row.kind) || 0) + 1);
  console.log('RELLENO DE ENVÍOS DE RUTINAS · America/Panama');
  console.log(`Rutinas: ${allRoutines.length} · exercises_hash por rellenar: ${missingHashes.length} · root_routine_id por verificar: ${missingRoots.length}`);
  console.log(`Envíos reconstruibles pendientes: ${pending.length} · asignaciones: ${byKind.get('assignment') || 0} · enlaces: ${byKind.get('link') || 0} · enlaces de viaje: ${byKind.get('travel_link') || 0} · ofertas: ${byKind.get('offer') || 0}`);
  console.log('Cada asignación histórica usa 12:00 de Panamá y queda marcada como fecha/hora aproximada.');
  console.log('No reconstruible: enlaces copiados o enviados por WhatsApp sin fila, y envíos anteriores a la existencia de estas tablas.');
  return { allRoutines, allSources, pending, missingHashes, missingRoots };
}

async function apply(sql: postgres.Sql) {
  const plan = await printPlan(sql);
  if (!plan.pending.length && !plan.missingHashes.length && !plan.missingRoots.length) {
    console.log('APLICAR · no hay nada nuevo; no se creó un lote.');
    return;
  }
  await sql.begin(async transaction => {
    const [run] = await transaction`
      INSERT INTO routine_backfill_runs (status) VALUES ('applying') RETURNING id::text AS id
    `;
    for (const row of plan.allRoutines.filter(item => !item.exercises_hash || !item.root_routine_id)) {
      await transaction`
        INSERT INTO routine_backfill_items (run_id, routine_id, previous_root_routine_id, previous_exercises_hash)
        VALUES (${run.id}::uuid, ${row.id}::uuid, ${row.root_routine_id}::uuid, ${row.exercises_hash})
      `;
      await transaction`
        UPDATE routines
        SET root_routine_id = COALESCE(root_routine_id, id),
            exercises_hash = COALESCE(exercises_hash, ${exercisesHash(Array.isArray(row.exercises) ? row.exercises : [])}),
            updated_at = now()
        WHERE id = ${row.id}::uuid
      `;
    }
    for (const row of plan.pending) {
      const summary = routineSummary(row);
      await transaction`
        INSERT INTO routine_deliveries (
          owner_id, routine_id, client_id, kind, sent_at, sent_by_user_id, due_on,
          share_link_id, offer_id, assignment_id, routine_title, routine_version,
          client_name, summary_text, exercises_snapshot, summary_reconstructed, backfilled, backfill_run_id
        ) VALUES (
          ${row.owner_id}::uuid, ${row.routine_id}::uuid, ${row.client_id}::uuid, ${row.kind}, ${row.sent_at},
          ${row.sent_by_user_id ? `${row.sent_by_user_id}` : null}::uuid, ${row.due_on}::date,
          ${row.share_link_id}::uuid, ${row.offer_id}::uuid, ${row.assignment_id}::uuid,
          ${row.title}, ${row.version || 1}, ${row.client_name}, ${summary}, ${transaction.json(row.exercises || [])}, true, true, ${run.id}::uuid
        )
      `;
      console.log(`RECONSTRUIDO · ${sourceLabel(row.kind)} · ${row.client_name} · ${row.title} · ${sourceReference(row)}`);
    }
    await transaction`UPDATE routine_backfill_runs SET status = 'applied', finished_at = now() WHERE id = ${run.id}::uuid`;
    console.log(`LOTE · ${run.id} · rutinas actualizadas: ${plan.missingHashes.length + plan.missingRoots.length} campo(s) · envíos: ${plan.pending.length}`);
  });
  console.log('APLICAR · operación idempotente; los originales y envíos no backfilled no se tocaron.');
}

async function revert(sql: postgres.Sql, requested: string) {
  const [run] = requested === 'ultimo'
    ? await sql`SELECT id::text AS id FROM routine_backfill_runs WHERE status = 'applied' ORDER BY created_at DESC LIMIT 1`
    : await sql`SELECT id::text AS id FROM routine_backfill_runs WHERE id = ${requested}::uuid AND status = 'applied'`;
  if (!run) { console.log('REVERSIÓN · no hay un lote aplicado para revertir.'); return; }
  await sql.begin(async transaction => {
    const deliveries = await transaction`DELETE FROM routine_deliveries WHERE backfill_run_id = ${run.id}::uuid RETURNING id`;
    let restoredHashes = 0; let respectedChanges = 0;
    const items = await transaction`SELECT routine_id::text, previous_root_routine_id::text, previous_exercises_hash FROM routine_backfill_items WHERE run_id = ${run.id}::uuid`;
    for (const item of items) {
      const [routine] = await transaction`SELECT root_routine_id::text, exercises_hash FROM routines WHERE id = ${item.routine_id}::uuid`;
      if (!routine) continue;
      const expectedRoot = item.previous_root_routine_id || item.routine_id;
      const expectedHash = item.previous_exercises_hash || exercisesHash((await transaction`SELECT exercises FROM routines WHERE id = ${item.routine_id}::uuid`)[0]?.exercises || []);
      const sameRoot = routine.root_routine_id === expectedRoot || (item.previous_root_routine_id == null && routine.root_routine_id === item.routine_id);
      const sameHash = routine.exercises_hash === expectedHash;
      if (sameRoot || sameHash) {
        await transaction`
          UPDATE routines SET
            root_routine_id = CASE WHEN ${sameRoot}::boolean THEN ${item.previous_root_routine_id}::uuid ELSE root_routine_id END,
            exercises_hash = CASE WHEN ${sameHash}::boolean THEN ${item.previous_exercises_hash} ELSE exercises_hash END,
            updated_at = now()
          WHERE id = ${item.routine_id}::uuid
        `;
        if (sameHash) restoredHashes += 1;
      } else respectedChanges += 1;
    }
    await transaction`UPDATE routine_backfill_runs SET status = 'reverted', finished_at = now() WHERE id = ${run.id}::uuid`;
    console.log(`REVERSIÓN · lote ${run.id} · envíos eliminados: ${deliveries.length} · huellas restauradas: ${restoredHashes} · cambios posteriores respetados: ${respectedChanges}`);
  });
}

async function main() {
  if (selected.length > 1 || [...args].some(arg => !MODES.includes(arg) && arg !== target)) {
    usage(); process.exitCode = 2; return;
  }
  const sql = postgres(config.DATABASE_URL, { max: 1, connection: { TimeZone: 'America/Panama' } });
  try {
    if (mode === '--dry-run') await printPlan(sql);
    else if (mode === '--aplicar') await apply(sql);
    else await revert(sql, target || 'ultimo');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error(`Relleno detenido: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
