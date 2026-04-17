// Shared helpers used by every file-based adapter.
// Keeping these out of any single adapter file means an Obsidian tweak doesn't
// ripple into the Folder adapter, and a future Notion adapter can't accidentally
// reach into file-writing logic it shouldn't care about.

import fs from 'fs'
import path from 'path'
import type { NotePayload } from '../types'

// ─── Filename generation ──────────────────────────────────────────────────────

/**
 * Turn an ISO 8601 timestamp (e.g. "2026-04-16T22:31:45.123Z") into a
 * filesystem-safe, sortable prefix ("2026-04-16-223145").
 * Falls back to the server's current time if the input is missing/invalid —
 * we never want filename generation to fail and drop the note.
 */
export function toFilenameTimestamp(iso: string | undefined): string {
  const date = iso ? new Date(iso) : new Date()
  const d = Number.isNaN(date.getTime()) ? new Date() : date
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Strip characters that are unsafe in file names across macOS, Windows, Linux.
 * Also truncates to 100 chars to keep full paths under Windows' 260-char limit.
 */
export function sanitizeFilename(title: string): string {
  return title
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 100)
}

/**
 * Compose the final on-disk filename from a note's timestamp + title.
 * Example: `2026-04-16-223145-meeting-with-andy.md`
 */
export function buildFilename(note: NotePayload): string {
  const timestamp = toFilenameTimestamp(note.createdAt)
  const slug = sanitizeFilename(note.title || 'untitled')
  return `${timestamp}-${slug}.md`
}

// ─── Markdown assembly ────────────────────────────────────────────────────────

/**
 * Assemble the final .md file content from a NotePayload.
 * Produces YAML frontmatter + body — the format every markdown-native
 * target app (Obsidian, Logseq, Affine) understands natively.
 */
export function buildMarkdown(note: NotePayload): string {
  const fm = note.frontmatter ?? {}
  const frontmatter = [
    '---',
    `title: "${escapeYamlString(note.title)}"`,
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
 * Minimal YAML escape for the title field — quotes and backslashes only.
 * Full YAML escaping isn't needed because the title is always wrapped in "".
 */
function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ─── File writing ─────────────────────────────────────────────────────────────

/**
 * Write markdown content into a target folder, creating the folder if needed.
 * Returns the absolute path of the written file.
 *
 * Throws if the folder can't be created or written to — caller decides whether
 * to retry at a fallback location.
 */
export function writeMarkdownFile(folder: string, filename: string, content: string): string {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true })
  }
  const target = path.join(folder, filename)
  fs.writeFileSync(target, content, 'utf-8')
  return target
}
