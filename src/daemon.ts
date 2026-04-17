// Shared daemon bootstrap — used by both the CLI entry (index.ts) and the
// tray wrapper (tray.ts). Keeping the startup sequence in one place means
// the two entrypoints can't drift out of sync, and future entrypoints
// (Windows service, test harness) can reuse the same primitives.

import type { FastifyInstance } from 'fastify'
import { loadOrCreateKeypair, getPublicKeyBase64, loadOrCreateSharedSecret } from './crypto'
import { loadConfig, ensureFolders } from './config'
import { buildQRPayload, getLocalIP, printQRCode } from './qr'
import { createServer } from './server'
import { createAdapter } from './adapters'
import { registerMDNS, unregisterMDNS } from './mdns'
import type { Adapter, DaemonConfig, QRPayload } from './types'

export interface DaemonHandle {
  server: FastifyInstance
  adapter: Adapter
  config: DaemonConfig
  qrPayload: QRPayload
  advertisedIP: string
  port: number
  /** Cleanly stop the HTTP server and mDNS advertiser. */
  stop: () => Promise<void>
}

export interface StartOptions {
  /** When true, skip printing the QR banner to the terminal (tray mode). */
  silent?: boolean
}

/**
 * Full daemon boot: load config → load keys → pick adapter → start HTTP
 * server → register mDNS → return handles. Returns a DaemonHandle the
 * caller uses to shut things down gracefully.
 *
 * Does not install signal handlers — that's the entrypoint's concern, since
 * the tray wrapper wants its own lifecycle (quit menu item) while the CLI
 * wants SIGINT/SIGTERM.
 */
export async function startDaemon(opts: StartOptions = {}): Promise<DaemonHandle> {
  const config = loadConfig()
  ensureFolders(config)

  const { secretKey } = await loadOrCreateKeypair()
  const publicKeyBase64 = await getPublicKeyBase64()
  const sharedSecret = await loadOrCreateSharedSecret()

  const advertisedIP = getLocalIP(config.daemon.host)
  const qrPayload = buildQRPayload(
    publicKeyBase64,
    sharedSecret,
    config.daemon.port,
    advertisedIP
  )

  if (!opts.silent) {
    printQRCode(qrPayload, config.adapter.vaultPath, config.adapter.fallbackPath)
  }

  const adapter = createAdapter(config)
  console.log(`[daemon] Adapter: ${adapter.name} → ${config.adapter.vaultPath}`)

  const server = createServer(secretKey, sharedSecret, config, adapter, qrPayload)

  await server.listen({ port: config.daemon.port, host: '0.0.0.0' })
  console.log(
    `[daemon] Listening on 0.0.0.0:${config.daemon.port} — phone should dial ${advertisedIP}:${config.daemon.port}`
  )

  registerMDNS(config.daemon.port)

  return {
    server,
    adapter,
    config,
    qrPayload,
    advertisedIP,
    port: config.daemon.port,
    stop: async () => {
      console.log('[daemon] Shutting down...')
      await unregisterMDNS()
      await server.close()
      console.log('[daemon] Goodbye.')
    },
  }
}
