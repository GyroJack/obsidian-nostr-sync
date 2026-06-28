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
    await this.relay.connect();
    await this.subscribeAll();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const id of this.subIds) this.relay.unsubscribe(id);
    this.subIds = [];
    this.relay.disconnect();
  }

  // -----------------------------------------------------------------------
  // Push: local → remote
  // -----------------------------------------------------------------------

  /** Push a file to relays. Call after vault.create or vault.modify. */
  async pushFile(path: string): Promise<void> {
    try {
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

      const encrypted = encryptPayload(
        this.convKey,
        JSON.stringify(payload),
      );

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
      await this.relay.publish(signed);

      this.files.set(path, {
        eventId: signed.id!,
        checksum,
        version,
      });

      await this.pushIndex();
    } catch (e) {
      console.error("nostr-sync push:", e);
    }
  }

  /** Mark a file as deleted and update the vault index. */
  async handleDelete(path: string): Promise<void> {
    this.files.delete(path);
    await this.pushIndex();
  }

  /** Publish the vault index (kind 30801) */
  private async pushIndex(): Promise<void> {
    const entries = Array.from(this.files.entries()).map(([path, f]) => ({
      eventId: f.eventId,
      d: path,
      path,
      checksum: f.checksum,
      version: f.version,
      modified: Math.floor(Date.now() / 1000),
    }));

    const indexPayload: VaultIndexPayload = {
      name: "Obsidian Vault",
      description: "Synced via obsidian-nostr-sync",
      created: Math.floor(Date.now() / 1000),
      files: entries,
      deleted: [],
      settings: {},
    };

    const encrypted = encryptPayload(
      this.convKey,
      JSON.stringify(indexPayload),
    );

    const unsigned = {
      kind: INDEX_KIND,
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", this.vaultId]],
      content: encrypted,
    };
    const signed = finalizeEvent(unsigned, this.privkey);
    await this.relay.publish(signed);
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

      const decrypted = decryptPayload(this.convKey, event.content);
      const payload: FilePayload = JSON.parse(decrypted);

      const computed = await sha256(payload.content);
      if (computed !== payload.checksum) {
        console.warn(`nostr-sync: checksum mismatch for ${path}`);
        return;
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
}
