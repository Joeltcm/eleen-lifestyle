-- Qué ejercicios llevan peso.
--
-- Hasta ahora una rutina decía series y repeticiones pero no con cuánto peso,
-- así que la carga vivía en la cabeza de la entrenadora o en un cuaderno.
--
-- No todos lo llevan: una plancha, una caminadora o un ejercicio con banda
-- elástica no tienen kilos que anotar, y pedirlos en todos ensuciaría la rutina
-- con campos vacíos. Los campos de máquina y peso libre del catálogo son texto
-- libre ("No aplica", "Peso corporal", "Barra / Mancuernas"), así que se hace
-- una primera clasificación con ellos y se deja editable: la entrenadora
-- corrige lo que la heurística falle, que es más honesto que fingir que un
-- patrón de texto sabe de entrenamiento.
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS uses_weight boolean NOT NULL DEFAULT false;

UPDATE exercises SET uses_weight = true
WHERE
  -- Implementos con carga declarada.
  free_weight ~* '(barra|mancuern|disco|kettlebell|pesa rusa|chaleco|placa)'
  -- O una máquina que no sea de cardio puro.
  OR (
    machine IS NOT NULL
    AND machine !~* '^no aplica'
    AND machine !~* '(caminadora|bicicleta|el[íi]ptica|escaladora|pista|remo ergom|cuerda|salto)'
  );

CREATE INDEX IF NOT EXISTS exercises_con_peso_idx ON exercises(owner_id) WHERE uses_weight;
