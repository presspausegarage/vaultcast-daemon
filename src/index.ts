import { loadOrCreateKeypair, getPublicKeyBase64, loadOrCreateSharedSecret } from './crypto'
import { loadConfig, ensureFolders } from './config'
import { buildQRPayload, printQRCode, getLocalIP } from './qr'
import { createServer } from './server'
import { createAdapter } from './adapters'
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

  // 3. Build and display QR code for mobile pairing.
  //    getLocalIP() picks an RFC 1918 LAN address by default; config.daemon.host
  //    overrides it for users on networks where auto-detection picks wrong
  //    (e.g. Tailscale 100.x.x.x CGNAT interface on a machine with Tailscale).
  const advertisedIP = getLocalIP(config.daemon.host)
  const qrPayload = buildQRPayload(
    publicKeyBase64,
    sharedSecret,
    config.daemon.port,
    advertisedIP
  )
  printQRCode(qrPayload, config.adapter.vaultPath, config.adapter.fallbackPath)

  // 4. Resolve the adapter once at startup so the HTTP layer doesn't need to
  //    care which target app notes are destined for — it just calls
  //    adapter.write() on every incoming decrypted note.
  const adapter = createAdapter(config)
  console.log(`[daemon] Adapter: ${adapter.name} → ${config.adapter.vaultPath}`)

  // 5. Start HTTP server. Bind to 0.0.0.0 so the server is reachable on every
  //    local interface — the QR tells the phone which IP to dial, but binding
  //    all interfaces is more robust when the machine has multiple LANs or an
  //    IP change (DHCP lease renewal). Security is handled by HMAC signing +
  //    NaCl encryption — binding a specific interface added no real protection.
  const server = createServer(secretKey, sharedSecret, config, adapter)

  try {
    await server.listen({ port: config.daemon.port, host: '0.0.0.0' })
    console.log(`[daemon] Listening on 0.0.0.0:${config.daemon.port} — phone should dial ${advertisedIP}:${config.daemon.port}`)
  } catch (err) {
    console.error('[daemon] Failed to start server:', err)
    process.exit(1)
  }

  // 6. Register on local network via mDNS so the mobile app can discover the daemon
  registerMDNS(config.daemon.port)

  // 7. Graceful shutdown — clean up mDNS and close server on Ctrl+C or system stop
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
