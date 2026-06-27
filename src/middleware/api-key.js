import { createHash } from 'crypto'
import { prisma } from '../lib/prisma.js'

/**
 * Fastify preHandler middleware for API key consumers (gateway calls).
 *
 * Reads the Authorization header, hashes the raw API key,
 * looks it up in the database, and attaches consumer context
 * to the request object.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {Promise<void>}
 */
export async function authenticateApiKey(request, reply) {
  const authHeader = request.headers.authorization

  // Missing or malformed header
  if (!authHeader || typeof authHeader !== 'string') {
    return reply.code(401).send({
      error: 'API key required. Format: Bearer sk_live_...'
    })
  }

  if (!authHeader.startsWith('Bearer sk_')) {
    return reply.code(401).send({
      error: 'API key required. Format: Bearer sk_live_...'
    })
  }

  const rawKey = authHeader.slice('Bearer '.length)

  if (!rawKey || rawKey.length === 0) {
    return reply.code(401).send({
      error: 'API key required. Format: Bearer sk_live_...'
    })
  }

  // Hash the raw key for database lookup
  let keyHash
  try {
    keyHash = createHash('sha256').update(rawKey).digest('hex')
  } catch (err) {
    console.error('[authenticateApiKey] Failed to hash API key:', err.message)
    return reply.code(500).send({ error: 'Internal server error' })
  }

  // Lookup key in database
  let apiKey
  try {
    apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        user: {
          include: {
            ledger: true
          }
        }
      }
    })
  } catch (err) {
    console.error('[authenticateApiKey] Database lookup failed:', err.message)
    return reply.code(500).send({ error: 'Internal server error' })
  }

  // Key not found
  if (!apiKey) {
    return reply.code(401).send({ error: 'Invalid API key' })
  }

  // Key has been revoked
  if (apiKey.revokedAt !== null) {
    return reply.code(401).send({ error: 'API key has been revoked' })
  }

  // Attach consumer context to request
  request.userId = apiKey.userId
  request.apiKeyScopes = apiKey.scopes
  request.userLedger = apiKey.user.ledger ?? null
}
