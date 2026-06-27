import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { prisma } from '../lib/prisma.js'
import { verifyAuthToken } from '../lib/auth-provider.js'

/**
 * Authentication routes plugin.
 *
 * POST /auth/privy  — Exchange Privy token for platform JWT
 * GET  /auth/me     — Get current authenticated user
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function authRoutes(fastify, options) {
  // POST /auth/privy
  fastify.post('/auth/privy', async (request, reply) => {
    const { privyToken } = request.body ?? {}

    // Validate body
    if (!privyToken || typeof privyToken !== 'string') {
      return reply.code(400).send({
        error: 'privyToken is required and must be a string'
      })
    }

    // Verify Privy token
    let identity
    try {
      identity = await verifyAuthToken(privyToken)
    } catch (err) {
      console.error('[POST /auth/privy] Privy verification failed:', err.message)
      return reply.code(401).send({ error: 'Invalid Privy token' })
    }

    // Upsert user with nested ledger creation on first sign-in
    let user
    try {
      user = await prisma.user.upsert({
        where: { authDid: identity.did },
        create: {
          authDid: identity.did,
          walletAddress: identity.walletAddress,
          email: identity.email,
          ledger: {
            create: {
              balance: 0n
            }
          }
        },
        update: {
          walletAddress: identity.walletAddress,
          email: identity.email
        },
        include: {
          ledger: true
        }
      })
    } catch (err) {
      // Handle unique constraint violations on walletAddress or email
      // (e.g., another user already claimed this wallet or email)
      if (err.code === 'P2002') {
        const field = err.meta?.target?.[0] ?? 'field'
        console.error(
          `[POST /auth/privy] Unique constraint violation on ${field}:`,
          err.message
        )
        return reply.code(409).send({
          error: `Account conflict: ${field} is already associated with another user`
        })
      }

      console.error('[POST /auth/privy] User upsert failed:', err.message)
      return reply.code(500).send({ error: 'Failed to create or update user' })
    }

    // Sign platform JWT
    let token
    try {
      token = jwt.sign(
        {
          userId: user.id,
          walletAddress: user.walletAddress
        },
        config.JWT_SECRET,
        { expiresIn: '7d' }
      )
    } catch (err) {
      console.error('[POST /auth/privy] JWT signing failed:', err.message)
      return reply.code(500).send({ error: 'Failed to generate session token' })
    }

    // Return token and user (never expose JWT secret or internal DB IDs beyond user.id)
    return reply.code(200).send({
      token,
      user: {
        id: user.id,
        email: user.email,
        walletAddress: user.walletAddress,
        balanceMicroUsdc: user.ledger?.balance?.toString() ?? '0'
      }
    })
  })

  // GET /auth/me
  fastify.get('/auth/me', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user

    let user
    try {
      user = await prisma.user.findUnique({
        where: { id: userId },
        include: { ledger: true }
      })
    } catch (err) {
      console.error('[GET /auth/me] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch user' })
    }

    if (!user) {
      return reply.code(404).send({ error: 'User not found' })
    }

    return reply.code(200).send({
      id: user.id,
      email: user.email,
      walletAddress: user.walletAddress,
      balanceMicroUsdc: user.ledger?.balance?.toString() ?? '0',
      createdAt: user.createdAt
    })
  })
}
