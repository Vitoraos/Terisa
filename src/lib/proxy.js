import { randomUUID } from 'crypto'
import { config } from '../config.js'
import { debitApiUsage, refundApiUsage, creditProviderEarnings } from './ledger.js'
import { recordCallLatency, recordCallFailure } from './metrics.js'

/**
 * Core proxy function that forwards a consumer request to a provider endpoint.
 * Handles billing (debit on start, refund on any failure), timeout enforcement,
 * and provider earnings credit on success.
 *
 * This is the SINGLE execution path for both human gateway calls and agent calls.
 *
 * @param {Object} params
 * @param {string} params.userId - The consumer's user ID
 * @param {Object} params.route - The ProviderRoute object from Prisma
 * @param {any} params.body - The request body to forward to the provider
 * @param {Object} [params.extraHeaders={}] - Additional headers to include in the upstream request
 * @returns {Promise<{success: boolean, statusCode: number, data?: any, error?: any, latencyMs: number, referenceId: string, refunded: boolean}>}
 */
export async function proxyRequest({ userId, route, body, extraHeaders = {} }) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required and must be a string')
  }
  if (!route || typeof route !== 'object') {
    throw new Error('route is required and must be an object')
  }
  if (!route.id || typeof route.id !== 'string') {
    throw new Error('route.id is required and must be a string')
  }
  if (!route.providerId || typeof route.providerId !== 'string') {
    throw new Error('route.providerId is required and must be a string')
  }
  if (!route.upstreamUrl || typeof route.upstreamUrl !== 'string') {
    throw new Error('route.upstreamUrl is required and must be a string')
  }
  if (!route.httpMethod || typeof route.httpMethod !== 'string') {
    throw new Error('route.httpMethod is required and must be a string')
  }

  // 1. Generate unique reference for this call
  const referenceId = `call:${route.id}:${randomUUID()}`

  // 2. Always cast cost to BigInt (Prisma may return it as BigInt already, but be safe)
  const costMicroUsdc = BigInt(route.costMicroUsdc)

  // 3. Calculate provider share after platform fee
  const providerCut = (costMicroUsdc * BigInt(10000 - config.PLATFORM_FEE_BPS)) / 10000n

  // 4. Debit consumer balance first
  const hasBalance = await debitApiUsage({ userId, costMicroUsdc, referenceId })
  if (!hasBalance) {
    return {
      success: false,
      statusCode: 402,
      error: 'Insufficient balance',
      latencyMs: 0,
      referenceId,
      refunded: false
    }
  }

  // 5. Setup abort controller with capped timeout
  const controller = new AbortController()
  const timeout = Math.min(route.timeoutMs ?? 8000, 60_000)
  const timer = setTimeout(() => controller.abort(), timeout)

  const start = Date.now()

  try {
    // 7. Forward request to provider
    const upstream = await fetch(route.upstreamUrl, {
      method: route.httpMethod,
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Route-Id': route.id,
        'X-Gateway-Request-Id': referenceId,
        ...extraHeaders
      },
      body: ['GET', 'HEAD'].includes(route.httpMethod)
        ? undefined
        : JSON.stringify(body),
      signal: controller.signal
    })

    // 8. Clear timeout immediately after fetch returns (in all success/error branches)
    clearTimeout(timer)

    const latencyMs = Date.now() - start

    // 12. Parse response body (best-effort JSON)
    let parsedBody
    try {
      parsedBody = await upstream.json()
    } catch {
      parsedBody = {}
    }

    // 13. Upstream returned non-2xx status — refund consumer
    if (!upstream.ok) {
      await refundApiUsage({ userId, costMicroUsdc, referenceId })
      await recordCallFailure(route.id, 'UPSTREAM_ERROR')
      return {
        success: false,
        statusCode: upstream.status,
        error: parsedBody,
        latencyMs,
        referenceId,
        refunded: true
      }
    }

    // 14. Success — credit provider and record latency
    await creditProviderEarnings({ providerId: route.providerId, amountMicroUsdc: providerCut, referenceId })
    await recordCallLatency(route.id, latencyMs)

    return {
      success: true,
      statusCode: 200,
      data: parsedBody,
      latencyMs,
      referenceId,
      refunded: false
    }

  } catch (err) {
    // 8. Clear timeout in ALL branches where timer was started
    clearTimeout(timer)
    const latencyMs = Date.now() - start

    // 10. AbortError = timeout
    if (err.name === 'AbortError') {
      await refundApiUsage({ userId, costMicroUsdc, referenceId })
      await recordCallFailure(route.id, 'TIMEOUT')
      return {
        success: false,
        statusCode: 504,
        error: 'Provider timeout',
        latencyMs,
        referenceId,
        refunded: true
      }
    }

    // 11. Any other network-level failure (DNS, connection refused, etc.)
    await refundApiUsage({ userId, costMicroUsdc, referenceId })
    await recordCallFailure(route.id, 'UNREACHABLE')
    return {
      success: false,
      statusCode: 502,
      error: 'Provider unreachable',
      latencyMs,
      referenceId,
      refunded: true
    }
  }
}
