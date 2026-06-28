/**
 * SettingsTab — plugin configuration UI in Obsidian's Settings panel.
 */
import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_RELAYS, isValidRelayUrl } from "./constants";
import type { NostrSyncSettings } from "./types";
import type NostrSyncPlugin from "./main";

export class SettingsTab extends PluginSettingTab {
  private settings: NostrSyncSettings;
  private saveFn: () => Promise<void>;
  private clearNsecFn: () => void;

  constructor(
    app: App,
    plugin: NostrSyncPlugin,
    settings: NostrSyncSettings,
    saveFn: () => Promise<void>,
    clearNsecFn: () => void,
  ) {
    super(app, plugin);
    this.settings     = settings;
    this.saveFn       = saveFn;
    this.clearNsecFn  = clearNsecFn;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Nostr Sync" });

    // ── Status ──────────────────────────────────────
    const statusText = this.settings.syncEnabled
      ? `Sync is ${this.settings.syncStatus || "idle"}`
      : "Sync is paused";
    containerEl.createEl("p", {
      text: `Status: ${statusText}`,
      cls: "nostr-sync-status",
    });

    // ── Toggle ──────────────────────────────────────
    new Setting(containerEl)
      .setName("Enable sync")
      .setDesc("Turn Nostr relay sync on or off")
      .addToggle((t) =>
        t
          .setValue(this.settings.syncEnabled)
          .onChange(async (v) => {
            this.settings.syncEnabled = v;
            await this.saveFn();
          }),
      );

    // ── Public key ──────────────────────────────────
    new Setting(containerEl)
      .setName("Public key")
      .setDesc("Your Nostr public key (npub)")
      .addText((t) =>
        t
          .setValue(this.settings.pubkey || "")
          .setDisabled(true),
      );

    // ── Passphrase / Reset ──────────────────────────
    new Setting(containerEl)
      .setName("Reset keys")
      .setDesc(
        this.settings.encryptedNsec
          ? "Remove the stored secret key. You'll need your nsec to re-register."
          : "No secret key stored yet.",
      )
      .addButton((btn) => {
        btn
          .setButtonText(this.settings.encryptedNsec ? "Clear Key" : "Set Key")
          .onClick(() => {
            this.clearNsecFn();
            containerEl.empty();
            this.display();
          });
      });

    // ── Relays ──────────────────────────────────────
    containerEl.createEl("h3", { text: "Relays" });
    containerEl.createEl("p", {
      text: "One WebSocket URL per line. Changes take effect on next sync cycle.",
    });

    new Setting(containerEl).addTextArea((ta) => {
      ta.setValue((this.settings.relays ?? DEFAULT_RELAYS).join("\n"));
      ta.setPlaceholder(DEFAULT_RELAYS.join("\n"));
      ta.inputEl.rows = 6;
      ta.onChange(async (val) => {
        this.settings.relays = val
          .split("\n")
          .map((s) => s.trim())
          .filter(isValidRelayUrl);
        await this.saveFn();
      });
      return ta;
    });

    containerEl.createEl("p", {
      text: "Default relays: damus.io, nos.lol, primal.net, ditto.pub",
      cls: "setting-item-description",
    });
  }
}
