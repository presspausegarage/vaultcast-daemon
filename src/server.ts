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
 *
 * Filename format: `YYYY-MM-DD-HHmmss-<slugified-title>.md`
 * The timestamp prefix (1) sorts notes chronologically in any file listing
 * and (2) prevents collisions — short transcripts like "voice note" or
 * "what was that" were overwriting each other before this change.
 * We use note.createdAt (ISO 8601 from the mobile capture moment) rather
 * than `new Date()` so the filename reflects when the note was SPOKEN,
 * not when the daemon happened to receive it — queued notes that deliver
 * late still sort correctly.
 */
function writeNoteToFile(note: NotePayload, config: DaemonConfig): string {
  const timestamp = toFilenameTimestamp(note.createdAt)
  const slug = sanitizeFilename(note.title || 'untitled')
  const filename = `${timestamp}-${slug}.md`
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
 * Turn an ISO 8601 timestamp (e.g. "2026-04-16T22:31:45.123Z") into a
 * filesystem-safe, sortable prefix ("2026-04-16-223145").
 * Falls back to the server's current time if the input is missing/invalid —
 * we never want filename generation to fail and drop the note.
 */
function toFilenameTimestamp(iso: string | undefined): string {
  const date = iso ? new Date(iso) : new Date()
  const d = Number.isNaN(date.getTime()) ? new Date() : date
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
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
