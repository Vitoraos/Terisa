import { config } from '../config.js'

// ─── DISCORD WEBHOOK FORMATTER ─────────────────────────────────────────────

/**
 * Sends a rich embed notification to Discord via webhook.
 *
 * @param {Object} params
 * @param {string} params.title - Embed title
 * @param {string} params.description - Embed description
 * @param {number} [params.color] - Discord color integer (default: info blue)
 * @param {Array<{name: string, value: string, inline?: boolean}>} [params.fields] - Embed fields
 * @param {string} [params.url] - URL to link from title
 * @param {string} [params.footer] - Footer text
 * @returns {Promise<boolean>}
 */
export async function sendDiscordNotification({ title, description, color, fields, url, footer }) {
  const webhookUrl = config.DISCORD_WEBHOOK_URL
  if (!webhookUrl) {
    console.error('[discord] No DISCORD_WEBHOOK_URL configured')
    return false
  }

  const embed = {
    title: title ?? 'Notification',
    description: description ?? '',
    color: color ?? 0x3b82f6, // Default: blue
    timestamp: new Date().toISOString(),
    fields: fields?.map((f) => ({
      name: f.name,
      value: f.value,
      inline: f.inline ?? false
    })) ?? []
  }

  if (url) {
    embed.url = url
  }

  if (footer) {
    embed.footer = { text: footer }
  }

  const payload = {
    username: 'API Gateway Support',
    avatar_url: 'https://cdn-icons-png.flaticon.com/512/4712/4712035.png',
    embeds: [embed]
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown')
      console.error(`[discord] Webhook failed: ${res.status} ${text}`)
      return false
    }

    return true
  } catch (err) {
    console.error('[discord] Failed to send notification:', err.message)
    return false
  }
}

// ─── SLACK WEBHOOK FORMATTER ───────────────────────────────────────────────

/**
 * Sends a Block Kit notification to Slack via incoming webhook.
 *
 * @param {Object} params
 * @param {string} params.title - Header text
 * @param {string} params.text - Main message text (mrkdwn format)
 * @param {Array<{type: string, text: string}>} [params.blocks] - Additional Block Kit blocks
 * @param {string} [params.footer] - Footer text
 * @returns {Promise<boolean>}
 */
export async function sendSlackNotification({ title, text, blocks, footer }) {
  const webhookUrl = config.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    console.error('[slack] No SLACK_WEBHOOK_URL configured')
    return false
  }

  const payloadBlocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: title ?? 'Notification',
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: text ?? ''
      }
    }
  ]

  if (blocks && Array.isArray(blocks)) {
    payloadBlocks.push(...blocks)
  }

  if (footer) {
    payloadBlocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: footer
          }
        ]
      }
    )
  }

  const payload = {
    text: title ?? 'Notification', // Fallback for notifications
    blocks: payloadBlocks
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown')
      console.error(`[slack] Webhook failed: ${res.status} ${text}`)
      return false
    }

    return true
  } catch (err) {
    console.error('[slack] Failed to send notification:', err.message)
    return false
  }
}

// ─── UNIFIED TICKET NOTIFICATION ───────────────────────────────────────────

/**
 * Sends a new support ticket notification to the configured channel(s).
 * Attempts Discord first, falls back to Slack if Discord fails or is not configured.
 *
 * @param {Object} ticket - SupportTicket object
 * @param {Object} user - User object (email, walletAddress)
 * @param {string|null} diagnosticUrl - URL to diagnostic endpoint (if route-linked)
 * @returns {Promise<boolean>}
 */
export async function notifyNewTicket(ticket, user, diagnosticUrl = null) {
  const categoryColors = {
    BILLING: 0xf59e0b,      // Amber
    TECHNICAL: 0xef4444,    // Red
    ROUTE_SUSPENSION: 0x8b5cf6, // Violet
    GENERAL: 0x3b82f6       // Blue
  }

  const color = categoryColors[ticket.category] ?? categoryColors.GENERAL

  // ── Discord notification ──
  const discordFields = [
    {
      name: 'Category',
      value: ticket.category,
      inline: true
    },
    {
      name: 'Priority',
      value: ticket.priority,
      inline: true
    },
    {
      name: 'Status',
      value: ticket.status,
      inline: true
    },
    {
      name: 'User Email',
      value: user.email ?? 'N/A',
      inline: false
    },
    {
      name: 'Wallet',
      value: user.walletAddress ?? 'N/A',
      inline: false
    }
  ]

  if (ticket.routeId) {
    discordFields.push({
      name: 'Linked Route',
      value: ticket.routeId,
      inline: false
    })
  }

  if (diagnosticUrl) {
    discordFields.push({
      name: 'Diagnostic Report',
      value: `[View Full Diagnostic](${diagnosticUrl})`,
      inline: false
    })
  }

  const discordSent = await sendDiscordNotification({
    title: `🎫 New Support Ticket: ${ticket.subject}`,
    description: ticket.messages?.[0]?.content ?? 'No initial message',
    color,
    fields: discordFields,
    url: diagnosticUrl ?? undefined,
    footer: `Ticket ID: ${ticket.id} • ${new Date(ticket.createdAt).toLocaleString()}`
  })

  if (discordSent) {
    return true
  }

  // ── Slack fallback ──
  let slackText = `*New Support Ticket*\n` +
    `*Subject:* ${ticket.subject}\n` +
    `*Category:* ${ticket.category} | *Priority:* ${ticket.priority} | *Status:* ${ticket.status}\n` +
    `*User:* ${user.email ?? 'N/A'}\n` +
    `*Wallet:* ${user.walletAddress ?? 'N/A'}\n`

  if (ticket.routeId) {
    slackText += `*Linked Route:* ${ticket.routeId}\n`
  }

  if (diagnosticUrl) {
    slackText += `*Diagnostic:* <${diagnosticUrl}|View Full Diagnostic>\n`
  }

  slackText += `\n*Message:*\n${ticket.messages?.[0]?.content ?? 'No initial message'}`

  return await sendSlackNotification({
    title: `🎫 New Support Ticket: ${ticket.subject}`,
    text: slackText,
    footer: `Ticket ID: ${ticket.id} • ${new Date(ticket.createdAt).toLocaleString()}`
  })
}

/**
 * Sends a ticket reply notification (when customer or agent responds).
 *
 * @param {Object} ticket - SupportTicket object
 * @param {Object} message - SupportMessage object
 * @param {Object} sender - User object who sent the message
 * @returns {Promise<boolean>}
 */
export async function notifyTicketReply(ticket, message, sender) {
  const isAgent = message.senderType === 'AGENT'
  const emoji = isAgent ? '💬' : '👤'
  const color = isAgent ? 0x22c55e : 0x6366f1

  const discordSent = await sendDiscordNotification({
    title: `${emoji} Reply on Ticket: ${ticket.subject}`,
    description: message.content,
    color,
    fields: [
      { name: 'From', value: isAgent ? 'Support Agent' : (sender.email ?? 'Customer'), inline: true },
      { name: 'Ticket Status', value: ticket.status, inline: true }
    ],
    footer: `Ticket ID: ${ticket.id} • Reply ID: ${message.id}`
  })

  if (discordSent) return true

  const slackText = `*Reply on Ticket: ${ticket.subject}*\n` +
    `*From:* ${isAgent ? 'Support Agent' : (sender.email ?? 'Customer')}\n` +
    `*Status:* ${ticket.status}\n\n` +
    `${message.content}`

  return await sendSlackNotification({
    title: `${emoji} Reply on Ticket: ${ticket.subject}`,
    text: slackText,
    footer: `Ticket ID: ${ticket.id}`
  })
}
