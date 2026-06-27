import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const schema = z.object({
  // Database (Supabase)
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  DIRECT_URL: z.string().url('DIRECT_URL must be a valid URL'),

  // Redis (Upstash)
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Auth (Privy)
  PRIVY_APP_ID: z.string().min(1, 'PRIVY_APP_ID is required'),
  PRIVY_APP_SECRET: z.string().min(1, 'PRIVY_APP_SECRET is required'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  // Blockchain listeners
  HELIUS_API_KEY: z.string().min(1, 'HELIUS_API_KEY is required'),
  HELIUS_WEBHOOK_SECRET: z.string().min(1, 'HELIUS_WEBHOOK_SECRET is required'),
  ALCHEMY_API_KEY: z.string().min(1, 'ALCHEMY_API_KEY is required'),
  ALCHEMY_WEBHOOK_SECRET: z.string().min(1, 'ALCHEMY_WEBHOOK_SECRET is required'),

  // Treasury wallets (receive deposits — private keys stored offline, never here)
  SOLANA_TREASURY_ADDRESS: z.string().min(1, 'SOLANA_TREASURY_ADDRESS is required'),
  BASE_TREASURY_ADDRESS: z.string().min(1, 'BASE_TREASURY_ADDRESS is required'),

  // On-ramp (HoneyCoin = Africa mobile money)
  HONEYCOIN_API_KEY: z.string().min(1, 'HONEYCOIN_API_KEY is required'),
  HONEYCOIN_WEBHOOK_SECRET: z.string().min(1, 'HONEYCOIN_WEBHOOK_SECRET is required'),

  // Platform config
  PLATFORM_FEE_BPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(1500),
  GATEWAY_BASE_URL: z.string().url('GATEWAY_BASE_URL must be a valid URL'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // Observability
  SENTRY_DSN: z.string().url().optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const errors = parsed.error.flatten().fieldErrors
  const missing = Object.entries(errors)
    .map(([key, messages]) => `  ${key}: ${messages.join(', ')}`)
    .join('\n')

  console.error('❌ Invalid or missing environment variables:\n')
  console.error(missing)
  console.error('\nCheck your .env file against .env.example')
  process.exit(1)
}

export const config = parsed.data
