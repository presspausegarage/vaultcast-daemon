import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import { decryptNote } from './crypto'
import type { EncryptedNotePayload, NotePayload, DaemonConfig } from './types'

// ─── Server factory ───────────────────────────────────────────────────────────

export function createServer(secretKey: Uint8Array, config: DaemonConfig) {
  const fastify = Fastify({
    logger: config.daemon.logLevel === 'debug',
  })

  // ── Health check ────────────────────────────────────────────────────────────
  fastify.get('/status', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      adapter: config.adapter.type,
    }
  })

  // ── Receive encrypted note ──────────────────────────────────────────────────
  fastify.post<{ Body: EncryptedNotePayload }>('/notes', async (request, reply) => {
    const payload = request.body

    // Basic shape validation
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
