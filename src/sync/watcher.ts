/**
 * VaultWatcher — wraps Obsidian's vault.on() events and debounces them.
 */
import type { Vault, TAbstractFile, EventRef } from "obsidian";
import { TFolder } from "obsidian";
import { SYNC_DEBOUNCE_MS } from "../constants";

export type FileChangeAction = "modify" | "create" | "delete" | "rename";

export interface FileChangeEvent {
  path: string;
  action: FileChangeAction;
  oldPath?: string;
  isFolder?: boolean;
}

export type ChangeHandler = (e: FileChangeEvent) => void;

export class VaultWatcher {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private refs: EventRef[] = [];
  private vault: Vault;
  private handler: ChangeHandler;

  constructor(vault: Vault, handler: ChangeHandler) {
    this.vault   = vault;
    this.handler = handler;
  }

  /** Attach Obsidian vault event listeners. */
  start(): void {
    this.refs.push(this.vault.on("modify", (file: TAbstractFile) => {
      this.debounce(file.path, "modify");
    }));
    this.refs.push(this.vault.on("create", (file: TAbstractFile) => {
      this.debounce(file.path, "modify");
    }));
    this.refs.push(this.vault.on("delete", (file: TAbstractFile) => {
      this.handler({
        path: file.path,
        action: "delete",
        isFolder: file instanceof TFolder,
      });
    }));
    this.refs.push(this.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      this.handler({ path: file.path, action: "rename", oldPath });
    }));
  }

  /** Clear pending debounce timers and detach vault event listeners. */
  stop(): void {
    // Obsidian auto-unregisters vault events on plugin unload;
    // we just clear our tracked refs.
    this.refs = [];
    const vals = Array.from(this.timers.values());
    for (const t of vals) clearTimeout(t);
    this.timers.clear();
  }

  private debounce(path: string, action: FileChangeAction): void {
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        this.handler({ path, action });
      }, SYNC_DEBOUNCE_MS),
    );
  }
}
