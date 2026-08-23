import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SETUP_TOKEN: z.string().min(16),
  CORS_ORIGIN: z.string().default('http://localhost:8788'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development')
});

export const config = schema.parse(process.env);

