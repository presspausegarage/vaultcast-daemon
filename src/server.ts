import Fastify from 'fastify'
import { decryptNote, verifyHMAC } from './crypto'
import type { Adapter, EncryptedNotePayload, NotePayload, DaemonConfig } from './types'

const SIGNATURE_HEADER = 'x-vaultcast-signature'
const MAX_BODY_BYTES = 1024 * 512  // 512 KB — generous ceiling for a structured note

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Build the Fastify server. The adapter is injected so server.ts knows nothing
 * about where notes ultimately land — that's the adapter's job. This keeps the
 * HTTP/crypto layer free of target-app branching.
 */
export function createServer(
  secretKey: Uint8Array,
  sharedSecret: string,
  config: DaemonConfig,
  adapter: Adapter
) {
  const fastify = Fastify({
    logger: config.daemon.logLevel === 'debug',
    bodyLimit: MAX_BODY_BYTES,
  })

  // ── Health check (unauthenticated — mobile uses this to detect daemon) ──────
  fastify.get('/status', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      adapter: adapter.name,
    }
  })

  // ── Receive encrypted note ──────────────────────────────────────────────────
  fastify.post<{ Body: EncryptedNotePayload }>('/notes', async (request, reply) => {
    // 1. Verify HMAC signature before doing anything else
    const signature = request.headers[SIGNATURE_HEADER]
    if (!signature || typeof signature !== 'string') {
      return reply.status(401).send({ error: 'Missing signature header.' })
    }

    const rawBody = JSON.stringify(request.body)
    if (!verifyHMAC(sharedSecret, rawBody, signature)) {
      console.warn('[server] Rejected request — invalid HMAC signature.')
      return reply.status(401).send({ error: 'Invalid signature.' })
    }

    // 2. Shape validation
    const payload = request.body
    if (!payload.ephemeralPublicKey || !payload.nonce || !payload.ciphertext) {
      return reply.status(400).send({ error: 'Invalid payload — missing required fields.' })
    }

    // 3. Decrypt
    let plaintext: string
    try {
      plaintext = await decryptNote(payload, secretKey)
    } catch (err) {
      console.error('[server] Decryption failed:', err)
      return reply.status(422).send({ error: 'Decryption failed.' })
    }

    // 4. Parse
    let note: NotePayload
    try {
      note = JSON.parse(plaintext) as NotePayload
    } catch {
      return reply.status(422).send({ error: 'Decrypted payload is not valid JSON.' })
    }

    // 5. Hand off to the adapter — it decides where and how to write.
    try {
      const result = await adapter.write(note)
      if (!result.success) {
        console.error(`[server] Adapter "${adapter.name}" failed:`, result.error)
        return reply.status(500).send({ error: result.error ?? 'Adapter write failed.' })
      }
      console.log(`[server] Note written via ${adapter.name}: ${result.path}`)
      return reply.status(201).send({ success: true, path: result.path })
    } catch (err) {
      console.error(`[server] Adapter "${adapter.name}" threw:`, err)
      return reply.status(500).send({ error: 'Failed to write note.' })
    }
  })

  return fastify
}
