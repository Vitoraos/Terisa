import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { anchorCallRecord, isAlreadyAnchoredError } from '../lib/solanaCalls.js'

const QUEUE_NAME = 'solana-call-anchor'
const MAX_ATTEMPTS = 8

/**
 * Anchors pending API-call receipts to Solana, off the gateway's request
 * path. See CallAnchorReceipt model — the request path only ever writes
 * a PENDING row there; this worker is what actually talks to Solana.
 *
 * Same shape as the existing health-monitor.js job: repeating BullMQ
 * job, sequential processing, defensive per-item error handling that
 * never lets one bad item crash the run.
 */
export async function startCallAnchorWorker() {
  const queue = new Queue(QUEUE_NAME, { connection: redis })

  let existing
  try {
    existing = await queue.getRepeatableJobs()
  } catch (err) {
    console.error('[solana-call-anchor] Failed to get repeatable jobs:', err.message)
    existing = []
  }

  const alreadyRegistered = existing.some((job) => job.key?.includes('drain-pending'))

  if (!alreadyRegistered) {
    try {
      await queue.add('drain-pending', {}, {
        repeat: { every: 30 * 1000 },
        jobId: 'solana-call-anchor-drain',
      })
      console.log('[solana-call-anchor] Registered repeating job: drain-pending every 30s')
    } catch (err) {
      console.error('[solana-call-anchor] Failed to register repeating job:', err.message)
    }
  } else {
    console.log('[solana-call-anchor] Repeating job already registered, skipping')
  }

  const worker = new Worker(QUEUE_NAME, async (job) => {
    if (!config.SOLANA_ANCHORING_ENABLED) {
      return { skipped: true }
    }

    let pending
    try {
      pending = await prisma.callAnchorReceipt.findMany({
        where: { status: 'PENDING', attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      })
    } catch (err) {
      console.error('[solana-call-anchor] Failed to fetch pending receipts:', err.message)
      throw err
    }

    let anchored = 0
    let failed = 0

    for (const receipt of pending) {
      try {
        const payload = JSON.parse(receipt.payload)
        let result
        try {
          result = await anchorCallRecord({
            callerWallet: payload.callerWallet,
            routeId: payload.routeId,
            amountMicroUsdc: BigInt(payload.amountMicroUsdc),
            referenceId: receipt.referenceId,
          })
        } catch (err) {
          if (isAlreadyAnchoredError(err)) {
            await prisma.callAnchorReceipt.update({
              where: { id: receipt.id },
              data: { status: 'CONFIRMED', lastError: null },
            })
            anchored++
            continue
          }
          throw err
        }

        await prisma.callAnchorReceipt.update({
          where: { id: receipt.id },
          data: {
            status: 'CONFIRMED',
            txSignature: result.signature,
            recordAddress: result.recordAddress,
            lastError: null,
          },
        })
        anchored++
        console.log(`[solana-call-anchor] Anchored ${receipt.referenceId} -> ${result.signature}`)
      } catch (err) {
        failed++
        const attempts = receipt.attempts + 1
        const willRetry = attempts < MAX_ATTEMPTS
        console.error(
          `[solana-call-anchor] Failed to anchor ${receipt.referenceId} (attempt ${attempts}/${MAX_ATTEMPTS}):`,
          err.message
        )
        try {
          await prisma.callAnchorReceipt.update({
            where: { id: receipt.id },
            data: {
              attempts,
              lastError: err.message?.slice(0, 500) ?? 'Unknown error',
              status: willRetry ? 'PENDING' : 'FAILED',
            },
          })
        } catch (updateErr) {
          console.error(`[solana-call-anchor] Failed to record failure for ${receipt.id}:`, updateErr.message)
        }
        if (!willRetry) {
          console.error(
            `[solana-call-anchor] GIVING UP on ${receipt.referenceId} after ${MAX_ATTEMPTS} attempts. ` +
            `Postgres ledger is unaffected; this call will not appear on-chain.`
          )
        }
      }
    }

    console.log(`[solana-call-anchor] Drain complete: ${anchored} anchored, ${failed} failed, ${pending.length} total`)
    return { anchored, failed, total: pending.length }
  }, {
    connection: redis,
    concurrency: 1,
  })

  worker.on('error', (err) => console.error('[solana-call-anchor] Worker error:', err.message))
  worker.on('failed', (job, err) => console.error(`[solana-call-anchor] Job ${job?.id} failed:`, err.message))

  console.log('[solana-call-anchor] Worker started')
  return { queue, worker }
}
