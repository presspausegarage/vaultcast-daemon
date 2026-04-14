import { loadOrCreateKeypair, getPublicKeyBase64, encryptNoteForTesting } from './crypto'
import { loadConfig, ensureFolders } from './config'
import { buildQRPayload, printQRCode } from './qr'
import { createServer } from './server'

async function main() {
  console.log('\n⬡  VaultCast Daemon starting...\n')

  // 1. Load config (creates defaults on first run)
  const config = loadConfig()
  ensureFolders(config)

  // 2. Load or generate Curve25519 keypair (stored in OS keychain)
  const { secretKey } = await loadOrCreateKeypair()
  const publicKeyBase64 = await getPublicKeyBase64()

  // 3. Build and display QR code for mobile pairing
  const qrPayload = buildQRPayload(
    publicKeyBase64,
    config.daemon.port,
    config.adapter.vaultPath,
    config.adapter.fallbackPath
  )
  printQRCode(qrPayload)

  // 4. Start HTTP server
  const server = createServer(secretKey, config)

  try {
    await server.listen({ port: config.daemon.port, host: '0.0.0.0' })
    console.log(`[daemon] Listening on port ${config.daemon.port}`)
  } catch (err) {
    console.error('[daemon] Failed to start server:', err)
    process.exit(1)
  }

  // ── Dev/test helper ─────────────────────────────────────────────────────────
  // Uncomment this block to simulate a note coming in from the mobile app.
  // Sends a test encrypted note to the local server immediately after startup.
  //
  // import { decodeBase64 } from 'tweetnacl-util'
  // setTimeout(async () => {
  //   const { encryptNoteForTesting } = await import('./crypto')
  //   const { decodeBase64 } = await import('tweetnacl-util')
  //   const pubKey = decodeBase64(publicKeyBase64)
  //   const testNote = {
  //     title: 'Test Note from Simulator',
  //     body: '## Notes\n\nThis is a simulated note from the dev test helper.\n\n## Action Items\n\n- [ ] Verify decryption works end to end',
  //     frontmatter: { date: new Date().toISOString().split('T')[0], tags: ['test'] },
  //     createdAt: new Date().toISOString(),
  //   }
  //   const encrypted = encryptNoteForTesting(JSON.stringify(testNote), pubKey)
  //   const res = await fetch(`http://localhost:${config.daemon.port}/notes`, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(encrypted),
  //   })
  //   console.log('[test] Simulated note response:', await res.json())
  // }, 1000)
}

main().catch((err) => {
  console.error('[daemon] Fatal error:', err)
  process.exit(1)
})
