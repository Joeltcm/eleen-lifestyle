import type { Fragment } from 'postgres';
import { sql } from './db.js';

// Una sola definición de sesión medible para todos los informes. El alias sólo
// se usa con identificadores internos (s/c); nunca se recibe desde una petición.
export function complianceSessionCondition(sessionAlias = 's', clientAlias = 'c'): Fragment {
  if (!['s', 'session'].includes(sessionAlias) || !['c', 'client'].includes(clientAlias)) {
    throw new Error('Alias SQL no permitido para cumplimiento');
  }
  return sql.unsafe(`(
    ${sessionAlias}.starts_at <= now()
    AND NOT (
      COALESCE(${sessionAlias}.paused_hold, false)
      OR EXISTS (
        SELECT 1 FROM client_package_pauses pp
        WHERE pp.client_id = ${sessionAlias}.client_id
          AND (${sessionAlias}.starts_at AT TIME ZONE 'America/Panama')::date >= pp.starts_on
          AND (pp.resumed_on IS NULL OR (${sessionAlias}.starts_at AT TIME ZONE 'America/Panama')::date < pp.resumed_on)
      )
      OR (${sessionAlias}.status = 'scheduled' AND ${clientAlias}.status = 'paused')
    )
    AND (
      ${sessionAlias}.status IN ('completed', 'no_show')
      OR (
        ${sessionAlias}.status = 'cancelled'
        AND ${sessionAlias}.cancellation_kind = 'not_rescheduled'
        AND COALESCE(${sessionAlias}.cancelled_by, 'client') = 'client'
      )
    )
  )`);
}

export function complianceCompletionExpression(sessionAlias = 's'): Fragment {
  if (!['s', 'session'].includes(sessionAlias)) throw new Error('Alias SQL no permitido para cumplimiento');
  return sql.unsafe(`CASE WHEN ${sessionAlias}.status = 'completed' THEN COALESCE(${sessionAlias}.completion_percent, 0)::int ELSE 0 END`);
}

export type ComplianceSessionLike = {
  status: string;
  cancellation_kind?: string | null;
  cancelled_by?: string | null;
  starts_at?: Date | string;
  paused_hold?: boolean | null;
  paused?: boolean | null;
};

export function isComplianceSession(session: ComplianceSessionLike, now = new Date()): boolean {
  if (session.starts_at && new Date(session.starts_at).getTime() > now.getTime()) return false;
  if (session.paused_hold || session.paused) return false;
  if (session.status === 'completed' || session.status === 'no_show') return true;
  return session.status === 'cancelled'
    && session.cancellation_kind === 'not_rescheduled'
    && (session.cancelled_by || 'client') === 'client';
}

export function compliancePercent(rows: Array<{ completion_percent?: number | string | null; status: string }>) {
  const medibles = rows.filter(row => isComplianceSession(row));
  const puntos = medibles.reduce((sum, row) => sum + (row.status === 'completed' ? Number(row.completion_percent || 0) : 0), 0);
  return {
    medibles: medibles.length,
    completed: medibles.filter(row => row.status === 'completed').length,
    points: puntos,
    percent: medibles.length ? Math.round(puntos / medibles.length) : null
  };
}
