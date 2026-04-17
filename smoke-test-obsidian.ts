// Smoke test: adapter write path only — does not touch crypto/keytar,
// so it runs in a Linux sandbox where the Windows-built keytar binary
// can't be loaded. Proves the Obsidian adapter nests into
// VaultCast-Inbox/ and builds the expected markdown.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createAdapter } from './src/adapters'
import type { DaemonConfig, NotePayload } from './src/types'

async function run() {
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-smoke-vault-'))
  const tmpFallback = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-smoke-fallback-'))
  console.log('tmpVault:', tmpVault)

  const config: DaemonConfig = {
    daemon: { port: 47821, logLevel: 'info' },
    adapter: {
      type: 'obsidian',
      vaultPath: tmpVault,
      fallbackPath: tmpFallback,
      inboxFolder: 'VaultCast-Inbox',
    },
  }

  const adapter = createAdapter(config)
  console.log('adapter.name =', adapter.name)

  const note: NotePayload = {
    title: 'Test voice note',
    body: '## Summary\n\nThis is a smoke test of the Obsidian adapter.\n',
    frontmatter: { date: '2026-04-16', tags: ['test', 'smoke'], duration: '0m7s', language: 'en' },
    createdAt: '2026-04-16T22:31:45.000Z',
  }

  const result = await adapter.write(note)
  console.log('result:', result)

  if (!result.success || !result.path) {
    console.error('FAIL — adapter did not report success')
    process.exit(1)
  }

  const expectedDir = path.join(tmpVault, 'VaultCast-Inbox')
  if (!result.path.startsWith(expectedDir)) {
    console.error(`FAIL — expected path under ${expectedDir}, got ${result.path}`)
    process.exit(1)
  }

  const content = fs.readFileSync(result.path, 'utf-8')
  console.log('\n--- file content ---\n' + content + '--- end ---\n')

  const checks: Array<[string, boolean]> = [
    ['title in frontmatter', content.includes('title: "Test voice note"')],
    ['date in frontmatter', content.includes('date: 2026-04-16')],
    ['tags in frontmatter', content.includes('tags: [test, smoke]')],
    ['source: vaultcast', content.includes('source: vaultcast')],
    ['duration preserved', content.includes('duration: 0m7s')],
    ['language preserved', content.includes('language: en')],
    ['body present', content.includes('## Summary')],
    ['timestamped filename', /\d{4}-\d{2}-\d{2}-\d{6}-test-voice-note\.md$/.test(result.path)],
  ]

  let failed = false
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`)
    if (!ok) failed = true
  }

  // Fallback path test: vault dir missing → write should go to fallbackPath
  const ghostVault = path.join(os.tmpdir(), 'vc-definitely-not-there-' + Date.now())
  const ghostConfig: DaemonConfig = {
    ...config,
    adapter: { ...config.adapter, vaultPath: ghostVault },
  }
  const ghostAdapter = createAdapter(ghostConfig)
  const fallbackResult = await ghostAdapter.write(note)
  console.log('\nfallback result:', fallbackResult)
  const fallbackOK = !!(
    fallbackResult.success &&
    fallbackResult.path &&
    fallbackResult.path.startsWith(tmpFallback)
  )
  console.log(`  ${fallbackOK ? 'OK  ' : 'FAIL'}  fallback used when vault missing`)
  if (!fallbackOK) failed = true

  if (failed) {
    console.error('\nFAIL — see above')
    process.exit(1)
  }
  console.log('\nPASS — Obsidian adapter behaves correctly')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
