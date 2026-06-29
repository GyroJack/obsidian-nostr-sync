/** Nostr event kinds used by the sync protocol (Onyx-compatible) */
export const FILE_KIND = 30800 as const;
export const INDEX_KIND = 30801 as const;

/** Default relay pool */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.ditto.pub",
] as const;

/** PBKDF2 iterations for passphrase → key derivation (OWASP 2023 recommendation) */
export const PBKDF2_ITERATIONS = 600_000;

/** Debounce window for file-change → publish (ms) — 15s idle push timer */
export const SYNC_DEBOUNCE_MS = 15_000;

/** Max events to fetch in a single relay query */
export const MAX_FETCH_LIMIT = 500;

/** Interval at which relay health is re-checked (ms) */
export const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Max consecutive errors before a relay is considered dead */
export const MAX_CONSECUTIVE_ERRORS = 5;

/** Validate a relay URL: must be a ws:// or wss:// WebSocket URL. */
export function isValidRelayUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "wss:" || parsed.protocol === "ws:";
  } catch {
    return false;
  }
}
