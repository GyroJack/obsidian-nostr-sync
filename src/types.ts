/** Decrypted contents of a kind-30800 file event */
export interface FilePayload {
  path: string;
  content: string;
  checksum: string;     // SHA-256 hex
  version: number;
  modified: number;     // Unix timestamp
  contentType: string;  // "text/markdown" by default
  previousEventId?: string;
}

/** Entry in the vault index (kind 30801) */
export interface VaultFileEntry {
  eventId: string;
  d: string;            // d-tag = file path
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
  relays: string[];
  syncEnabled: boolean;
  syncStatus: SyncStatus;
}

export type SyncStatus = "unlocked" | "locked" | "syncing" | "idle" | "error" | "offline";

/** In-memory representation of a known synced file */
export interface KnownFile {
  eventId: string;
  checksum: string;
  version: number;
}

/** Result of publishing a file to relays */
export interface PublishResult {
  eventId: string;
  path: string;
  checksum: string;
}

/** What the relay subscription passes to on-file handlers */
export interface RemoteFileEvent {
  eventId: string;
  path: string;
  encryptedContent: string;
  checksum: string;
}
