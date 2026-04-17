// Folder adapter — writes .md files straight into a flat folder.
// This is the generic "no target app" mode: useful if the user wants raw
// markdown in a specific directory and will handle it themselves, or as a
// fallback for target apps that aren't configured. Matches the behaviour of
// config.adapter.type = "folder".

import fs from 'fs'
import type { Adapter, NotePayload, WriteResult, DaemonConfig } from '../types'
import { buildFilename, buildMarkdown, writeMarkdownFile } from './utils'

export class FolderAdapter implements Adapter {
  readonly name = 'folder'

  constructor(private readonly config: DaemonConfig) {}

  async write(note: NotePayload): Promise<WriteResult> {
    const filename = buildFilename(note)
    const content = buildMarkdown(note)

    // Try vault path first. Unlike Obsidian we don't nest inside an inbox
    // subfolder here — the user picked "folder" mode precisely because they
    // want files flat where they told us to put them.
    try {
      if (fs.existsSync(this.config.adapter.vaultPath)) {
        const filePath = writeMarkdownFile(this.config.adapter.vaultPath, filename, content)
        return { success: true, path: filePath }
      }
    } catch (err) {
      console.warn('[folder] Vault path unavailable, falling back:', err)
    }

    // Fallback folder
    try {
      const fallbackPath = writeMarkdownFile(this.config.adapter.fallbackPath, filename, content)
      return { success: true, path: fallbackPath }
    } catch (err) {
      return {
        success: false,
        error: `Failed to write note: ${(err as Error).message}`,
      }
    }
  }
}
