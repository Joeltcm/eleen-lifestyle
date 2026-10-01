const TIME_ZONE = 'America/Panama';

function datePartsInPanama(value: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(value)
      .filter(part => ['year', 'month', 'day'].includes(part.type))
      .map(part => [part.type, part.value])
  );
}

/** Fecha calendario del negocio, evaluada en el momento de la llamada. */
export function fechaDeNegocioPanama(value = new Date()): string {
  const { year, month, day } = datePartsInPanama(value);
  return `${year}-${month}-${day}`;
}

/** Fecha de negocio desplazada por días calendario, sin depender de UTC. */
export function fechaPanamaDiasAtras(days: number, value = new Date()): string {
  const [year, month, day] = fechaDeNegocioPanama(value).split('-').map(Number);
  const calendario = new Date(Date.UTC(year, month - 1, day, 12));
  calendario.setUTCDate(calendario.getUTCDate() - days);
  return fechaDeNegocioPanama(calendario);
}

/** Hora del día (0-23) en Panamá, evaluada en el momento de la llamada. */
export function horaDeNegocioPanama(value = new Date()): number {
  const hora = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hour12: false }).format(value);
  return Number(hora) % 24;
}
