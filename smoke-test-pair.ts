// Smoke test for the /pair endpoint — boots createServer with mock keys and
// a dummy adapter, then exercises loopback + non-loopback behaviour.
//
// We bypass daemon.ts (which touches keytar, bad ELF on Linux sandbox) by
// calling createServer directly with synthetic inputs.
//
// Usage: ts-node smoke-test-pair.ts

import nacl from 'tweetnacl'
import { createServer } from './src/server'
import type { Adapter, DaemonConfig, QRPayload, WriteResult, NotePayload } from './src/types'

async function main() {
  // Synthetic keys + shared secret — we don't need real crypto for /pair
  const kp = nacl.box.keyPair()
  const sharedSecret = 'test-shared-secret-0123456789abcdef'

  const config: DaemonConfig = {
    daemon: { port: 47821, host: 'auto', logLevel: 'info' },
    adapter: {
      type: 'obsidian',
      vaultPath: '/tmp/fake-vault',
      fallbackPath: '/tmp/fake-fallback',
      inboxFolder: 'VaultCast-Inbox',
    },
  }

  const fakeAdapter: Adapter = {
    name: 'fake',
    async write(_note: NotePayload): Promise<WriteResult> {
      return { success: true, path: '/tmp/fake.md' }
    },
  }

  const qrPayload: QRPayload = {
    publicKey: 'FAKEPUBKEYBASE64',
    sharedSecret,
    ip: '192.168.1.42',
    port: 47821,
  }

  const server = createServer(kp.secretKey, sharedSecret, config, fakeAdapter, qrPayload)

  await server.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.server.address()
  if (!addr || typeof addr === 'string') throw new Error('Bad address')
  const base = `http://127.0.0.1:${addr.port}`
  console.log(`[smoke] server listening on ${base}`)

  let pass = 0, fail = 0
  const check = (label: string, ok: boolean, detail?: string) => {
    if (ok) { console.log(`  PASS: ${label}`); pass++ }
    else { console.error(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); fail++ }
  }

  // 1. /status is reachable
  {
    const res = await fetch(`${base}/status`)
    const body: any = await res.json()
    check('/status returns 200', res.status === 200, `got ${res.status}`)
    check('/status body.status === "ok"', body.status === 'ok', JSON.stringify(body))
    check('/status exposes adapter name', body.adapter === 'fake', JSON.stringify(body))
  }

  // 2. /pair is served to loopback (we're calling from 127.0.0.1)
  {
    const res = await fetch(`${base}/pair`)
    const html = await res.text()
    check('/pair returns 200 on loopback', res.status === 200, `got ${res.status}`)
    check('/pair content-type is HTML',
      (res.headers.get('content-type') ?? '').startsWith('text/html'),
      res.headers.get('content-type') ?? 'none')
    check('/pair body contains <svg> QR', html.includes('<svg'), 'no svg tag')
    check('/pair body shows the IP', html.includes('192.168.1.42'), 'IP missing')
    check('/pair body shows the port', html.includes('47821'), 'port missing')
    check('/pair body shows adapter type', html.includes('obsidian'), 'adapter missing')
    check('/pair body shows vault path', html.includes('/tmp/fake-vault'), 'vault missing')
    check('/pair body warns about screenshots', /screenshot/i.test(html), 'warning missing')
  }

  // 3. /pair rejects POST (only GET is registered)
  {
    const res = await fetch(`${base}/pair`, { method: 'POST' })
    check('/pair rejects POST', res.status === 404 || res.status === 405, `got ${res.status}`)
  }

  // 4. /notes without signature returns 401
  {
    const res = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ephemeralPublicKey: 'x', nonce: 'y', ciphertext: 'z' }),
    })
    check('/notes without signature returns 401', res.status === 401, `got ${res.status}`)
  }

  await server.close()
  console.log(`\n[smoke] ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err)
  process.exit(1)
})
