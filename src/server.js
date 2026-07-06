import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import * as Sentry from '@sentry/node'
import { config } from './config.js'
import { redis } from './lib/redis.js'
import { authenticate } from './middleware/auth.js'
import { authenticateApiKey } from './middleware/api-key.js'

// Route imports
import { authRoutes } from './routes/auth.js'
import { keyRoutes } from './routes/keys.js'
import { ledgerRoutes } from './routes/ledger.js'
import { webhookRoutes } from './routes/webhooks.js'
import { providerRoutes } from './routes/provider.js'
import { gatewayRoutes } from './routes/gateway.js'
import { marketplaceRoutes } from './routes/marketplace.js'
import { reviewRoutes } from './routes/reviews.js'
import { supportRoutes } from './routes/support.js'
import { supportTicketRoutes } from './routes/support-tickets.js'

// Job imports
import { startHealthMonitor } from './jobs/health-monitor.js'
import { startSuspensionCheck } from './jobs/suspension-check.js'
import { startCallAnchorWorker } from './jobs/anchorWorker.js'

// ─── 1. Initialize Sentry (before anything else) ─────────────────────────────
if (config.SENTRY_DSN) {
  try {
    Sentry.init({
      dsn: config.SENTRY_DSN,
      environment: config.NODE_ENV,
      tracesSampleRate: config.NODE_ENV === 'production' ? 0.1 : 1.0
    })
    console.log('[sentry] Initialized')
  } catch (err) {
    console.error('[sentry] Failed to initialize:', err.message)
  }
}

// ─── 2. Create Fastify instance ────────────────────────────────────────────
const fastify = Fastify({
  logger: config.NODE_ENV === 'production'
    ? { level: 'warn' }
    : { level: 'info', transport: { target: 'pino-pretty' } },
  trustProxy: true  // Required for rate limiting behind Render's proxy
})

// ─── 3. Register plugins in exact order ─────────────────────────────────────
await fastify.register(helmet)  // Security headers
await fastify.register(cors, { origin: true })  // MVP: allow all. Tighten in production.
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  redis,
  keyGenerator: (req) => req.headers['x-forwarded-for'] ?? req.ip
})

// ─── 4. Register middleware as decorators ────────────────────────────────────
fastify.decorate('authenticate', authenticate)
fastify.decorate('authenticateApiKey', authenticateApiKey)

// ─── 5. Global error handler ───────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  if (config.SENTRY_DSN) {
    Sentry.captureException(error)
  }

  const statusCode = error.statusCode ?? error.status ?? 500

  // Log server errors internally, but never expose stack traces or
  // internal details to clients in production.
  if (statusCode >= 500) {
    fastify.log.error(error)
    return reply.code(500).send({
      error: 'Internal server error'
    })
  }

  // Client errors: safe to expose the message
  return reply.code(statusCode).send({
    error: error.message
  })
})

// ─── 6. Health check route (before prefix registration) ─────────────────────
fastify.get('/health', async () => ({
  status: 'ok',
  ts: Date.now(),
  version: '1.0.0'
}))

// ─── 7. Register all route plugins under /v1 ────────────────────────────────
await fastify.register(authRoutes, { prefix: '/v1' })
await fastify.register(keyRoutes, { prefix: '/v1' })
await fastify.register(ledgerRoutes, { prefix: '/v1' })
await fastify.register(webhookRoutes, { prefix: '/v1' })
await fastify.register(providerRoutes, { prefix: '/v1' })
await fastify.register(gatewayRoutes, { prefix: '/v1' })
await fastify.register(marketplaceRoutes, { prefix: '/v1' })
await fastify.register(reviewRoutes, { prefix: '/v1' })
await fastify.register(supportRoutes, { prefix: '/v1' })
await fastify.register(supportTicketRoutes, { prefix: '/v1' })

// PHASE 2 AGENT ROUTES — uncomment to enable agent layer:
// import { agentRoutes } from './routes/agent/index.js'
// await fastify.register(agentRoutes, { prefix: '/v1' })

// ─── 8. 404 handler ────────────────────────────────────────────────────────
fastify.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    error: `Route ${request.method} ${request.url} not found`
  })
})

// ─── 9. Start background jobs ──────────────────────────────────────────────
try {
  await startHealthMonitor()
} catch (err) {
  console.error('[server] Health monitor failed to start:', err.message)
  // Non-fatal: server can still serve requests without health monitoring
}

try {
  await startSuspensionCheck()
} catch (err) {
  console.error('[server] Suspension check failed to start:', err.message)
  // Non-fatal: server can still serve requests without auto-suspension
}

try {
  await startCallAnchorWorker()
} catch (err) {
  console.error('[server] Solana call-anchor worker failed to start:', err.message)
  // Non-fatal: gateway calls still succeed and bill correctly even if
  // on-chain anchoring is unavailable — see anchorQueue.js/anchorWorker.js.
  // Calls will simply queue up as PENDING CallAnchorReceipt rows until
  // this worker (or a future restart) is able to drain them.
}

// ─── 10. Start server ───────────────────────────────────────────────────────
try {
  await fastify.listen({ port: config.PORT, host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

// ─── 11. Graceful shutdown ──────────────────────────────────────────────────
const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal}. Shutting down.`)

  try {
    await fastify.close()
    fastify.log.info('Server closed gracefully.')
  } catch (err) {
    fastify.log.error('Error during shutdown:', err.message)
  }

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Handle uncaught exceptions to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message)
  if (config.SENTRY_DSN) {
    Sentry.captureException(err)
  }
  shutdown('uncaughtException')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason)
  if (config.SENTRY_DSN) {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
  }
})
