import os from 'os'
import qrcode from 'qrcode-terminal'
import type { QRPayload } from './types'

// ─── Local IP detection ───────────────────────────────────────────────────────

/**
 * Returns the first non-loopback IPv4 address on the machine.
 * Used to populate the QR payload so the mobile app knows where to connect.
 */
export function getLocalIP(): string {
  const interfaces = os.networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue

    for (const entry of iface) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address
      }
    }
  }

  // Fallback — should not happen on a networked machine
  return '127.0.0.1'
}

// ─── QR generation ───────────────────────────────────────────────────────────

/**
 * Build the QR payload object from config + crypto state.
 */
export function buildQRPayload(
  publicKeyBase64: string,
  sharedSecret: string,
  port: number,
  vaultPath: string,
  fallbackPath: string
): QRPayload {
  return {
    publicKey: publicKeyBase64,
    sharedSecret,
    ip: getLocalIP(),
    port,
    vaultPath,
    fallbackPath,
  }
}

/**
 * Print the QR code to the terminal.
 * The mobile app scans this once during setup to complete pairing.
 */
export function printQRCode(payload: QRPayload): void {
  const encoded = JSON.stringify(payload)

  console.log('\n─────────────────────────────────────────────')
  console.log('  VaultCast — scan this with the mobile app')
  console.log('─────────────────────────────────────────────\n')

  qrcode.generate(encoded, { small: true })

  console.log('\n─────────────────────────────────────────────')
  console.log(`  Listening on  ${payload.ip}:${payload.port}`)
  console.log(`  Vault path    ${payload.vaultPath}`)
  console.log(`  Fallback      ${payload.fallbackPath}`)
  console.log('─────────────────────────────────────────────\n')
}
