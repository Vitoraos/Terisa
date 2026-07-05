import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor'
import bs58 from 'bs58'
import { config } from '../config.js'
import idl from './terisa_calls.idl.json' with { type: 'json' }

/**
 * Solana on-chain call-receipt client.
 *
 * Wraps the single `record_call` instruction of the `terisa_calls`
 * Anchor program. Used only to anchor a permanent, public receipt of a
 * gateway call that already succeeded and was already billed in
 * Postgres — this module never decides billing, never blocks a
 * response, and its failure never affects gateway behavior.
 *
 * SECURITY NOTE: holds a hot Solana keypair that pays transaction fees
 * for these writes. This is separate from SOLANA_TREASURY_ADDRESS
 * (receive-only, offline key). This wallet should hold only enough SOL
 * for fees/rent — never user funds or provider earnings.
 */

let _program = null
let _walletPublicKey = null

function getProgram() {
  if (_program) {
    return { program: _program, walletPublicKey: _walletPublicKey }
  }

  if (!config.SOLANA_ANCHOR_SECRET_KEY) {
    throw new Error('SOLANA_ANCHOR_SECRET_KEY is not configured')
  }
  if (!config.SOLANA_ANCHOR_PROGRAM_ID) {
    throw new Error('SOLANA_ANCHOR_PROGRAM_ID is not configured')
  }
  if (!config.SOLANA_RPC_URL) {
    throw new Error('SOLANA_RPC_URL is not configured')
  }

  const secretKeyBytes = bs58.decode(config.SOLANA_ANCHOR_SECRET_KEY)
  const keypair = Keypair.fromSecretKey(secretKeyBytes)
  const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed')
  const wallet = new Wallet(keypair)
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })

  const programId = new PublicKey(config.SOLANA_ANCHOR_PROGRAM_ID)
  _program = new Program(idl, programId, provider)
  _walletPublicKey = keypair.publicKey

  console.log(`[solanaCalls] Initialized. Anchoring wallet: ${keypair.publicKey.toBase58()}`)

  return { program: _program, walletPublicKey: _walletPublicKey }
}

/**
 * Anchors a single API call receipt on-chain. Idempotent via PDA
 * derivation — a retry after a partial failure hits "already in use"
 * rather than double-writing (see isAlreadyAnchoredError below).
 *
 * @param {Object} params
 * @param {string} params.callerWallet - Base58 Solana public key of the caller
 * @param {string} params.routeId
 * @param {bigint} params.amountMicroUsdc
 * @param {string} params.referenceId - same referenceId as the Postgres LedgerEntry
 * @returns {Promise<{signature: string, recordAddress: string}>}
 */
export async function anchorCallRecord({ callerWallet, routeId, amountMicroUsdc, referenceId }) {
  const { program, walletPublicKey } = getProgram()
  const callerPubkey = new PublicKey(callerWallet)

  const [recordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('call'), callerPubkey.toBuffer(), Buffer.from(referenceId)],
    program.programId
  )

  const signature = await program.methods
    .recordCall(routeId, new BN(amountMicroUsdc.toString()), referenceId)
    .accounts({
      caller: walletPublicKey,
      record: recordPda,
      systemProgram: PublicKey.default,
    })
    .rpc()

  return { signature, recordAddress: recordPda.toBase58() }
}

/**
 * True if the error means "this exact record already exists on-chain" —
 * i.e. a prior attempt actually succeeded before a crash/timeout
 * prevented recording that in Postgres. Treat as success, not failure.
 */
export function isAlreadyAnchoredError(err) {
  const msg = err?.message ?? ''
  return msg.includes('already in use') || err?.logs?.some((l) => l.includes('already in use'))
}
