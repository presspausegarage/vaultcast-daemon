// Obsidian adapter — writes .md files directly into an Obsidian vault folder.
// Obsidian auto-detects new files on disk and indexes them without any plugin,
// so file-write is the simplest working integration. No REST API or community
// plugin required for MVP. A REST-based variant can live beside this one
// later (src/adapters/obsidian-rest.ts) for features that need it, such as
// appending to daily notes or querying the vault for backlink candidates.

import path from 'path'
import fs from 'fs'
import type { Adapter, NotePayload, WriteResult, DaemonConfig } from '../types'
import { buildFilename, buildMarkdown, writeMarkdownFile } from './utils'

export class ObsidianAdapter implements Adapter {
  readonly name = 'obsidian'

  constructor(private readonly config: DaemonConfig) {}

  async write(note: NotePayload): Promise<WriteResult> {
    const filename = buildFilename(note)
    const content = buildMarkdown(note)

    // Target: <vaultPath>/<inboxFolder>/<filename>
    // Keeping VaultCast notes in a dedicated inbox folder means Obsidian's
    // graph view, daily notes, and any user-organised structure stay clean.
    // The user triages from the inbox into their real structure on desktop.
    const inboxFolder = this.config.adapter.inboxFolder ?? 'VaultCast-Inbox'
    const vaultInbox = path.join(this.config.adapter.vaultPath, inboxFolder)

    // First attempt: write into the vault's inbox subfolder.
    // If the vault root doesn't exist (e.g. external drive unmounted,
    // folder moved since pairing), we fall through to the fallback path.
    try {
      if (fs.existsSync(this.config.adapter.vaultPath)) {
        const filePath = writeMarkdownFile(vaultInbox, filename, content)
        return { success: true, path: filePath }
      }
      console.warn(`[obsidian] Vault path missing: ${this.config.adapter.vaultPath}`)
    } catch (err) {
      console.warn('[obsidian] Vault write failed, falling back:', err)
    }

    // Fallback: drop into the configured fallback folder at vault root
    // (no inbox subfolder — this is already a user-visible "something went wrong"
    // bucket, so burying files one level deeper would just make them harder to find).
    try {
      const fallbackPath = writeMarkdownFile(this.config.adapter.fallbackPath, filename, content)
      return { success: true, path: fallbackPath }
    } catch (err) {
      return {
        success: false,
        error: `Failed to write note to vault or fallback: ${(err as Error).message}`,
      }
    }
  }
}
