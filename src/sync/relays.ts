/**
 * RelayPool — wraps nostr-tools SimplePool.
 */
import { SimplePool, type Event, type Filter } from "nostr-tools";

export class RelayPool {
  private pool = new SimplePool();
  private urls: Set<string>;
  private subs = new Map<string, { close: () => void }>();
  connected = false;

  constructor(urls: string[]) {
    this.urls = new Set(urls);
  }

  setUrls(urls: string[]): void {
    this.disconnect();
    this.urls = new Set(urls);
  }

  async connect(): Promise<void> {
    this.connected = true;
    const arr = Array.from(this.urls);
    await Promise.all(
      arr.map((url) => this.pool.ensureRelay(url).catch(() => {})),
    );
  }

  async publish(event: Event): Promise<void> {
    const arr = Array.from(this.urls);
    const pubs = this.pool.publish(arr, event);
    await Promise.allSettled(pubs);
  }

  subscribe(
    filters: Filter[],
    onEvent: (event: Event) => void,
  ): string {
    const id = Math.random().toString(36).slice(2, 10);
    const arr = Array.from(this.urls);
    const sub = this.pool.subscribeMany(arr, filters as any, { onevent: onEvent });
    this.subs.set(id, sub);
    return id;
  }

  unsubscribe(id: string): void {
    this.subs.get(id)?.close();
    this.subs.delete(id);
  }

  disconnect(): void {
    for (const [, sub] of Array.from(this.subs)) sub.close();
    this.subs.clear();
    this.pool.close(Array.from(this.urls));
    this.connected = false;
  }
}
