import os from 'os'
import qrcode from 'qrcode-terminal'
import type { QRPayload } from './types'

// ─── Local IP detection ───────────────────────────────────────────────────────

/**
 * IP classification helpers. We need to pick the address the phone can
 * actually reach, which is specifically an RFC 1918 private LAN address
 * (10/8, 172.16/12, 192.168/16). The previous naive "first non-loopback"
 * approach picked whichever interface enumerated first — often Tailscale
 * (CGNAT 100.64.0.0/10) on machines that have it installed, which the
 * phone can't route to.
 */

function isPrivateLAN(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false
  const [a, b] = parts
  // 10.0.0.0/8
  if (a === 10) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  return false
}

function isCGNAT(ip: string): boolean {
  // 100.64.0.0/10 — used by carrier-grade NAT and Tailscale by default.
  // Phones outside the tailnet cannot reach this range.
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  const [a, b] = parts
  return a === 100 && b >= 64 && b <= 127
}

function looksLikeVirtualInterface(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.includes('tailscale') ||
    lower.includes('zerotier') ||
    lower.includes('wireguard') ||
    lower.includes('vpn') ||
    lower.startsWith('utun') ||      // macOS tun interfaces
    lower.startsWith('tun') ||       // linux tun interfaces
    lower.startsWith('docker') ||    // docker bridge
    lower.startsWith('vboxnet') ||   // VirtualBox
    lower.startsWith('vmnet')        // VMware
  )
}

interface IPCandidate {
  name: string
  address: string
}

/**
 * Enumerate all candidate IPv4 addresses and rank them so the phone-reachable
 * LAN address wins. Returns an ordered list; caller takes the first.
 *
 * Priority:
 *   1. RFC 1918 private LAN on a real (non-virtual) interface
 *   2. RFC 1918 private LAN on any interface
 *   3. Any non-loopback, non-CGNAT address (last resort)
 * CGNAT (100.64/10) and loopback are always excluded.
 */
function rankCandidates(): IPCandidate[] {
  const interfaces = os.networkInterfaces()
  const all: IPCandidate[] = []

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue
    for (const entry of iface) {
      if (entry.family !== 'IPv4') continue
      if (entry.internal) continue
      if (isCGNAT(entry.address)) continue
      all.push({ name, address: entry.address })
    }
  }

  const tier1 = all.filter((c) => isPrivateLAN(c.address) && !looksLikeVirtualInterface(c.name))
  const tier2 = all.filter((c) => isPrivateLAN(c.address) && looksLikeVirtualInterface(c.name))
  const tier3 = all.filter((c) => !isPrivateLAN(c.address))

  return [...tier1, ...tier2, ...tier3]
}

/**
 * Returns the best IPv4 address for the mobile app to dial.
 *
 * If `override` is provided (from config.daemon.host), we use that verbatim —
 * power users on weird networks can pin a specific IP or hostname.
 */
export function getLocalIP(override?: string): string {
  if (override && override.trim().length > 0) {
    console.log(`[qr] Using configured host override: ${override}`)
    return override.trim()
  }

  const ranked = rankCandidates()

  if (ranked.length === 0) {
    console.warn('[qr] No suitable LAN interface found — falling back to 127.0.0.1.')
    console.warn('[qr] The phone will not be able to reach the daemon at this address.')
    return '127.0.0.1'
  }

  const chosen = ranked[0]
  if (ranked.length > 1) {
    const others = ranked.slice(1).map((c) => `${c.address} (${c.name})`).join(', ')
    console.log(`[qr] Selected ${chosen.address} (${chosen.name}); skipped: ${others}`)
  } else {
    console.log(`[qr] Selected ${chosen.address} (${chosen.name})`)
  }
  return chosen.address
}

// ─── QR generation ───────────────────────────────────────────────────────────

/**
 * Build the QR payload — only what the mobile needs.
 * Paths are excluded to keep the QR small and scannable.
 */
export function buildQRPayload(
  publicKeyBase64: string,
  sharedSecret: string,
  port: number,
  hostOverride?: string
): QRPayload {
  return {
    publicKey: publicKeyBase64,
    sharedSecret,
    ip: getLocalIP(hostOverride),
    port,
  }
}

/**
 * Print the QR code to the terminal.
 * Larger format (no small:true) for reliable scanning.
 */
export function printQRCode(payload: QRPayload, vaultPath: string, fallbackPath: string): void {
  const encoded = JSON.stringify(payload)

  console.log('\n─────────────────────────────────────────────')
  console.log('  VaultCast — scan this with the mobile app')
  console.log('─────────────────────────────────────────────\n')

  qrcode.generate(encoded)

  console.log('\n─────────────────────────────────────────────')
  console.log(`  Listening on  ${payload.ip}:${payload.port}`)
  console.log(`  Vault path    ${vaultPath}`)
  console.log(`  Fallback      ${fallbackPath}`)
  console.log('─────────────────────────────────────────────\n')
}
