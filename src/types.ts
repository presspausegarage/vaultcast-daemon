// ─── Encrypted payload sent from the mobile app ───────────────────────────────
// The mobile encrypts each note using NaCl box with:
//   - daemon's public key (received via QR at setup)
//   - an ephemeral keypair generated fresh per message
// The daemon decrypts using its own secret key + the ephemeral public key.

export interface EncryptedNotePayload {
  ephemeralPublicKey: string  // base64 — mobile's per-message ephemeral public key
  nonce: string               // base64 — 24-byte NaCl nonce
  ciphertext: string          // base64 — encrypted note content
}

// ─── Decrypted note structure (plaintext only ever exists here, on desktop) ───

export interface NotePayload {
  title: string
  body: string                // full structured markdown
  frontmatter: Record<string, unknown>
  createdAt: string           // ISO 8601 timestamp from mobile
}

// ─── Adapter interface — each target app implements this ──────────────────────

export interface Adapter {
  name: string
  write(note: NotePayload): Promise<WriteResult>
}

export interface WriteResult {
  success: boolean
  path?: string   // file path or URL where the note was written
  error?: string
}

// ─── QR payload — encoded into the setup QR code ─────────────────────────────

export interface QRPayload {
  publicKey: string     // base64 — daemon's Curve25519 public key
  sharedSecret: string  // hex — HMAC signing secret for request authentication
  ip: string            // local IP of the desktop
  port: number          // daemon HTTP port
  vaultPath: string     // absolute path to the vault folder
  fallbackPath: string  // absolute path to the fallback folder
}

// ─── Daemon config (persisted to ~/.vaultcast/config.toml) ───────────────────

export interface DaemonConfig {
  daemon: {
    port: number
    logLevel: 'debug' | 'info' | 'warn' | 'error'
  }
  adapter: {
    type: 'obsidian' | 'notion' | 'affine' | 'logseq' | 'anytype' | 'folder'
    vaultPath: string
    fallbackPath: string
  }
}
