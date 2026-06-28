/**
 * SettingsTab — plugin configuration UI in Obsidian's Settings panel.
 */
import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_RELAYS, isValidRelayUrl } from "./constants";
import type { NostrSyncSettings, RelayHealth } from "./types";
import type NostrSyncPlugin from "./main";

export class SettingsTab extends PluginSettingTab {
  private settings: NostrSyncSettings;
  private saveFn: () => Promise<void>;
  private clearNsecFn: () => void;
  private storeNsecFn: (nsec: string, passphrase: string) => Promise<void>;
  private getRelayHealth: () => RelayHealth[];

  constructor(
    app: App,
    plugin: NostrSyncPlugin,
    settings: NostrSyncSettings,
    saveFn: () => Promise<void>,
    clearNsecFn: () => void,
    storeNsecFn: (nsec: string, passphrase: string) => Promise<void>,
    getRelayHealth: () => RelayHealth[],
  ) {
    super(app, plugin);
    this.settings       = settings;
    this.saveFn         = saveFn;
    this.clearNsecFn    = clearNsecFn;
    this.storeNsecFn    = storeNsecFn;
    this.getRelayHealth = getRelayHealth;
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

    if (this.settings.encryptedNsec) {
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
          "Remove the stored secret key. You'll need your nsec to re-register.",
        )
        .addButton((btn) => {
          btn
            .setButtonText("Clear Key")
            .onClick(() => {
              this.clearNsecFn();
              containerEl.empty();
              this.display();
            });
        });
    } else {
      // ── Register key ────────────────────────────────
      let nsecValue = "";
      let passphraseValue = "";

      containerEl.createEl("h3", { text: "Register key" });
      containerEl.createEl("p", {
        text: "Enter your nsec and a strong passphrase to encrypt it.",
      });

      new Setting(containerEl)
        .setName("Secret key (nsec)")
        .setDesc("Your Nostr secret key, starting with nsec1...")
        .addText((t) => {
          t.setPlaceholder("nsec1...");
          t.inputEl.type = "password";
          t.onChange((v) => {
            nsecValue = v;
          });
        });

      new Setting(containerEl)
        .setName("Passphrase")
        .setDesc("At least 8 characters. Required to unlock on startup.")
        .addText((t) => {
          t.setPlaceholder("Enter passphrase...");
          t.inputEl.type = "password";
          t.onChange((v) => {
            passphraseValue = v;
          });
        });

      new Setting(containerEl)
        .setName("Register")
        .setDesc("Save the encrypted key and start syncing.")
        .addButton((btn) => {
          btn
            .setButtonText("Register")
            .setCta()
            .onClick(async () => {
              try {
                await this.storeNsecFn(nsecValue, passphraseValue);
                containerEl.empty();
                this.display();
              } catch {
                // Error notices are shown by the plugin.
              }
            });
        });
    }

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

    // ── Relay Health ────────────────────────────────
    containerEl.createEl("h3", { text: "Relay Health" });
    const health = this.getRelayHealth();
    if (health.length === 0) {
      containerEl.createEl("p", {
        text: "No relay health data yet. Start sync to connect.",
        cls: "setting-item-description",
      });
    } else {
      const table = containerEl.createEl("table", { cls: "nostr-sync-health-table" });
      const header = table.createEl("tr");
      header.createEl("th", { text: "Status" });
      header.createEl("th", { text: "Relay" });
      header.createEl("th", { text: "Latency" });
      header.createEl("th", { text: "Errors" });

      for (const h of health) {
        const row = table.createEl("tr");
        const statusIcon = h.connected ? "✅" : h.consecutiveErrors > 0 ? "🟡" : "❌";
        row.createEl("td", { text: statusIcon });
        row.createEl("td", { text: h.url });
        row.createEl("td", { text: h.latency === -1 ? "—" : `${h.latency}ms` });
        row.createEl("td", { text: h.consecutiveErrors > 0 ? `${h.consecutiveErrors}` : "0" });
      }
    }
  }
}
