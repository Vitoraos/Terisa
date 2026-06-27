import { prisma } from '../lib/prisma.js'

/**
 * Ledger routes plugin.
 *
 * GET /ledger/balance   — Current balance in micro-USDC and USDC
 * GET /ledger/history   — Paginated transaction history
 *
 * All routes require JWT authentication.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function ledgerRoutes(fastify, options) {
  // GET /ledger/balance
  fastify.get('/ledger/balance', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user

    let ledger
    try {
      ledger = await prisma.ledger.findUnique({
        where: { userId }
      })
    } catch (err) {
      console.error('[GET /ledger/balance] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch balance' })
    }

    // New user or user without a ledger yet
    if (!ledger) {
      return reply.code(200).send({
        balanceMicroUsdc: '0',
        balanceUsdc: '0.000000'
      })
    }

    // Convert BigInt balance to USDC string with 6 decimal places
    // WARNING: For very large balances (above ~9 quadrillion micro-USDC),
    // Number() loses integer precision. For MVP this is acceptable.
    // In production, use a BigInt-safe decimal library (e.g., decimal.js-light).
    const balanceNum = Number(ledger.balance)
    const balanceUsdc = (balanceNum / 1_000_000).toFixed(6)

    return reply.code(200).send({
      balanceMicroUsdc: ledger.balance.toString(),
      balanceUsdc
    })
  })

  // GET /ledger/history
  fastify.get('/ledger/history', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user

    // Parse and validate pagination params
    const rawPage = request.query?.page
    const rawLimit = request.query?.limit

    let page = 1
    let limit = 20

    if (rawPage !== undefined) {
      const parsed = parseInt(rawPage, 10)
      if (!Number.isNaN(parsed)) {
        page = Math.max(1, parsed)
      }
    }

    if (rawLimit !== undefined) {
      const parsed = parseInt(rawLimit, 10)
      if (!Number.isNaN(parsed)) {
        limit = Math.max(1, Math.min(100, parsed))
      }
    }

    const skip = (page - 1) * limit

    let entries
    let total
    try {
      entries = await prisma.ledgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      })

      total = await prisma.ledgerEntry.count({
        where: { userId }
      })
    } catch (err) {
      console.error('[GET /ledger/history] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch ledger history' })
    }

    // Map entries: serialize BigInt amount to string, never return raw Prisma objects
    const mappedEntries = entries.map((entry) => ({
      id: entry.id,
      amount: entry.amount.toString(),
      type: entry.type,
      referenceId: entry.referenceId,
      chain: entry.chain,
      createdAt: entry.createdAt
    }))

    return reply.code(200).send({
      entries: mappedEntries,
      page,
      limit,
      total
    })
  })
}
