/**
 * obsidian-nostr-sync — encrypted vault sync via Nostr relays.
 */
import { Plugin, Notice } from "obsidian";
import { nip19, getPublicKey, SimplePool } from "nostr-tools";
import { DEFAULT_RELAYS, isValidRelayUrl, MAX_CONSECUTIVE_ERRORS } from "./constants";
import type { NostrSyncSettings, RelayHealth, SyncStatus, ConflictInfo, SyncActivityEntry } from "./types";
import { ConflictModal } from "./modals/conflict-modal";
import { unwrapNsec, wrapNsec, unwrapNsecDevice, wrapNsecDevice } from "./crypto/encryption";
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
  relays: [...DEFAULT_RELAYS],
  syncEnabled: false,
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
  private latestRelayHealth: RelayHealth[] = [];

  override async onload(): Promise<void> {
    try {
      await this.loadSettings();

      this.addSettingTab(
        new SettingsTab(
          this.app,
          this,
          this.settings,
          () => this.saveSettings(),
          () => this.clearStoredKey(),
          (nsec, passphrase) => this.storeNsec(nsec, passphrase),
          () => this.getRelayHealth(),
          (url) => this.testRelay(url),
          () => this.getSyncStats(),
        ),
      );

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
        // Defer to after layout ready — otherwise onload() hangs
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
    // Push final state before disconnecting
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

  /** Load persisted settings from Obsidian's data store. */
  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  /** Persist current settings to Obsidian's data store. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Remove all stored keys and stop sync. */
  clearStoredKey(): void {
    this.settings.encryptedNsec = "";
    this.settings.salt          = "";
    this.settings.pubkey        = "";
    this.settings.deviceEncryptedNsec = "";
    this.settings.syncEnabled   = false;
    this.engine?.stop();
    void this.saveSettings();
    new Notice("Nostr Sync: key cleared.");
  }

  /**
   * Register a new nsec with a passphrase.
   * Also stores a device-encrypted copy so the user isn't prompted on restart.
   */
  async storeNsec(nsec: string, passphrase: string): Promise<void> {
    if (passphrase.length < 8) {
      new Notice(
        "Nostr Sync: passphrase must be at least 8 characters.",
        6000,
      );
      throw new Error("Passphrase too short");
    }

    let nsecBytes: Uint8Array;
    try {
      if (nsec.startsWith("nsec1")) {
        const decoded = nip19.decode(nsec);
        if (decoded.type !== "nsec") throw new Error("Invalid nsec");
        nsecBytes = decoded.data as Uint8Array;
      } else if (/^[0-9a-fA-F]{64}$/.test(nsec)) {
        nsecBytes = new Uint8Array(32);
        for (let i = 0; i < 64; i += 2) {
          nsecBytes[i / 2] = parseInt(nsec.substring(i, i + 2), 16);
        }
      } else {
        throw new Error("Invalid nsec format");
      }
    } catch {
      new Notice(
        "Nostr Sync: invalid nsec format. Use nsec1... or 64-char hex.",
        8000,
      );
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

    // Auto-save device-encrypted copy so restart doesn't prompt
    await this.saveDeviceEncryptedNsec(nsecBytes);
    new Notice("Nostr Sync: key registered and syncing");
  }

  // ── Unlock ────────────────────────────────────────

  /**
   * Try to unlock and start sync. Device-key first, then passphrase prompt.
   */
  private async unlockAndStart(): Promise<void> {
    // 1. Try device-key auto-unlock first
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
        // Device key mismatch (settings migrated to new device? pubkey/vaultId changed?)
        // Fall through to passphrase prompt.
        console.debug("nostr-sync: device-key auto-unlock failed, falling back to passphrase");
        this.settings.deviceEncryptedNsec = "";
        await this.saveSettings();
      }
    }

    // 2. Fall back to passphrase prompt
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
      new Notice(
        "Nostr Sync: wrong passphrase. Try again or clear your key in settings.",
        8000,
      );
      this.settings.syncStatus = "locked";
      await this.saveSettings();
      this.setSyncStatus("locked");
      return;
    }

    await this.startSync(nsecBytes);
    this.settings.syncStatus = "idle";
    await this.saveSettings();

    // If user checked "Remember this device", save device-encrypted copy
    if (result.remember) {
      await this.saveDeviceEncryptedNsec(nsecBytes);
    }

    new Notice("Nostr Sync: unlocked and syncing");
  }

  /** Encrypt nsec with device-derived key and persist to settings. */
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

  // ── Sync ──────────────────────────────────────────

  private async startSync(nsecBytes: Uint8Array): Promise<void> {
    // Generate and persist a deterministic vault ID on first run
    if (!this.settings.vaultId) {
      this.settings.vaultId = getPublicKey(nsecBytes).slice(0, 12);
      await this.saveSettings();
    }

    this.engine = new SyncEngine(
      this.app.vault,
      this.app,
      nsecBytes,
      this.settings.vaultId,
      this.settings.relays.filter(isValidRelayUrl),
    );

    // Wire relay health to status bar
    this.engine.onHealthChange = (health) => {
      const prevConnected = this.latestRelayHealth.some((h) => h.connected);
      this.latestRelayHealth = health;

      const relay = health.length > 0 ? health[0] : null;
      const connected = relay?.connected ?? false;
      const allDown = health.length > 0 && health.every((h) => h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS);

      if (connected) {
        if (!prevConnected && relay) {
          new Notice(`Nostr Sync: connected to relay (${relay.latency}ms)`);
        }
        this.setSyncStatus("idle", relay!.latency);
      } else if (allDown) {
        this.setSyncStatus("offline");
      } else {
        this.setSyncStatus("connecting");
      }
    };

    // Wire conflict detection
    this.engine.onConflict = (info) => this.showConflictModal(info);

    // Wire file-change watcher (15s idle debounce → push)
    this.watcher = new VaultWatcher(this.app.vault, (e: FileChangeEvent) =>
      this.handleFileChange(e),
    );
    this.watcher.start();

    await this.engine.start();

    // Do an initial sync on startup
    await this.syncNow();
  }

  /**
   * Full sync cycle: push all local changes to relays.
   * Pull happens automatically via active subscriptions.
   */
  private async syncNow(): Promise<void> {
    if (!this.engine) return;
    this.setSyncStatus("syncing");
    try {
      await this.engine.syncAllLocalFiles();
      await this.engine.rebuildIndex();
      this.setSyncStatus("idle");
    } catch (e) {
      console.warn("nostr-sync: sync cycle failed", e);
      this.setSyncStatus("error");
    }
  }

  // ── Status Bar ────────────────────────────────────

  /** Bridges VaultWatcher events to SyncEngine. */
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

  private setSyncStatus(status: SyncStatus, latency?: number): void {
    // Debounce: avoid rapid DOM updates during sync cycles.
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
          this.statusBarItem.setText(`✅ Nostr Sync (${latency}ms)`);
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

  /** Test a single relay connection and measure latency. */
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

  /** Get sync stats from the engine. */
  getSyncStats(): { fileCount: number; lastSync: number } {
    if (this.engine) {
      return this.engine.getSyncStats();
    }
    return { fileCount: 0, lastSync: 0 };
  }

  /** Get recent sync activity from the engine. */
  getRecentActivity(): SyncActivityEntry[] {
    return this.engine?.getRecentActivity() ?? [];
  }
}