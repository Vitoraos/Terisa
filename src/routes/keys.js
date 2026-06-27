import { randomBytes, createHash } from 'crypto'
import { prisma } from '../lib/prisma.js'

const ALLOWED_SCOPES = new Set([
  'gateway:call',
  'agent:discover',
  'ledger:read',
  'keys:manage'
])

/**
 * API key management routes plugin.
 *
 * GET  /keys        — List all non-revoked API keys
 * POST /keys        — Create a new API key
 * DELETE /keys/:id  — Revoke an API key
 *
 * All routes require JWT authentication.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function keyRoutes(fastify, options) {
  // GET /keys — List all non-revoked keys for the authenticated user
  fastify.get('/keys', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user

    let keys
    try {
      keys = await prisma.apiKey.findMany({
        where: {
          userId,
          revokedAt: null
        },
        select: {
          id: true,
          label: true,
          scopes: true,
          createdAt: true
          // NEVER select keyHash
        },
        orderBy: { createdAt: 'desc' }
      })
    } catch (err) {
      console.error('[GET /keys] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch API keys' })
    }

    return reply.code(200).send({ keys })
  })

  // POST /keys — Create a new API key
  fastify.post('/keys', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { label, scopes } = request.body ?? {}

    const resolvedLabel = typeof label === 'string' && label.trim().length > 0
      ? label.trim()
      : 'My Key'

    // Resolve scopes with defaults
    const resolvedScopes = Array.isArray(scopes) && scopes.length > 0
      ? scopes
      : ['gateway:call', 'agent:discover', 'ledger:read']

    // Validate each scope is a string and in the allowed set
    for (const scope of resolvedScopes) {
      if (typeof scope !== 'string') {
        return reply.code(400).send({
          error: 'Invalid scope',
          detail: 'All scopes must be strings'
        })
      }
      if (!ALLOWED_SCOPES.has(scope)) {
        return reply.code(400).send({
          error: 'Invalid scope',
          detail: `Scope '${scope}' is not allowed`,
          allowedScopes: Array.from(ALLOWED_SCOPES)
        })
      }
    }

    // Generate raw key: sk_live_ + 64 hex chars (32 random bytes)
    let rawKey
    try {
      rawKey = `sk_live_${randomBytes(32).toString('hex')}`
    } catch (err) {
      console.error('[POST /keys] Failed to generate random key:', err.message)
      return reply.code(500).send({ error: 'Failed to generate API key' })
    }

    // Hash the raw key for storage
    let keyHash
    try {
      keyHash = createHash('sha256').update(rawKey).digest('hex')
    } catch (err) {
      console.error('[POST /keys] Failed to hash key:', err.message)
      return reply.code(500).send({ error: 'Failed to generate API key' })
    }

    // Create the key record
    let apiKey
    try {
      apiKey = await prisma.apiKey.create({
        data: {
          userId,
          keyHash,
          label: resolvedLabel,
          scopes: resolvedScopes
        },
        select: {
          id: true,
          label: true,
          scopes: true,
          createdAt: true
        }
      })
    } catch (err) {
      console.error('[POST /keys] Database insert failed:', err.message)
      return reply.code(500).send({ error: 'Failed to create API key' })
    }

    // CRITICAL: raw key is returned ONCE here and never stored or returned again
    return reply.code(201).send({
      id: apiKey.id,
      key: rawKey,
      label: apiKey.label,
      scopes: apiKey.scopes,
      createdAt: apiKey.createdAt
    })
  })

  // DELETE /keys/:id — Revoke an API key (soft delete)
  fastify.delete('/keys/:id', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { id } = request.params

    if (!id || typeof id !== 'string') {
      return reply.code(400).send({ error: 'Key ID is required' })
    }

    let result
    try {
      result = await prisma.apiKey.updateMany({
        where: {
          id,
          userId,
          revokedAt: null
        },
        data: {
          revokedAt: new Date()
        }
      })
    } catch (err) {
      console.error('[DELETE /keys/:id] Database update failed:', err.message)
      return reply.code(500).send({ error: 'Failed to revoke API key' })
    }

    // If 0 rows updated, the key either doesn't exist or belongs to another user
    if (result.count === 0) {
      return reply.code(404).send({ error: 'Key not found' })
    }

    return reply.code(204).send()
  })
}
