import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'

const QUEUE_NAME = 'suspension-check'

/**
 * Starts the auto-suspension background job.
 *
 * Every hour, fetches all active routes and checks their health logs
 * from the last 24 hours. If a route has >= 10 checks and > 50% failure
 * rate, it is automatically suspended (isActive = false, isPublic = false).
 *
 * The 10-log minimum threshold prevents routes from being suspended
 * before the monitor has run twice.
 *
 * @returns {Promise<{queue: Queue, worker: Worker}>}
 */
export async function startSuspensionCheck() {
  const queue = new Queue(QUEUE_NAME, { connection: redis })

  // Register repeating job only if not already registered
  let existing
  try {
    existing = await queue.getRepeatableJobs()
  } catch (err) {
    console.error('[suspension-check] Failed to get repeatable jobs:', err.message)
    existing = []
  }

  const alreadyRegistered = existing.some((job) =>
    job.key && job.key.includes('check-all')
  )

  if (!alreadyRegistered) {
    try {
      await queue.add('check-all', {}, {
        repeat: { every: 60 * 60 * 1000 }, // 1 hour
        jobId: 'suspension-check'
      })
      console.log('[suspension-check] Registered repeating job: check-all every 1 hour')
    } catch (err) {
      console.error('[suspension-check] Failed to register repeating job:', err.message)
    }
  } else {
    console.log('[suspension-check] Repeating job already registered, skipping')
  }

  const worker = new Worker(QUEUE_NAME, async (job) => {
    console.log(`[suspension-check] Starting suspension check job ${job.id}`)

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

    let routes
    try {
      routes = await prisma.providerRoute.findMany({
        where: { isActive: true },
        select: {
          id: true,
          providerId: true
        }
      })
    } catch (err) {
      console.error('[suspension-check] Failed to fetch active routes:', err.message)
      throw err
    }

    let suspendedCount = 0

    for (const route of routes) {
      try {
        // Fetch health logs for this route in the last 24 hours
        const logs = await prisma.routeHealthLog.findMany({
          where: {
            routeId: route.id,
            checkedAt: { gte: since }
          },
          select: {
            success: true
          }
        })

        // Minimum data threshold: need at least 10 checks to make a decision
        if (logs.length < 10) {
          continue
        }

        const failCount = logs.filter((log) => !log.success).length
        const failRate = failCount / logs.length

        if (failRate > 0.5) {
          await prisma.providerRoute.update({
            where: { id: route.id },
            data: {
              isActive: false,
              isPublic: false,
              suspensionReason: `Auto-suspended: ${Math.round(failRate * 100)}% failure rate in last 24h (${logs.length} checks)`
            }
          })

          console.warn(
            `[suspension-check] Route ${route.id} suspended. ` +
            `Fail rate: ${Math.round(failRate * 100)}% (${failCount}/${logs.length})`
          )

          suspendedCount++
        }
      } catch (err) {
        console.error(
          `[suspension-check] Error processing route ${route.id}:`,
          err.message
        )
        continue
      }
    }

    console.log(`[suspension-check] Suspended ${suspendedCount} of ${routes.length} routes`)
    return { suspended: suspendedCount, total: routes.length }
  }, {
    connection: redis,
    concurrency: 1
  })

  worker.on('error', (err) => {
    console.error('[suspension-check] Worker error:', err.message)
  })

  worker.on('failed', (job, err) => {
    console.error(`[suspension-check] Job ${job?.id} failed:`, err.message)
  })

  console.log('[suspension-check] Worker started')
  return { queue, worker }
}
