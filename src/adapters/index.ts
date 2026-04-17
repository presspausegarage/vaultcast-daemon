// Adapter factory — pick the right adapter implementation from config.
// Callers (server.ts) depend only on the Adapter interface, not on any concrete
// class, so adding a new target app (Logseq, Affine, Notion, Anytype) means
// adding a file here and one case below — no changes to server.ts.

import type { Adapter, DaemonConfig } from '../types'
import { ObsidianAdapter } from './obsidian'
import { FolderAdapter } from './folder'

export function createAdapter(config: DaemonConfig): Adapter {
  switch (config.adapter.type) {
    case 'obsidian':
      return new ObsidianAdapter(config)

    case 'folder':
      return new FolderAdapter(config)

    // Not yet implemented — we fall back to the generic folder adapter so the
    // daemon still receives notes while the real adapter is being built,
    // rather than rejecting transfers and losing data on the mobile side.
    case 'notion':
    case 'affine':
    case 'logseq':
    case 'anytype':
      console.warn(
        `[adapters] Adapter "${config.adapter.type}" is not implemented yet — ` +
          'falling back to folder adapter. Notes will be written as .md files.'
      )
      return new FolderAdapter(config)

    default: {
      // exhaustiveness check — if config.adapter.type gains a new value and
      // we forget to handle it, this will surface as a TypeScript error here.
      const _exhaustive: never = config.adapter.type
      throw new Error(`Unknown adapter type: ${_exhaustive}`)
    }
  }
}

export type { Adapter } from '../types'
