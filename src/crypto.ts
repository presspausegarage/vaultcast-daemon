import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util'
import keytar from 'keytar'
import type { EncryptedNotePayload } from './types'

const KEYTAR_SERVICE = 'vaultcast-daemon'
const KEYTAR_ACCOUNT_PUBLIC = 'publicKey'
const KEYTAR_ACCOUNT_SECRET = 'secretKey'

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

  return decodeUTF8(decrypted)
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
  const message = encodeUTF8(plaintext)

  const ciphertext = nacl.box(message, nonce, daemonPublicKey, ephemeralKeypair.secretKey)

  return {
    ephemeralPublicKey: encodeBase64(ephemeralKeypair.publicKey),
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  }
}
