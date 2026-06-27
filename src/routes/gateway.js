import { proxyRequest } from '../lib/proxy.js'
import { prisma } from '../lib/prisma.js'

/**
 * Gateway proxy routes — the core revenue-generating endpoint.
 *
 * Consumers call this with their API key. The gateway deducts micro-USDC
 * from their balance, proxies to the provider, and credits the provider
 * on success. On any failure after debit, the consumer is refunded.
 *
 * POST /gateway/:routeId
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function gatewayRoutes(fastify, options) {

  fastify.post('/gateway/:routeId', {
    onRequest: [fastify.authenticateApiKey]
  }, async (request, reply) => {
    const { routeId } = request.params

    // ── Validate routeId ──
    if (!routeId || typeof routeId !== 'string' || routeId.trim().length === 0) {
      return reply.code(400).send({ error: 'Route ID is required' })
    }

    // ── Fetch route (must be active and public) ──
    let route
    try {
      route = await prisma.providerRoute.findUnique({
        where: {
          id: routeId,
          isActive: true,
          isPublic: true
        }
      })
    } catch (err) {
      console.error('[POST /gateway/:routeId] Database lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch route' })
    }

    if (!route) {
      return reply.code(404).send({ error: 'Route not found or unavailable' })
    }

    // ── Verify API key scope ──
    const scopes = request.apiKeyScopes ?? []
    if (!scopes.includes('gateway:call')) {
      return reply.code(403).send({
        error: 'This API key does not have gateway:call scope'
      })
    }

    // ── Proxy the request to the provider ──
    let result
    try {
      result = await proxyRequest({
        userId: request.userId,
        route,
        body: request.body ?? {}
      })
    } catch (err) {
      // proxyRequest should not throw under normal circumstances,
      // but database deadlocks or unexpected errors can propagate.
      console.error('[POST /gateway/:routeId] proxyRequest threw:', err.message)
      return reply.code(500).send({
        error: 'Internal server error',
        routeId
      })
    }

    // ── Success ──
    if (result.success) {
      return reply.code(200).send(result.data)
    }

    // ── Insufficient balance (402) ──
    if (result.statusCode === 402) {
      return reply.code(402).send({
        error: result.error,
        refunded: false
      })
    }

    // ── All other failures (timeout, unreachable, upstream error) ──
    // Do NOT expose internal referenceId to consumers
    return reply.code(result.statusCode).send({
      error: result.error,
      refunded: result.refunded,
      routeId
    })
  })
}
