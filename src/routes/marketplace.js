import { prisma } from '../lib/prisma.js'

const VALID_ROUTE_CATEGORIES = new Set([
  'TEXT_AI',
  'IMAGE_AI',
  'DATA',
  'FINANCE',
  'WEATHER',
  'COMMUNICATION',
  'UTILITIES',
  'DEVELOPER_TOOLS',
  'AFRICA_SPECIFIC',
  'OTHER'
])

/**
 * Marketplace routes — public API discovery and browsing.
 *
 * GET /marketplace        — Browse/search public active routes
 * GET /marketplace/:id    — Route detail with reviews
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function marketplaceRoutes(fastify, options) {

  // ─── GET /marketplace ────────────────────────────────────────────────────
  fastify.get('/marketplace', async (request, reply) => {
    const {
      q,
      category,
      minUptime,
      maxPriceMicroUsdc,
      page: rawPage,
      limit: rawLimit
    } = request.query ?? {}

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

    const offset = (page - 1) * limit

    // Validate category if provided
    if (category !== undefined && category !== null && category !== '') {
      if (!VALID_ROUTE_CATEGORIES.has(category)) {
        return reply.code(400).send({
          error: 'Invalid category',
          validValues: Array.from(VALID_ROUTE_CATEGORIES)
        })
      }
    }

    // Validate minUptime if provided
    if (minUptime !== undefined && minUptime !== null && minUptime !== '') {
      const parsed = parseFloat(minUptime)
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
        return reply.code(400).send({
          error: 'minUptime must be a number between 0 and 100'
        })
      }
    }

    // Validate maxPriceMicroUsdc if provided
    let maxPriceBigInt = null
    if (maxPriceMicroUsdc !== undefined && maxPriceMicroUsdc !== null && maxPriceMicroUsdc !== '') {
      try {
        maxPriceBigInt = BigInt(String(maxPriceMicroUsdc).trim())
      } catch {
        return reply.code(400).send({
          error: 'maxPriceMicroUsdc must be a valid integer'
        })
      }
    }

    let results = []

    // ── Full-text search path ──
    if (q && typeof q === 'string' && q.trim().length > 0) {
      try {
        const rawResults = await prisma.$queryRaw`
          SELECT
            r.id, r.name, r.description, r.category, r.tags,
            r."costMicroUsdc", r."avgLatencyMs", r."uptimePct", r."avgRating", r."totalCalls",
            p."businessName" as "providerName", p.verified as "providerVerified",
            ts_rank(
              to_tsvector('english', r.name || ' ' || r.description),
              plainto_tsquery('english', ${q.trim()})
            ) AS rank
          FROM "ProviderRoute" r
          JOIN "Provider" p ON p.id = r."providerId"
          WHERE
            to_tsvector('english', r.name || ' ' || r.description) @@ plainto_tsquery('english', ${q.trim()})
            AND r."isPublic" = true
            AND r."isActive" = true
          ORDER BY rank DESC, r."totalCalls" DESC
          LIMIT 50
        `

        results = rawResults
      } catch (err) {
        console.error('[GET /marketplace] Full-text search failed:', err.message)
        return reply.code(500).send({ error: 'Search failed' })
      }

      // JS-level filters (MVP: cannot add dynamic WHERE to $queryRaw safely)
      if (category) {
        results = results.filter((r) => r.category === category)
      }
      if (maxPriceBigInt !== null) {
        results = results.filter((r) => {
          try {
            return BigInt(r.costMicroUsdc) <= maxPriceBigInt
          } catch {
            return false
          }
        })
      }
      if (minUptime !== undefined && minUptime !== null && minUptime !== '') {
        const minUptimeVal = parseFloat(minUptime)
        results = results.filter((r) => r.uptimePct !== null && r.uptimePct >= minUptimeVal)
      }

      // Apply pagination after filtering
      results = results.slice(0, limit)

    // ── Browse path (no q) ──
    } else {
      const whereClause = {
        isPublic: true,
        isActive: true
      }

      if (category) {
        whereClause.category = category
      }

      if (minUptime !== undefined && minUptime !== null && minUptime !== '') {
        const minUptimeVal = parseFloat(minUptime)
        whereClause.uptimePct = { gte: minUptimeVal }
      }

      if (maxPriceBigInt !== null) {
        whereClause.costMicroUsdc = { lte: maxPriceBigInt }
      }

      try {
        results = await prisma.providerRoute.findMany({
          where: whereClause,
          include: {
            provider: {
              select: {
                businessName: true,
                verified: true
              }
            }
          },
          orderBy: [
            { totalCalls: 'desc' },
            { uptimePct: 'desc' }
          ],
          skip: offset,
          take: limit
        })
      } catch (err) {
        console.error('[GET /marketplace] Browse query failed:', err.message)
        return reply.code(500).send({ error: 'Failed to fetch marketplace' })
      }
    }

    // Serialize response
    const serialized = results.map((route) => ({
      id: route.id,
      name: route.name,
      description: route.description,
      category: route.category,
      tags: route.tags ?? [],
      costMicroUsdc: route.costMicroUsdc?.toString() ?? '0',
      costUsdc: (Number(route.costMicroUsdc ?? 0n) / 1_000_000).toFixed(6),
      avgLatencyMs: route.avgLatencyMs,
      uptimePct: route.uptimePct,
      avgRating: route.avgRating,
      totalCalls: route.totalCalls?.toString() ?? '0',
      provider: {
        name: route.providerName ?? route.provider?.businessName ?? '',
        verified: route.providerVerified ?? route.provider?.verified ?? false
      }
    }))

    return reply.code(200).send(serialized)
  })

  // ─── GET /marketplace/:routeId ───────────────────────────────────────────
  fastify.get('/marketplace/:routeId', async (request, reply) => {
    const { routeId } = request.params

    if (!routeId || typeof routeId !== 'string') {
      return reply.code(400).send({ error: 'Route ID is required' })
    }

    let route
    try {
      route = await prisma.providerRoute.findUnique({
        where: { id: routeId },
        include: {
          provider: {
            select: {
              businessName: true,
              verified: true
            }
          },
          reviews: {
            take: 10,
            orderBy: { createdAt: 'desc' },
            include: {
              user: {
                select: {
                  email: true
                }
              }
            }
          }
        }
      })
    } catch (err) {
      console.error('[GET /marketplace/:routeId] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch route' })
    }

    if (!route || !route.isPublic || !route.isActive) {
      return reply.code(404).send({ error: 'Route not found or unavailable' })
    }

    return reply.code(200).send({
      id: route.id,
      name: route.name,
      description: route.description,
      category: route.category,
      tags: route.tags ?? [],
      upstreamUrl: route.upstreamUrl,
      httpMethod: route.httpMethod,
      timeoutMs: route.timeoutMs,
      costMicroUsdc: route.costMicroUsdc.toString(),
      costUsdc: (Number(route.costMicroUsdc) / 1_000_000).toFixed(6),
      avgLatencyMs: route.avgLatencyMs,
      uptimePct: route.uptimePct,
      avgRating: route.avgRating,
      totalCalls: route.totalCalls.toString(),
      openApiSpec: route.openApiSpec,
      provider: {
        name: route.provider.businessName,
        verified: route.provider.verified
      },
      reviews: route.reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        user: {
          email: review.user.email
        }
      }))
    })
  })
}
