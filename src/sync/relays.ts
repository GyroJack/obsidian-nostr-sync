/**
 * RelayPool — wraps nostr-tools SimplePool.
 */
import { SimplePool, type Event, type Filter } from "nostr-tools";
import { isValidRelayUrl } from "../constants";

export class RelayPool {
  private pool = new SimplePool();
  private urls: Set<string>;
  private subs = new Map<string, { close: () => void }>();

  /** @param urls Initial relay WebSocket URLs. Invalid URLs are ignored. */
  constructor(urls: string[]) {
    this.urls = new Set(urls.filter(isValidRelayUrl));
  }

  /** Replace the active relay set and disconnect from previous relays. */
  setUrls(urls: string[]): void {
    this.disconnect();
    this.urls = new Set(urls.filter(isValidRelayUrl));
  }

  /** Open connections to all configured relays; failures are swallowed per relay. */
  async connect(): Promise<void> {
    const arr = Array.from(this.urls);
    await Promise.all(
      arr.map((url) => this.pool.ensureRelay(url).catch(() => {})),
    );
  }

  /** Publish an event to all configured relays. */
  async publish(event: Event): Promise<void> {
    const arr = Array.from(this.urls);
    const pubs = this.pool.publish(arr, event);
    await Promise.allSettled(pubs);
  }

  /**
   * Subscribe to events matching the given filter across all relays.
   * @returns An opaque subscription ID that can be passed to {@link unsubscribe}.
   */
  subscribe(
    filter: Filter,
    onEvent: (event: Event) => void,
  ): string {
    const id = Math.random().toString(36).slice(2, 10);
    const arr = Array.from(this.urls);
    const sub = this.pool.subscribeMany(arr, filter, { onevent: onEvent });
    this.subs.set(id, sub);
    return id;
  }

  /** Close a subscription created by {@link subscribe}. */
  unsubscribe(id: string): void {
    this.subs.get(id)?.close();
    this.subs.delete(id);
  }

  /** Close all subscriptions and relay connections. */
  disconnect(): void {
    for (const [, sub] of Array.from(this.subs)) sub.close();
    this.subs.clear();
    this.pool.close(Array.from(this.urls));
  }
}
