import { prisma } from './prisma.js'

/**
 * Writes a PENDING receipt row for a successful gateway call. Does NOT
 * talk to Solana — that's the background worker's job (anchorWorker.js).
 * This function is the only Solana-adjacent thing on the gateway's
 * request path, and it's just one small Postgres insert.
 *
 * Never throws — a missing on-chain receipt should never be able to
 * break a gateway response.
 */
export async function enqueueCallAnchor({ userId, routeId, amountMicroUsdc, referenceId }) {
  let user
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    })
  } catch (err) {
    console.error(`[anchorQueue] Failed to look up wallet for userId=${userId}:`, err.message)
    return
  }

  if (!user?.walletAddress) {
    // Common, not an error: the user's embedded wallet may not have been
    // created yet (providers.tsx notes this happens async on first login).
    console.warn(`[anchorQueue] No walletAddress for userId=${userId}, skipping anchor for ${referenceId}`)
    return
  }

  const payload = JSON.stringify({
    callerWallet: user.walletAddress,
    routeId,
    amountMicroUsdc: amountMicroUsdc.toString(), // BigInt -> string for JSON
  })

  try {
    await prisma.callAnchorReceipt.upsert({
      where: { referenceId },
      create: { referenceId, payload, status: 'PENDING' },
      update: {}, // don't clobber an in-flight or confirmed receipt
    })
  } catch (err) {
    console.error(`[anchorQueue] Failed to enqueue ${referenceId}:`, err.message)
  }
}
