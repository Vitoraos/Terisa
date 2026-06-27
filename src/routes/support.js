import { prisma } from '../lib/prisma.js'

/**
 * Customer Support routes — diagnostic tools for support agents.
 *
 * GET /support/route/:routeId/diagnostic  — Full diagnostic view of a route
 *
 * Returns everything customer support needs to decide on reactivation:
 * - Route config and current status
 * - Provider identity and contact info
 * - Last 50 health logs (success/failure pattern)
 * - Recent gateway calls (success rate, latency)
 * - Payout history (are they earning?)
 * - Review summary (consumer sentiment)
 *
 * This endpoint is NOT authenticated in MVP — it relies on Render/Vercel
 * IP restrictions or a simple shared secret. In production, add proper
 * admin auth (e.g., separate admin JWT scope).
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function supportRoutes(fastify, options) {

  fastify.get('/support/route/:routeId/diagnostic', async (request, reply) => {
    const { routeId } = request.params

    if (!routeId || typeof routeId !== 'string') {
      return reply.code(400).send({ error: 'Route ID is required' })
    }

    // ── Fetch route with deep provider info ──
    let route
    try {
      route = await prisma.providerRoute.findUnique({
        where: { id: routeId },
        include: {
          provider: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  walletAddress: true,
                  baseWallet: true,
                  createdAt: true
                }
              },
              earnings: true
            }
          }
        }
      })
    } catch (err) {
      console.error('[GET /support/route/:routeId/diagnostic] Route lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch route diagnostic' })
    }

    if (!route) {
      return reply.code(404).send({ error: 'Route not found' })
    }

    // ── Fetch last 50 health logs ──
    let healthLogs
    try {
      healthLogs = await prisma.routeHealthLog.findMany({
        where: { routeId },
        orderBy: { checkedAt: 'desc' },
        take: 50
      })
    } catch (err) {
      console.error('[diagnostic] Health logs fetch failed:', err.message)
      healthLogs = []
    }

    // ── Compute health statistics ──
    const totalChecks = healthLogs.length
    const successChecks = healthLogs.filter((l) => l.success).length
    const failureChecks = totalChecks - successChecks
    const currentUptimePct = totalChecks > 0
      ? (successChecks / totalChecks) * 100
      : null

    const avgLatencyMs = healthLogs.length > 0
      ? Math.round(
          healthLogs
            .filter((l) => l.latencyMs !== null && l.latencyMs !== undefined)
            .reduce((sum, l) => sum + (l.latencyMs ?? 0), 0) /
          Math.max(1, healthLogs.filter((l) => l.latencyMs !== null).length)
        )
      : null

    // ── Fetch recent gateway calls (last 7 days) ──
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    let recentCalls
    try {
      recentCalls = await prisma.ledgerEntry.findMany({
        where: {
          referenceId: { startsWith: `call:${routeId}:` },
          createdAt: { gte: sevenDaysAgo }
        },
        orderBy: { createdAt: 'desc' },
        take: 100
      })
    } catch (err) {
      console.error('[diagnostic] Recent calls fetch failed:', err.message)
      recentCalls = []
    }

    const callSuccessCount = recentCalls.filter(
      (c) => c.amount < 0n // API_USAGE entries have negative amounts
    ).length
    // Refunds indicate failures
    const callRefundCount = recentCalls.filter(
      (c) => c.type === 'REFUND'
    ).length

    // ── Fetch payout history ──
    let payouts
    try {
      payouts = await prisma.payout.findMany({
        where: { providerId: route.providerId },
        orderBy: { createdAt: 'desc' },
        take: 10
      })
    } catch (err) {
      console.error('[diagnostic] Payouts fetch failed:', err.message)
      payouts = []
    }

    // ── Fetch review summary ──
    let reviewAgg
    try {
      reviewAgg = await prisma.review.aggregate({
        where: { routeId },
        _avg: { rating: true },
        _count: { id: true }
      })
    } catch (err) {
      console.error('[diagnostic] Review aggregation failed:', err.message)
      reviewAgg = { _avg: { rating: null }, _count: { id: 0 } }
    }

    // ── Build diagnostic response ──
    return reply.code(200).send({
      route: {
        id: route.id,
        name: route.name,
        description: route.description,
        category: route.category,
        upstreamUrl: route.upstreamUrl,
        httpMethod: route.httpMethod,
        timeoutMs: route.timeoutMs,
        costMicroUsdc: route.costMicroUsdc.toString(),
        isPublic: route.isPublic,
        isActive: route.isActive,
        suspensionReason: route.suspensionReason,
        avgLatencyMs: route.avgLatencyMs,
        uptimePct: route.uptimePct,
        avgRating: route.avgRating,
        totalCalls: route.totalCalls.toString(),
        createdAt: route.createdAt,
        updatedAt: route.updatedAt
      },
      provider: {
        id: route.provider.id,
        businessName: route.provider.businessName,
        description: route.provider.description,
        website: route.provider.website,
        verified: route.provider.verified,
        active: route.provider.active,
        user: {
          id: route.provider.user.id,
          email: route.provider.user.email,
          walletAddress: route.provider.user.walletAddress,
          baseWallet: route.provider.user.baseWallet,
          memberSince: route.provider.user.createdAt
        },
        earnings: route.provider.earnings
          ? {
              balance: route.provider.earnings.balance.toString(),
              lifetime: route.provider.earnings.lifetime.toString()
            }
          : { balance: '0', lifetime: '0' }
      },
      health: {
        totalChecks,
        successChecks,
        failureChecks,
        currentUptimePct: currentUptimePct !== null
          ? parseFloat(currentUptimePct.toFixed(2))
          : null,
        avgLatencyMs,
        lastCheckedAt: healthLogs.length > 0 ? healthLogs[0].checkedAt : null,
        recentLogs: healthLogs.slice(0, 10).map((log) => ({
          success: log.success,
          latencyMs: log.latencyMs,
          source: log.source,
          checkedAt: log.checkedAt
        }))
      },
      recentActivity: {
        totalCalls7d: recentCalls.length,
        refundCount7d: callRefundCount,
        estimatedSuccessRate7d: recentCalls.length > 0
          ? parseFloat(((recentCalls.length - callRefundCount) / recentCalls.length * 100).toFixed(2))
          : null
      },
      payouts: payouts.map((p) => ({
        id: p.id,
        amountMicroUsdc: p.amountMicroUsdc.toString(),
        status: p.status,
        payoutMethod: p.payoutMethod,
        createdAt: p.createdAt
      })),
      reviews: {
        count: reviewAgg._count.id,
        avgRating: reviewAgg._avg.rating
          ? parseFloat(reviewAgg._avg.rating.toFixed(2))
          : null
      },
      supportDecision: {
        canReactivate: !route.isActive && route.suspensionReason?.startsWith('Auto-suspended'),
        recommendation: route.isActive
          ? 'Route is currently active'
          : failureChecks > successChecks
            ? 'High failure rate — verify endpoint health before reactivating'
            : 'Failures resolved — safe to reactivate if endpoint validates',
        actionItems: [
          'Verify upstreamUrl is reachable and returns valid JSON',
          'Check provider earnings — are they actively serving traffic?',
          'Review recent health logs for failure pattern (DNS, timeout, 5xx)',
          'If reactivating: PUT /provider/routes/:id with isPublic fix (manual DB update for now)'
        ]
      }
    })
  })
}
