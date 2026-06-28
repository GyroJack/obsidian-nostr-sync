/**
 * SyncEngine — orchestrates encrypted file sync over Nostr relays.
 *
 * Protocol (Onyx-compatible):
 *   - kind 30800 = encrypted file (d-tag = cleartext path)
 *   - kind 30801 = encrypted vault index (d-tag = vault id)
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
  type Filter,
} from "nostr-tools";
import type { Vault } from "obsidian";
import { FILE_KIND, INDEX_KIND, MAX_FETCH_LIMIT } from "../constants";
import type { KnownFile, VaultIndexPayload, FilePayload } from "../types";
import {
  decryptPayload,
  encryptPayload,
  deriveConversationKey,
  sha256,
} from "../crypto/encryption";
import { RelayPool } from "./relays";

// ---------------------------------------------------------------------------
// Chunking constants (NIP-44 plaintext limit: 65,535 bytes, safe margin 60K)
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 60_000;
const CHUNK_HEADER_PREFIX = '{"_chunked":true,"total":';

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

  /** Debounce index pushes (batch multiple file changes) */
  private indexPushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Retry state */
  private retryBackoff = 2_000; // starts at 2s, doubles each failure
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  constructor(
    private vault: Vault,
    privkey?: Uint8Array | string,
    relays?: string[],
  ) {
    const sk: Uint8Array =
      privkey instanceof Uint8Array
        ? privkey
        : typeof privkey === "string"
          ? new Uint8Array(Buffer.from(privkey, "hex"))
          : generateSecretKey();

    this.privkey = sk;
    this.pubkey  = getPublicKey(sk);
    this.convKey = deriveConversationKey(sk, this.pubkey);
    this.vaultId = Math.random().toString(36).slice(2, 12);

    this.relay = new RelayPool(
      relays ?? ["wss://relay.damus.io", "wss://nos.lol"],
    );
  }

  get publicKey(): string {
    return this.pubkey;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.retryBackoff = 2_000;
    await this.connectWithRetry();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.indexPushTimer) clearTimeout(this.indexPushTimer);
    for (const id of this.subIds) this.relay.unsubscribe(id);
    this.subIds = [];
    this.relay.disconnect();
  }

  /** Replace relay list at runtime. Reconnects on new URLs. */
  updateRelays(relays: string[]): void {
    this.relay.setUrls(relays);
    void this.connectWithRetry();
  }

  // -----------------------------------------------------------------------
  // Connectivity (with auto-retry)
  // -----------------------------------------------------------------------

  private async connectWithRetry(): Promise<void> {
    try {
      await this.relay.connect();
      this.retryBackoff = 2_000; // reset on success
      await this.subscribeAll();
    } catch {
      if (!this.started) return;
      console.warn(
        `nostr-sync: relay connect failed, retry in ${this.retryBackoff / 1000}s`,
      );
      this.reconnectTimer = setTimeout(
        () => void this.connectWithRetry(),
        this.retryBackoff,
      );
      this.retryBackoff = Math.min(this.retryBackoff * 2, 60_000);
    }
  }

  // -----------------------------------------------------------------------
  // Push: local → remote
  // -----------------------------------------------------------------------

  /** Push a file to relays. Serialized via internal op queue. */
  async pushFile(path: string): Promise<void> {
    await this.enqueue(async () => {
      await this._pushFile(path);
    });
  }

  /** Mark a file as deleted. */
  async handleDelete(path: string): Promise<void> {
    await this.enqueue(async () => {
      this.files.delete(path);
      await this._pushIndex();
    });
  }

  /** Handle a file rename (old path → new path). */
  async handleRename(oldPath: string, newPath: string): Promise<void> {
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
    const now     = Math.floor(Date.now() / 1000);

    const payload: FilePayload = {
      path,
      content,
      checksum,
      version,
      modified: now,
      contentType: "text/markdown",
    };

    const plaintext = JSON.stringify(payload);
    const encrypted = this.chunkEncrypt(plaintext);

    const unsigned = {
      kind: FILE_KIND,
      pubkey: this.pubkey,
      created_at: now,
      tags: [
        ["d", path],
        ["checksum", checksum],
      ],
      content: encrypted,
    };
    const signed = finalizeEvent(unsigned, this.privkey);
    await this.publishWithRetry(signed);

    this.files.set(path, {
      eventId: signed.id!,
      checksum,
      version,
    });

    // Debounce index push — batch multiple rapid file changes
    this.scheduleIndexPush();
  }

  private async _pushIndex(deletedPaths: string[] = []): Promise<void> {
    const entries = Array.from(this.files.entries()).map(([path, f]) => ({
      eventId: f.eventId,
      d: path,
      path,
      checksum: f.checksum,
      version: f.version,
      modified: Math.floor(Date.now() / 1000),
    }));

    const now = Math.floor(Date.now() / 1000);

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
    await this.publishWithRetry(signed);
  }

  // -----------------------------------------------------------------------
  // Debounced index push
  // -----------------------------------------------------------------------

  private scheduleIndexPush(): void {
    if (this.indexPushTimer) clearTimeout(this.indexPushTimer);
    this.indexPushTimer = setTimeout(
      () => void this.enqueue(async () => {
        await this._pushIndex();
      }),
      3_000, // 3s debounce
    );
  }

  // -----------------------------------------------------------------------
  // Chunking (large files >60KB)
  // -----------------------------------------------------------------------

  private chunkEncrypt(plaintext: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(plaintext);

    if (bytes.length <= CHUNK_SIZE) {
      return encryptPayload(this.convKey, plaintext);
    }

    // Split into chunks
    const chunks: string[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      // Find safe split point (don't split multi-byte chars)
      let end = offset + CHUNK_SIZE;
      if (end < bytes.length) {
        while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
        if (end === offset) end = offset + CHUNK_SIZE; // fallback
      } else {
        end = bytes.length;
      }
      chunks.push(new TextDecoder().decode(bytes.slice(offset, end)));
      offset = end;
    }

    // Encrypt header + each chunk, join with '.'
    const header = `${CHUNK_HEADER_PREFIX}${chunks.length}}`;
    const parts = [encryptPayload(this.convKey, header)];
    for (const chunk of chunks) {
      parts.push(encryptPayload(this.convKey, chunk));
    }
    return parts.join(".");
  }

  /** Decrypt possibly-chunked payload. Public so tests can verify. */
  chunkDecrypt(ciphertext: string): string {
    if (!ciphertext.includes(".")) {
      return decryptPayload(this.convKey, ciphertext);
    }

    // Split on '.' — safe because base64 has no '.'
    const parts = ciphertext.split(".");
    const header = decryptPayload(this.convKey, parts[0]!);

    if (!header.startsWith(CHUNK_HEADER_PREFIX)) {
      throw new Error("Invalid chunk header");
    }

    const total = parseInt(
      header.slice(CHUNK_HEADER_PREFIX.length).replace("}", ""),
      10,
    );
    if (isNaN(total) || parts.length !== total + 1) {
      throw new Error(`Chunk count mismatch: expected ${total}, got ${parts.length - 1}`);
    }

    const chunks = parts.slice(1).map((p) => decryptPayload(this.convKey, p));
    return chunks.join("");
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
        if (i === attempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 1_000 * (i + 1)));
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
      [idxFilter],
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
      [fileFilter],
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
    } catch {
      // ignore unparseable index
    }
  }

  private async onRemoteFile(event: Event): Promise<void> {
    try {
      const dTag = event.tags.find((t: string[]) => t[0] === "d");
      if (!dTag) return;

      const path        = dTag[1]!;
      const checksumTag = event.tags.find(
        (t: string[]) => t[0] === "checksum",
      )?.[1] ?? "";
      const known = this.files.get(path);
      if (known && known.checksum === checksumTag) return;

      // Decrypt (handles chunked payloads)
      const decrypted = this.chunkDecrypt(event.content);
      const payload: FilePayload = JSON.parse(decrypted);

      const computed = await sha256(payload.content);
      if (computed !== payload.checksum) {
        console.warn(`nostr-sync: checksum mismatch for ${path}`);
        return;
      }

      // Create parent directories if needed
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir && !(await this.vault.adapter.exists(dir))) {
        await this.vault.createFolder(dir);
      }

      const exists = await this.vault.adapter.exists(path);
      if (exists) {
        await this.vault.adapter.write(path, payload.content);
      } else {
        await this.vault.create(path, payload.content);
      }

      this.files.set(path, {
        eventId: event.id!,
        checksum: payload.checksum,
        version: payload.version,
      });
    } catch {
      // skip
    }
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
    const skipExts = new Set([
      "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
      "pdf", "mp4", "mp3", "ogg", "wav", "webm",
      "zip", "gz", "tar", "7z",
      "excalidraw", // Excalidraw JSON is syncable, but the lib file isn't
    ]);
    if (skipExts.has(ext)) return false;

    // Canvas files (.canvas) ARE syncable — they're JSON
    // Markdown (.md) IS syncable — it's the primary type

    return true;
  }

  /** Force-rebuild the vault index and push to relays */
  async rebuildIndex(): Promise<void> {
    await this.enqueue(async () => {
      await this._pushIndex();
    });
  }

  /** Reset all local state (for testing or key rotation) */
  reset(): void {
    this.files.clear();
    if (this.indexPushTimer) clearTimeout(this.indexPushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const id of this.subIds) this.relay.unsubscribe(id);
    this.subIds = [];
  }
}
