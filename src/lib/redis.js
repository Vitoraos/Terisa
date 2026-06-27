import { Redis } from 'ioredis'
import { config } from '../config.js'

function createRedisClient() {
  const client = new Redis(config.REDIS_URL, {
    // Both required for BullMQ — do not change
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Reconnect on failures
    retryStrategy(times) {
      if (times > 10) {
        console.error('[redis] Too many reconnect attempts. Giving up.')
        return null
      }
      return Math.min(times * 200, 3000)
    },
  })

  client.on('connect', () => {
    console.log('[redis] Connected to Upstash Redis')
  })

  client.on('error', (err) => {
    // Log but do not crash — BullMQ handles reconnection
    console.error('[redis] Connection error:', err.message)
  })

  return client
}

export const redis = createRedisClient()
