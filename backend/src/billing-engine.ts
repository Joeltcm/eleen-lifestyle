// Estado operativo de la facturación (etapa 1B-0).
//
// Hay dos generadores de facturas: el viejo (generateRecurringInvoices, que
// escribe en `invoices`) y el nuevo (todavía no existe; escribirá en las tablas
// billing_*). Nunca pueden escribir a la vez, o el mismo cobro se emitiría dos
// veces. Este módulo decide, a partir de dos variables de entorno, qué está
// permitido y deja el resultado a la vista para que se pueda auditar.
//
//   LEGACY_BILLING_GENERATION  on | off          (por defecto on)
//   NEW_BILLING_GENERATION     off | shadow | on (por defecto off)
//
//   legacy on  + new off     -> legacy       el viejo escribe (situación actual)
//   legacy on  + new shadow  -> shadow       el viejo escribe, el nuevo solo calcula
//   legacy off + new off     -> maintenance  ninguno escribe (respaldo, carga, conciliación)
//   legacy off + new shadow  -> maintenance  ninguno escribe; el nuevo calcula
//   legacy off + new on      -> new          el nuevo escribe, el viejo no
//   legacy on  + new on      -> CONFLICTO: se dejan los dos apagados (maintenance)
//
// Ante un conflicto no se tumba el servicio (sería peor que no facturar un rato):
// se apagan ambos, se registra el error y el diagnóstico lo marca.

export type LegacyGeneration = 'on' | 'off';
export type NewGeneration = 'off' | 'shadow' | 'on';
export type BillingEngineState = 'legacy' | 'shadow' | 'maintenance' | 'new';

export interface BillingEngine {
  state: BillingEngineState;
  legacyGeneration: LegacyGeneration;
  newGeneration: NewGeneration;
  legacyWrites: boolean;
  newWrites: boolean;
  newComputes: boolean;
  conflict: boolean;
  message: string;
}

export function resolveBillingEngine(input: { legacy?: string; next?: string } = {}): BillingEngine {
  const legacy: LegacyGeneration = input.legacy === 'off' ? 'off' : 'on';
  const next: NewGeneration = input.next === 'shadow' || input.next === 'on' ? input.next : 'off';

  if (legacy === 'on' && next === 'on') {
    return {
      state: 'maintenance', legacyGeneration: legacy, newGeneration: next,
      legacyWrites: false, newWrites: false, newComputes: false, conflict: true,
      message: 'Configuración inválida: los dos generadores estaban activos. Se dejaron ambos apagados.'
    };
  }
  if (legacy === 'on') {
    const shadow = next === 'shadow';
    return {
      state: shadow ? 'shadow' : 'legacy', legacyGeneration: legacy, newGeneration: next,
      legacyWrites: true, newWrites: false, newComputes: shadow, conflict: false,
      message: shadow ? 'Generador viejo activo; el nuevo solo calcula.' : 'Generador viejo activo; el nuevo está apagado.'
    };
  }
  if (next === 'on') {
    return {
      state: 'new', legacyGeneration: legacy, newGeneration: next,
      legacyWrites: false, newWrites: true, newComputes: true, conflict: false,
      message: 'Generador nuevo activo; el viejo está apagado.'
    };
  }
  return {
    state: 'maintenance', legacyGeneration: legacy, newGeneration: next,
    legacyWrites: false, newWrites: false, newComputes: next === 'shadow', conflict: false,
    message: 'Mantenimiento: ningún generador escribe.'
  };
}
