-- Regla de Eileen: negocio = gastos operativos; todo lo demás, personal.
--
-- Los operativos del negocio son los del vehículo: "automovil expense" y
-- "Volkswagen". Venían de Zoho sin clasificar (ámbito NULL), así que no entraban
-- en el margen y lo dejaban en "—". Se fijan en 'negocio'. Y todo lo que no sea
-- operativo pasa a 'personal': no queda estado "sin clasificar", que es
-- justamente lo que confundía el margen.
UPDATE expense_categories
SET ambito = 'negocio'
WHERE lower(btrim(name)) IN ('automovil expense', 'volkswagen');

UPDATE expense_categories
SET ambito = 'personal'
WHERE ambito IS DISTINCT FROM 'negocio';
