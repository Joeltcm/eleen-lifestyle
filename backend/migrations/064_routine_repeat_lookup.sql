-- La advertencia de envíos repetidos consulta por cliente y fecha, excluyendo
-- traslados automáticos a una nueva versión (que no son una decisión de Eileen).
CREATE INDEX IF NOT EXISTS routine_deliveries_repeat_lookup_idx
  ON routine_deliveries(client_id, sent_at DESC)
  WHERE kind <> 'new_version';
