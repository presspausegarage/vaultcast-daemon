import Fastify from 'fastify'
import QRCode from 'qrcode'
import { decryptNote, verifyHMAC } from './crypto'
import type {
  Adapter,
  EncryptedNotePayload,
  NotePayload,
  DaemonConfig,
  QRPayload,
} from './types'

const SIGNATURE_HEADER = 'x-vaultcast-signature'
const MAX_BODY_BYTES = 1024 * 512  // 512 KB — generous ceiling for a structured note

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Build the Fastify server. The adapter is injected so server.ts knows nothing
 * about where notes ultimately land — that's the adapter's job. This keeps the
 * HTTP/crypto layer free of target-app branching.
 *
 * The qrPayload is injected so the /pair page (tray mode) can render the QR
 * without the server caring how it was generated.
 */
export function createServer(
  secretKey: Uint8Array,
  sharedSecret: string,
  config: DaemonConfig,
  adapter: Adapter,
  qrPayload: QRPayload
) {
  const fastify = Fastify({
    logger: config.daemon.logLevel === 'debug',
    bodyLimit: MAX_BODY_BYTES,
  })

  // ── Health check (unauthenticated — mobile uses this to detect daemon) ──────
  fastify.get('/status', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      adapter: adapter.name,
    }
  })

  // ── Pairing page (localhost-only — renders the QR in a browser) ─────────────
  // Served only to loopback requests. The daemon binds 0.0.0.0 so mobile can
  // reach /notes over the LAN; we do NOT want the pairing QR reachable from
  // anywhere on the network — it contains the long-lived public key and the
  // HMAC shared secret, which is as sensitive as the pairing itself.
  fastify.get('/pair', async (request, reply) => {
    if (!isLoopback(request.ip)) {
      console.warn(`[server] Rejected /pair request from non-loopback ${request.ip}`)
      return reply.status(403).send({ error: 'Pairing page is localhost-only.' })
    }

    const svg = await QRCode.toString(JSON.stringify(qrPayload), {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    })

    const html = renderPairPage(svg, qrPayload, config)
    return reply.type('text/html').send(html)
  })

  // ── Receive encrypted note ──────────────────────────────────────────────────
  fastify.post<{ Body: EncryptedNotePayload }>('/notes', async (request, reply) => {
    // 1. Verify HMAC signature before doing anything else
    const signature = request.headers[SIGNATURE_HEADER]
    if (!signature || typeof signature !== 'string') {
      return reply.status(401).send({ error: 'Missing signature header.' })
    }

    const rawBody = JSON.stringify(request.body)
    if (!verifyHMAC(sharedSecret, rawBody, signature)) {
      console.warn('[server] Rejected request — invalid HMAC signature.')
      return reply.status(401).send({ error: 'Invalid signature.' })
    }

    // 2. Shape validation
    const payload = request.body
    if (!payload.ephemeralPublicKey || !payload.nonce || !payload.ciphertext) {
      return reply.status(400).send({ error: 'Invalid payload — missing required fields.' })
    }

    // 3. Decrypt
    let plaintext: string
    try {
      plaintext = await decryptNote(payload, secretKey)
    } catch (err) {
      console.error('[server] Decryption failed:', err)
      return reply.status(422).send({ error: 'Decryption failed.' })
    }

    // 4. Parse
    let note: NotePayload
    try {
      note = JSON.parse(plaintext) as NotePayload
    } catch {
      return reply.status(422).send({ error: 'Decrypted payload is not valid JSON.' })
    }

    // 5. Hand off to the adapter — it decides where and how to write.
    try {
      const result = await adapter.write(note)
      if (!result.success) {
        console.error(`[server] Adapter "${adapter.name}" failed:`, result.error)
        return reply.status(500).send({ error: result.error ?? 'Adapter write failed.' })
      }
      console.log(`[server] Note written via ${adapter.name}: ${result.path}`)
      return reply.status(201).send({ success: true, path: result.path })
    } catch (err) {
      console.error(`[server] Adapter "${adapter.name}" threw:`, err)
      return reply.status(500).send({ error: 'Failed to write note.' })
    }
  })

  return fastify
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Is an IP address loopback? Handles both IPv4 127.0.0.0/8 and IPv6 ::1 plus
 * the IPv4-mapped-IPv6 form ::ffff:127.x.x.x that Node reports when the
 * server is bound to a dual-stack socket.
 */
function isLoopback(ip: string): boolean {
  if (!ip) return false
  if (ip === '::1') return true
  if (ip.startsWith('127.')) return true
  // Node sometimes reports loopback IPv4 via the mapped-IPv6 form.
  if (ip.startsWith('::ffff:127.')) return true
  return false
}

/**
 * Render the /pair HTML page. Self-contained (no external CSS/JS) so it
 * works on machines with no internet and isn't vulnerable to CDN changes.
 */
function renderPairPage(qrSvg: string, payload: QRPayload, config: DaemonConfig): string {
  // qrcode returns an <svg>…</svg> blob; drop it straight into the document.
  // The inline SVG sizes to 320x320 as configured above.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VaultCast — Pair Your Phone</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #111; color: #eee; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
  .card { max-width: 480px; background: #1a1a1a; border-radius: 16px; padding: 32px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); text-align: center; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  p.hint { margin: 0 0 24px; color: #888; font-size: 14px; }
  .qr { background: #fff; border-radius: 8px; padding: 16px; display: inline-block; }
  .qr svg { display: block; }
  dl { margin: 28px 0 0; padding: 0; font-size: 13px; color: #aaa; text-align: left; display: grid; grid-template-columns: auto 1fr; column-gap: 16px; row-gap: 6px; }
  dt { color: #666; }
  dd { margin: 0; color: #ddd; font-family: "SF Mono", Menlo, Consolas, monospace; word-break: break-all; }
  .footer { margin-top: 20px; font-size: 12px; color: #555; }
</style>
</head>
<body>
  <div class="card">
    <h1>Pair your phone</h1>
    <p class="hint">Open the VaultCast app, tap the icon's long-press menu, scan this code.</p>
    <div class="qr">${qrSvg}</div>
    <dl>
      <dt>IP</dt><dd>${escapeHtml(payload.ip)}</dd>
      <dt>Port</dt><dd>${payload.port}</dd>
      <dt>Adapter</dt><dd>${escapeHtml(config.adapter.type)}</dd>
      <dt>Vault</dt><dd>${escapeHtml(config.adapter.vaultPath)}</dd>
    </dl>
    <div class="footer">This page is served only to this machine. Do not share or screenshot the QR code — it contains your pairing secret.</div>
  </div>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
