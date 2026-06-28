/**
 * SyncEngine — orchestrates encrypted file sync over Nostr relays.
 *
 * Protocol (Onyx-compatible):
 *   - kind 30800 = encrypted file (d-tag = SHA-256 of path, content encrypted)
 *   - kind 30801 = encrypted vault index (d-tag = vault id)
 */

import {
  finalizeEvent,
  getPublicKey,
  type Event,
  type Filter,
} from "nostr-tools";
import type { Vault } from "obsidian";
import { FILE_KIND, INDEX_KIND, MAX_FETCH_LIMIT } from "../constants";
import type { KnownFile, VaultIndexPayload, FilePayload, RelayHealth, ConflictInfo, ConflictChoice, SyncActivityEntry } from "../types";
import {
  decryptPayload,
  encryptPayload,
  deriveConversationKey,
  sha256,
} from "../crypto/encryption";
import { RelayPool } from "./relays";

/** Non-text file extensions to skip during sync. */
const SKIP_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
  "pdf", "mp4", "mp3", "ogg", "wav", "webm",
  "zip", "gz", "tar", "7z",
  "excalidraw", // Excalidraw JSON is syncable, but the lib file isn't
]);

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SyncEngine {
  /** Map<path, KnownFile> — local knowledge of what's synced */
  private files = new Map<string, KnownFile>();

  /** Nostr key material (in memory only) */
  private privkey: Uint8Array;
  private pubkey: string;
  private convKey: Uint8Array;

  /** Relay transport */
  private relay: RelayPool;
  private vaultId: string;

  /** Sub IDs */
  private subIds: string[] = [];
  private started = false;

  /** Serialize writes to prevent race conditions */
  private opQueue: Promise<void> = Promise.resolve();

  /** Retry state */
  private retryBackoff = 2_000; // starts at 2s, doubles each failure
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Stored conflict info for resolution (supports multiple concurrent conflicts). */
  private _pendingConflicts = new Map<string, ConflictInfo>();

  /** Track last sync time for stats display. */
  private _lastSync = 0;

  /** Activity log for tracking recent sync operations. */
  private _activityLog: SyncActivityEntry[] = [];
  private readonly MAX_ACTIVITY = 50;

  /** Timer for debounced vault index push (Fix 1). */
  private _indexPushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly INDEX_DEBOUNCE_MS = 2_000;

  /** Strictly monotonic timestamp for event created_at (Fix 2). */
  private _lastEventTime = 0;

  // -----------------------------------------------------------------------
  // Callbacks for the main plugin
  // -----------------------------------------------------------------------

  /** Called when a sync conflict is detected. */
  onConflict: ((info: ConflictInfo) => void) | null = null;

  /** Called when relay health data changes. */
  onHealthChange: ((health: RelayHealth[]) => void) | null = null;

  /** Called when a sync operation starts. */
  onSyncStart: (() => void) | null = null;

  /** Called when a sync operation ends (success or failure). */
  onSyncEnd: (() => void) | null = null;

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  /**
   * @param vault Obsidian vault instance.
   * @param privkey Nostr secret key bytes or hex string.
   * @param relays WebSocket relay URLs.
   */
  constructor(
    private vault: Vault,
    privkey: Uint8Array | string,
    relays?: string[],
  ) {
    const sk: Uint8Array =
      privkey instanceof Uint8Array
        ? privkey
        : new Uint8Array(Buffer.from(privkey, "hex"));

    this.privkey = sk;
    this.pubkey  = getPublicKey(sk);
    this.convKey = deriveConversationKey(sk, this.pubkey);
    this.vaultId = Math.random().toString(36).slice(2, 12);

    this.relay = new RelayPool(
      relays ?? ["wss://relay.damus.io", "wss://nos.lol"],
    );

    // Wire health callback
    this.relay.onHealthChange = (health) => {
      if (this.onHealthChange) this.onHealthChange(health);
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Connect to relays and subscribe to remote file/index events. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.retryBackoff = 2_000;
    await this.connectWithRetry();
  }

  /** Disconnect from relays and stop all subscriptions and timers. */
  stop(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this._indexPushTimer) clearTimeout(this._indexPushTimer);
    for (const id of this.subIds) this.relay.unsubscribe(id);
    this.subIds = [];
    this.relay.disconnect();
  }

  // -----------------------------------------------------------------------
  // Connectivity (with auto-retry)
  // -----------------------------------------------------------------------

  private async connectWithRetry(): Promise<void> {
    try {
      await this.relay.connect();
      this.retryBackoff = 2_000; // reset on success
      // Report initial health after connecting
      if (this.onHealthChange) {
        this.onHealthChange(this.relay.getHealth());
      }
      await this.subscribeAll();
    } catch (e) {
      if (!this.started) return;
      console.debug("nostr-sync: relay connect failed, retrying in", this.retryBackoff, "ms");
      // Silently back off and retry — relay disconnects should not spam the user.
      this.reconnectTimer = setTimeout(
        () => void this.connectWithRetry(),
        this.retryBackoff,
      );
      this.retryBackoff = Math.min(this.retryBackoff * 2, 60_000);
    }
  }

  /** Expose relay health for the settings tab and status bar. */
  getRelayHealth(): RelayHealth[] {
    return this.relay.getHealth();
  }

  /** Expose sync stats for the settings tab. */
  getSyncStats(): { fileCount: number; lastSync: number } {
    return { fileCount: this.files.size, lastSync: this._lastSync };
  }

  /** Log a sync activity entry (capped at MAX_ACTIVITY). */
  private logActivity(path: string, action: SyncActivityEntry["action"]): void {
    this._activityLog.push({ path, action, timestamp: Date.now() });
    if (this._activityLog.length > this.MAX_ACTIVITY) {
      this._activityLog = this._activityLog.slice(-this.MAX_ACTIVITY);
    }
  }

  /** Return recent activity entries, newest first. */
  getRecentActivity(): SyncActivityEntry[] {
    return [...this._activityLog].reverse();
  }

  // -----------------------------------------------------------------------
  // Push: local → remote
  // -----------------------------------------------------------------------

  /**
   * Push a file's current content to relays.
   * The call is serialized via an internal operation queue.
   */
  async pushFile(path: string): Promise<void> {
    this.onSyncStart?.();
    try {
      await this.enqueue(async () => {
        await this._pushFile(path);
      });
    } finally {
      this.onSyncEnd?.();
    }
  }

  /** Mark a file as deleted and publish an updated vault index. */
  async handleDelete(path: string): Promise<void> {
    this.onSyncStart?.();
    try {
      await this.enqueue(async () => {
        this.files.delete(path);
        this.logActivity(path, "deleted");
        await this._pushIndex();
      });
    } finally {
      this.onSyncEnd?.();
    }
  }

  /** Handle a file rename (old path → new path), preserving history in the index. */
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    this.onSyncStart?.();
    try {
      await this.enqueue(async () => {
        // Remove old entry
        this.files.delete(oldPath);
        // Push new file (if exists)
        const exists = await this.vault.adapter.exists(newPath);
        if (exists) {
          await this._pushFile(newPath);
        }
        // Publish index with tombstone for old
        await this._pushIndex([oldPath]);
      });
    } finally {
      this.onSyncEnd?.();
    }
  }

  // -----------------------------------------------------------------------
  // Internal push helpers
  // -----------------------------------------------------------------------

  private async _pushFile(path: string): Promise<void> {
    // Skip non-text files
    if (!this.isSyncablePath(path)) return;

    const exists = await this.vault.adapter.exists(path);
    if (!exists) return;

    const content  = await this.vault.adapter.read(path);
    const checksum = await sha256(content);
    const known    = this.files.get(path);
    if (known && known.checksum === checksum) return;

    const version = (known?.version ?? 0) + 1;
    const now     = Math.max(Math.floor(Date.now() / 1000), this._lastEventTime + 1);
    this._lastEventTime = now;

    const payload: FilePayload = {
      path,
      content,
      checksum,
      version,
      modified: now,
      contentType: "text/markdown",
    };

    const plaintext = JSON.stringify(payload);
    const encrypted = encryptPayload(this.convKey, plaintext);

    // Use a hash of the path as the d-tag so relays cannot read file names.
    const pathHash = await sha256(path);

    const unsigned = {
      kind: FILE_KIND,
      pubkey: this.pubkey,
      created_at: now,
      tags: [["d", pathHash]],
      content: encrypted,
    };
    const signed = finalizeEvent(unsigned, this.privkey);
    console.debug('nostr-sync encrypted publish | path:', path ?? 'index', '| content chars:', encrypted.length, '| first 30:', encrypted.slice(0, 30));
    await this.publishWithRetry(signed);

    this.files.set(path, {
      eventId: signed.id!,
      checksum,
      version,
    });

    this.logActivity(path, "pushed");

    // Schedule a debounced index push instead of immediate (Fix 1)
    this._scheduleIndexPush();
  }

  /** Schedule a debounced vault-index push (batches rapid file edits). */
  private _scheduleIndexPush(): void {
    if (this._indexPushTimer) return; // already scheduled
    this._indexPushTimer = setTimeout(() => {
      this._indexPushTimer = null;
      this.enqueue(async () => {
        await this._pushIndex();
      });
    }, this.INDEX_DEBOUNCE_MS);
  }

  private async _pushIndex(deletedPaths: string[] = []): Promise<void> {
    const entries = Array.from(this.files.entries()).map(([path, f]) => ({
      eventId: f.eventId,
      path,
      checksum: f.checksum,
      version: f.version,
      modified: Math.floor(Date.now() / 1000),
    }));

    const now = Math.max(Math.floor(Date.now() / 1000), this._lastEventTime + 1);
    this._lastEventTime = now;

    const indexPayload: VaultIndexPayload = {
      name: "Obsidian Vault",
      description: "Synced via obsidian-nostr-sync",
      created: now,
      files: entries,
      deleted: deletedPaths.map((p) => ({ path: p, deletedAt: now })),
      settings: {},
    };

    const encrypted = encryptPayload(
      this.convKey,
      JSON.stringify(indexPayload),
    );

    const unsigned = {
      kind: INDEX_KIND,
      pubkey: this.pubkey,
      created_at: now,
      tags: [["d", this.vaultId]],
      content: encrypted,
    };
    const signed = finalizeEvent(unsigned, this.privkey);
    console.debug('nostr-sync encrypted publish | path: [vault index] | content chars:', encrypted.length, '| first 30:', encrypted.slice(0, 30));
    await this.publishWithRetry(signed);
    this._lastSync = Date.now();
  }

  // -----------------------------------------------------------------------
  // Retry logic
  // -----------------------------------------------------------------------

  private async publishWithRetry(event: Event, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.relay.publish(event);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Rate-limited: back off harder (Fix 3)
        const delay = msg.includes("rate-limited")
          ? 5_000 * (i + 1)  // 5s, 10s, 15s
          : 1_000 * (i + 1); // 1s, 2s, 3s (original)
        if (i === attempts - 1) {
          console.warn("nostr-sync: publish failed after retries:", msg);
          throw e;
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // -----------------------------------------------------------------------
  // Operation queue
  // -----------------------------------------------------------------------

  private async enqueue(fn: () => Promise<void>): Promise<void> {
    this.opQueue = this.opQueue.then(fn, fn);
    await this.opQueue;
  }

  // -----------------------------------------------------------------------
  // Pull: remote → local
  // -----------------------------------------------------------------------

  private async subscribeAll(): Promise<void> {
    for (const id of this.subIds) this.relay.unsubscribe(id);
    this.subIds = [];

    const idxFilter: Filter = {
      kinds: [INDEX_KIND],
      authors: [this.pubkey],
      limit: MAX_FETCH_LIMIT,
    };
    const sid1 = this.relay.subscribe(
      idxFilter,
      (e) => void this.onRemoteIndex(e),
    );
    this.subIds.push(sid1);

    const fileFilter: Filter = {
      kinds: [FILE_KIND],
      authors: [this.pubkey],
      since: Math.floor(Date.now() / 1000) - 60,
      limit: MAX_FETCH_LIMIT,
    };
    const sid2 = this.relay.subscribe(
      fileFilter,
      (e) => void this.onRemoteFile(e),
    );
    this.subIds.push(sid2);
  }

  private async onRemoteIndex(event: Event): Promise<void> {
    try {
      const decrypted = decryptPayload(this.convKey, event.content);
      const index: VaultIndexPayload = JSON.parse(decrypted);

      for (const entry of index.files) {
        const known = this.files.get(entry.path);
        if (!known || entry.version > known.version) {
          this.files.set(entry.path, {
            eventId: entry.eventId,
            checksum: entry.checksum,
            version: entry.version,
          });
        }
      }

      for (const del of index.deleted) {
        const exists = await this.vault.adapter.exists(del.path);
        if (exists) {
          await this.vault.adapter.remove(del.path);
        }
        this.files.delete(del.path);
      }
    } catch (e) {
      console.debug("nostr-sync: unparseable vault index, skipping", e);
    }
  }

  private async onRemoteFile(event: Event): Promise<void> {
    try {
      // Require a d-tag (SHA-256 of the path) per protocol, but resolve the
      // actual path from the encrypted payload so file names never leak.
      const dTag = event.tags.find((t: string[]) => t[0] === "d");
      if (!dTag?.[1]) return;

      const decrypted = decryptPayload(this.convKey, event.content);
      const payload: FilePayload = JSON.parse(decrypted);

      // Integrity check: d-tag must match the hash of the decrypted path.
      if (dTag[1] !== (await sha256(payload.path))) return;

      const known = this.files.get(payload.path);
      if (known && known.checksum === payload.checksum) return;

      const computed = await sha256(payload.content);
      if (computed !== payload.checksum) {
        // Drop malformed/ tampered events silently.
        return;
      }

      // ── Conflict detection ─────────────────────────────────────
      const localExists = await this.vault.adapter.exists(payload.path);
      if (localExists && known && payload.version > known.version) {
        // Remote has a newer version, but we may have local changes too
        const localContent = await this.vault.adapter.read(payload.path);
        const localChecksum = await sha256(localContent);

        // Real conflict: both local and remote changed relative to known state
        if (localChecksum !== known.checksum && payload.checksum !== known.checksum) {
          // CONFLICT DETECTED
          const conflictInfo: ConflictInfo = {
            path: payload.path,
            localContent,
            remoteContent: payload.content,
            localVersion: known.version + 1, // approximate
            remoteVersion: payload.version,
          };
          this._pendingConflicts.set(payload.path, conflictInfo);
          if (this.onConflict) {
            this.onConflict(conflictInfo);
          }
          return; // Don't auto-overwrite — wait for user resolution
        }
      }

      // Create parent directories if needed
      const dir = payload.path.substring(0, payload.path.lastIndexOf("/"));
      if (dir && !(await this.vault.adapter.exists(dir))) {
        await this.vault.createFolder(dir);
      }

      if (localExists) {
        await this.vault.adapter.write(payload.path, payload.content);
      } else {
        await this.vault.create(payload.path, payload.content);
      }

      this.files.set(payload.path, {
        eventId: event.id!,
        checksum: payload.checksum,
        version: payload.version,
      });

      this.logActivity(payload.path, "pulled");
    } catch (e) {
      console.debug("nostr-sync: bad remote file event, skipping", e);
    }
  }

  // -----------------------------------------------------------------------
  // Conflict resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a sync conflict by applying the user's chosen strategy.
   */
  async resolveConflict(path: string, choice: ConflictChoice): Promise<void> {
    await this.enqueue(async () => {
      const conflict = this._pendingConflicts.get(path);
      if (choice === "keep-local") {
        // Re-push local version to update remote
        await this._pushFile(path);
        this.logActivity(path, "pushed");
      } else if (choice === "keep-remote") {
        // Write remote content to path, then push updated index
        if (conflict) {
          const exists = await this.vault.adapter.exists(path);
          if (exists) {
            await this.vault.adapter.write(path, conflict.remoteContent);
          } else {
            await this.vault.create(path, conflict.remoteContent);
          }
          // Update known state with remote version
          const checksum = await sha256(conflict.remoteContent);
          this.files.set(path, {
            eventId: "", // will be set on next push
            checksum,
            version: conflict.remoteVersion,
          });
        }
        await this._pushFile(path);
        this.logActivity(path, "pulled");
      } else {
        // keep-both: duplicate local file with conflict suffix
        const ext = path.lastIndexOf(".");
        const base = ext > 0 ? path.substring(0, ext) : path;
        const suffix = ext > 0 ? path.substring(ext) : "";
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
        const conflictPath = `${base}-conflict-${timestamp}${suffix}`;

        // Write remote content to conflict file
        if (conflict) {
          await this.vault.create(conflictPath, conflict.remoteContent);
          await this._pushFile(conflictPath);
          this.logActivity(conflictPath, "pulled");
        }
        // Keep local file as-is (already on disk)
        await this._pushFile(path);
      }
      this._pendingConflicts.delete(path);
    });
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  /** Determine if a path should be synced (exclude binaries, configs, etc.) */
  private isSyncablePath(path: string): boolean {
    // Skip hidden files/dirs
    if (path.startsWith(".")) return false;

    // Skip non-text files by extension (common Obsidian binary types)
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (SKIP_EXTS.has(ext)) return false;

    // Canvas files (.canvas) ARE syncable — they're JSON
    // Markdown (.md) IS syncable — it's the primary type

    return true;
  }

  /** Force-rebuild the vault index and push it to relays. */
  async rebuildIndex(): Promise<void> {
    await this.enqueue(async () => {
      await this._pushIndex();
    });
  }
}
