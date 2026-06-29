/**
 * PassphraseModal — prompts the user for their passphrase at plugin startup.
 * Includes a "Remember this device" option for auto-unlock on next start.
 */
import { App, Modal, Setting } from "obsidian";

export interface PassphraseResult {
  passphrase: string;
  remember: boolean;
}

export class PassphraseModal extends Modal {
  private resolve: ((result: PassphraseResult | null) => void) | null = null;

  /**
   * Show the modal and return the entered passphrase + remember flag, or null if dismissed.
   */
  static prompt(app: App): Promise<PassphraseResult | null> {
    return new Promise((resolve) => {
      const modal = new PassphraseModal(app, resolve);
      modal.open();
    });
  }

  private constructor(
    app: App,
    resolve: (result: PassphraseResult | null) => void,
  ) {
    super(app);
    this.resolve = resolve;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Unlock Nostr Sync" });
    contentEl.createEl("p", {
      text: "Enter your passphrase to decrypt your Nostr secret key.",
      cls: "nostr-sync-desc",
    });

    let inputValue = "";
    let rememberValue = false;

    new Setting(contentEl)
      .setName("Passphrase")
      .setDesc("This is never stored — only used in memory this session.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.placeholder = "Your passphrase";
        text.onChange((val) => (inputValue = val));
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && inputValue.length > 0) {
            this.resolve!({ passphrase: inputValue, remember: rememberValue });
            this.close();
          }
        });
      });

    new Setting(contentEl)
      .setName("Remember this device")
      .setDesc("Skip the passphrase next time. The key is encrypted with a device-derived secret — it won't work if you copy your vault to another machine.")
      .addToggle((toggle) => {
        toggle.setValue(false);
        toggle.onChange((val) => (rememberValue = val));
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("Unlock")
          .setCta()
          .onClick(() => {
            if (inputValue.length > 0) {
              this.resolve!({ passphrase: inputValue, remember: rememberValue });
              this.close();
            }
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => {
          this.resolve!(null);
          this.close();
        });
      });
  }

  override onClose(): void {
    if (this.resolve) {
      this.resolve(null);
      this.resolve = null!;
    }
    this.contentEl.empty();
  }
}