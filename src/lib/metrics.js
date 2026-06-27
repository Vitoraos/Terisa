import { prisma } from './prisma.js'

/**
 * Records a successful call latency and updates the route's exponential moving average.
 * Also increments totalCalls and creates a RouteHealthLog entry.
 *
 * @param {string} routeId - The ProviderRoute ID
 * @param {number} latencyMs - The call latency in milliseconds (must be non-negative)
 * @returns {Promise<void>}
 * @throws {Error} If the route does not exist or the transaction fails
 */
export async function recordCallLatency(routeId, latencyMs) {
  if (!routeId || typeof routeId !== 'string') {
    throw new Error('routeId is required and must be a string')
  }
  if (typeof latencyMs !== 'number' || latencyMs < 0 || !Number.isFinite(latencyMs)) {
    throw new Error('latencyMs must be a non-negative finite number')
  }

  await prisma.$transaction(async (tx) => {
    const route = await tx.providerRoute.findUnique({
      where: { id: routeId },
      select: { avgLatencyMs: true }
    })

    if (!route) {
      throw new Error(`Route ${routeId} not found`)
    }

    // Exponential moving average: new = round(old * 0.9 + new * 0.1)
    const newAvgLatencyMs = route.avgLatencyMs === null
      ? latencyMs
      : Math.round(route.avgLatencyMs * 0.9 + latencyMs * 0.1)

    await tx.providerRoute.update({
      where: { id: routeId },
      data: {
        avgLatencyMs: newAvgLatencyMs,
        totalCalls: { increment: 1n }
      }
    })

    await tx.routeHealthLog.create({
      data: {
        routeId,
        success: true,
        latencyMs,
        source: 'REAL_CALL'
      }
    })
  })
}

/**
 * Records a failed call in the health log.
 * The failure reason is logged to stderr but NOT stored in the database
 * (no schema field for it).
 *
 * @param {string} routeId - The ProviderRoute ID
 * @param {string} reason - Human-readable failure reason (e.g., 'TIMEOUT', 'UNREACHABLE')
 * @returns {Promise<void>}
 */
export async function recordCallFailure(routeId, reason) {
  if (!routeId || typeof routeId !== 'string') {
    throw new Error('routeId is required and must be a string')
  }
  if (!reason || typeof reason !== 'string') {
    throw new Error('reason is required and must be a string')
  }

  try {
    await prisma.routeHealthLog.create({
      data: {
        routeId,
        success: false,
        source: 'REAL_CALL'
      }
    })
  } catch (err) {
    console.error(
      `[recordCallFailure] Failed to create health log for route ${routeId}:`,
      err.message
    )
  }

  console.error(`[recordCallFailure] Route ${routeId} failed: ${reason}`)
}

/**
 * Recomputes uptime percentage and average latency for a route
 * based on the last 24 hours of health logs.
 *
 * @param {string} routeId - The ProviderRoute ID
 * @returns {Promise<void>}
 */
export async function recomputeUptime(routeId) {
  if (!routeId || typeof routeId !== 'string') {
    throw new Error('routeId is required and must be a string')
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const logs = await prisma.routeHealthLog.findMany({
    where: {
      routeId,
      checkedAt: { gte: since }
    }
  })

  // Not enough data to compute meaningful statistics
  if (logs.length < 5) {
    return
  }

  const successCount = logs.filter((log) => log.success).length
  const uptimePct = (successCount / logs.length) * 100

  const successfulLogs = logs.filter(
    (log) => log.latencyMs !== null && log.latencyMs !== undefined
  )

  let avgLatencyMs = null
  if (successfulLogs.length > 0) {
    const sum = successfulLogs.reduce((acc, log) => acc + log.latencyMs, 0)
    avgLatencyMs = Math.round(sum / successfulLogs.length)
  }

  const updateData = { uptimePct }
  if (avgLatencyMs !== null) {
    updateData.avgLatencyMs = avgLatencyMs
  }

  await prisma.providerRoute.update({
    where: { id: routeId },
    data: updateData
  })
}
