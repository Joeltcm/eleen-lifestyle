-- Etapa 1B-4: carga inicial (cargador con vista previa).
--
-- Dos tablas técnicas para que la carga sea revisable, aprobable y reversible:
--   * billing_import_batches: un lote = una vista previa (con su hash), su aprobación,
--     su aplicación y, si hace falta, su reversión.
--   * billing_import_items: una fila por entrada de la lista aprobada (incluida, excluida,
--     por revisar o ya aplicada), con sus identificadores de origen y de destino.
-- Además reemplaza billing_forbid_delete() para permitir UNA sola vía de borrado: la
-- reversión de un lote que aún no tuvo cambios (variable de sesión local a la transacción
-- `billing.allow_import_reverse`). Todo lo demás sigue sin poder borrarse.
-- Esta migración no modifica ni lee las tablas del sistema anterior.
-- Reversa: backend/migrations-down/053_billing_import.down.sql.

CREATE TABLE IF NOT EXISTS billing_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'approved', 'applied', 'reversed', 'failed', 'superseded')),
  source_system text NOT NULL DEFAULT 'legacy_import',
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL,
  preview_hash text NOT NULL,
  source_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  counter_before integer NOT NULL CHECK (counter_before >= 0),
  counter_after integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  applied_at timestamptz,
  applied_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reversal_reason text,
  failure_reason text
);
CREATE INDEX IF NOT EXISTS billing_import_batches_owner_idx ON billing_import_batches (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_import_items (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES billing_import_batches(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invoice', 'exclusion')),
  decision text NOT NULL CHECK (decision IN ('incluir', 'excluir', 'revisar', 'ya_aplicado')),
  key text NOT NULL,
  label text NOT NULL,
  external_id text,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  destination_invoice_id uuid,
  destination_payment_id uuid,
  UNIQUE (batch_id, seq)
);

-- Igual que en la 051, salvo que se permite borrar cuando la transacción activó
-- explícitamente la reversión de un lote (SET LOCAL billing.allow_import_reverse = 'on').
CREATE OR REPLACE FUNCTION billing_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('billing.allow_import_reverse', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Una factura emitida no se borra: se anula con motivo (%)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
