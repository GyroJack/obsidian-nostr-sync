/** Decrypted contents of a kind-30800 file event */
export interface FilePayload {
  path: string;
  content: string;
  checksum: string;     // SHA-256 hex
  version: number;
  modified: number;     // Unix timestamp
  contentType: string;  // "text/markdown" by default
}

/** Entry in the vault index (kind 30801) */
export interface VaultFileEntry {
  eventId: string;
  path: string;
  checksum: string;
  version: number;
  modified: number;
}

/** Tombstone for a deleted file */
export interface DeletedFileEntry {
  path: string;
  deletedAt: number;
}

/** Decrypted vault index payload */
export interface VaultIndexPayload {
  name: string;
  description: string;
  created: number;
  files: VaultFileEntry[];
  deleted: DeletedFileEntry[];
  settings: Record<string, unknown>;
}

/** Plugin settings persisted to data.json */
export interface NostrSyncSettings {
  encryptedNsec: string;   // AES-GCM blob, base64
  salt: string;            // PBKDF2 salt, base64
  pubkey: string;          // hex public key
  vaultId: string;         // deterministic vault identifier, persisted across restarts
  deviceEncryptedNsec: string;  // nsec encrypted with device-derived key (no passphrase needed)
  relays: string[];
  syncEnabled: boolean;
  syncStatus: SyncStatus;
  lastSyncTime: number;    // Unix timestamp ms, 0 if never
  syncedFileCount: number;
}

export type SyncStatus = "locked" | "unlocked" | "idle" | "syncing" | "error" | "offline" | "conflict" | "connecting";

/** In-memory representation of a known synced file */
export interface KnownFile {
  eventId: string;
  checksum: string;
  version: number;
}

/** Per-relay health tracking state */
export interface RelayHealth {
  url: string;
  connected: boolean;
  latency: number;           // last measured ms, -1 if unknown
  consecutiveErrors: number;
  lastError: string | null;
  lastChecked: number;       // Unix timestamp ms
  healthScore: number;       // lower = better, computed
}

/** Format relay health for display (shared by settings tab and status bar popup). */
export function formatRelayHealth(h: RelayHealth): { icon: string; latencyStr: string; errorStr: string } {
  const icon = h.connected ? "✅" : h.consecutiveErrors > 0 ? "🟡" : "❌";
  const latencyStr = h.latency === -1 ? "—" : `${h.latency}ms`;
  const errorStr = h.consecutiveErrors > 0 ? ` (${h.consecutiveErrors} errors)` : "";
  return { icon, latencyStr, errorStr };
}

/** Conflict resolution choice */
export type ConflictChoice = "keep-local" | "keep-remote" | "keep-both";

/** Information about a sync conflict for the UI */
export interface ConflictInfo {
  path: string;
  localContent: string;
  remoteContent: string;
  localVersion: number;
  remoteVersion: number;
  /** Remote event ID, carried through to resolveConflict for accurate tracking. */
  eventId?: string;
}

/** Entry in the sync activity log. */
export interface SyncActivityEntry {
  path: string;
  action: "pushed" | "pulled" | "deleted";
  timestamp: number; // Unix ms
}
