import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import { decryptNote, verifyHMAC } from './crypto'
import type { EncryptedNotePayload, NotePayload, DaemonConfig } from './types'

const SIGNATURE_HEADER = 'x-vaultcast-signature'
const MAX_BODY_BYTES = 1024 * 512  // 512 KB — generous ceiling for a structured note

// ─── Server factory ───────────────────────────────────────────────────────────

export function createServer(secretKey: Uint8Array, sharedSecret: string, config: DaemonConfig) {
  const fastify = Fastify({
    logger: config.daemon.logLevel === 'debug',
    bodyLimit: MAX_BODY_BYTES,
  })

  // ── Health check (unauthenticated — mobile uses this to detect daemon) ──────
  fastify.get('/status', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      adapter: config.adapter.type,
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

    let plaintext: string
    try {
      plaintext = await decryptNote(payload, secretKey)
    } catch (err) {
      console.error('[server] Decryption failed:', err)
      return reply.status(422).send({ error: 'Decryption failed.' })
    }

    let note: NotePayload
    try {
      note = JSON.parse(plaintext) as NotePayload
    } catch {
      return reply.status(422).send({ error: 'Decrypted payload is not valid JSON.' })
    }

    try {
      const filePath = writeNoteToFile(note, config)
      console.log(`[server] Note written: ${filePath}`)
      return reply.status(201).send({ success: true, path: filePath })
    } catch (err) {
      console.error('[server] Failed to write note:', err)
      return reply.status(500).send({ error: 'Failed to write note to disk.' })
    }
  })

  return fastify
}

// ─── File writing ─────────────────────────────────────────────────────────────

/**
 * Write a decrypted NotePayload as a .md file.
 * Tries the configured vault path first; falls back to the fallback folder.
 */
function writeNoteToFile(note: NotePayload, config: DaemonConfig): string {
  const filename = sanitizeFilename(note.title || 'untitled') + '.md'
  const content = buildMarkdown(note)

  // Try vault path first
  const vaultTarget = path.join(config.adapter.vaultPath, filename)
  const fallbackTarget = path.join(config.adapter.fallbackPath, filename)

  try {
    if (fs.existsSync(config.adapter.vaultPath)) {
      fs.writeFileSync(vaultTarget, content, 'utf-8')
      return vaultTarget
    }
  } catch (err) {
    console.warn('[server] Vault path unavailable, falling back:', err)
  }

  // Fallback folder
  fs.mkdirSync(config.adapter.fallbackPath, { recursive: true })
  fs.writeFileSync(fallbackTarget, content, 'utf-8')
  return fallbackTarget
}

/**
 * Assemble the final .md file content from a NotePayload.
 */
function buildMarkdown(note: NotePayload): string {
  const fm = note.frontmatter ?? {}
  const frontmatter = [
    '---',
    `title: "${note.title}"`,
    `date: ${fm['date'] ?? new Date().toISOString().split('T')[0]}`,
    `tags: [${((fm['tags'] as string[]) ?? []).join(', ')}]`,
    `source: vaultcast`,
    fm['duration'] ? `duration: ${fm['duration']}` : null,
    fm['language'] ? `language: ${fm['language']}` : null,
    '---',
  ]
    .filter(Boolean)
    .join('\n')

  return `${frontmatter}\n\n${note.body}\n`
}

/**
 * Strip characters that are unsafe in file names across macOS, Windows, Linux.
 */
function sanitizeFilename(title: string): string {
  return title
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 100)
}
