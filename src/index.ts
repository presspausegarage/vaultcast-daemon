import { loadOrCreateKeypair, getPublicKeyBase64, loadOrCreateSharedSecret, encryptNoteForTesting, computeHMAC } from './crypto'
import { loadConfig, ensureFolders } from './config'
import { buildQRPayload, printQRCode } from './qr'
import { createServer } from './server'
import { decodeBase64 } from 'tweetnacl-util'

async function main() {
  console.log('\n  VaultCast Daemon starting...\n')

  // 1. Load config (creates defaults on first run)
  const config = loadConfig()
  ensureFolders(config)

  // 2. Load or generate Curve25519 keypair and shared secret (stored in OS keychain)
  const { secretKey } = await loadOrCreateKeypair()
  const publicKeyBase64 = await getPublicKeyBase64()
  const sharedSecret = await loadOrCreateSharedSecret()

  // 3. Build and display QR code for mobile pairing
  const qrPayload = buildQRPayload(
    publicKeyBase64,
    sharedSecret,
    config.daemon.port,
    config.adapter.vaultPath,
    config.adapter.fallbackPath
  )
  printQRCode(qrPayload)

  // 4. Start HTTP server
  const server = createServer(secretKey, sharedSecret, config)

  try {
    await server.listen({ port: config.daemon.port, host: '0.0.0.0' })
    console.log(`[daemon] Listening on port ${config.daemon.port}`)
  } catch (err) {
    console.error('[daemon] Failed to start server:', err)
    process.exit(1)
  }

  // Dev test helper — fires a signed, encrypted note at the server after 1 second.
  // Comment this block out once the roundtrip is confirmed working.
//   setTimeout(async () => {
//     const pubKey = decodeBase64(publicKeyBase64)
//     const testNote = {
//       title: 'Test Note from Simulator',
//       body: '## Notes\n\nThis is a simulated note from the dev test helper.\n\n## Action Items\n\n- [ ] Verify auth + decryption works end to end',
//       frontmatter: { date: new Date().toISOString().split('T')[0], tags: ['test'] },
//       createdAt: new Date().toISOString(),
//     }
//     const encrypted = encryptNoteForTesting(JSON.stringify(testNote), pubKey)
//     const body = JSON.stringify(encrypted)
//     const signature = computeHMAC(sharedSecret, body)

//     const res = await fetch(`http://localhost:${config.daemon.port}/notes`, {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'x-vaultcast-signature': signature,
//       },
//       body,
//     })
//     console.log('[test] Simulated note response:', await res.json())
//   }, 1000)
// }

main().catch((err) => {
  console.error('[daemon] Fatal error:', err)
  process.exit(1)
})
