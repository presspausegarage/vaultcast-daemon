# VaultCast Daemon

The desktop half of [VaultCast](https://vaultcast.app) — a local-network service that receives encrypted voice notes from the VaultCast mobile app and writes them as `.md` files into your note vault.

**Open source (MIT).** The mobile app is proprietary; the daemon lives here so you can audit exactly what runs on your machine.

## How it works

```
[Phone]  --encrypted .md payload over HTTPS on LAN-->  [Daemon]  --.md file-->  [Obsidian / Logseq / ...]
```

1. Daemon starts, reads `~/.vaultcast/config.toml`, loads its Curve25519 keypair from the OS keychain.
2. Daemon prints a QR code in the terminal — you scan it once in the mobile app. The QR encodes daemon's public key, an HMAC shared secret, local IP, and port.
3. Daemon registers itself on the local network via mDNS (`_vaultcast._tcp`) so the phone can discover it.
4. Phone records → transcribes on-device with Whisper → encrypts with daemon's public key → signs with the shared HMAC secret → HTTPS POST to `/notes`.
5. Daemon verifies HMAC, decrypts the payload, hands the decrypted `NotePayload` to the configured adapter, which writes it into your vault.

No cloud. No relay. No audio ever leaves the phone. The daemon only works while the phone and desktop are on the same LAN.

## Install

Prereqs: Node 18 or newer.

```bash
git clone <repo-url> vaultcast-daemon
cd vaultcast-daemon
npm install
npm run build
```

On first run the daemon will create `~/.vaultcast/config.toml` with sensible defaults and generate its keypair + shared secret into the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).

## Run

```bash
npm start        # production build
npm run dev      # ts-node, auto-reload friendlier for development
```

Pair once:

1. Start the daemon. A QR code prints in the terminal along with the advertised IP and port.
2. Open the VaultCast mobile app, go to setup, scan the QR.
3. Done forever — no re-pairing after this.

## Configure

Edit `~/.vaultcast/config.toml`. The daemon re-reads it on restart.

```toml
[daemon]
port = 47821
logLevel = "info"
# Optional: override the IP advertised in the QR when auto-detection picks wrong
# (e.g. a machine with Tailscale where CGNAT 100.x.x.x would otherwise win).
# host = "192.168.1.42"

[adapter]
type = "obsidian"
vaultPath = 'C:\path\to\your\ObsidianVault'
fallbackPath = 'C:\path\to\your\ObsidianVault\VaultCast-Inbox'
inboxFolder = "VaultCast-Inbox"
```

### Config reference

| Key | Type | Default | Notes |
|---|---|---|---|
| `daemon.port` | int | `47821` | HTTP port, bound to `0.0.0.0` |
| `daemon.logLevel` | string | `"info"` | `debug` to enable Fastify request logs |
| `daemon.host` | string | unset | Override advertised LAN IP (see IP selection below) |
| `adapter.type` | string | `"folder"` | `obsidian`, `folder`, or a future target |
| `adapter.vaultPath` | string | `~/VaultCast-Inbox` | Root of the target vault or folder |
| `adapter.fallbackPath` | string | `~/VaultCast-Inbox` | Where notes go when vault is unreachable |
| `adapter.inboxFolder` | string | `"VaultCast-Inbox"` | Subfolder inside the vault. Obsidian adapter only |

### Adapters

| `type` | What it does | Destination |
|---|---|---|
| `obsidian` | Writes `.md` into `<vaultPath>/<inboxFolder>/`. Obsidian auto-indexes the new file | Obsidian vault |
| `folder` | Writes `.md` flat into `vaultPath`. Ignores `inboxFolder` | Any folder |
| `notion`, `affine`, `logseq`, `anytype` | Not implemented yet — falls back to `folder` adapter with a warning so mobile transfers don't fail | Same as `folder` |

## The path auto-selection gotcha

The daemon tries to pick the right LAN IP to advertise in the QR. It prefers RFC 1918 private ranges (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`) on a non-virtual interface, and explicitly excludes:

- Tailscale CGNAT (`100.64.0.0/10`) — the phone isn't on your tailnet
- Docker / VMware / WireGuard interfaces

If auto-detection still picks wrong, set `daemon.host` explicitly in the config.

## Adapter architecture (for contributors)

Adding a new target app is three files:

1. `src/adapters/<target>.ts` — implements the `Adapter` interface from `src/types.ts`
2. `src/adapters/index.ts` — add a `case '<target>':` branch to `createAdapter()`
3. `src/types.ts` — add `'<target>'` to the `adapter.type` string union

The `Adapter` interface is deliberately tiny:

```typescript
interface Adapter {
  name: string
  write(note: NotePayload): Promise<WriteResult>
}
```

`server.ts` knows nothing about where notes land — it just verifies, decrypts, and calls `adapter.write()`. Shared file-writing helpers live in `src/adapters/utils.ts` — filename generation, markdown assembly, safe folder creation.

## Security model

- **Encryption:** NaCl box (Curve25519 + XSalsa20-Poly1305). Mobile generates an ephemeral keypair per message; daemon decrypts with its long-lived secret key held in the OS keychain.
- **Authentication:** HMAC-SHA256 over the request body using a 32-byte shared secret exchanged once via the pairing QR. Rejected with 401 if the signature is missing or invalid.
- **Transport:** Plain HTTP on LAN is acceptable because the payload is already encrypted + signed. Body limit: 512 KB.
- **Keys never leave the desktop.** The secret key is generated on first run and stored in the OS keychain. Losing access to the keychain means re-pairing all mobile devices.
- **No plaintext at rest on mobile.** Mobile stores only encrypted blobs; decrypted plaintext only ever exists on the desktop after `decryptNote()`.

## Troubleshooting

**"Note wrote to disk but Obsidian doesn't show it"** — Obsidian's vault is probably a subfolder of `vaultPath`. Open the vault manager in Obsidian, check the actual vault path, and update `vaultPath` to match exactly.

**"Phone can't reach daemon / `ERR_NETWORK` in mobile logs"** — the advertised IP in the QR is wrong. Check the daemon's startup log for the `[qr] Selected …` line. Set `daemon.host` in config.toml to your real LAN IP as a workaround.

**"Decryption failed" (422 response)** — the phone was paired with a different daemon installation, or the daemon's keychain entry was wiped. Re-scan a fresh QR to re-pair.

**"Invalid signature" (401 response)** — HMAC shared secret mismatch between phone and daemon. Same fix: re-pair.

**Daemon won't start, mentions `keytar`** — the native binding for the OS keychain didn't build. On Linux install `libsecret-1-dev` and `npm rebuild keytar`.

## Testing

```bash
npx ts-node smoke-test-obsidian.ts
```

Smoke test for the Obsidian adapter — runs against a temp vault, verifies filename format, frontmatter integrity, inbox nesting, and fallback behavior. Skips crypto/keytar so it runs in CI and Linux containers where the Windows-built keychain binding won't load.

## License

MIT. See `LICENSE` in the repo root.
