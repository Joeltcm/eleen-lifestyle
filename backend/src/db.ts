import postgres from 'postgres';
import { config } from './config.js';

export const sql = postgres(config.DATABASE_URL, {
  ssl: config.NODE_ENV === 'production' ? 'require' : undefined,
  max: 10,
  idle_timeout: 20,
  // Toda la aritmética de fechas del negocio es en horario de Panamá
  // (mediodiaEnPanama, diaEnPanama, AT TIME ZONE 'America/Panama'). Fijar el
  // TimeZone de CADA conexión del pool a Panamá alinea current_date/now() con
  // esa lógica: sin esto, current_date sale en la zona del servidor (UTC en
  // Railway) y cerca de medianoche cae en un día distinto al que ve la app.
  connection: { TimeZone: 'America/Panama' }
});

