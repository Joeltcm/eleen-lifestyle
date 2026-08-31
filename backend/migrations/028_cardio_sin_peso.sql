-- El cardio no lleva peso.
--
-- La clasificación anterior miraba el nombre de la máquina, y "Remo en
-- Máquina" se coló: su máquina no coincidía con ninguno de los aparatos de
-- cardio que la lista contemplaba. Pero en cardio se mide tiempo, distancia o
-- nivel de resistencia; nunca kilos.
--
-- Es una regla por sección y no otro patrón de texto, así que no vuelve a
-- fallar por cómo se escriba el nombre del aparato.
UPDATE exercises SET uses_weight = false WHERE section = 'cardio';
