/**
 * VaultWatcher — wraps Obsidian's vault.on() events and debounces them.
 */
import type { Vault, TAbstractFile } from "obsidian";
import { SYNC_DEBOUNCE_MS } from "../constants";

export type FileChangeAction = "modify" | "create" | "delete" | "rename";

export interface FileChangeEvent {
  path: string;
  action: FileChangeAction;
  oldPath?: string;
}

export type ChangeHandler = (e: FileChangeEvent) => void;

export class VaultWatcher {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private vault: Vault;
  private handler: ChangeHandler;

  constructor(vault: Vault, handler: ChangeHandler) {
    this.vault   = vault;
    this.handler = handler;
  }

  start(): void {
    this.vault.on("modify", (file: TAbstractFile) => {
      this.debounce(file.path, "modify");
    });
    this.vault.on("create", (file: TAbstractFile) => {
      this.handler({ path: file.path, action: "create" });
    });
    this.vault.on("delete", (file: TAbstractFile) => {
      this.handler({ path: file.path, action: "delete" });
    });
    this.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      this.handler({ path: file.path, action: "rename", oldPath });
    });
  }

  stop(): void {
    // Obsidian's vault.on() returns EventRef, which we don't need to track
    // for stop — the plugin's onunload() handles cleanup via Obsidian internals.
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
