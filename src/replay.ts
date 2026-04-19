// Anti-replay cache for authenticated requests.
//
// An attacker with LAN access can capture a valid /notes POST and resend it
// verbatim — the HMAC will still verify, because it's deterministic. We defend
// against that by requiring each request to carry a fresh timestamp + nonce,
// both folded into the signing input. Timestamp bounds the window; the nonce
// cache blocks duplicates inside that window.

const REPLAY_WINDOW_MS = 60_000
const MAX_ENTRIES = 10_000

export class ReplayCache {
  private readonly seen = new Map<string, number>()

  /**
   * Record a nonce. Returns false if it has already been seen inside the
   * window — caller should reject the request. Map iteration order is
   * insertion order, so prune can stop at the first non-expired entry.
   */
  checkAndRecord(nonce: string, nowMs = Date.now()): boolean {
    this.prune(nowMs)

    if (this.seen.has(nonce)) return false

    if (this.seen.size >= MAX_ENTRIES) {
      // Unusual — likely a buggy client or abuse. Drop the oldest entry so
      // we keep accepting requests rather than wedging.
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }

    this.seen.set(nonce, nowMs)
    return true
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - REPLAY_WINDOW_MS
    for (const [nonce, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(nonce)
      else break
    }
  }
}

/**
 * Is the client-supplied timestamp (unix millis, as a decimal string) within
 * the acceptable skew window? Guards against both clock-skew abuse and very
 * old captures being replayed after the nonce cache has forgotten them.
 */
export function isTimestampFresh(timestamp: string, nowMs = Date.now()): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  return Math.abs(nowMs - ts) <= REPLAY_WINDOW_MS
}

export { REPLAY_WINDOW_MS }
