-- Negocio o personal.
--
-- Eileen lleva en la aplicación tanto las finanzas del entrenamiento como las
-- suyas propias, y el historial importado de Zoho mezcla las dos: alquiler del
-- apartamento y supermercado junto a gasolina para ir a ver clientes. Sumarlo
-- todo contra los ingresos del entrenamiento daba un "margen" que no describía
-- ningún negocio real.
--
-- Se queda en NULL a propósito para las que ya existen: clasificarlas por
-- nosotros sería adivinar. "Sin clasificar" es una respuesta honesta y la
-- interfaz invita a resolverla.
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS ambito text;

ALTER TABLE expense_categories DROP CONSTRAINT IF EXISTS expense_categories_ambito_check;
ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_ambito_check
  CHECK (ambito IS NULL OR ambito IN ('negocio', 'personal'));

CREATE INDEX IF NOT EXISTS expense_categories_ambito_idx
  ON expense_categories(owner_id, ambito);
