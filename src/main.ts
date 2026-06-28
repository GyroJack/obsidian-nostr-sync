/**
 * obsidian-nostr-sync — encrypted vault sync via Nostr relays.
 */
import { Plugin, Notice } from "obsidian";
import { nip19, getPublicKey, SimplePool } from "nostr-tools";
import { DEFAULT_RELAYS, isValidRelayUrl, MAX_CONSECUTIVE_ERRORS } from "./constants";
import type { NostrSyncSettings, RelayHealth, SyncStatus, ConflictInfo, SyncActivityEntry } from "./types";
import { ConflictModal } from "./modals/conflict-modal";
import { unwrapNsec, wrapNsec } from "./crypto/encryption";
import { SyncEngine } from "./sync/engine";
import { SettingsTab } from "./settings";
import { PassphraseModal } from "./modals";

const DEFAULTS: NostrSyncSettings = {
  encryptedNsec: "",
  salt: "",
  pubkey: "",
  relays: [...DEFAULT_RELAYS],
  syncEnabled: false,
  syncStatus: "locked",
  lastSyncTime: 0,
  syncedFileCount: 0,
};

export default class NostrSyncPlugin extends Plugin {
  declare settings: NostrSyncSettings;
  private engine!: SyncEngine;
  private _syncTimer: ReturnType<typeof setInterval> | null = null;
  private statusBarItem: HTMLElement | null = null;
  private statusDebounce: ReturnType<typeof setTimeout> | null = null;

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

      // Status bar
      this.app.workspace.onLayoutReady(() => {
        this.statusBarItem = this.addStatusBarItem();
        this.setSyncStatus(this.settings.syncStatus || "locked");
        this.statusBarItem.addClass("nostr-sync-status-bar");
        this.statusBarItem.addEventListener("click", () => {
          void this.showRelayHealthPopup();
        });
      });

      if (this.settings.syncEnabled && this.settings.encryptedNsec) {
        // Defer modal to after layout ready — otherwise onload() hangs
        // and Obsidian kills the plugin for taking too long.
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
    // Stop interval timer
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    // Push final state before disconnecting
    if (this.engine) {
      try {
        await this.engine.rebuildIndex();
      } catch {
        // Best effort on shutdown
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

  /** Remove the encrypted nsec, salt, and pubkey from settings and stop sync. */
  clearStoredKey(): void {
    this.settings.encryptedNsec = "";
    this.settings.salt          = "";
    this.settings.pubkey        = "";
    this.settings.syncEnabled   = false;
    this.engine?.stop();
    void this.saveSettings();
    new Notice("Nostr Sync: key cleared.");
  }

  /**
   * Register a new nsec with a passphrase.
   * Validates the key, wraps it with the passphrase, derives the pubkey,
   * persists settings, and starts the sync engine.
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
    new Notice("Nostr Sync: key registered and syncing");
  }

  // ── Unlock ────────────────────────────────────────

  private async unlockAndStart(): Promise<void> {
    const pw = await PassphraseModal.prompt(this.app);
    if (!pw) {
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
        pw,
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
    new Notice("Nostr Sync: unlocked and syncing");
  }

  // ── Sync ──────────────────────────────────────────

  private async startSync(nsecBytes: Uint8Array): Promise<void> {
    this.engine = new SyncEngine(
      this.app.vault,
      nsecBytes,
      this.settings.relays.filter(isValidRelayUrl),
    );

    // Wire relay health to status bar
    this.engine.onHealthChange = (health) => {
      const allDown = health.length > 0 && health.every((h) => h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS);
      this.setSyncStatus(allDown ? "offline" : "idle");
    };

    // Wire conflict detection
    this.engine.onConflict = (info) => this.showConflictModal(info);

    await this.engine.start();

    // Do an initial sync on startup
    await this.syncNow();

    // Set up 5-minute auto-sync interval
    this._syncTimer = setInterval(() => {
      void this.syncNow();
    }, 5 * 60 * 1000);
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

  private setSyncStatus(status: SyncStatus): void {
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
        this.statusBarItem.setText("✅ Nostr Sync");
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

  /** Show a notice with live relay pings and recent sync activity. */
  private async showRelayHealthPopup(): Promise<void> {
    const relays = this.settings.relays.filter(isValidRelayUrl);

    // Show "measuring" notice while testing
    const measuringNotice = new Notice("Measuring relay latency...", 0);

    try {
      // Test all relays in parallel
      const results = await Promise.all(
        relays.map(async (url) => {
          const result = await this.testRelay(url);
          return { url, ...result };
        }),
      );

      // Format relay results
      const relayLines: string[] = [];
      for (const r of results) {
        if (r.ok) {
          const icon = r.latency < 200 ? "✅" : "🟡";
          relayLines.push(`${icon} ${r.url} — ${r.latency}ms`);
        } else {
          relayLines.push(`❌ ${r.url} — failed`);
        }
      }

      // Get recent activity
      const activity = this.getRecentActivity();
      const activityLines: string[] = [];
      if (activity.length === 0) {
        activityLines.push("No recent sync activity");
      } else {
        activityLines.push("Recent Activity (last 20):");
        const recent = activity.slice(0, 20);
        for (const entry of recent) {
          const arrow = entry.action === "pulled" ? "↓" : entry.action === "pushed" ? "↑" : "✕";
          activityLines.push(`${arrow} ${entry.action} ${entry.path}`);
        }
      }

      // Build full message
      const lines = [
        "Nostr Sync",
        "",
        "Relays:",
        ...relayLines,
        "",
        ...activityLines,
      ];

      // Dismiss measuring notice and show results
      measuringNotice.hide();
      new Notice(lines.join("\n"), 10000);
    } catch (err) {
      measuringNotice.hide();
      new Notice("❌ Failed to test relays", 5000);
    }
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
