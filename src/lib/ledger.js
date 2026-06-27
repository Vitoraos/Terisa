import { prisma } from './prisma.js'

/**
 * Debits a user's ledger balance for API usage.
 * Uses row-level locking (FOR UPDATE) to prevent race conditions.
 *
 * @param {Object} params
 * @param {string} params.userId - The user ID to debit
 * @param {bigint} params.costMicroUsdc - The amount to debit in micro-USDC (must be positive)
 * @param {string} params.referenceId - Unique reference for this transaction
 * @returns {Promise<boolean>} True if debit succeeded, false if insufficient balance or no ledger exists
 * @throws {Error} If the database transaction fails (e.g., deadlock, connection lost)
 */
export async function debitApiUsage({ userId, costMicroUsdc, referenceId }) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required and must be a string')
  }
  if (costMicroUsdc === undefined || costMicroUsdc === null) {
    throw new Error('costMicroUsdc is required')
  }
  if (typeof costMicroUsdc !== 'bigint') {
    throw new Error('costMicroUsdc must be a BigInt')
  }
  if (costMicroUsdc <= 0n) {
    throw new Error('costMicroUsdc must be positive')
  }
  if (!referenceId || typeof referenceId !== 'string') {
    throw new Error('referenceId is required and must be a string')
  }

  return await prisma.$transaction(async (tx) => {
    // 1. Lock row and read current balance
    const rows = await tx.$queryRaw`
      SELECT balance FROM "Ledger" WHERE "userId" = ${userId} FOR UPDATE
    `

    // 2. No ledger found OR insufficient balance
    if (!rows || rows.length === 0) {
      return false
    }

    const currentBalance = rows[0].balance
    if (currentBalance < costMicroUsdc) {
      return false
    }

    // 3. Decrement balance
    await tx.ledger.update({
      where: { userId },
      data: { balance: { decrement: costMicroUsdc } }
    })

    // 4. Record the usage entry
    await tx.ledgerEntry.create({
      data: {
        userId,
        amount: -costMicroUsdc,
        type: 'API_USAGE',
        referenceId
      }
    })

    // 5. Success
    return true
  })
}

/**
 * Refunds a user's ledger balance after a failed upstream call.
 * This function MUST NEVER THROW — failures are logged and swallowed
 * to prevent cascading errors during error recovery.
 *
 * @param {Object} params
 * @param {string} params.userId - The user ID to refund
 * @param {bigint} params.costMicroUsdc - The amount to refund in micro-USDC
 * @param {string} params.referenceId - The original transaction referenceId
 * @returns {Promise<void>}
 */
export async function refundApiUsage({ userId, costMicroUsdc, referenceId }) {
  if (!userId || typeof userId !== 'string') {
    console.error('[refundApiUsage] Invalid userId provided, skipping refund')
    return
  }
  if (costMicroUsdc === undefined || costMicroUsdc === null) {
    console.error('[refundApiUsage] costMicroUsdc is required, skipping refund')
    return
  }
  if (typeof costMicroUsdc !== 'bigint') {
    console.error('[refundApiUsage] costMicroUsdc must be a BigInt, skipping refund')
    return
  }
  if (costMicroUsdc <= 0n) {
    console.error('[refundApiUsage] costMicroUsdc must be positive, skipping refund')
    return
  }
  if (!referenceId || typeof referenceId !== 'string') {
    console.error('[refundApiUsage] Invalid referenceId provided, skipping refund')
    return
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Increment balance
      await tx.ledger.update({
        where: { userId },
        data: { balance: { increment: costMicroUsdc } }
      })

      // 2. Record the refund entry
      await tx.ledgerEntry.create({
        data: {
          userId,
          amount: costMicroUsdc,
          type: 'REFUND',
          referenceId: `refund:${referenceId}`
        }
      })
    })
  } catch (err) {
    console.error(
      `[refundApiUsage] Failed to refund userId=${userId}, referenceId=${referenceId}, amount=${costMicroUsdc}:`,
      err.message
    )
  }
}

/**
 * Credits a deposit to a user's ledger.
 * Idempotent: duplicate referenceIds are silently ignored.
 *
 * @param {Object} params
 * @param {string} params.userId - The user ID to credit
 * @param {bigint} params.amountMicroUsdc - The deposit amount in micro-USDC (must be positive)
 * @param {string} params.referenceId - Unique reference for idempotency (e.g., tx signature)
 * @param {'SOLANA' | 'BASE'} params.chain - The deposit chain
 * @returns {Promise<boolean>} True if credited, false if already processed
 * @throws {Error} If the database transaction fails for non-duplicate reasons
 */
export async function creditDeposit({ userId, amountMicroUsdc, referenceId, chain }) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required and must be a string')
  }
  if (amountMicroUsdc === undefined || amountMicroUsdc === null) {
    throw new Error('amountMicroUsdc is required')
  }
  if (typeof amountMicroUsdc !== 'bigint') {
    throw new Error('amountMicroUsdc must be a BigInt')
  }
  if (amountMicroUsdc <= 0n) {
    throw new Error('amountMicroUsdc must be positive')
  }
  if (!referenceId || typeof referenceId !== 'string') {
    throw new Error('referenceId is required and must be a string')
  }
  if (chain !== 'SOLANA' && chain !== 'BASE') {
    throw new Error("chain must be 'SOLANA' or 'BASE'")
  }

  // Idempotency check: already processed?
  const existing = await prisma.ledgerEntry.findUnique({
    where: { referenceId }
  })
  if (existing) {
    return false
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Defensive double-check inside transaction (race condition protection)
      const doubleCheck = await tx.ledgerEntry.findUnique({
        where: { referenceId }
      })
      if (doubleCheck) {
        throw new DuplicateReferenceError()
      }

      // 1. Upsert ledger: create with deposit amount or increment existing
      await tx.ledger.upsert({
        where: { userId },
        create: {
          userId,
          balance: amountMicroUsdc
        },
        update: {
          balance: { increment: amountMicroUsdc }
        }
      })

      // 2. Record the deposit entry
      await tx.ledgerEntry.create({
        data: {
          userId,
          amount: amountMicroUsdc,
          type: 'DEPOSIT',
          referenceId,
          chain
        }
      })
    })

    return true
  } catch (err) {
    // P2002 = Prisma unique constraint violation (duplicate referenceId from race)
    if (err.code === 'P2002' || err.name === 'DuplicateReferenceError') {
      return false
    }
    throw err
  }
}

/**
 * Internal error used to abort a transaction when a duplicate referenceId
 * is detected inside the transaction boundary.
 */
class DuplicateReferenceError extends Error {
  constructor() {
    super('Duplicate referenceId detected inside transaction')
    this.name = 'DuplicateReferenceError'
  }
}

/**
 * Credits provider earnings for a successful API call.
 * Upserts the ProviderEarnings record: creates with initial balance/lifetime
 * or increments both fields.
 *
 * @param {Object} params
 * @param {string} params.providerId - The provider ID to credit
 * @param {bigint} params.amountMicroUsdc - The earnings amount in micro-USDC (must be positive)
 * @param {string} params.referenceId - The call referenceId (for audit trail)
 * @returns {Promise<void>}
 * @throws {Error} If the database operation fails
 */
export async function creditProviderEarnings({ providerId, amountMicroUsdc, referenceId }) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('providerId is required and must be a string')
  }
  if (amountMicroUsdc === undefined || amountMicroUsdc === null) {
    throw new Error('amountMicroUsdc is required')
  }
  if (typeof amountMicroUsdc !== 'bigint') {
    throw new Error('amountMicroUsdc must be a BigInt')
  }
  if (amountMicroUsdc <= 0n) {
    throw new Error('amountMicroUsdc must be positive')
  }
  if (!referenceId || typeof referenceId !== 'string') {
    throw new Error('referenceId is required and must be a string')
  }

  await prisma.providerEarnings.upsert({
    where: { providerId },
    create: {
      providerId,
      balance: amountMicroUsdc,
      lifetime: amountMicroUsdc
    },
    update: {
      balance: { increment: amountMicroUsdc },
      lifetime: { increment: amountMicroUsdc }
    }
  })
}
