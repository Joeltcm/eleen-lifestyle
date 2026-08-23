import postgres from 'postgres';
import { config } from './config.js';

export const sql = postgres(config.DATABASE_URL, {
  ssl: config.NODE_ENV === 'production' ? 'require' : undefined,
  max: 10,
  idle_timeout: 20
});

