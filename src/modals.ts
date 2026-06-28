/**
 * PassphraseModal — prompts the user for their passphrase at plugin startup.
 * Caching in memory for the session is handled by the main plugin module.
 */
import { App, Modal, Setting } from "obsidian";

export class PassphraseModal extends Modal {
  private resolve!: (passphrase: string | null) => void;

  /**
   * Show the modal and return the entered passphrase or null if dismissed.
   */
  static prompt(app: App): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new PassphraseModal(app, resolve);
      modal.open();
    });
  }

  private constructor(
    app: App,
    resolve: (passphrase: string | null) => void,
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

    new Setting(contentEl)
      .setName("Passphrase")
      .setDesc("This is never stored — only used in memory this session.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.placeholder = "Your passphrase";
        text.onChange((val) => (inputValue = val));
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && inputValue.length > 0) {
            this.resolve(inputValue);
            this.close();
          }
        });
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("Unlock")
          .setCta()
          .onClick(() => {
            if (inputValue.length > 0) {
              this.resolve(inputValue);
              this.close();
            }
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => {
          this.resolve(null);
          this.close();
        });
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
