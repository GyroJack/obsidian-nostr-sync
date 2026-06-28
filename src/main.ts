/**
 * obsidian-nostr-sync — encrypted vault sync via Nostr relays.
 */
import { Plugin } from "obsidian";
import { nip19, getPublicKey } from "nostr-tools";
import { DEFAULT_RELAYS } from "./constants";
import type { NostrSyncSettings } from "./types";
import { wrapNsec, unwrapNsec } from "./crypto/encryption";
import { SyncEngine } from "./sync/engine";
import { VaultWatcher } from "./sync/watcher";
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
    await this.loadSettings();

    this.addSettingTab(
      new SettingsTab(
        this.app,
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
        /* Manual trigger — engine handles live events */
        console.log("nostr-sync: manual sync triggered");
      },
    });
  }

  override onunload(): void {
    this.watcher?.stop();
    this.engine?.stop();
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
    this.settings.syncEnabled   = false;
    this.engine?.stop();
    void this.saveSettings();
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
      alert("Wrong passphrase. Try again or clear your key in settings.");
      this.settings.syncStatus = "locked";
      await this.saveSettings();
      return;
    }

    await this.startSync(nsecBytes);
    this.settings.syncStatus = "idle";
    await this.saveSettings();
  }

  // ── Sync ──────────────────────────────────────────

  private async startSync(nsecBytes: Uint8Array): Promise<void> {
    this.engine = new SyncEngine(
      this.app.vault,
      nsecBytes,
      this.settings.relays,
    );

    this.watcher = new VaultWatcher(this.app.vault, (e) =>
      this.handleFileChange(e.path, e.action),
    );

    void this.queueFileOp(async () => {
      this.watcher.start();
      await this.engine.start();
    });
  }

  // Drop-in method — bridges watcher events to engine
  private async handleFileChange(
    path: string,
    action: string,
  ): Promise<void> {
    if (action === "delete") {
      await this.engine.handleDelete(path);
    } else {
      await this.engine.pushFile(path);
    }
  }

  // Stub to avoid race conditions (can be expanded for queue)
  private async queueFileOp(fn: () => Promise<void>): Promise<void> {
    await fn();
  }

  // ── Registration ──────────────────────────────────

  async storeNsec(nsec: string, passphrase: string): Promise<void> {
    let nsecBytes: Uint8Array;
    if (nsec.startsWith("nsec")) {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== "nsec") throw new Error("Invalid nsec");
      nsecBytes = decoded.data;
    } else if (/^[0-9a-fA-F]{64}$/.test(nsec)) {
      nsecBytes = new Uint8Array(
        nsec.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
      );
    } else {
      throw new Error("Invalid nsec — must be nsec1... or 64 hex chars");
    }

    const { salt, encrypted } = await wrapNsec(nsecBytes, passphrase);
    const pubkey = getPublicKey(nsecBytes);

    this.settings.encryptedNsec = encrypted;
    this.settings.salt          = salt;
    this.settings.pubkey        = pubkey;
    this.settings.syncEnabled   = true;
    await this.saveSettings();

    await this.startSync(nsecBytes);
  }
}
