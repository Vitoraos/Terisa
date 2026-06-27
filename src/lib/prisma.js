import { PrismaClient } from '@prisma/client'
import { config } from '../config.js'

const isDev = config.NODE_ENV === 'development'

// In development, attach to globalThis so hot reloads don't create new
// PrismaClient instances and exhaust the connection pool.
const globalForPrisma = globalThis

function createPrismaClient() {
  return new PrismaClient({
    log: isDev
      ? ['query', 'warn', 'error']
      : ['error'],
  })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (isDev) {
  globalForPrisma.prisma = prisma
}
