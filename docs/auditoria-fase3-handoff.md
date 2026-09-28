# Handoff — cobertura adicional de facturación

Rama: **`test/auditoria-cobertura-fase3`**

Esta rama parte de `main` en `4092bc6`. No modifica la lógica de producción ni
`main`; añade únicamente cobertura de integración en
`backend/test/api.test.mjs` y este documento para revisión de Claude.

## Qué se cubre

- Alta completa: cliente nuevo → asignación de plan → saldo → sesión → débito.
- Cliente con mensualidad `anticipado` pendiente: el worker abre el saldo activo
  y el cliente puede entrenar; la restricción de abrir saldo manualmente sigue
  vigente.
- Cobertura familiar: el cobro queda ligado al expediente del pagador y del
  dependiente, pero el débito pertenece a quien entrenó.
- Renovación explícita de `anticipado` y `no_anticipado`, incluyendo el origen
  esperado del saldo.
- Cancelación del cliente sin reprogramar en ambas modalidades: descuenta el
  saldo contratado.
- Reconciliación de una clase ya marcada antes de que existiera el saldo, en
  ambas modalidades.

## Criterio de revisión

Claude debe verificar que los casos nuevos no alteran la lógica productiva,
que son reproducibles sobre una base limpia y que los asserts distinguen:

1. saldo activo para entrenar;
2. origen del cobro en anticipado frente a saldo nuevo sin cobro en no
   anticipado;
3. titular del débito frente al titular del pago;
4. consumo por cancelación y reconciliación.

## Verificación local

```sh
cd backend
npm run check
npm run build
PGHOST=localhost PGUSER=<user> PGPASSWORD= PGPORT=5432 npm test
```

La suite completa debe conservar las pruebas existentes y sumar los casos de
esta rama. Esta rama no debe mergearse hasta la revisión de Claude.
