import jwt from 'jsonwebtoken'
import { config } from '../config.js'

/**
 * Fastify preHandler middleware for authenticated dashboard users (JWT).
 *
 * Reads the Authorization header, verifies the Bearer JWT token,
 * and attaches the decoded user payload to `request.user`.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {Promise<void>}
 */
export async function authenticate(request, reply) {
  const authHeader = request.headers.authorization

  // Missing or malformed header
  if (!authHeader || typeof authHeader !== 'string') {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' })
  }

  if (!authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' })
  }

  const token = authHeader.slice('Bearer '.length)

  if (!token || token.length === 0) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' })
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET)

    // Defensive: verify the payload shape we expect
    if (!payload || typeof payload !== 'object') {
      return reply.code(401).send({ error: 'Invalid or expired token' })
    }
    if (!payload.userId || typeof payload.userId !== 'string') {
      return reply.code(401).send({ error: 'Invalid or expired token' })
    }

    request.user = {
      userId: payload.userId,
      walletAddress: payload.walletAddress ?? null
    }
  } catch (err) {
    // Distinguish token errors from system errors
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return reply.code(401).send({ error: 'Invalid or expired token' })
    }

    // Any other error from jwt.verify (e.g., crypto failure, malformed secret)
    console.error('[authenticate] JWT verification failed:', err.message)
    return reply.code(500).send({ error: 'Auth verification failed' })
  }
}
