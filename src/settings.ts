/**
 * SettingsTab — plugin configuration UI in Obsidian's Settings panel.
 */
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { DEFAULT_RELAYS, isValidRelayUrl } from "./constants";
import type { NostrSyncSettings, RelayHealth } from "./types";
import { formatRelayHealth } from "./types";
import type NostrSyncPlugin from "./main";
import { nip19 } from "nostr-tools";

export class SettingsTab extends PluginSettingTab {
  private settings: NostrSyncSettings;
  private saveFn: () => Promise<void>;
  private clearNsecFn: () => void;
  private storeNsecFn: (nsec: string, passphrase: string) => Promise<void>;
  private getRelayHealth: () => RelayHealth[];
  private relayTestFn: (url: string) => Promise<{ ok: boolean; latency: number }>;
  private getSyncStats: () => { fileCount: number; lastSync: number };

  constructor(
    app: App,
    plugin: NostrSyncPlugin,
    settings: NostrSyncSettings,
    saveFn: () => Promise<void>,
    clearNsecFn: () => void,
    storeNsecFn: (nsec: string, passphrase: string) => Promise<void>,
    getRelayHealth: () => RelayHealth[],
    relayTestFn?: (url: string) => Promise<{ ok: boolean; latency: number }>,
    getSyncStats?: () => { fileCount: number; lastSync: number },
  ) {
    super(app, plugin);
    this.settings       = settings;
    this.saveFn         = saveFn;
    this.clearNsecFn    = clearNsecFn;
    this.storeNsecFn    = storeNsecFn;
    this.getRelayHealth = getRelayHealth;
    this.relayTestFn    = relayTestFn ?? (async () => ({ ok: false, latency: -1 }));
    this.getSyncStats   = getSyncStats ?? (() => ({ fileCount: 0, lastSync: 0 }));
  }

  /** Format a timestamp for display as a relative time string. */
  private formatTimeAgo(ts: number): string {
    if (ts === 0) return "Never synced";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(ts).toLocaleDateString();
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

    // ── Sync Stats ──────────────────────────────────
    const stats = this.getSyncStats();
    const timeStr = this.formatTimeAgo(stats.lastSync);
    const statsLine = stats.lastSync === 0
      ? "Never synced"
      : `Last sync: ${timeStr} • ${stats.fileCount} files synced`;
    containerEl.createEl("p", {
      text: statsLine,
      cls: "setting-item-description",
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
      const npub = this.settings.pubkey
        ? (() => { try { return nip19.npubEncode(this.settings.pubkey); } catch { return this.settings.pubkey; } })()
        : "";
      new Setting(containerEl)
        .setName("Public key")
        .setDesc("Your Nostr public key")
        .addText((t) =>
          t
            .setValue(npub || "Not available")
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
      text: "Your private relay (ws://your-relay:7777) should be listed above. One URL per line.",
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
      header.createEl("th", { text: "Test" });

      for (const h of health) {
        const f = formatRelayHealth(h);
        const row = table.createEl("tr");
        row.createEl("td", { text: f.icon });
        row.createEl("td", { text: h.url });
        row.createEl("td", { text: f.latencyStr });
        row.createEl("td", { text: h.consecutiveErrors > 0 ? `${h.consecutiveErrors}` : "0" });
        // Test button
        const testTd = row.createEl("td");
        const testBtn = testTd.createEl("button", { text: "Test" });
        testBtn.addEventListener("click", async () => {
          testBtn.setText("Testing...");
          testBtn.setAttr("disabled", "true");
          const result = await this.relayTestFn(h.url);
          if (result.ok) {
            new Notice(`✅ Connected to ${h.url} (${result.latency}ms)`);
          } else {
            new Notice(`❌ Failed to connect to ${h.url}`);
          }
          testBtn.setText("Test");
          testBtn.removeAttribute("disabled");
        });
      }
    }
  }
}
