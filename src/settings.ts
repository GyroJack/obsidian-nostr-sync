/**
 * SettingsTab — plugin configuration UI in Obsidian's Settings panel.
 */
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { DEFAULT_RELAYS, isValidRelayUrl, MAX_CONSECUTIVE_ERRORS } from "./constants";
import type NostrSyncPlugin from "./main";
import { nip19 } from "nostr-tools";

export class SettingsTab extends PluginSettingTab {
  private healthRefreshInterval: number | null = null;

  constructor(app: App, private plugin: NostrSyncPlugin) {
    super(app, plugin);
  }

  /** Format a timestamp for display as a relative time string. */
  private formatTimeAgo(ts: number): string {
    if (ts === 0) return "never";
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

    // ═══════════════════════════════════════════════════
    // 🔐 Security
    // ═══════════════════════════════════════════════════
    new Setting(containerEl).setName("🔐 Security").setHeading();

    if (this.plugin.settings.encryptedNsec) {
      // ── Public key ────────────────────────────────
      const npub = this.plugin.settings.pubkey
        ? (() => { try { return nip19.npubEncode(this.plugin.settings.pubkey); } catch { return this.plugin.settings.pubkey; } })()
        : "";
      new Setting(containerEl)
        .setName("Public key")
        .setDesc("Your Nostr identity for this vault.")
        .addText((t) =>
          t.setValue(npub || "Not available").setDisabled(true),
        );

      // ── Remember this device ──────────────────────
      const hasDeviceKey = !!this.plugin.settings.deviceEncryptedNsec;
      new Setting(containerEl)
        .setName("Remember this device")
        .setDesc(
          hasDeviceKey
            ? "Auto-unlock on startup without entering your passphrase."
            : "Enable to skip the passphrase prompt when Obsidian restarts.",
        )
        .addToggle((t) =>
          t.setValue(hasDeviceKey).onChange(async (v) => {
            if (v) {
              await this.plugin.rememberDevice();
            } else {
              this.plugin.forgetDevice();
            }
            containerEl.empty();
            this.display();
          }),
        );

      // ── Clear key ─────────────────────────────────
      new Setting(containerEl)
        .setName("Clear stored key")
        .setDesc("Remove all key material. Sync will stop until you re-register.")
        .addButton((btn) =>
          btn.setButtonText("Clear Key").onClick(() => {
            this.plugin.clearStoredKey();
            containerEl.empty();
            this.display();
          }),
        );
    } else {
      // ── Register key ──────────────────────────────
      let nsecValue = "";
      let passphraseValue = "";

      containerEl.createEl("p", {
        text: "Enter your nsec and a strong passphrase to get started.",
      });

      new Setting(containerEl)
        .setName("Secret key (nsec)")
        .setDesc("Your Nostr secret key, starting with nsec1...")
        .addText((t) => {
          t.setPlaceholder("nsec1...");
          t.inputEl.type = "password";
          t.onChange((v) => { nsecValue = v; });
        });

      new Setting(containerEl)
        .setName("Passphrase")
        .setDesc("At least 8 characters. Required to unlock on startup.")
        .addText((t) => {
          t.setPlaceholder("Enter passphrase...");
          t.inputEl.type = "password";
          t.onChange((v) => { passphraseValue = v; });
        });

      new Setting(containerEl)
        .addButton((btn) =>
          btn.setButtonText("Register").setCta().onClick(async () => {
            try {
              await this.plugin.storeNsec(nsecValue, passphraseValue);
              containerEl.empty();
              this.display();
            } catch {
              // Error notices are shown by the plugin.
            }
          }),
        );
    }

    // ═══════════════════════════════════════════════════
    // 🔄 Sync
    // ═══════════════════════════════════════════════════
    new Setting(containerEl).setName("🔄 Sync").setHeading();

    // ── Enable / disable ───────────────────────────
    new Setting(containerEl)
      .setName("Enable sync")
      .setDesc("Turn Nostr relay sync on or off. When off, no files are pushed or pulled.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncEnabled).onChange(async (v) => {
          this.plugin.toggleSync(v);
        }),
      );

    // ── Debounce slider ────────────────────────────
    new Setting(containerEl)
      .setName("Sync delay")
      .setDesc(
        `How long to wait after you stop typing before pushing changes. ` +
        `Longer delays reduce relay traffic on public relays.`,
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.debounceMs / 1000)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.debounceMs = val * 1000;
            await this.plugin.saveSettings();
          }),
      );

    // ── Sync Now button ────────────────────────────
    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc("Push all local files to relays immediately.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").onClick(async () => {
          if (!this.plugin.settings.encryptedNsec) {
            new Notice("❌ Register a key first.");
            return;
          }
          btn.setDisabled(true);
          btn.setButtonText("Syncing...");
          new Notice("🔄 Nostr Sync: pushing all files...");
          try {
            await this.plugin.syncNow();
          } finally {
            btn.setDisabled(false);
            btn.setButtonText("Sync Now");
            containerEl.empty();
            this.display();
          }
        }),
      );

    // ── Sync stats ─────────────────────────────────
    const stats = this.plugin.getSyncStats();
    const timeStr = this.formatTimeAgo(stats.lastSync);
    new Setting(containerEl)
      .setName("Sync stats")
      .setDesc(
        stats.lastSync === 0
          ? "No syncs yet."
          : `${stats.fileCount} files tracked · last sync ${timeStr}`,
      );

    // ═══════════════════════════════════════════════════
    // 📡 Relays
    // ═══════════════════════════════════════════════════
    new Setting(containerEl).setName("📡 Relays").setHeading();

    const relays =
      this.plugin.settings.relays.length > 0
        ? this.plugin.settings.relays
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
                this.plugin.settings.relays[idx] = v;
                await this.plugin.saveSettings();
              }
            }),
        )
        .addButton((btn) =>
          btn.setButtonText("Test").onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("...");
            const result = await this.plugin.testRelay(relayUrl);
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
            this.plugin.settings.relays.splice(idx, 1);
            await this.plugin.saveSettings();
            containerEl.empty();
            this.display();
          }),
        );
    }

    // ── Add relay ──────────────────────────────────
    let newRelayUrl = "";
    new Setting(containerEl)
      .addText((text) =>
        text
          .setPlaceholder("wss://relay.example.com")
          .onChange((v) => { newRelayUrl = v; }),
      )
      .addButton((btn) =>
        btn.setButtonText("Add").setCta().onClick(async () => {
          if (isValidRelayUrl(newRelayUrl)) {
            this.plugin.settings.relays.push(newRelayUrl);
            await this.plugin.saveSettings();
            containerEl.empty();
            this.display();
          } else {
            new Notice("❌ Invalid relay URL — must start with ws:// or wss://");
          }
        }),
      );

    // ── Relay Health (table) ───────────────────────
    containerEl.createEl("h3", { text: "Relay Health" });
    const healthSectionEl = containerEl.createDiv({ cls: "nostr-sync-health" });
    this.renderRelayHealth(healthSectionEl);

    this.healthRefreshInterval = window.setInterval(() => {
      this.renderRelayHealth(healthSectionEl);
    }, 5000);

    // ═══════════════════════════════════════════════════
    // ℹ️ About
    // ═══════════════════════════════════════════════════
    new Setting(containerEl).setName("ℹ️ About").setHeading();

    new Setting(containerEl)
      .setName("Version")
      .setDesc("1.2.4");

    new Setting(containerEl)
      .setName("Authors")
      .setDesc("Jack & Hermes");

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("github.com/GyroJack/obsidian-nostr-sync");
  }

  // ── Relay Health Table ──────────────────────────────

  private renderRelayHealth(containerEl: HTMLElement): void {
    containerEl.empty();
    const health = this.plugin.getRelayHealth();
    if (health.length === 0) {
      containerEl.createEl("p", {
        text: "No relay health data yet. Start sync to connect.",
        cls: "setting-item-description",
      });
      return;
    }

    const table = containerEl.createEl("table", {
      cls: "nostr-sync-health-table",
    });
    const header = table.createEl("tr");
    header.createEl("th", { text: "" });
    header.createEl("th", { text: "Relay" });
    header.createEl("th", { text: "Latency" });
    header.createEl("th", { text: "Status" });

    for (const h of health) {
      const dot = h.connected
        ? "🟢"
        : h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
          ? "🔴"
          : h.consecutiveErrors > 0
            ? "🟡"
            : "⚪";
      const statusText = h.connected
        ? "Connected"
        : h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
          ? "Dead"
          : h.consecutiveErrors > 0
            ? "Unstable"
            : "Unknown";
      const latencyStr = h.latency === -1 ? "—" : `${h.latency}ms`;

      const row = table.createEl("tr");
      row.createEl("td", { text: dot });
      row.createEl("td", { text: h.url });
      row.createEl("td", { text: latencyStr });
      row.createEl("td", { text: statusText });
    }
  }

  // ── Relay Health Dot Helper ─────────────────────────

  private getRelayHealthDot(relayUrl: string): string {
    const health = this.plugin.getRelayHealth();
    const h = health.find((r) => r.url === relayUrl);
    if (!h) return "⚪";
    if (h.connected) return "🟢";
    if (h.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return "🔴";
    if (h.consecutiveErrors > 0) return "🟡";
    return "⚪";
  }

  // ── Cleanup ─────────────────────────────────────────

  override hide(): void {
    if (this.healthRefreshInterval !== null) {
      clearInterval(this.healthRefreshInterval);
      this.healthRefreshInterval = null;
    }
  }
}
