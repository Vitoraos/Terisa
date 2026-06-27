import { prisma } from '../lib/prisma.js'

/**
 * Review routes — consumers leave reviews after successfully calling a route.
 *
 * POST /marketplace/:routeId/review  — Leave or update a review (auth required)
 * GET  /marketplace/:routeId/reviews — List reviews (public)
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function reviewRoutes(fastify, options) {

  // ─── POST /marketplace/:routeId/review ───────────────────────────────────
  fastify.post('/marketplace/:routeId/review', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { routeId } = request.params
    const { rating, comment } = request.body ?? {}

    // Validate routeId
    if (!routeId || typeof routeId !== 'string') {
      return reply.code(400).send({ error: 'Route ID is required' })
    }

    // ── Validate rating ──
    if (rating === undefined || rating === null) {
      return reply.code(400).send({ error: 'rating is required' })
    }
    if (typeof rating !== 'number' || !Number.isInteger(rating)) {
      return reply.code(400).send({ error: 'rating must be an integer' })
    }
    if (rating < 1 || rating > 5) {
      return reply.code(400).send({ error: 'rating must be between 1 and 5' })
    }

    // ── Validate comment ──
    if (comment !== undefined && comment !== null) {
      if (typeof comment !== 'string') {
        return reply.code(400).send({ error: 'comment must be a string' })
      }
      if (comment.length > 1000) {
        return reply.code(400).send({ error: 'comment must not exceed 1000 characters' })
      }
    }

    // ── Verify route exists and is active ──
    let route
    try {
      route = await prisma.providerRoute.findUnique({
        where: { id: routeId }
      })
    } catch (err) {
      console.error('[POST /marketplace/:routeId/review] Route lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to verify route' })
    }

    if (!route) {
      return reply.code(404).send({ error: 'Route not found' })
    }

    if (!route.isActive) {
      return reply.code(400).send({ error: 'Cannot review an inactive route' })
    }

    // ── Anti-gaming: user must have successfully called this route ──
    let hasCalled
    try {
      hasCalled = await prisma.ledgerEntry.findFirst({
        where: {
          userId,
          type: 'API_USAGE',
          referenceId: {
            startsWith: `call:${routeId}:`
          }
        }
      })
    } catch (err) {
      console.error('[POST /marketplace/:routeId/review] Ledger check failed:', err.message)
      return reply.code(500).send({ error: 'Failed to verify usage history' })
    }

    if (!hasCalled) {
      return reply.code(403).send({
        error: 'You must successfully call this API at least once before reviewing it'
      })
    }

    // ── Upsert review (one per user per route, enforced by DB unique constraint) ──
    let review
    try {
      review = await prisma.review.upsert({
        where: {
          routeId_userId: {
            routeId,
            userId
          }
        },
        create: {
          routeId,
          userId,
          rating,
          comment: comment ?? null
        },
        update: {
          rating,
          comment: comment ?? null
        },
        include: {
          user: {
            select: {
              email: true
            }
          }
        }
      })
    } catch (err) {
      console.error('[POST /marketplace/:routeId/review] Review upsert failed:', err.message)
      return reply.code(500).send({ error: 'Failed to save review' })
    }

    // ── Recompute avgRating on ProviderRoute ──
    try {
      const agg = await prisma.review.aggregate({
        where: { routeId },
        _avg: { rating: true }
      })

      await prisma.providerRoute.update({
        where: { id: routeId },
        data: { avgRating: agg._avg.rating }
      })
    } catch (err) {
      console.error('[POST /marketplace/:routeId/review] avgRating recomputation failed:', err.message)
      // Non-fatal: review is saved, avgRating may be stale until next review
    }

    return reply.code(201).send({
      id: review.id,
      routeId: review.routeId,
      userId: review.userId,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt,
      user: {
        email: review.user.email
      }
    })
  })

  // ─── GET /marketplace/:routeId/reviews ───────────────────────────────────
  fastify.get('/marketplace/:routeId/reviews', async (request, reply) => {
    const { routeId } = request.params
    const { page: rawPage, limit: rawLimit } = request.query ?? {}

    if (!routeId || typeof routeId !== 'string') {
      return reply.code(400).send({ error: 'Route ID is required' })
    }

    // Parse pagination
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
        limit = Math.max(1, Math.min(50, parsed))
      }
    }

    const skip = (page - 1) * limit

    let reviews
    let total
    try {
      reviews = await prisma.review.findMany({
        where: { routeId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              email: true
            }
          }
        }
      })

      total = await prisma.review.count({
        where: { routeId }
      })
    } catch (err) {
      console.error('[GET /marketplace/:routeId/reviews] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch reviews' })
    }

    return reply.code(200).send({
      reviews: reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        user: {
          email: review.user.email
        }
      })),
      page,
      limit,
      total
    })
  })
}
