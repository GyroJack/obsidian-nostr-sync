/**
 * obsidian-nostr-sync — encrypted vault sync via Nostr relays.
 */
import { Plugin, Notice } from "obsidian";
import { nip19, getPublicKey, utils, SimplePool, finalizeEvent } from "nostr-tools";
import { DEFAULT_RELAYS, isValidRelayUrl, MAX_CONSECUTIVE_ERRORS, SYNC_DEBOUNCE_MS, VAULT_KEY_KIND } from "./constants";
import type { NostrSyncSettings, RelayHealth, SyncStatus, ConflictInfo, SyncActivityEntry } from "./types";
import { ConflictModal } from "./modals/conflict-modal";
import { unwrapNsec, wrapNsec, unwrapNsecDevice, wrapNsecDevice, generateVaultKey, wrapVaultKey, unwrapVaultKey, deriveConversationKey, encryptVaultKeyToRecipient, decryptVaultKeyFromSender } from "./crypto/encryption";
import { SyncEngine } from "./sync/engine";
import { VaultWatcher } from "./sync/watcher";
import type { FileChangeEvent } from "./sync/watcher";
import { SettingsTab } from "./settings";
import { PassphraseModal } from "./modals";
import type { PassphraseResult } from "./modals";

const DEFAULTS: NostrSyncSettings = {
  encryptedNsec: "",
  salt: "",
  pubkey: "",
  vaultId: "",
  deviceEncryptedNsec: "",
  encryptedVaultKey: "",
  collaborators: [],
  isVaultOwner: false,
  relays: [...DEFAULT_RELAYS],
  syncEnabled: false,
  debounceMs: SYNC_DEBOUNCE_MS,
  syncStatus: "locked",
  lastSyncTime: 0,
  syncedFileCount: 0,
};

export default class NostrSyncPlugin extends Plugin {
  declare settings: NostrSyncSettings;
  private engine!: SyncEngine;
  private watcher!: VaultWatcher;
  private statusBarItem: HTMLElement | null = null;
  private statusDebounce: ReturnType<typeof setTimeout> | null = null;
  private wasConnected = false;
  private nsecBytes: Uint8Array | null = null;
  private vaultKeyBytes: Uint8Array | null = null;

  override async onload(): Promise<void> {
    try {
      await this.loadSettings();

      // ── Vault ID migration (v1.0.x → v1.1.0) ──────
      if (this.settings.vaultId && this.settings.vaultId.length === 12) {
        const legacyId = this.settings.vaultId;
        this.settings.vaultId = crypto.randomUUID();
        this.settings.isVaultOwner = true;
        console.log(`nostr-sync: migrated vaultId ${legacyId} → ${this.settings.vaultId}`);
        await this.saveSettings();
      } else if (!this.settings.vaultId) {
        this.settings.vaultId = crypto.randomUUID();
        this.settings.isVaultOwner = true;
        await this.saveSettings();
      }

      this.addSettingTab(new SettingsTab(this.app, this));

      // Status bar — click triggers manual sync
      this.app.workspace.onLayoutReady(() => {
        this.statusBarItem = this.addStatusBarItem();
        this.setSyncStatus(this.settings.syncStatus || "locked");
        this.statusBarItem.addClass("nostr-sync-status-bar");
        this.statusBarItem.addEventListener("click", () => {
          void this.syncNow();
        });
      });

      // Ribbon icon for manual sync
      this.addRibbonIcon("refresh-ccw", "Nostr Sync", () => {
        void this.syncNow();
      });

      if (this.settings.syncEnabled && this.settings.encryptedNsec) {
        this.app.workspace.onLayoutReady(() => {
          void this.unlockAndStart();
        });
      }

      this.addCommand({
        id: "sync-now",
        name: "Sync Now",
        callback: () => {
          if (!this.engine) {
            new Notice("❌ Nostr Sync: engine not started. Register a key first.");
            return;
          }
          new Notice("🔄 Nostr Sync: syncing...");
          void this.syncNow().then(() => {
            new Notice("✅ Nostr Sync: complete");
          });
        },
      });
    } catch (err) {
      new Notice("Nostr Sync: failed to start. Check the developer console.", 0);
      console.error("Nostr Sync: onload failed", err);
    }
  }

  override async onunload(): Promise<void> {
    this.watcher?.stop();
    if (this.engine) {
      try {
        await this.engine.rebuildIndex();
      } catch (e) {
        console.warn("nostr-sync: final index push failed during shutdown", e);
      }
      this.engine.stop();
    }
  }

  // ── Settings ──────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  clearStoredKey(): void {
    this.settings.encryptedNsec = "";
    this.settings.salt          = "";
    this.settings.pubkey        = "";
    this.settings.deviceEncryptedNsec = "";
    this.settings.encryptedVaultKey = "";
    this.settings.syncEnabled   = false;
    this.engine?.stop();
    void this.saveSettings();
    new Notice("Nostr Sync: key cleared.");
  }

  /**
   * Register a new nsec with a passphrase.
   */
  async storeNsec(nsec: string, passphrase: string): Promise<void> {
    if (passphrase.length < 8) {
      new Notice("Nostr Sync: passphrase must be at least 8 characters.", 6000);
      throw new Error("Passphrase too short");
    }

    let nsecBytes: Uint8Array;
    try {
      if (nsec.startsWith("nsec1")) {
        const decoded = nip19.decode(nsec);
        if (decoded.type !== "nsec") throw new Error("Invalid nsec");
        nsecBytes = decoded.data as Uint8Array;
      } else if (/^[0-9a-fA-F]{64}$/.test(nsec)) {
        nsecBytes = utils.hexToBytes(nsec);
      } else {
        throw new Error("Invalid nsec format");
      }
    } catch {
      new Notice("Nostr Sync: invalid nsec format. Use nsec1... or 64-char hex.", 8000);
      throw new Error("Invalid nsec format");
    }

    const { encrypted, salt } = await wrapNsec(nsecBytes, passphrase);
    this.settings.encryptedNsec = encrypted;
    this.settings.salt          = salt;
    this.settings.pubkey        = getPublicKey(nsecBytes);
    this.settings.syncEnabled   = true;
    await this.saveSettings();

    await this.startSync(nsecBytes);
    this.settings.syncStatus = "idle";
    await this.saveSettings();

    await this.saveDeviceEncryptedNsec(nsecBytes);
    new Notice("Nostr Sync: key registered and syncing");
  }

  // ── Unlock ────────────────────────────────────────

  private async unlockAndStart(): Promise<void> {
    if (this.settings.deviceEncryptedNsec && this.settings.pubkey && this.settings.vaultId) {
      try {
        const nsecBytes = await unwrapNsecDevice(
          this.settings.deviceEncryptedNsec,
          this.settings.pubkey,
          this.settings.vaultId,
        );
        await this.startSync(nsecBytes);
        this.settings.syncStatus = "idle";
        await this.saveSettings();
        return;
      } catch {
        console.debug("nostr-sync: device-key auto-unlock failed, falling back to passphrase");
        this.settings.deviceEncryptedNsec = "";
        await this.saveSettings();
      }
    }

    const result: PassphraseResult | null = await PassphraseModal.prompt(this.app);
    if (!result) {
      this.settings.syncStatus = "locked";
      await this.saveSettings();
      this.setSyncStatus("locked");
      return;
    }

    let nsecBytes: Uint8Array;
    try {
      nsecBytes = await unwrapNsec(
        this.settings.encryptedNsec,
        this.settings.salt,
        result.passphrase,
      );
    } catch {
      new Notice("Nostr Sync: wrong passphrase. Try again or clear your key in settings.", 8000);
      this.settings.syncStatus = "locked";
      await this.saveSettings();
      this.setSyncStatus("locked");
      return;
    }

    await this.startSync(nsecBytes);
    this.settings.syncStatus = "idle";
    await this.saveSettings();

    if (result.remember) {
      await this.saveDeviceEncryptedNsec(nsecBytes);
    }

    new Notice("Nostr Sync: unlocked and syncing");
  }

  private async saveDeviceEncryptedNsec(nsecBytes: Uint8Array): Promise<void> {
    if (!this.settings.pubkey || !this.settings.vaultId) return;
    try {
      this.settings.deviceEncryptedNsec = await wrapNsecDevice(
        nsecBytes,
        this.settings.pubkey,
        this.settings.vaultId,
      );
      await this.saveSettings();
    } catch (e) {
      console.warn("nostr-sync: failed to save device-encrypted key", e);
    }
  }

  async rememberDevice(): Promise<void> {
    if (this.nsecBytes) {
      await this.saveDeviceEncryptedNsec(this.nsecBytes);
      new Notice("Nostr Sync: device key saved for auto-unlock");
    }
  }

  forgetDevice(): void {
    this.settings.deviceEncryptedNsec = "";
    void this.saveSettings();
    new Notice("Nostr Sync: device key cleared — passphrase required on next restart");
  }

  toggleSync(enable: boolean): void {
    this.settings.syncEnabled = enable;
    if (enable) {
      if (this.engine) {
        this.watcher?.start();
        this.setSyncStatus("idle");
      }
    } else {
      this.watcher?.stop();
      this.setSyncStatus("locked");
    }
    void this.saveSettings();
  }

  /** Get the vault key from memory (decrypted on startup). */
  getVaultKey(): Uint8Array | null {
    return this.vaultKeyBytes;
  }

  /**
   * Add a collaborator (owner only).
   * Encrypts the vault key to their pubkey and publishes a kind 30802 envelope.
   */
  async addCollaborator(npubOrHex: string): Promise<void> {
    if (!this.settings.isVaultOwner || !this.vaultKeyBytes || !this.nsecBytes) {
      new Notice("❌ Only the vault owner can add collaborators.");
      return;
    }

    let hexPubkey: string;
    try {
      if (npubOrHex.startsWith("npub1")) {
        hexPubkey = (nip19.decode(npubOrHex).data as string);
      } else if (/^[0-9a-fA-F]{64}$/.test(npubOrHex)) {
        hexPubkey = npubOrHex;
      } else {
        throw new Error("Invalid format");
      }
    } catch {
      new Notice("❌ Invalid npub or hex pubkey.");
      return;
    }

    if (hexPubkey === this.settings.pubkey) {
      new Notice("❌ You're already the vault owner.");
      return;
    }
    if (this.settings.collaborators.includes(hexPubkey)) {
      new Notice("❌ This collaborator has already been added.");
      return;
    }

    // Encrypt vault key to recipient
    const ciphertext = encryptVaultKeyToRecipient(
      this.vaultKeyBytes,
      this.nsecBytes,
      hexPubkey,
    );

    // Publish kind 30802 envelope
    const unsigned = {
      kind: VAULT_KEY_KIND,
      pubkey: this.settings.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", hexPubkey], ["d", `vault-key:${this.settings.vaultId}`]],
      content: ciphertext,
    };
    const signed = finalizeEvent(unsigned, this.nsecBytes);

    // Use a temporary relay pool to publish (not the engine's pool)
    const pool = new SimplePool();
    let published = false;
    try {
      const relays = this.settings.relays.filter(isValidRelayUrl);
      await Promise.any(relays.map((url) => pool.publish([url], signed)));
      published = true;
    } catch {
      new Notice("⚠️ Failed to publish key envelope to any relay.");
    } finally {
      pool.close(this.settings.relays.filter(isValidRelayUrl));
    }

    if (!published) return;

    this.settings.collaborators.push(hexPubkey);
    await this.saveSettings();
    new Notice(`✅ Collaborator added: ${npubOrHex.slice(0, 12)}...`);
  }

  /**
   * Remove a collaborator. Rotates the vault key and re-distributes.
   */
  async removeCollaborator(pubkey: string): Promise<void> {
    if (!this.settings.isVaultOwner) {
      new Notice("❌ Only the vault owner can remove collaborators.");
      return;
    }

    this.settings.collaborators = this.settings.collaborators.filter((p) => p !== pubkey);
    await this.saveSettings();

    // Rotate vault key
    const newKey = await this.createVaultKey();

    // Re-distribute to all remaining collaborators (single pool)
    const pool = new SimplePool();
    const relays = this.settings.relays.filter(isValidRelayUrl);
    try {
      for (const collabPubkey of this.settings.collaborators) {
        const ciphertext = encryptVaultKeyToRecipient(newKey, this.nsecBytes!, collabPubkey);
        const unsigned = {
          kind: VAULT_KEY_KIND,
          pubkey: this.settings.pubkey,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", collabPubkey], ["d", `vault-key:${this.settings.vaultId}`]],
          content: ciphertext,
        };
        const signed = finalizeEvent(unsigned, this.nsecBytes!);

        try {
          await Promise.any(relays.map((url) => pool.publish([url], signed)));
        } catch {
          console.warn(`nostr-sync: failed to re-distribute key to ${collabPubkey.slice(0, 12)}`);
        }
      }
    } finally {
      pool.close(relays);
    }

    new Notice(`✅ Collaborator removed. Vault key rotated.`);
  }

  /**
   * Handle an incoming kind 30802 vault key envelope.
   * Decrypts the vault key with our nsec and saves it locally.
   */
  private async onRemoteKeyEnvelope(event: { pubkey: string; content: string }): Promise<void> {
    if (!this.nsecBytes) return;
    try {
      const vaultKey = decryptVaultKeyFromSender(
        event.content,
        event.pubkey,
        this.nsecBytes,
      );
      this.vaultKeyBytes = vaultKey;

      const convKey = deriveConversationKey(this.nsecBytes, this.settings.pubkey);
      this.settings.encryptedVaultKey = wrapVaultKey(vaultKey, convKey);
      await this.saveSettings();

      new Notice("🔑 Nostr Sync: received vault key — restarting sync...");
      if (this.engine) this.engine.stop();
      await this.startSync(this.nsecBytes);
      await this.syncNow();
    } catch (e) {
      console.warn("nostr-sync: failed to decrypt vault key envelope", e);
    }
  }

  /** Create a new vault key — owner only. */
  private async createVaultKey(): Promise<Uint8Array> {
    const vaultKey = generateVaultKey();
    if (!this.nsecBytes) throw new Error("Cannot create vault key without nsec");
    const pubkey = this.settings.pubkey;
    const convKey = deriveConversationKey(this.nsecBytes, pubkey);
    this.settings.encryptedVaultKey = wrapVaultKey(vaultKey, convKey);
    this.vaultKeyBytes = vaultKey;
    await this.saveSettings();
    return vaultKey;
  }

  /** Load the vault key from local storage (NIP-44 self-decrypt). */
  private loadVaultKey(): Uint8Array | null {
    if (!this.settings.encryptedVaultKey || !this.nsecBytes) return null;
    try {
      const pubkey = this.settings.pubkey;
      const convKey = deriveConversationKey(this.nsecBytes, pubkey);
      return unwrapVaultKey(this.settings.encryptedVaultKey, convKey);
    } catch {
      console.warn("nostr-sync: failed to decrypt vault key");
      return null;
    }
  }

  // ── Sync ──────────────────────────────────────────

  private async startSync(nsecBytes: Uint8Array): Promise<void> {
    this.nsecBytes = nsecBytes;

    let vaultKey = this.loadVaultKey();
    if (!vaultKey && this.settings.isVaultOwner) {
      vaultKey = await this.createVaultKey();
    }
    if (!vaultKey && !this.settings.isVaultOwner) {
      console.warn("nostr-sync: no vault key yet — waiting for kind 30802 envelope");
    }
    this.vaultKeyBytes = vaultKey;

    this.engine = new SyncEngine(
      this.app.vault,
      this.app,
      nsecBytes,
      this.settings.vaultId,
      this.settings.relays.filter(isValidRelayUrl),
      vaultKey,
      this.settings.collaborators,
    );

    // Wire relay health to status bar
    this.engine.onHealthChange = (health) => {
      const currentlyConnected = health.some((h) => h.connected);
      const prevConnected = this.wasConnected;
      this.wasConnected = currentlyConnected;

      const connectedCount = health.filter((h) => h.connected).length;
      const totalCount = health.length;
      const bestRelay = health
        .filter((h) => h.connected)
        .sort((a, b) => a.latency - b.latency)[0];
      const allDown = health.length > 0 && health.every((h) => h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS);

      if (currentlyConnected && bestRelay) {
        if (!prevConnected) {
          new Notice(`Nostr Sync: connected to relay (${bestRelay.latency}ms)`);
        }
        if (totalCount > 1) {
          this.setSyncStatus("idle", bestRelay.latency, connectedCount, totalCount);
        } else {
          this.setSyncStatus("idle", bestRelay.latency);
        }
      } else if (allDown) {
        this.setSyncStatus("offline");
      } else {
        this.setSyncStatus("connecting");
      }
    };

    this.engine.onConflict = (info) => this.showConflictModal(info);

    // Non-owners: subscribe to kind 30802 to receive vault key from owner
    if (!vaultKey && !this.settings.isVaultOwner) {
      this.engine.subscribeKeyEnvelopes((event) => {
        this.onRemoteKeyEnvelope(event).catch((e) => {
          console.warn("nostr-sync: failed to process key envelope", e);
        });
      });
      console.log("nostr-sync: subscribed to kind 30802 (waiting for vault key)");
    }

    this.watcher = new VaultWatcher(this.app.vault, (e: FileChangeEvent) =>
      this.handleFileChange(e),
      this.settings.debounceMs,
    );
    this.watcher.start();

    await this.engine.start();
    await this.syncNow();
  }

  async syncNow(): Promise<void> {
    if (!this.engine) return;
    this.setSyncStatus("syncing");
    try {
      await this.engine.pushAllLocalFiles();
      this.setSyncStatus("idle");
    } catch (e) {
      console.warn("nostr-sync: sync cycle failed", e);
      this.setSyncStatus("error");
    }
  }

  // ── Status Bar ────────────────────────────────────

  private async handleFileChange(e: FileChangeEvent): Promise<void> {
    try {
      switch (e.action) {
        case "modify":
        case "create":
          await this.engine.pushFile(e.path);
          break;
        case "delete":
          if (e.isFolder) {
            await this.engine.deleteFolder(e.path);
          } else {
            await this.engine.handleDelete(e.path);
          }
          break;
        case "rename":
          if (e.oldPath) {
            await this.engine.handleRename(e.oldPath, e.path);
          } else {
            await this.engine.pushFile(e.path);
          }
          break;
      }
    } catch (e) {
      console.warn("nostr-sync: file change handler failed", e);
    }
  }

  private setSyncStatus(status: SyncStatus, latency?: number, connectedCount?: number, totalCount?: number): void {
    if (this.statusDebounce) clearTimeout(this.statusDebounce);
    this.statusDebounce = setTimeout(() => {
      this.statusDebounce = null;
      if (!this.statusBarItem) return;
      switch (status) {
      case "locked":
        this.statusBarItem.setText("🔒 Nostr Sync: locked");
        break;
      case "unlocked":
        this.statusBarItem.setText("🔓 Nostr Sync: ready");
        break;
      case "idle":
        if (latency !== undefined && latency >= 0) {
          if (connectedCount !== undefined && totalCount !== undefined && totalCount > 1) {
            this.statusBarItem.setText(`✅ ${connectedCount}/${totalCount} relays (${latency}ms)`);
          } else {
            this.statusBarItem.setText(`✅ Nostr Sync (${latency}ms)`);
          }
        } else {
          this.statusBarItem.setText("✅ Nostr Sync");
        }
        break;
      case "connecting":
        this.statusBarItem.setText("🔄 Nostr Sync: connecting...");
        break;
      case "syncing":
        this.statusBarItem.setText("🔄 Nostr Sync: syncing...");
        break;
      case "error":
        this.statusBarItem.setText("❌ Nostr Sync: error");
        break;
      case "offline":
        this.statusBarItem.setText("⬜ Nostr Sync: offline");
        break;
      case "conflict":
        this.statusBarItem.setText("⚠️ Nostr Sync: conflict");
        break;
      default:
        this.statusBarItem.setText("🔒 Nostr Sync: locked");
      }
    }, 150);
  }

  // ── Conflict Modal ────────────────────────────────

  private async showConflictModal(info: ConflictInfo): Promise<void> {
    this.setSyncStatus("conflict");
    new Notice(`⚠️ Sync conflict: "${info.path}" was modified on both devices.`, 8000);
    const choice = await ConflictModal.show(this.app, info);
    await this.engine?.resolveConflict(info.path, choice);
    this.setSyncStatus("idle");
  }

  // ── Relay Health ──────────────────────────────────

  getRelayHealth(): RelayHealth[] {
    return this.engine?.getRelayHealth() ?? [];
  }

  async testRelay(url: string): Promise<{ ok: boolean; latency: number }> {
    const pool = new SimplePool();
    const start = Date.now();
    try {
      await pool.ensureRelay(url);
      const latency = Date.now() - start;
      pool.close([url]);
      return { ok: true, latency };
    } catch {
      pool.close([url]);
      return { ok: false, latency: -1 };
    }
  }

  getSyncStats(): { fileCount: number; lastSync: number } {
    if (this.engine) {
      return this.engine.getSyncStats();
    }
    return { fileCount: 0, lastSync: 0 };
  }

  getRecentActivity(): SyncActivityEntry[] {
    return this.engine?.getRecentActivity() ?? [];
  }
}
