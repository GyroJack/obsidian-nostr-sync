/** Nostr event kinds used by the sync protocol (Onyx-compatible) */
export const FILE_KIND = 30800 as const;
export const INDEX_KIND = 30801 as const;
export const SHARE_KIND = 30802 as const;
export const PREF_KIND  = 30078 as const;

/** Default relay pool */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.ditto.pub",
] as const;

/** Plugin identifier */
export const PLUGIN_ID = "obsidian-nostr-sync" as const;

/** PBKDF2 iterations for passphrase → key derivation (OWASP 2023 recommendation) */
export const PBKDF2_ITERATIONS = 600_000;

/** Debounce window for file-change → publish (ms) */
export const SYNC_DEBOUNCE_MS = 3_000;

/** Max events to fetch in a single relay query */
export const MAX_FETCH_LIMIT = 500;
