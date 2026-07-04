import { PrivyClient } from '@privy-io/server-auth'
import { config } from '../config.js'

/**
 * Single PrivyClient instance for the application.
 * Initialized once at module load using validated config.
 */
const privy = new PrivyClient(config.PRIVY_APP_ID, config.PRIVY_APP_SECRET)

/**
 * Verifies a Privy authentication token and extracts user identity claims.
 *
 * Wallet lookup is strictly Solana — this platform is Solana-first
 * (see SOLANA_TREASURY_ADDRESS in config), and the frontend's Privy
 * config creates Solana-only embedded wallets to match.
 *
 * @param {string} token - The Privy auth token to verify
 * @returns {Promise<{did: string, walletAddress: string|null, email: string|null}>}
 * @throws {Error} If the token is invalid, expired, or verification fails
 */
export async function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('token is required and must be a string')
  }

  const verifiedClaims = await privy.verifyAuthToken(token)

  const walletAccount = verifiedClaims.linkedAccounts?.find(
    (account) => account.type === 'wallet' && account.chainType === 'solana'
  )

  const emailAccount = verifiedClaims.linkedAccounts?.find(
    (account) => account.type === 'email'
  )

  return {
    did: verifiedClaims.userId,
    walletAddress: walletAccount?.address ?? null,
    email: emailAccount?.address ?? null
  }
}
