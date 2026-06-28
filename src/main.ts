/**
 * obsidian-nostr-sync — encrypted vault sync via Nostr relays.
 */
import { Plugin, Notice } from "obsidian";
import { DEFAULT_RELAYS, isValidRelayUrl } from "./constants";
import type { NostrSyncSettings } from "./types";
import { unwrapNsec } from "./crypto/encryption";
import { SyncEngine } from "./sync/engine";
import { VaultWatcher } from "./sync/watcher";
import type { FileChangeEvent } from "./sync/watcher";
import { SettingsTab } from "./settings";
import { PassphraseModal } from "./modals";

const DEFAULTS: NostrSyncSettings = {
  encryptedNsec: "",
  salt: "",
  pubkey: "",
  relays: [...DEFAULT_RELAYS],
  syncEnabled: false,
  syncStatus: "locked",
};

export default class NostrSyncPlugin extends Plugin {
  declare settings: NostrSyncSettings;
  private engine!: SyncEngine;
  private watcher!: VaultWatcher;

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
        ),
      );

      if (this.settings.syncEnabled && this.settings.encryptedNsec) {
        await this.unlockAndStart();
      }

      this.addCommand({
        id: "sync-now",
        name: "Sync Now",
        callback: () => {
          new Notice("Nostr Sync: checking for remote changes...");
          void this.engine?.rebuildIndex();
        },
      });
    } catch (err) {
      new Notice("Nostr Sync: failed to start. Check the developer console.", 0);
      console.error("Nostr Sync: onload failed", err);
    }
  }

  override onunload(): void {
    this.watcher?.stop();
    this.engine?.stop();
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

  // ── Unlock ────────────────────────────────────────

  private async unlockAndStart(): Promise<void> {
    const pw = await PassphraseModal.prompt(this.app);
    if (!pw) {
      this.settings.syncStatus = "locked";
      await this.saveSettings();
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

    this.watcher = new VaultWatcher(this.app.vault, (e: FileChangeEvent) =>
      this.handleFileChange(e),
    );

    this.watcher.start();
    await this.engine.start();
  }

  /** Bridges VaultWatcher events to SyncEngine */
  private async handleFileChange(e: FileChangeEvent): Promise<void> {
    try {
      switch (e.action) {
        case "modify":
        case "create":
          await this.engine.pushFile(e.path);
          break;
        case "delete":
          await this.engine.handleDelete(e.path);
          break;
        case "rename":
          if (e.oldPath) {
            await this.engine.handleRename(e.oldPath, e.path);
          } else {
            await this.engine.pushFile(e.path);
          }
          break;
      }
    } catch {
      // Swallow file-sync errors so a single bad file doesn't crash the plugin.
      // No sensitive data (paths, content, keys) is logged.
    }
  }

}
