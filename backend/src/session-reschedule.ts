/**
 * A schedule change is a reprogramming when the start instant changes.
 * Keeping this predicate shared prevents the application PATCH and the Google
 * Calendar pull from disagreeing about a move made only by changing the hour.
 */
import type { TransactionSql } from 'postgres';

export function scheduleWasMoved(previousStartsAt: Date | string, nextStartsAt: Date | string): boolean {
  return new Date(previousStartsAt).getTime() !== new Date(nextStartsAt).getTime();
}

type MoveOptions = {
  startsAt: Date | string;
  durationMinutes: number;
  mode?: string;
  notes?: string | null;
  clientId?: string;
};

// La operación que convierte una sesión ya cobrada en reprogramada vive aquí
// para que PATCH y Google hagan exactamente lo mismo. El lock interno hace que
// dos pulls simultáneos puedan registrar el movimiento, pero sólo uno revierta
// el débito del saldo.
export async function moveSessionInTransaction(transaction: TransactionSql, sessionId: string, options: MoveOptions) {
  const [actual] = await transaction`
    SELECT * FROM sessions WHERE id = ${sessionId} FOR UPDATE
  `;
  if (!actual || actual.status === 'cancelled') return null;
  const moved = scheduleWasMoved(actual.starts_at, options.startsAt);
  if (!moved) {
    const [updated] = await transaction`
      UPDATE sessions SET duration_minutes = ${options.durationMinutes},
        mode = COALESCE(${options.mode ?? null}, mode),
        notes = CASE WHEN ${options.notes === undefined} THEN notes ELSE ${options.notes ?? null} END,
        client_id = COALESCE(${options.clientId ?? null}, client_id),
        updated_at = now()
      WHERE id = ${sessionId}
      RETURNING *
    `;
    return { session: updated, moved: false, debitReverted: false };
  }

  let debitReverted = false;
  if (actual.status === 'completed' && actual.package_debited && actual.package_id) {
    await transaction`
      UPDATE session_packages
      SET used_sessions = GREATEST(0, used_sessions - 1),
          status = CASE WHEN GREATEST(0, used_sessions - 1) >= total_sessions THEN 'exhausted' ELSE 'active' END
      WHERE id = ${actual.package_id}
    `;
    debitReverted = true;
  }
  const [updated] = await transaction`
    UPDATE sessions SET starts_at = ${options.startsAt}, duration_minutes = ${options.durationMinutes},
      mode = COALESCE(${options.mode ?? null}, mode),
      notes = CASE WHEN ${options.notes === undefined} THEN notes ELSE ${options.notes ?? null} END,
      client_id = COALESCE(${options.clientId ?? null}, client_id),
      package_id = CASE WHEN ${debitReverted} THEN NULL ELSE package_id END,
      package_debited = CASE WHEN ${debitReverted} THEN false ELSE package_debited END,
      debited_group_id = CASE WHEN ${debitReverted} THEN NULL ELSE debited_group_id END,
      updated_at = now()
    WHERE id = ${sessionId}
    RETURNING *
  `;
  await transaction`
    INSERT INTO session_reschedules (session_id, client_id, from_starts_at, to_starts_at, origin)
    VALUES (${sessionId}, ${actual.client_id}, ${actual.starts_at}, ${updated.starts_at}, 'moved')
  `;
  return { session: updated, moved: true, debitReverted };
}
