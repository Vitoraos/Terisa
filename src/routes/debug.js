/**
 * TEMPORARY DEBUG ROUTE — DELETE THIS FILE AFTER TESTING.
 *
 * Exists only to set a test user's Ledger balance from Termux (where
 * Prisma's query engine has no working binary for Android/aarch64,
 * so scripts and Prisma Studio both fail locally). This route runs on
 * Render's real Linux servers, where Prisma works normally — it's
 * triggered remotely via a single curl command instead.
 *
 * Protected by a shared secret (DEBUG_SECRET env var) so it can't be
 * hit by anyone else while it exists. Still: remove this route and the
 * env var once you're done testing. This is not something that should
 * ever ship to a real production deployment long-term.
 */

import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'

export async function debugRoutes(fastify) {
  fastify.post('/debug/set-balance', async (request, reply) => {
    const { secret, email, amountMicroUsdc } = request.body ?? {}

    if (!config.DEBUG_SECRET || secret !== config.DEBUG_SECRET) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    if (!email || typeof email !== 'string') {
      return reply.code(400).send({ error: 'email is required' })
    }

    const balance = BigInt(amountMicroUsdc ?? 1_000_000)

    const user = await prisma.user.findUnique({
      where: { email },
      include: { ledger: true },
    })

    if (!user) {
      return reply.code(404).send({ error: `No user found with email: ${email}` })
    }

    if (user.ledger) {
      await prisma.ledger.update({
        where: { userId: user.id },
        data: { balance },
      })
    } else {
      await prisma.ledger.create({
        data: { userId: user.id, balance },
      })
    }

    return reply.send({
      userId: user.id,
      walletAddress: user.walletAddress ?? null,
      balance: balance.toString(),
      warning: user.walletAddress
        ? undefined
        : 'This user has no walletAddress — on-chain anchoring will be skipped for their calls.',
    })
  })
}
