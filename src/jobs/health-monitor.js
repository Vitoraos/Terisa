import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { validateRoute } from '../lib/validator.js'
import { recomputeUptime } from '../lib/metrics.js'

const QUEUE_NAME = 'health-monitor'

/**
 * Starts the health monitor background job.
 *
 * Registers a repeating BullMQ job that pings all active provider routes
 * every 5 minutes. Each route is validated via a test HTTP call.
 * Results are logged to RouteHealthLog and uptime is recomputed.
 *
 * Routes are processed SEQUENTIALLY (not Promise.all) to avoid hammering
 * providers with concurrent health checks.
 *
 * @returns {Promise<{queue: Queue, worker: Worker, count: number}>}
 */
export async function startHealthMonitor() {
  const queue = new Queue(QUEUE_NAME, { connection: redis })

  // Register repeating job only if not already registered
  let existing
  try {
    existing = await queue.getRepeatableJobs()
  } catch (err) {
    console.error('[health-monitor] Failed to get repeatable jobs:', err.message)
    existing = []
  }

  const alreadyRegistered = existing.some((job) =>
    job.key && job.key.includes('ping-all')
  )

  if (!alreadyRegistered) {
    try {
      await queue.add('ping-all', {}, {
        repeat: { every: 5 * 60 * 1000 }, // 5 minutes
        jobId: 'health-ping'
      })
      console.log('[health-monitor] Registered repeating job: ping-all every 5 minutes')
    } catch (err) {
      console.error('[health-monitor] Failed to register repeating job:', err.message)
    }
  } else {
    console.log('[health-monitor] Repeating job already registered, skipping')
  }

  // Worker: sequential health checks
  const worker = new Worker(QUEUE_NAME, async (job) => {
    console.log(`[health-monitor] Starting health check job ${job.id}`)

    let routes
    try {
      routes = await prisma.providerRoute.findMany({
        where: { isActive: true },
        select: {
          id: true,
          upstreamUrl: true,
          httpMethod: true,
          timeoutMs: true,
          testPayload: true
        }
      })
    } catch (err) {
      console.error('[health-monitor] Failed to fetch active routes:', err.message)
      throw err // Let BullMQ handle retry
    }

    let checkedCount = 0

    // Process sequentially — one slow route shouldn't block others,
    // but we don't want to hammer providers with concurrent checks.
    for (const route of routes) {
      try {
        const result = await validateRoute({
          upstreamUrl: route.upstreamUrl,
          httpMethod: route.httpMethod,
          timeoutMs: route.timeoutMs,
          testPayload: route.testPayload
        })

        // Log health check result
        try {
          await prisma.routeHealthLog.create({
            data: {
              routeId: route.id,
              success: result.passed,
              latencyMs: result.latencyMs,
              source: 'MONITOR'
            }
          })
        } catch (logErr) {
          console.error(
            `[health-monitor] Failed to log health check for route ${route.id}:`,
            logErr.message
          )
          // Continue even if logging fails
        }

        // Recompute uptime statistics
        try {
          await recomputeUptime(route.id)
        } catch (uptimeErr) {
          console.error(
            `[health-monitor] Failed to recompute uptime for route ${route.id}:`,
            uptimeErr.message
          )
          // Continue even if recomputation fails
        }

        checkedCount++
      } catch (err) {
        // validateRoute should never throw (it returns { passed, latencyMs, error }),
        // but catch defensively in case of unexpected errors.
        console.error(
          `[health-monitor] Unexpected error checking route ${route.id}:`,
          err.message
        )
        continue
      }
    }

    console.log(`[health-monitor] Checked ${checkedCount} of ${routes.length} routes`)
    return { checked: checkedCount, total: routes.length }
  }, {
    connection: redis,
    concurrency: 1 // Sequential processing
  })

  worker.on('error', (err) => {
    console.error('[health-monitor] Worker error:', err.message)
  })

  worker.on('failed', (job, err) => {
    console.error(`[health-monitor] Job ${job?.id} failed:`, err.message)
  })

  console.log('[health-monitor] Worker started')
  return { queue, worker, count: 0 }
}
