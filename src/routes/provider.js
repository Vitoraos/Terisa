import { prisma } from '../lib/prisma.js'
import { validateRoute } from '../lib/validator.js'

// ─── VALIDATION CONSTANTS ──────────────────────────────────────────────────

const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

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

const VALID_PAYOUT_METHODS = new Set(['CRYPTO_WALLET', 'MOBILE_MONEY'])

// ─── SERIALIZATION HELPERS ─────────────────────────────────────────────────

function serializeProviderRoute(route) {
  if (!route) return null
  return {
    id: route.id,
    name: route.name,
    description: route.description,
    category: route.category,
    tags: route.tags,
    upstreamUrl: route.upstreamUrl,
    httpMethod: route.httpMethod,
    timeoutMs: route.timeoutMs,
    asyncMode: route.asyncMode,
    costMicroUsdc: route.costMicroUsdc?.toString() ?? '0',
    costUsdc: (Number(route.costMicroUsdc ?? 0n) / 1_000_000).toFixed(6),
    avgLatencyMs: route.avgLatencyMs,
    uptimePct: route.uptimePct,
    avgRating: route.avgRating,
    totalCalls: route.totalCalls?.toString() ?? '0',
    isPublic: route.isPublic,
    isActive: route.isActive,
    suspensionReason: route.suspensionReason,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt
  }
}

function serializeEarnings(earnings) {
  if (!earnings) {
    return {
      balance: '0',
      lifetime: '0',
      balanceUsdc: '0.000000',
      lifetimeUsdc: '0.000000'
    }
  }
  return {
    balance: earnings.balance.toString(),
    lifetime: earnings.lifetime.toString(),
    balanceUsdc: (Number(earnings.balance) / 1_000_000).toFixed(6),
    lifetimeUsdc: (Number(earnings.lifetime) / 1_000_000).toFixed(6)
  }
}

// ─── VALIDATION HELPERS ─────────────────────────────────────────────────────

function parseCostMicroUsdc(value) {
  if (value === undefined || value === null) {
    return { valid: false, error: 'costMicroUsdc is required' }
  }
  const str = String(value).trim()
  if (!/^\d+$/.test(str)) {
    return { valid: false, error: 'costMicroUsdc must be a positive integer' }
  }
  try {
    const bigint = BigInt(str)
    if (bigint < 100n) {
      return { valid: false, error: 'costMicroUsdc must be at least 100 (0.0001 USDC)' }
    }
    if (bigint > 1_000_000_000n) {
      return { valid: false, error: 'costMicroUsdc must not exceed 1,000,000,000 (1000 USDC)' }
    }
    return { valid: true, value: bigint }
  } catch {
    return { valid: false, error: 'costMicroUsdc is not a valid integer' }
  }
}

function validateTags(tags) {
  if (tags === undefined || tags === null) {
    return { valid: true, value: [] }
  }
  if (!Array.isArray(tags)) {
    return { valid: false, error: 'tags must be an array of strings' }
  }
  if (tags.length > 10) {
    return { valid: false, error: 'tags must not exceed 10 items' }
  }
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      return { valid: false, error: 'All tags must be strings' }
    }
    if (tag.length > 30) {
      return { valid: false, error: 'Each tag must not exceed 30 characters' }
    }
  }
  return { valid: true, value: tags }
}

function isHttpsUrl(value) {
  if (!value || typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

// ─── ROUTE PLUGIN ──────────────────────────────────────────────────────────

/**
 * Provider management routes.
 *
 * POST /provider/register     — Register as a provider
 * GET  /provider/me           — Get own provider profile + routes + earnings
 * POST /provider/routes       — Publish a new API route
 * PUT  /provider/routes/:id   — Update an existing route (triggers re-review)
 * DELETE /provider/routes/:id — Soft-delete a route
 * GET  /provider/earnings     — Get earnings balance
 * POST /provider/payout       — Request a payout
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function providerRoutes(fastify, options) {

  // ─── POST /provider/register ─────────────────────────────────────────────
  fastify.post('/provider/register', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { businessName, description, website, logoUrl } = request.body ?? {}

    // Validate businessName
    if (!businessName || typeof businessName !== 'string') {
      return reply.code(400).send({ error: 'businessName is required and must be a string' })
    }
    if (businessName.length < 2 || businessName.length > 100) {
      return reply.code(400).send({ error: 'businessName must be between 2 and 100 characters' })
    }

    // Validate description
    if (!description || typeof description !== 'string') {
      return reply.code(400).send({ error: 'description is required and must be a string' })
    }
    if (description.length < 10 || description.length > 500) {
      return reply.code(400).send({ error: 'description must be between 10 and 500 characters' })
    }

    // Validate optional website
    if (website !== undefined && website !== null) {
      if (typeof website !== 'string' || !isHttpsUrl(website)) {
        return reply.code(400).send({ error: 'website must be a valid HTTPS URL' })
      }
    }

    // Validate optional logoUrl
    if (logoUrl !== undefined && logoUrl !== null) {
      if (typeof logoUrl !== 'string' || !isHttpsUrl(logoUrl)) {
        return reply.code(400).send({ error: 'logoUrl must be a valid HTTPS URL' })
      }
    }

    // Check if already registered
    let existing
    try {
      existing = await prisma.provider.findUnique({
        where: { userId }
      })
    } catch (err) {
      console.error('[POST /provider/register] Database lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to check existing registration' })
    }

    if (existing) {
      return reply.code(409).send({ error: 'Already registered as a provider' })
    }

    // Create provider with nested earnings
    let provider
    try {
      provider = await prisma.provider.create({
        data: {
          userId,
          businessName: businessName.trim(),
          description: description.trim(),
          website: website ?? null,
          logoUrl: logoUrl ?? null,
          earnings: {
            create: {
              balance: 0n,
              lifetime: 0n
            }
          }
        }
      })
    } catch (err) {
      console.error('[POST /provider/register] Database insert failed:', err.message)
      return reply.code(500).send({ error: 'Failed to register provider' })
    }

    return reply.code(201).send({
      id: provider.id,
      userId: provider.userId,
      businessName: provider.businessName,
      description: provider.description,
      website: provider.website,
      logoUrl: provider.logoUrl,
      verified: provider.verified,
      active: provider.active,
      createdAt: provider.createdAt
    })
  })

  // ─── GET /provider/me ────────────────────────────────────────────────────
  fastify.get('/provider/me', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user

    let provider
    try {
      provider = await prisma.provider.findUnique({
        where: { userId },
        include: {
          routes: {
            select: {
              id: true,
              name: true,
              isPublic: true,
              isActive: true,
              costMicroUsdc: true,
              avgRating: true,
              uptimePct: true,
              totalCalls: true,
              suspensionReason: true
            }
          },
          earnings: true
        }
      })
    } catch (err) {
      console.error('[GET /provider/me] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch provider profile' })
    }

    if (!provider) {
      return reply.code(404).send({ error: 'Not registered as a provider' })
    }

    return reply.code(200).send({
      id: provider.id,
      businessName: provider.businessName,
      description: provider.description,
      website: provider.website,
      logoUrl: provider.logoUrl,
      verified: provider.verified,
      active: provider.active,
      routes: provider.routes.map((route) => ({
        id: route.id,
        name: route.name,
        isPublic: route.isPublic,
        isActive: route.isActive,
        costMicroUsdc: route.costMicroUsdc.toString(),
        avgRating: route.avgRating,
        uptimePct: route.uptimePct,
        totalCalls: route.totalCalls.toString(),
        suspensionReason: route.suspensionReason
      })),
      earnings: serializeEarnings(provider.earnings)
    })
  })

  // ─── POST /provider/routes ───────────────────────────────────────────────
  fastify.post('/provider/routes', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const body = request.body ?? {}

    const {
      name,
      description,
      category,
      tags,
      upstreamUrl,
      httpMethod,
      costMicroUsdc,
      timeoutMs,
      testPayload,
      openApiSpec
    } = body

    // ── Validate name ──
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'name is required and must be a string' })
    }
    if (name.length < 3 || name.length > 100) {
      return reply.code(400).send({ error: 'name must be between 3 and 100 characters' })
    }

    // ── Validate description ──
    if (!description || typeof description !== 'string') {
      return reply.code(400).send({ error: 'description is required and must be a string' })
    }
    if (description.length < 10 || description.length > 1000) {
      return reply.code(400).send({ error: 'description must be between 10 and 1000 characters' })
    }

    // ── Validate category (must be valid enum value, not silently default) ──
    if (!category || typeof category !== 'string') {
      return reply.code(400).send({ error: 'category is required and must be a string' })
    }
    if (!VALID_ROUTE_CATEGORIES.has(category)) {
      return reply.code(400).send({
        error: 'Invalid category',
        validValues: Array.from(VALID_ROUTE_CATEGORIES)
      })
    }

    // ── Validate upstreamUrl ──
    if (!upstreamUrl || typeof upstreamUrl !== 'string') {
      return reply.code(400).send({ error: 'upstreamUrl is required and must be a string' })
    }
    if (!isHttpsUrl(upstreamUrl)) {
      return reply.code(400).send({ error: 'upstreamUrl must be a valid HTTPS URL' })
    }

    // ── Validate httpMethod ──
    const resolvedMethod = (httpMethod || 'POST').toUpperCase()
    if (!VALID_HTTP_METHODS.has(resolvedMethod)) {
      return reply.code(400).send({
        error: 'Invalid httpMethod',
        validValues: Array.from(VALID_HTTP_METHODS)
      })
    }

    // ── Validate costMicroUsdc ──
    const costResult = parseCostMicroUsdc(costMicroUsdc)
    if (!costResult.valid) {
      return reply.code(400).send({ error: costResult.error })
    }

    // ── Validate timeoutMs ──
    let resolvedTimeout = 8000
    if (timeoutMs !== undefined && timeoutMs !== null) {
      const parsed = parseInt(timeoutMs, 10)
      if (Number.isNaN(parsed) || parsed < 1000 || parsed > 60000) {
        return reply.code(400).send({ error: 'timeoutMs must be an integer between 1000 and 60000' })
      }
      resolvedTimeout = parsed
    }

    // ── Validate tags ──
    const tagsResult = validateTags(tags)
    if (!tagsResult.valid) {
      return reply.code(400).send({ error: tagsResult.error })
    }

    // ── Find provider for this user ──
    let provider
    try {
      provider = await prisma.provider.findUnique({
        where: { userId }
      })
    } catch (err) {
      console.error('[POST /provider/routes] Provider lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to verify provider status' })
    }

    if (!provider) {
      return reply.code(403).send({ error: 'You must register as a provider first' })
    }

    // ── Validate the route by making a test call ──
    const validation = await validateRoute({
      upstreamUrl,
      httpMethod: resolvedMethod,
      timeoutMs: resolvedTimeout,
      testPayload
    })

    if (!validation.passed) {
      return reply.code(400).send({
        error: 'Route validation failed',
        detail: validation.error,
        hint: 'Your endpoint must be reachable and return valid JSON'
      })
    }

    // ── Create the route ──
    let route
    try {
      route = await prisma.providerRoute.create({
        data: {
          providerId: provider.id,
          name: name.trim(),
          description: description.trim(),
          category,
          tags: tagsResult.value,
          upstreamUrl: upstreamUrl.trim(),
          httpMethod: resolvedMethod,
          timeoutMs: resolvedTimeout,
          asyncMode: false,
          testPayload: testPayload ?? null,
          costMicroUsdc: costResult.value,
          avgLatencyMs: validation.latencyMs,
          openApiSpec: openApiSpec ?? null,
          isPublic: false,
          isActive: true
        }
      })
    } catch (err) {
      console.error('[POST /provider/routes] Route creation failed:', err.message)
      return reply.code(500).send({ error: 'Failed to create route' })
    }

    return reply.code(201).send({
      route: serializeProviderRoute(route),
      message: 'Route submitted for review. Routes are reviewed within 24 hours.'
    })
  })

  // ─── PUT /provider/routes/:id ────────────────────────────────────────────
  fastify.put('/provider/routes/:id', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { id: routeId } = request.params

    if (!routeId || typeof routeId !== 'string') {
      return reply.code(400).send({ error: 'Route ID is required' })
    }

    const body = request.body ?? {}

    // Reject disallowed fields explicitly
    if (body.upstreamUrl !== undefined) {
      return reply.code(400).send({ error: 'Cannot update upstreamUrl. Create a new route instead.' })
    }
    if (body.httpMethod !== undefined) {
      return reply.code(400).send({ error: 'Cannot update httpMethod. Create a new route instead.' })
    }
    if (body.isPublic !== undefined) {
      return reply.code(400).send({ error: 'Cannot update isPublic directly.' })
    }

    // Verify ownership: route must belong to provider owned by this user
    let route
    try {
      route = await prisma.providerRoute.findFirst({
        where: {
          id: routeId,
          provider: {
            userId
          }
        }
      })
    } catch (err) {
      console.error('[PUT /provider/routes/:id] Route lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to verify route ownership' })
    }

    if (!route) {
      return reply.code(404).send({ error: 'Route not found' })
    }

    // Build update data from allowed fields only
    const updateData = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length < 3 || body.name.length > 100) {
        return reply.code(400).send({ error: 'name must be between 3 and 100 characters' })
      }
      updateData.name = body.name.trim()
    }

    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.length < 10 || body.description.length > 1000) {
        return reply.code(400).send({ error: 'description must be between 10 and 1000 characters' })
      }
      updateData.description = body.description.trim()
    }

    if (body.tags !== undefined) {
      const tagsResult = validateTags(body.tags)
      if (!tagsResult.valid) {
        return reply.code(400).send({ error: tagsResult.error })
      }
      updateData.tags = tagsResult.value
    }

    if (body.costMicroUsdc !== undefined) {
      const costResult = parseCostMicroUsdc(body.costMicroUsdc)
      if (!costResult.valid) {
        return reply.code(400).send({ error: costResult.error })
      }
      updateData.costMicroUsdc = costResult.value
    }

    if (body.timeoutMs !== undefined) {
      const parsed = parseInt(body.timeoutMs, 10)
      if (Number.isNaN(parsed) || parsed < 1000 || parsed > 60000) {
        return reply.code(400).send({ error: 'timeoutMs must be an integer between 1000 and 60000' })
      }
      updateData.timeoutMs = parsed
    }

    if (body.testPayload !== undefined) {
      updateData.testPayload = body.testPayload
    }

    if (body.openApiSpec !== undefined) {
      updateData.openApiSpec = body.openApiSpec
    }

    // Any update triggers re-review
    updateData.isPublic = false

    // If no valid fields to update
    if (Object.keys(updateData).length === 1 && updateData.isPublic !== undefined) {
      return reply.code(400).send({ error: 'No valid fields provided for update' })
    }

    let updated
    try {
      updated = await prisma.providerRoute.update({
        where: { id: routeId },
        data: updateData
      })
    } catch (err) {
      console.error('[PUT /provider/routes/:id] Route update failed:', err.message)
      return reply.code(500).send({ error: 'Failed to update route' })
    }

    return reply.code(200).send({ route: serializeProviderRoute(updated) })
  })

  // ─── DELETE /provider/routes/:id ─────────────────────────────────────────
  fastify.delete('/provider/routes/:id', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { id: routeId } = request.params

    if (!routeId || typeof routeId !== 'string') {
      return reply.code(400).send({ error: 'Route ID is required' })
    }

    // Verify ownership
    let route
    try {
      route = await prisma.providerRoute.findFirst({
        where: {
          id: routeId,
          provider: {
            userId
          }
        }
      })
    } catch (err) {
      console.error('[DELETE /provider/routes/:id] Route lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to verify route ownership' })
    }

    if (!route) {
      return reply.code(404).send({ error: 'Route not found' })
    }

    // Soft delete: deactivate and unpublish
    try {
      await prisma.providerRoute.update({
        where: { id: routeId },
        data: {
          isActive: false,
          isPublic: false
        }
      })
    } catch (err) {
      console.error('[DELETE /provider/routes/:id] Route deactivation failed:', err.message)
      return reply.code(500).send({ error: 'Failed to deactivate route' })
    }

    return reply.code(204).send()
  })

  // ─── GET /provider/earnings ──────────────────────────────────────────────
  fastify.get('/provider/earnings', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user

    let provider
    try {
      provider = await prisma.provider.findUnique({
        where: { userId },
        include: { earnings: true }
      })
    } catch (err) {
      console.error('[GET /provider/earnings] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch earnings' })
    }

    if (!provider) {
      return reply.code(404).send({ error: 'Not registered as a provider' })
    }

    return reply.code(200).send(serializeEarnings(provider.earnings))
  })

  // ─── POST /provider/payout ───────────────────────────────────────────────
  fastify.post('/provider/payout', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { amountMicroUsdc, payoutMethod, recipientWallet } = request.body ?? {}

    // ── Validate amountMicroUsdc ──
    if (amountMicroUsdc === undefined || amountMicroUsdc === null) {
      return reply.code(400).send({ error: 'amountMicroUsdc is required' })
    }
    const strAmount = String(amountMicroUsdc).trim()
    if (!/^\d+$/.test(strAmount)) {
      return reply.code(400).send({ error: 'amountMicroUsdc must be a positive integer' })
    }
    let parsedAmount
    try {
      parsedAmount = BigInt(strAmount)
    } catch {
      return reply.code(400).send({ error: 'amountMicroUsdc is not a valid integer' })
    }
    if (parsedAmount < 10_000_000n) {
      return reply.code(400).send({ error: 'Minimum payout is 10,000,000 micro-USDC ($10 USDC)' })
    }

    // ── Validate payoutMethod ──
    if (!payoutMethod || typeof payoutMethod !== 'string') {
      return reply.code(400).send({ error: 'payoutMethod is required' })
    }
    if (!VALID_PAYOUT_METHODS.has(payoutMethod)) {
      return reply.code(400).send({
        error: 'Invalid payoutMethod',
        detail: 'BANK_TRANSFER is not implemented yet. Use CRYPTO_WALLET or MOBILE_MONEY.'
      })
    }

    // ── Validate recipientWallet ──
    if (!recipientWallet || typeof recipientWallet !== 'string') {
      return reply.code(400).send({ error: 'recipientWallet is required' })
    }
    if (recipientWallet.trim().length === 0) {
      return reply.code(400).send({ error: 'recipientWallet must not be empty' })
    }

    // ── Find provider and verify earnings in a transaction ──
    let provider
    let earnings
    try {
      const result = await prisma.$transaction(async (tx) => {
        const p = await tx.provider.findUnique({
          where: { userId },
          include: { earnings: true }
        })

        if (!p || !p.earnings) {
          return { error: 'not_found' }
        }

        if (p.earnings.balance < parsedAmount) {
          return {
            error: 'insufficient',
            available: p.earnings.balance.toString()
          }
        }

        // Decrement earnings balance
        await tx.providerEarnings.update({
          where: { providerId: p.id },
          data: { balance: { decrement: parsedAmount } }
        })

        // Create payout record
        const payout = await tx.payout.create({
          data: {
            providerId: p.id,
            amountMicroUsdc: parsedAmount,
            recipientWallet: recipientWallet.trim(),
            payoutMethod,
            status: 'PENDING'
          }
        })

        return { payout, provider: p }
      })

      if (result.error === 'not_found') {
        return reply.code(404).send({ error: 'Not registered as a provider' })
      }

      if (result.error === 'insufficient') {
        return reply.code(400).send({
          error: 'Insufficient earnings balance',
          available: result.available
        })
      }

      return reply.code(201).send({
        id: result.payout.id,
        providerId: result.payout.providerId,
        amountMicroUsdc: result.payout.amountMicroUsdc.toString(),
        recipientWallet: result.payout.recipientWallet,
        payoutMethod: result.payout.payoutMethod,
        status: result.payout.status,
        createdAt: result.payout.createdAt
      })
    } catch (err) {
      console.error('[POST /provider/payout] Payout creation failed:', err.message)
      return reply.code(500).send({ error: 'Failed to create payout request' })
    }
  })
}
