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
  INBODY_AI_DAILY_LIMIT: z.coerce.number().int().min(0).max(100).default(4),
  APP_URL: z.string().url().default('https://eileen-lifestyle.pages.dev'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('https://eileen-lifestyle.pages.dev/'),
  REMINDER_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  BILLING_GENERATION_DAYS_AHEAD: z.coerce.number().int().min(0).max(31).default(7),
  BILLING_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_ACCOUNTS_URL: z.string().url().default('https://accounts.zoho.com'),
  ZOHO_REDIRECT_URI: z.string().url().default('https://api-production-b417f.up.railway.app/api/integrations/zoho/callback'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default('https://api-production-b417f.up.railway.app/api/integrations/google-calendar/callback'),
  GOOGLE_CALENDAR_ID: z.string().default('primary')
});

export const config = schema.parse(process.env);
