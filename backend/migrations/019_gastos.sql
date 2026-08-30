-- Gastos del negocio, con sus categorías.
--
-- Hasta ahora la aplicación sólo sabía de ingresos: facturas y pagos. Sin la
-- otra mitad no hay finanzas, sólo cobranza.
--
-- Las categorías se importan de Zoho junto con los gastos, y también pueden
-- crearse a mano. external_id guarda la identidad del lado de Zoho para que
-- reimportar actualice en vez de duplicar.
CREATE TABLE IF NOT EXISTS expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  source_system text,
  external_id text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_externas_idx
  ON expense_categories(owner_id, source_system, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id uuid REFERENCES expense_categories(id) ON DELETE SET NULL,
  -- Un gasto puede estar ligado a un cliente (algo comprado para alguien en
  -- concreto) o no ligarse a nadie, que es lo habitual: alquiler, equipo, luz.
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  spent_on date NOT NULL,
  payment_method text,
  reference text,
  notes text,
  -- 'zoho_invoice' para lo importado, nulo para lo cargado a mano. Permite
  -- saber qué se puede volver a importar y qué sólo vive aquí.
  source_system text,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS expenses_externos_idx
  ON expenses(owner_id, source_system, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS expenses_owner_fecha_idx ON expenses(owner_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS expenses_categoria_idx ON expenses(category_id, spent_on DESC);
