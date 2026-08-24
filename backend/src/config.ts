import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SETUP_TOKEN: z.string().min(16),
  CORS_ORIGIN: z.string().default('http://localhost:8788'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().default('eleen-lifestyle-private'),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_VISION_MODEL: z.string().default('@cf/google/gemma-4-26b-a4b-it'),
  CLOUDFLARE_TEXT_MODEL: z.string().default('@cf/google/gemma-4-26b-a4b-it'),
  APP_URL: z.string().url().default('https://eileen-lifestyle.pages.dev'),
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_ACCOUNTS_URL: z.string().url().default('https://accounts.zoho.com'),
  ZOHO_REDIRECT_URI: z.string().url().default('https://api-production-b417f.up.railway.app/api/integrations/zoho/callback')
});

export const config = schema.parse(process.env);
