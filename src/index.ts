import { loadOrCreateKeypair, getPublicKeyBase64, loadOrCreateSharedSecret } from './crypto'
import { loadConfig, ensureFolders } from './config'
import { buildQRPayload, printQRCode, getLocalIP } from './qr'
import { createServer } from './server'
import { registerMDNS, unregisterMDNS } from './mdns'

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

  // 4. Start HTTP server — bind to local IP only, not all interfaces
  const server = createServer(secretKey, sharedSecret, config)
  const localIP = getLocalIP()

  try {
    await server.listen({ port: config.daemon.port, host: localIP })
    console.log(`[daemon] Listening on ${localIP}:${config.daemon.port}`)
  } catch (err) {
    console.error('[daemon] Failed to start server:', err)
    process.exit(1)
  }

  // 5. Register on local network via mDNS so the mobile app can discover the daemon
  registerMDNS(config.daemon.port)

  // 6. Graceful shutdown — clean up mDNS and close server on Ctrl+C or system stop
  const shutdown = async (signal: string) => {
    console.log(`\n[daemon] Received ${signal}, shutting down...`)
    await unregisterMDNS()
    await server.close()
    console.log('[daemon] Goodbye.')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[daemon] Fatal error:', err)
  process.exit(1)
})
