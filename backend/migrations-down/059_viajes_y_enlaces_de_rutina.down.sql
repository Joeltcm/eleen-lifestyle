-- Reversa de 059_viajes_y_enlaces_de_rutina.sql.
-- Borra los viajes registrados y los enlaces emitidos, por eso exige una orden explícita.
-- Las rutinas cumplidas desde un enlace se conservan (solo pierden la marca via_link).
BEGIN;
DO $$
BEGIN
  IF ((to_regclass('client_travel') IS NOT NULL AND EXISTS (SELECT 1 FROM client_travel))
      OR (to_regclass('routine_share_links') IS NOT NULL AND EXISTS (SELECT 1 FROM routine_share_links)))
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay viajes o enlaces de rutina guardados: respalde y active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
DROP TABLE IF EXISTS routine_share_links;
-- CASCADE: si la 060 sigue aplicada, sessions.cancelled_travel_id depende de esta tabla; se suelta solo la restricción (la 060 quita la columna).
DROP TABLE IF EXISTS client_travel CASCADE;
ALTER TABLE routine_completions DROP COLUMN IF EXISTS via_link;
DELETE FROM schema_migrations WHERE name = '059_viajes_y_enlaces_de_rutina.sql';
COMMIT;
