// Fixed: ADMIN_SECRET comparison replaced with timingSafeEqual (Fix 4)
import { prisma } from '../lib/prisma.js'
import { timingSafeEqual } from 'crypto'
import { notifyNewTicket, notifyTicketReply } from '../lib/notifications.js'

// Timing-safe admin secret verification (prevents timing attacks)
function verifyAdminSecret(providedSecret) {
  const expected = config.ADMIN_SECRET ?? ''
  if (!providedSecret || !expected) return false
  const providedBuf = Buffer.from(providedSecret, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

const VALID_TICKET_CATEGORIES = new Set([
  'BILLING',
  'TECHNICAL',
  'ROUTE_SUSPENSION',
  'GENERAL'
])

const VALID_TICKET_PRIORITIES = new Set([
  'LOW',
  'NORMAL',
  'HIGH',
  'URGENT'
])

const VALID_TICKET_STATUSES = new Set([
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED'
])

// ─── HELPER: Build diagnostic URL for route-linked tickets ─────────────────

function buildDiagnosticUrl(routeId) {
  const baseUrl = process.env.GATEWAY_BASE_URL ?? config.GATEWAY_BASE_URL
  if (!baseUrl || !routeId) return null
  return `${baseUrl}/v1/support/route/${routeId}/diagnostic`
}

// ─── ROUTE PLUGIN ──────────────────────────────────────────────────────────

/**
 * Support ticket routes — customer support messaging system.
 *
 * Customer endpoints (JWT required):
 *   POST /support/tickets              — Create a new ticket
 *   GET  /support/tickets              — List my tickets
 *   GET  /support/tickets/:id          — Get ticket + messages
 *   POST /support/tickets/:id/messages — Reply to my ticket
 *
 * Admin endpoints (X-Admin-Secret header):
 *   GET  /support/admin/tickets        — List all open tickets
 *   GET  /support/admin/tickets/:id    — Full ticket with diagnostic
 *   POST /support/admin/tickets/:id/messages — Agent reply
 *   PUT  /support/admin/tickets/:id    — Update status/priority
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function supportTicketRoutes(fastify, options) {

  // ─── CUSTOMER: POST /support/tickets ─────────────────────────────────────
  fastify.post('/support/tickets', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { subject, message, category, priority, routeId } = request.body ?? {}

    // ── Validate subject ──
    if (!subject || typeof subject !== 'string') {
      return reply.code(400).send({ error: 'subject is required' })
    }
    if (subject.length < 5 || subject.length > 200) {
      return reply.code(400).send({ error: 'subject must be between 5 and 200 characters' })
    }

    // ── Validate message ──
    if (!message || typeof message !== 'string') {
      return reply.code(400).send({ error: 'message is required' })
    }
    if (message.length < 10 || message.length > 5000) {
      return reply.code(400).send({ error: 'message must be between 10 and 5000 characters' })
    }

    // ── Validate category ──
    const resolvedCategory = category ?? 'GENERAL'
    if (!VALID_TICKET_CATEGORIES.has(resolvedCategory)) {
      return reply.code(400).send({
        error: 'Invalid category',
        validValues: Array.from(VALID_TICKET_CATEGORIES)
      })
    }

    // ── Validate priority ──
    const resolvedPriority = priority ?? 'NORMAL'
    if (!VALID_TICKET_PRIORITIES.has(resolvedPriority)) {
      return reply.code(400).send({
        error: 'Invalid priority',
        validValues: Array.from(VALID_TICKET_PRIORITIES)
      })
    }

    // ── Validate routeId if provided ──
    if (routeId !== undefined && routeId !== null) {
      if (typeof routeId !== 'string') {
        return reply.code(400).send({ error: 'routeId must be a string' })
      }

      let route
      try {
        route = await prisma.providerRoute.findUnique({
          where: { id: routeId }
        })
      } catch (err) {
        console.error('[POST /support/tickets] Route lookup failed:', err.message)
        return reply.code(500).send({ error: 'Failed to verify route' })
      }

      if (!route) {
        return reply.code(404).send({ error: 'Linked route not found' })
      }
    }

    // ── Create ticket with initial message ──
    let ticket
    try {
      ticket = await prisma.$transaction(async (tx) => {
        const t = await tx.supportTicket.create({
          data: {
            userId,
            routeId: routeId ?? null,
            subject: subject.trim(),
            status: 'OPEN',
            priority: resolvedPriority,
            category: resolvedCategory
          }
        })

        await tx.supportMessage.create({
          data: {
            ticketId: t.id,
            senderId: userId,
            senderType: 'CUSTOMER',
            content: message.trim()
          }
        })

        return t
      })
    } catch (err) {
      console.error('[POST /support/tickets] Ticket creation failed:', err.message)
      return reply.code(500).send({ error: 'Failed to create ticket' })
    }

    // ── Fetch user for notification ──
    let user
    try {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, walletAddress: true }
      })
    } catch (err) {
      console.error('[POST /support/tickets] User fetch failed:', err.message)
      user = { email: null, walletAddress: null }
    }

    // ── Fetch ticket with messages for notification ──
    let ticketWithMessages
    try {
      ticketWithMessages = await prisma.supportTicket.findUnique({
        where: { id: ticket.id },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 1
          }
        }
      })
    } catch (err) {
      console.error('[POST /support/tickets] Ticket fetch for notification failed:', err.message)
      ticketWithMessages = ticket
    }

    // ── Send Discord/Slack notification ──
    const diagnosticUrl = buildDiagnosticUrl(routeId)
    notifyNewTicket(ticketWithMessages, user, diagnosticUrl).catch((err) => {
      console.error('[POST /support/tickets] Notification failed:', err.message)
    })

    return reply.code(201).send({
      id: ticket.id,
      userId: ticket.userId,
      routeId: ticket.routeId,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      createdAt: ticket.createdAt,
      message: 'Ticket created successfully. A support agent will respond shortly.'
    })
  })

  // ─── CUSTOMER: GET /support/tickets ──────────────────────────────────────
  fastify.get('/support/tickets', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { status, page: rawPage, limit: rawLimit } = request.query ?? {}

    // Parse pagination
    let page = 1
    let limit = 20
    if (rawPage !== undefined) {
      const parsed = parseInt(rawPage, 10)
      if (!Number.isNaN(parsed)) page = Math.max(1, parsed)
    }
    if (rawLimit !== undefined) {
      const parsed = parseInt(rawLimit, 10)
      if (!Number.isNaN(parsed)) limit = Math.max(1, Math.min(50, parsed))
    }

    const where = { userId }
    if (status && VALID_TICKET_STATUSES.has(status)) {
      where.status = status
    }

    let tickets
    let total
    try {
      tickets = await prisma.supportTicket.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: {
            select: { messages: true }
          }
        }
      })

      total = await prisma.supportTicket.count({ where })
    } catch (err) {
      console.error('[GET /support/tickets] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch tickets' })
    }

    return reply.code(200).send({
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        category: t.category,
        messageCount: t._count.messages,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      })),
      page,
      limit,
      total
    })
  })

  // ─── CUSTOMER: GET /support/tickets/:id ──────────────────────────────────
  fastify.get('/support/tickets/:id', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { id: ticketId } = request.params

    if (!ticketId || typeof ticketId !== 'string') {
      return reply.code(400).send({ error: 'Ticket ID is required' })
    }

    let ticket
    try {
      ticket = await prisma.supportTicket.findFirst({
        where: {
          id: ticketId,
          userId
        },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              sender: {
                select: { email: true }
              }
            }
          },
          route: {
            select: {
              id: true,
              name: true,
              isActive: true,
              suspensionReason: true
            }
          }
        }
      })
    } catch (err) {
      console.error('[GET /support/tickets/:id] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch ticket' })
    }

    if (!ticket) {
      return reply.code(404).send({ error: 'Ticket not found' })
    }

    return reply.code(200).send({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      resolvedAt: ticket.resolvedAt,
      route: ticket.route,
      messages: ticket.messages.map((m) => ({
        id: m.id,
        senderType: m.senderType,
        senderEmail: m.sender?.email ?? null,
        content: m.content,
        isInternal: m.isInternal,
        createdAt: m.createdAt
      }))
    })
  })

  // ─── CUSTOMER: POST /support/tickets/:id/messages ────────────────────────
  fastify.post('/support/tickets/:id/messages', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const { userId } = request.user
    const { id: ticketId } = request.params
    const { content } = request.body ?? {}

    if (!ticketId || typeof ticketId !== 'string') {
      return reply.code(400).send({ error: 'Ticket ID is required' })
    }

    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'content is required' })
    }
    if (content.length < 1 || content.length > 5000) {
      return reply.code(400).send({ error: 'content must be between 1 and 5000 characters' })
    }

    // Verify ticket exists and belongs to user, and is not closed
    let ticket
    try {
      ticket = await prisma.supportTicket.findFirst({
        where: {
          id: ticketId,
          userId
        }
      })
    } catch (err) {
      console.error('[POST /support/tickets/:id/messages] Ticket lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to verify ticket' })
    }

    if (!ticket) {
      return reply.code(404).send({ error: 'Ticket not found' })
    }

    if (ticket.status === 'CLOSED') {
      return reply.code(400).send({ error: 'Cannot reply to a closed ticket. Open a new ticket instead.' })
    }

    // Create message
    let message
    try {
      message = await prisma.supportMessage.create({
        data: {
          ticketId,
          senderId: userId,
          senderType: 'CUSTOMER',
          content: content.trim()
        }
      })

      // Update ticket timestamp
      await prisma.supportTicket.update({
        where: { id: ticketId },
        data: { updatedAt: new Date() }
      })
    } catch (err) {
      console.error('[POST /support/tickets/:id/messages] Message creation failed:', err.message)
      return reply.code(500).send({ error: 'Failed to send message' })
    }

    // Notify support team
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true }
    }).catch(() => null)

    notifyTicketReply(ticket, message, user ?? { email: null }).catch((err) => {
      console.error('[POST /support/tickets/:id/messages] Notification failed:', err.message)
    })

    return reply.code(201).send({
      id: message.id,
      senderType: message.senderType,
      content: message.content,
      createdAt: message.createdAt
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS (X-Admin-Secret header authentication)
  // ════════════════════════════════════════════════════════════════════════

  // ─── ADMIN: GET /support/admin/tickets ───────────────────────────────────
  fastify.get('/support/admin/tickets', async (request, reply) => {
    // Verify admin secret
    const adminSecret = request.headers['x-admin-secret']
    if (!verifyAdminSecret(adminSecret)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { status, category, page: rawPage, limit: rawLimit } = request.query ?? {}

    let page = 1
    let limit = 20
    if (rawPage !== undefined) {
      const parsed = parseInt(rawPage, 10)
      if (!Number.isNaN(parsed)) page = Math.max(1, parsed)
    }
    if (rawLimit !== undefined) {
      const parsed = parseInt(rawLimit, 10)
      if (!Number.isNaN(parsed)) limit = Math.max(1, Math.min(100, parsed))
    }

    const where = {}
    if (status && VALID_TICKET_STATUSES.has(status)) {
      where.status = status
    }
    if (category && VALID_TICKET_CATEGORIES.has(category)) {
      where.category = category
    }

    let tickets
    let total
    try {
      tickets = await prisma.supportTicket.findMany({
        where,
        orderBy: [
          { priority: 'desc' },
          { updatedAt: 'desc' }
        ],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: {
            select: {
              email: true,
              walletAddress: true
            }
          },
          _count: {
            select: { messages: true }
          }
        }
      })

      total = await prisma.supportTicket.count({ where })
    } catch (err) {
      console.error('[GET /support/admin/tickets] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch tickets' })
    }

    return reply.code(200).send({
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        category: t.category,
        userEmail: t.user.email,
        userWallet: t.user.walletAddress,
        messageCount: t._count.messages,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      })),
      page,
      limit,
      total
    })
  })

  // ─── ADMIN: GET /support/admin/tickets/:id ───────────────────────────────
  fastify.get('/support/admin/tickets/:id', async (request, reply) => {
    const adminSecret = request.headers['x-admin-secret']
    if (!verifyAdminSecret(adminSecret)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { id: ticketId } = request.params

    if (!ticketId || typeof ticketId !== 'string') {
      return reply.code(400).send({ error: 'Ticket ID is required' })
    }

    let ticket
    try {
      ticket = await prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              sender: {
                select: { email: true }
              }
            }
          },
          user: {
            select: {
              id: true,
              email: true,
              walletAddress: true,
              baseWallet: true,
              createdAt: true
            }
          },
          route: {
            include: {
              provider: {
                include: {
                  earnings: true
                }
              }
            }
          }
        }
      })
    } catch (err) {
      console.error('[GET /support/admin/tickets/:id] Database query failed:', err.message)
      return reply.code(500).send({ error: 'Failed to fetch ticket' })
    }

    if (!ticket) {
      return reply.code(404).send({ error: 'Ticket not found' })
    }

    // Build diagnostic URL if route-linked
    const diagnosticUrl = ticket.routeId ? buildDiagnosticUrl(ticket.routeId) : null

    return reply.code(200).send({
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        resolvedAt: ticket.resolvedAt
      },
      customer: {
        id: ticket.user.id,
        email: ticket.user.email,
        walletAddress: ticket.user.walletAddress,
        baseWallet: ticket.user.baseWallet,
        memberSince: ticket.user.createdAt
      },
      route: ticket.route ? {
        id: ticket.route.id,
        name: ticket.route.name,
        isActive: ticket.route.isActive,
        isPublic: ticket.route.isPublic,
        suspensionReason: ticket.route.suspensionReason,
        upstreamUrl: ticket.route.upstreamUrl,
        providerEarnings: ticket.route.provider?.earnings
          ? {
              balance: ticket.route.provider.earnings.balance.toString(),
              lifetime: ticket.route.provider.earnings.lifetime.toString()
            }
          : null
      } : null,
      diagnosticUrl,
      messages: ticket.messages.map((m) => ({
        id: m.id,
        senderType: m.senderType,
        senderEmail: m.sender?.email ?? null,
        content: m.content,
        isInternal: m.isInternal,
        createdAt: m.createdAt
      }))
    })
  })

  // ─── ADMIN: POST /support/admin/tickets/:id/messages ────────────────────
  fastify.post('/support/admin/tickets/:id/messages', async (request, reply) => {
    const adminSecret = request.headers['x-admin-secret']
    if (!verifyAdminSecret(adminSecret)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { id: ticketId } = request.params
    const { content, isInternal } = request.body ?? {}

    if (!ticketId || typeof ticketId !== 'string') {
      return reply.code(400).send({ error: 'Ticket ID is required' })
    }

    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'content is required' })
    }
    if (content.length < 1 || content.length > 5000) {
      return reply.code(400).send({ error: 'content must be between 1 and 5000 characters' })
    }

    // Verify ticket exists
    let ticket
    try {
      ticket = await prisma.supportTicket.findUnique({
        where: { id: ticketId }
      })
    } catch (err) {
      console.error('[POST /support/admin/tickets/:id/messages] Ticket lookup failed:', err.message)
      return reply.code(500).send({ error: 'Failed to verify ticket' })
    }

    if (!ticket) {
      return reply.code(404).send({ error: 'Ticket not found' })
    }

    if (ticket.status === 'CLOSED') {
      return reply.code(400).send({ error: 'Cannot reply to a closed ticket' })
    }

    // Create agent message
    let message
    try {
      message = await prisma.supportMessage.create({
        data: {
          ticketId,
          senderId: 'admin', // System identifier for agents
          senderType: 'AGENT',
          content: content.trim(),
          isInternal: isInternal === true
        }
      })

      // Update ticket status to IN_PROGRESS if it was OPEN
      if (ticket.status === 'OPEN') {
        await prisma.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: 'IN_PROGRESS',
            updatedAt: new Date()
          }
        })
      } else {
        await prisma.supportTicket.update({
          where: { id: ticketId },
          data: { updatedAt: new Date() }
        })
      }
    } catch (err) {
      console.error('[POST /support/admin/tickets/:id/messages] Message creation failed:', err.message)
      return reply.code(500).send({ error: 'Failed to send message' })
    }

    // Notify customer (only for non-internal messages)
    if (!message.isInternal) {
      notifyTicketReply(ticket, message, { email: 'Support Team' }).catch((err) => {
        console.error('[POST /support/admin/tickets/:id/messages] Notification failed:', err.message)
      })
    }

    return reply.code(201).send({
      id: message.id,
      senderType: message.senderType,
      content: message.content,
      isInternal: message.isInternal,
      createdAt: message.createdAt
    })
  })

  // ─── ADMIN: PUT /support/admin/tickets/:id ────────────────────────────────
  fastify.put('/support/admin/tickets/:id', async (request, reply) => {
    const adminSecret = request.headers['x-admin-secret']
    if (!verifyAdminSecret(adminSecret)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { id: ticketId } = request.params
    const { status, priority } = request.body ?? {}

    if (!ticketId || typeof ticketId !== 'string') {
      return reply.code(400).send({ error: 'Ticket ID is required' })
    }

    const updateData = {}

    if (status !== undefined) {
      if (!VALID_TICKET_STATUSES.has(status)) {
        return reply.code(400).send({
          error: 'Invalid status',
          validValues: Array.from(VALID_TICKET_STATUSES)
        })
      }
      updateData.status = status
      if (status === 'RESOLVED') {
        updateData.resolvedAt = new Date()
      }
    }

    if (priority !== undefined) {
      if (!VALID_TICKET_PRIORITIES.has(priority)) {
        return reply.code(400).send({
          error: 'Invalid priority',
          validValues: Array.from(VALID_TICKET_PRIORITIES)
        })
      }
      updateData.priority = priority
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update' })
    }

    updateData.updatedAt = new Date()

    let ticket
    try {
      ticket = await prisma.supportTicket.update({
        where: { id: ticketId },
        data: updateData
      })
    } catch (err) {
      if (err.code === 'P2025') {
        return reply.code(404).send({ error: 'Ticket not found' })
      }
      console.error('[PUT /support/admin/tickets/:id] Update failed:', err.message)
      return reply.code(500).send({ error: 'Failed to update ticket' })
    }

    return reply.code(200).send({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      resolvedAt: ticket.resolvedAt,
      updatedAt: ticket.updatedAt
    })
  })
}
