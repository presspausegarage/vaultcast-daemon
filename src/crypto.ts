import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import keytar from 'keytar'
import type { EncryptedNotePayload } from './types'

// Use Node's Buffer for string ↔ Uint8Array — avoids tweetnacl-util's
// confusingly named encodeUTF8/decodeUTF8 which are backwards from what
// you'd expect (encodeUTF8 goes Uint8Array→string, decodeUTF8 goes string→Uint8Array)
const toBytes = (s: string): Uint8Array => Buffer.from(s, 'utf8')
const toString = (b: Uint8Array): string => Buffer.from(b).toString('utf8')

const KEYTAR_SERVICE = 'vaultcast-daemon'
const KEYTAR_ACCOUNT_PUBLIC = 'publicKey'
const KEYTAR_ACCOUNT_SECRET = 'secretKey'
const KEYTAR_ACCOUNT_SHARED = 'sharedSecret'

// ─── Keypair management ───────────────────────────────────────────────────────

/**
 * Load the existing keypair from the OS keychain, or generate and store a
 * new one if this is the first run. The secret key never leaves the keychain.
 */
export async function loadOrCreateKeypair(): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const storedPublic = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_PUBLIC)
  const storedSecret = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_SECRET)

  if (storedPublic && storedSecret) {
    return {
      publicKey: decodeBase64(storedPublic),
      secretKey: decodeBase64(storedSecret),
    }
  }

  // First run — generate a fresh Curve25519 keypair
  const keypair = nacl.box.keyPair()

  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_PUBLIC, encodeBase64(keypair.publicKey))
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_SECRET, encodeBase64(keypair.secretKey))

  console.log('[crypto] Generated new Curve25519 keypair and stored in OS keychain.')
  return keypair
}

/**
 * Retrieve just the public key as a base64 string (for embedding in the QR code).
 */
export async function getPublicKeyBase64(): Promise<string> {
  const stored = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_PUBLIC)
  if (!stored) throw new Error('No keypair found. Call loadOrCreateKeypair() first.')
  return stored
}

// ─── Decryption ───────────────────────────────────────────────────────────────

/**
 * Decrypt an incoming encrypted note payload using NaCl box.
 *
 * The mobile app encrypts each note with:
 *   nacl.box(message, nonce, daemonPublicKey, mobileEphemeralSecretKey)
 *
 * We decrypt with:
 *   nacl.box.open(ciphertext, nonce, mobileEphemeralPublicKey, daemonSecretKey)
 *
 * Returns the decrypted plaintext string, or throws if decryption fails.
 */
export async function decryptNote(
  payload: EncryptedNotePayload,
  secretKey: Uint8Array
): Promise<string> {
  const ephemeralPublicKey = decodeBase64(payload.ephemeralPublicKey)
  const nonce = decodeBase64(payload.nonce)
  const ciphertext = decodeBase64(payload.ciphertext)

  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, secretKey)

  if (!decrypted) {
    throw new Error('Decryption failed — payload may be corrupt or from an unpaired device.')
  }

  return toString(decrypted)
}

// ─── Shared secret (HMAC auth) ────────────────────────────────────────────────

/**
 * Load the shared secret from the OS keychain, or generate and store a new one.
 * The secret is included in the QR payload once and stored permanently on both sides.
 */
export async function loadOrCreateSharedSecret(): Promise<string> {
  const stored = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_SHARED)
  if (stored) return stored

  const secret = randomBytes(32).toString('hex')
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_SHARED, secret)
  console.log('[crypto] Generated new shared secret and stored in OS keychain.')
  return secret
}

/**
 * Compute HMAC-SHA256 of a request body using the shared secret.
 * Used in the test helper to simulate a signed mobile request.
 */
export function computeHMAC(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Verify an incoming HMAC signature against the expected value.
 * Uses timingSafeEqual to prevent timing attacks.
 */
export function verifyHMAC(secret: string, body: string, signature: string): boolean {
  const expected = computeHMAC(secret, body)
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  } catch {
    // Buffers of different lengths throw — treat as invalid
    return false
  }
}

// ─── Test helper (dev only) ───────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using a given public key.
 * Used in development to simulate what the mobile app will send.
 * Should not ship in production mobile code — this lives in the daemon only for testing.
 */
export function encryptNoteForTesting(
  plaintext: string,
  daemonPublicKey: Uint8Array
): EncryptedNotePayload {
  const ephemeralKeypair = nacl.box.keyPair()
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const message = toBytes(plaintext)

  const ciphertext = nacl.box(message, nonce, daemonPublicKey, ephemeralKeypair.secretKey)

  return {
    ephemeralPublicKey: encodeBase64(ephemeralKeypair.publicKey),
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  }
}
