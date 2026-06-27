import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '../config.js'
import { prisma } from '../lib/prisma.js'
import { creditDeposit } from '../lib/ledger.js'

// ─── CONSTANTS ─────────────────────────────────────────────────────────────

const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_DECIMALS = 6

// ─── HMAC VERIFICATION (timing-safe, prevents timing attacks) ──────────────

/**
 * Verifies an HMAC-SHA256 signature using constant-time comparison.
 *
 * @param {string} secret - The webhook secret
 * @param {Buffer} rawBody - The raw request body buffer
 * @param {string} signatureHex - The hex-encoded signature from the header
 * @returns {boolean} True if signature is valid
 */
function verifyHmacSha256(secret, rawBody, signatureHex) {
  if (!secret || typeof secret !== 'string') {
    return false
  }
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    return false
  }
  if (!signatureHex || typeof signatureHex !== 'string') {
    return false
  }

  let expected
  try {
    expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  } catch {
    return false
  }

  let expectedBuf
  let actualBuf
  try {
    expectedBuf = Buffer.from(expected, 'hex')
    actualBuf = Buffer.from(signatureHex, 'hex')
  } catch {
    return false
  }

  if (expectedBuf.length !== actualBuf.length) {
    return false
  }

  try {
    return timingSafeEqual(expectedBuf, actualBuf)
  } catch {
    return false
  }
}

// ─── HELPER: Process a single deposit ────────────────────────────────────────

/**
 * Idempotent deposit processor. Handles the full flow:
 * 1. Find user by wallet
 * 2. Validate amount > 0
 * 3. Upsert Inbox record
 * 4. Call creditDeposit
 * 5. Update Inbox status
 *
 * Any failure is caught, logged, and the Inbox is marked FAILED.
 * The outer loop continues to the next transaction.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {bigint} params.amountMicroUsdc
 * @param {string} params.txSig
 * @param {'SOLANA' | 'BASE'} params.chain
 * @param {any} params.payload - Raw webhook payload (stored in Inbox)
 */
async function processDeposit({ userId, amountMicroUsdc, txSig, chain, payload }) {
  // Step 1: Upsert Inbox record (idempotency gate)
  let inbox
  try {
    inbox = await prisma.inbox.upsert({
      where: { txSig },
      create: {
        txSig,
        chain,
        payload,
        status: 'PENDING',
        retries: 0
      },
      update: {} // No-op if already exists
    })
  } catch (err) {
    console.error(
      `[processDeposit] Inbox upsert failed for txSig=${txSig}:`,
      err.message
    )
    return
  }

  // If already processed, skip (idempotent)
  if (inbox.status === 'PROCESSED') {
    console.log(`[processDeposit] Already processed: ${txSig}`)
    return
  }

  // Step 2: Call creditDeposit (idempotent by referenceId)
  const referenceId = `deposit:${chain.toLowerCase()}:${txSig}`

  try {
    const credited = await creditDeposit({
      userId,
      amountMicroUsdc,
      referenceId,
      chain
    })

    // Step 3: Update Inbox status
    await prisma.inbox.update({
      where: { id: inbox.id },
      data: {
        status: 'PROCESSED',
        errorMsg: null
      }
    })

    if (credited) {
      console.log(
        `[processDeposit] Credited ${amountMicroUsdc.toString()} micro-USDC to user=${userId} txSig=${txSig}`
      )
    } else {
      console.log(`[processDeposit] Already credited (duplicate): ${txSig}`)
    }
  } catch (err) {
    console.error(
      `[processDeposit] creditDeposit failed for txSig=${txSig}:`,
      err.message
    )

    try {
      await prisma.inbox.update({
        where: { id: inbox.id },
        data: {
          status: 'FAILED',
          errorMsg: err.message ?? 'Unknown error',
          retries: { increment: 1 }
        }
      })
    } catch (updateErr) {
      console.error(
        `[processDeposit] Failed to mark Inbox as FAILED for txSig=${txSig}:`,
        updateErr.message
      )
    }
  }
}

// ─── ROUTE PLUGIN ────────────────────────────────────────────────────────────

/**
 * Webhook routes for deposit processing.
 *
 * POST /webhooks/helius     — Solana USDC deposits via Helius
 * POST /webhooks/alchemy    — Base chain USDC deposits via Alchemy
 * POST /webhooks/honeycoin  — Africa mobile money → USDC via HoneyCoin
 *
 * Security: Every webhook verifies HMAC-SHA256 before touching the database.
 * Idempotency: Duplicate txSig/transactionId never double-credits.
 * Resilience: One bad transaction in a batch does not stop processing others.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function webhookRoutes(fastify, options) {
  // Raw body access: Fastify needs a custom parser so we can verify HMAC
  // against the exact bytes the sender signed.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body
    try {
      const parsed = JSON.parse(body.toString())
      done(null, parsed)
    } catch (err) {
      done(err)
    }
  })

  // ─── ROUTE 1: Helius (Solana USDC) ───────────────────────────────────────
  fastify.post('/webhooks/helius', async (request, reply) => {
    const rawBody = request.rawBody

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: 'Unable to read raw body' })
    }

    const signature = request.headers['helius-signature']

    // Verify HMAC before any database access
    const valid = verifyHmacSha256(config.HELIUS_WEBHOOK_SECRET, rawBody, signature)
    if (!valid) {
      console.error('[Helius] Invalid webhook signature from IP:', request.ip)
      return reply.code(401).send({ error: 'Invalid webhook signature' })
    }

    // Parse body as JSON array (Helius sends an array of transactions)
    let transactions
    try {
      const parsed = JSON.parse(rawBody.toString())
      if (!Array.isArray(parsed)) {
        console.error('[Helius] Expected JSON array, got:', typeof parsed)
        return reply.code(200).send({ ok: true, warning: 'Expected array, skipped' })
      }
      transactions = parsed
    } catch (err) {
      console.error('[Helius] Failed to parse JSON body:', err.message)
      return reply.code(200).send({ ok: true, warning: 'Invalid JSON, skipped' })
    }

    // Process each transaction independently
    for (const tx of transactions) {
      try {
        if (!tx || typeof tx !== 'object') {
          console.warn('[Helius] Skipped non-object transaction')
          continue
        }

        // Find USDC transfer to our treasury
        const transfer = tx.tokenTransfers?.find(
          (t) => t &&
            t.mint === USDC_MINT_SOLANA &&
            t.toUserAccount === config.SOLANA_TREASURY_ADDRESS
        )

        if (!transfer) {
          continue // Not a USDC deposit to our treasury
        }

        // Find user by sender wallet address
        const user = await prisma.user.findUnique({
          where: { walletAddress: transfer.fromUserAccount }
        })

        if (!user) {
          console.warn(
            `[Helius] No user found for wallet=${transfer.fromUserAccount} txSig=${tx.signature}`
          )
          continue
        }

        // Convert token amount to micro-USDC safely
        // Never trust transfer.tokenAmount to be a safe integer
        const amountMicroUsdc = BigInt(Math.round(transfer.tokenAmount * 1_000_000))

        if (amountMicroUsdc <= 0n) {
          console.warn(`[Helius] Non-positive amount for txSig=${tx.signature}, skipping`)
          continue
        }

        await processDeposit({
          userId: user.id,
          amountMicroUsdc,
          txSig: tx.signature,
          chain: 'SOLANA',
          payload: tx
        })
      } catch (err) {
        // One bad transaction must not stop processing the batch
        console.error(
          '[Helius] Failed to process transaction in batch:',
          err.message
        )
        continue
      }
    }

    // Always return 200 — Helius retries on non-200
    return reply.code(200).send({ ok: true })
  })

  // ─── ROUTE 2: Alchemy (Base chain USDC) ─────────────────────────────────
  fastify.post('/webhooks/alchemy', async (request, reply) => {
    const rawBody = request.rawBody

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: 'Unable to read raw body' })
    }

    const signature = request.headers['x-alchemy-signature']

    const valid = verifyHmacSha256(config.ALCHEMY_WEBHOOK_SECRET, rawBody, signature)
    if (!valid) {
      console.error('[Alchemy] Invalid webhook signature from IP:', request.ip)
      return reply.code(401).send({ error: 'Invalid webhook signature' })
    }

    // Alchemy payload: { event: { activity: [...] } }
    const activity = request.body?.event?.activity ?? []

    if (!Array.isArray(activity)) {
      return reply.code(200).send({ ok: true, warning: 'No activity array found' })
    }

    for (const event of activity) {
      try {
        if (!event || typeof event !== 'object') {
          continue
        }

        // Must be USDC
        if (event.asset !== 'USDC') {
          continue
        }

        // Must be sent TO our treasury
        const toAddress = event.toAddress?.toLowerCase?.()
        if (!toAddress || toAddress !== config.BASE_TREASURY_ADDRESS.toLowerCase()) {
          continue
        }

        // Find user by sender wallet (case-insensitive match on baseWallet)
        const user = await prisma.user.findFirst({
          where: {
            baseWallet: {
              equals: event.fromAddress,
              mode: 'insensitive'
            }
          }
        })

        if (!user) {
          console.warn(
            `[Alchemy] No user found for baseWallet=${event.fromAddress} hash=${event.hash}`
          )
          continue
        }

        const amountMicroUsdc = BigInt(Math.round(event.value * 1_000_000))

        if (amountMicroUsdc <= 0n) {
          console.warn(`[Alchemy] Non-positive amount for hash=${event.hash}, skipping`)
          continue
        }

        await processDeposit({
          userId: user.id,
          amountMicroUsdc,
          txSig: event.hash,
          chain: 'BASE',
          payload: event
        })
      } catch (err) {
        console.error(
          '[Alchemy] Failed to process event in batch:',
          err.message
        )
        continue
      }
    }

    return reply.code(200).send({ ok: true })
  })

  // ─── ROUTE 3: HoneyCoin (Africa mobile money → USDC) ─────────────────────
  fastify.post('/webhooks/honeycoin', async (request, reply) => {
    const rawBody = request.rawBody

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: 'Unable to read raw body' })
    }

    const signature = request.headers['x-honeycoin-signature']

    const valid = verifyHmacSha256(config.HONEYCOIN_WEBHOOK_SECRET, rawBody, signature)
    if (!valid) {
      console.error('[HoneyCoin] Invalid webhook signature from IP:', request.ip)
      return reply.code(401).send({ error: 'Invalid webhook signature' })
    }

    const body = request.body

    // Only process completed payments
    if (body?.status !== 'COMPLETED') {
      return reply.code(200).send({ ok: true, skipped: true })
    }

    // Validate required fields
    if (!body.userId || typeof body.userId !== 'string') {
      return reply.code(400).send({ error: 'userId is required and must be a string' })
    }

    if (typeof body.amountUsdc !== 'number' || body.amountUsdc <= 0 || !Number.isFinite(body.amountUsdc)) {
      return reply.code(400).send({ error: 'amountUsdc must be a positive finite number' })
    }

    if (!body.transactionId || typeof body.transactionId !== 'string') {
      return reply.code(400).send({ error: 'transactionId is required and must be a string' })
    }

    const amountMicroUsdc = BigInt(Math.round(body.amountUsdc * 1_000_000))

    if (amountMicroUsdc <= 0n) {
      return reply.code(400).send({ error: 'amountUsdc results in non-positive micro-USDC' })
    }

    // Verify user exists
    let user
    try {
      user = await prisma.user.findUnique({
        where: { id: body.userId }
      })
    } catch (err) {
      console.error('[HoneyCoin] User lookup failed:', err.message)
      // Return 200 so HoneyCoin doesn't retry forever on transient DB errors
      return reply.code(200).send({ ok: true, warning: 'Database error, will retry' })
    }

    if (!user) {
      // Return 200 — don't 404, we don't want HoneyCoin to retry forever
      console.warn(`[HoneyCoin] User not found: ${body.userId}`)
      return reply.code(200).send({ ok: true, warning: 'User not found' })
    }

    try {
      const credited = await creditDeposit({
        userId: user.id,
        amountMicroUsdc,
        referenceId: `deposit:honeycoin:${body.transactionId}`,
        chain: 'BASE'
      })

      return reply.code(200).send({ ok: true, credited })
    } catch (err) {
      console.error(
        `[HoneyCoin] creditDeposit failed for user=${body.userId} tx=${body.transactionId}:`,
        err.message
      )
      // Return 200 so HoneyCoin doesn't retry, but log for manual investigation
      return reply.code(200).send({ ok: true, warning: 'Credit failed, logged for review' })
    }
  })
}
