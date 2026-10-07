#!/usr/bin/env node

import postgres from 'postgres';
import { config } from '../config.js';

type RoutineRow = {
  id: string;
  owner_id: string;
  title: string;
  clients: string;
};

const suffix = /\s*\((copia|copy)(\s+\d+)?\)\s*$/i;
const args = new Set(process.argv.slice(2));
const modes = ['--dry-run', '--aplicar', '--revertir'];
const selected = modes.filter(mode => args.has(mode));

function usage() {
  console.error('Uso: node dist/scripts/limpiar-copias-rutinas.js [--dry-run|--aplicar|--revertir]');
}

function cleanTitle(title: string) {
  const cleaned = title.replace(suffix, '').trim();
  return suffix.test(title) && cleaned.length >= 2 ? cleaned : null;
}

async function routines(sql: postgres.Sql) {
  return sql<RoutineRow[]>`
    SELECT r.id::text, r.owner_id::text, r.title,
      COALESCE(string_agg(DISTINCT c.full_name, ', ' ORDER BY c.full_name)
        FILTER (WHERE ra.active), 'Sin asignar') AS clients
    FROM routines r
    LEFT JOIN routine_assignments ra ON ra.routine_id = r.id
    LEFT JOIN clients c ON c.id = ra.client_id
    GROUP BY r.id
    ORDER BY r.title, r.id
  `;
}

function duplicateReport(rows: RoutineRow[]) {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const title = cleanTitle(row.title) || row.title.trim();
    const key = `${row.owner_id}\0${title.toLocaleLowerCase()}`;
    const ids = groups.get(key) || [];
    ids.push(row.id);
    groups.set(key, ids);
  }
  const duplicates = [...groups.entries()].filter(([, ids]) => ids.length > 1);
  console.log(`Títulos que coincidirían con otra rutina del mismo dueño: ${duplicates.length} grupo(s) / ${duplicates.reduce((n, [, ids]) => n + ids.length, 0)} rutina(s)`);
  for (const [key, ids] of duplicates) console.log(`  ${key.split('\0')[1]} · ${ids.join(', ')}`);
}

function printCandidates(rows: RoutineRow[]) {
  const candidates = rows.filter(row => suffix.test(row.title));
  let skipped = 0;
  for (const row of candidates) {
    const cleaned = cleanTitle(row.title);
    if (!cleaned) {
      skipped += 1;
      console.log(`OMITIDA · ${row.id} · ${row.clients} · "${row.title}" · el título limpio quedaría vacío o con menos de 2 caracteres`);
      continue;
    }
    console.log(`${row.id} · ${row.clients} · "${row.title}" → "${cleaned}"`);
  }
  console.log(`Rutinas con sufijo: ${candidates.length} · cambiarían: ${candidates.length - skipped} · omitidas: ${skipped}`);
  duplicateReport(rows);
  return candidates.filter(row => cleanTitle(row.title));
}

async function main() {
  if (selected.length > 1 || [...args].some(arg => !modes.includes(arg))) {
    usage(); process.exitCode = 2; return;
  }
  const mode = selected[0] || '--dry-run';
  const sql = postgres(config.DATABASE_URL, { max: 1, connection: { TimeZone: 'America/Panama' } });
  try {
    if (mode === '--revertir') {
      const saved = await sql<{ id: string; old_title: string }[]>`
        SELECT rtc.routine_id::text AS id, rtc.old_title
        FROM routine_title_cleanups rtc JOIN routines r ON r.id = rtc.routine_id
        ORDER BY rtc.cleaned_at, rtc.routine_id
      `;
      if (!saved.length) { console.log('No hay títulos limpiados para revertir.'); return; }
      let restauradas = 0; let respetadas = 0;
      await sql.begin(async transaction => {
        for (const row of saved) {
          // Solo se restaura si el título sigue siendo el que dejó la limpieza: si alguien la renombró después, ese título nuevo se respeta.
          const esperado = cleanTitle(row.old_title);
          const actualizadas = esperado ? await transaction`UPDATE routines SET title = ${row.old_title}, updated_at = now() WHERE id = ${row.id}::uuid AND title = ${esperado} RETURNING id` : [];
          if (actualizadas.length) restauradas += 1; else { respetadas += 1; console.log(`RESPETADA · ${row.id} · el título ya no es el de la limpieza; no se toca`); }
          await transaction`DELETE FROM routine_title_cleanups WHERE routine_id = ${row.id}::uuid`;
        }
      });
      console.log(`REVERSIÓN · ${restauradas} rutina(s) restauradas · ${respetadas} respetadas porque su título cambió después`);
      return;
    }

    const rows = await routines(sql);
    const candidates = printCandidates(rows);
    if (mode === '--dry-run') {
      console.log('DRY-RUN · no se escribió en PostgreSQL.');
      return;
    }
    await sql.begin(async transaction => {
      for (const row of candidates) {
        const cleaned = cleanTitle(row.title);
        if (!cleaned) continue;
        const saved = await transaction`
          INSERT INTO routine_title_cleanups (routine_id, old_title)
          VALUES (${row.id}::uuid, ${row.title})
          ON CONFLICT (routine_id) DO NOTHING
          RETURNING routine_id
        `;
        if (!saved.length) continue;
        const cambiadas = await transaction`UPDATE routines SET title = ${cleaned}, updated_at = now() WHERE id = ${row.id}::uuid AND title = ${row.title} RETURNING id`;
        // Si el título cambió entre la lectura y la escritura no se limpia, y no debe quedar un registro que luego "restaure" algo que nunca se limpió.
        if (!cambiadas.length) await transaction`DELETE FROM routine_title_cleanups WHERE routine_id = ${row.id}::uuid`;
      }
    });
    console.log(`APLICAR · ${candidates.length} rutina(s) procesadas; la operación es idempotente.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error(`Limpieza detenida: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
