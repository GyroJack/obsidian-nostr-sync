/**
 * SettingsTab — plugin configuration UI in Obsidian's Settings panel.
 */
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { DEFAULT_RELAYS, isValidRelayUrl, MAX_CONSECUTIVE_ERRORS } from "./constants";
import type { NostrSyncSettings, RelayHealth } from "./types";
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
  private healthRefreshInterval: number | null = null;

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

    const relays = this.settings.relays.length > 0
      ? this.settings.relays
      : [...DEFAULT_RELAYS];

    for (let i = 0; i < relays.length; i++) {
      const relayUrl = relays[i];
      const idx = i;

      new Setting(containerEl)
        .setName(this.getRelayHealthDot(relayUrl))
        .addText((text) =>
          text
            .setPlaceholder("wss://relay.example.com")
            .setValue(relayUrl)
            .onChange(async (v) => {
              if (isValidRelayUrl(v)) {
                this.settings.relays[idx] = v;
                await this.saveFn();
              }
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText("Test")
            .onClick(async () => {
              btn.setDisabled(true);
              btn.setButtonText("...");
              const result = await this.relayTestFn(relayUrl);
              new Notice(
                result.ok
                  ? `✅ ${relayUrl} (${result.latency}ms)`
                  : `❌ ${relayUrl} connection failed`,
              );
              btn.setDisabled(false);
              btn.setButtonText("Test");
            }),
        )
        .addButton((btn) =>
          btn.setIcon("cross").onClick(async () => {
            this.settings.relays.splice(idx, 1);
            await this.saveFn();
            containerEl.empty();
            this.display();
          }),
        );
    }

    // Add new relay
    let newRelayUrl = "";
    new Setting(containerEl)
      .addText((text) =>
        text
          .setPlaceholder("wss://relay.example.com")
          .onChange((v) => {
            newRelayUrl = v;
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            if (isValidRelayUrl(newRelayUrl)) {
              this.settings.relays.push(newRelayUrl);
              await this.saveFn();
              containerEl.empty();
              this.display();
            } else {
              new Notice("❌ Invalid relay URL");
            }
          }),
      );

    // ── Relay Health ────────────────────────────────
    containerEl.createEl("h3", { text: "Relay Health" });
    const healthSectionEl = containerEl.createDiv({ cls: "nostr-sync-health" });
    this.renderRelayHealth(healthSectionEl);

    this.healthRefreshInterval = window.setInterval(() => {
      this.renderRelayHealth(healthSectionEl);
    }, 5000);
  }

  private renderRelayHealth(containerEl: HTMLElement): void {
    containerEl.empty();
    const health = this.getRelayHealth();
    if (health.length === 0) {
      containerEl.createEl("p", {
        text: "No relay health data yet. Start sync to connect.",
        cls: "setting-item-description",
      });
    } else {
      for (const h of health) {
        const dot = h.connected
          ? "🟢"
          : h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
            ? "🔴"
            : h.consecutiveErrors > 0
              ? "🟡"
              : "⚪";
        const latencyStr = h.latency === -1 ? "—" : `${h.latency}ms`;
        containerEl.createEl("p", {
          text: `${dot} ${h.url} — ${latencyStr} — ${h.consecutiveErrors} errors`,
          cls: "setting-item-description",
        });
      }
    }
  }

  private getRelayHealthDot(relayUrl: string): string {
    const health = this.getRelayHealth();
    const h = health.find((r) => r.url === relayUrl);
    if (!h) return "⚪";
    if (h.connected) return "🟢";
    if (h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return "🔴";
    if (h.consecutiveErrors > 0) return "🟡";
    return "⚪";
  }

  override hide(): void {
    if (this.healthRefreshInterval !== null) {
      clearInterval(this.healthRefreshInterval);
      this.healthRefreshInterval = null;
    }
  }
}
