/**
 * ConflictModal — side-by-side diff modal for sync conflicts.
 * User picks "Keep Local", "Keep Remote", or "Keep Both".
 */
import { App, Modal } from "obsidian";
import type { ConflictInfo, ConflictChoice } from "../types";

export { ConflictChoice };
export type { ConflictInfo };

export class ConflictModal extends Modal {
  private resolve!: (choice: ConflictChoice) => void;

  static show(app: App, info: ConflictInfo): Promise<ConflictChoice> {
    return new Promise((resolve) => {
      const modal = new ConflictModal(app, info, resolve);
      modal.open();
    });
  }

  private constructor(
    app: App,
    private info: ConflictInfo,
    resolve: (choice: ConflictChoice) => void,
  ) {
    super(app);
    this.resolve = resolve;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Sync Conflict" });
    contentEl.createEl("p", {
      text: `"${this.info.path}" was modified on both devices. Choose which version to keep.`,
    });

    // Side-by-side diff
    const container = contentEl.createDiv({ cls: "nostr-sync-conflict-container" });
    container.style.display = "flex";
    container.style.gap = "16px";

    // Local (left)
    const localCol = container.createDiv({ cls: "nostr-sync-conflict-col" });
    localCol.style.flex = "1";
    localCol.createEl("h3", { text: "Local (v" + this.info.localVersion + ")" });
    const localText = localCol.createEl("textarea", {
      text: this.info.localContent,
      attr: { readonly: true },
    });
    localText.style.width = "100%";
    localText.style.height = "300px";
    localText.style.fontFamily = "monospace";
    localText.style.fontSize = "12px";

    // Remote (right)
    const remoteCol = container.createDiv({ cls: "nostr-sync-conflict-col" });
    remoteCol.style.flex = "1";
    remoteCol.createEl("h3", { text: "Remote (v" + this.info.remoteVersion + ")" });
    const remoteText = remoteCol.createEl("textarea", {
      text: this.info.remoteContent,
      attr: { readonly: true },
    });
    remoteText.style.width = "100%";
    remoteText.style.height = "300px";
    remoteText.style.fontFamily = "monospace";
    remoteText.style.fontSize = "12px";

    // Buttons
    const btnRow = contentEl.createDiv({ cls: "nostr-sync-conflict-buttons" });
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.marginTop = "16px";
    btnRow.style.justifyContent = "flex-end";

    const keepLocalBtn = btnRow.createEl("button", { text: "Keep Local" });
    keepLocalBtn.addEventListener("click", () => { this.resolve("keep-local"); this.close(); });

    const keepRemoteBtn = btnRow.createEl("button", { text: "Keep Remote" });
    keepRemoteBtn.addEventListener("click", () => { this.resolve("keep-remote"); this.close(); });

    const keepBothBtn = btnRow.createEl("button", { text: "Keep Both" });
    keepBothBtn.addEventListener("click", () => { this.resolve("keep-both"); this.close(); });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
