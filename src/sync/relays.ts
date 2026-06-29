/**
 * RelayPool — wraps nostr-tools SimplePool with per-relay health tracking and failover.
 */
import { SimplePool, type Event, type Filter } from "nostr-tools";
import { isValidRelayUrl, HEALTH_CHECK_INTERVAL_MS } from "../constants";
import type { RelayHealth } from "../types";

export class RelayPool {
  private pool = new SimplePool();
  private urls: Set<string>;
  private health = new Map<string, RelayHealth>();
  private subs = new Map<string, { close: () => void }>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** Optional callback invoked whenever health data changes. */
  onHealthChange: ((health: RelayHealth[]) => void) | null = null;

  /** @param urls Initial relay WebSocket URLs. Invalid URLs are ignored. */
  constructor(urls: string[]) {
    this.urls = new Set(urls.filter(isValidRelayUrl));
    for (const url of this.urls) {
      this.initHealth(url);
    }
  }

  /** Replace the active relay set and disconnect from previous relays. */
  setUrls(urls: string[]): void {
    this.disconnect();
    this.urls = new Set(urls.filter(isValidRelayUrl));
    this.health.clear();
    for (const url of this.urls) {
      this.initHealth(url);
    }
  }

  /** Open connections to all configured relays, measuring connection latency. */
  async connect(): Promise<void> {
    const arr = Array.from(this.urls);
    await Promise.all(
      arr.map(async (url) => {
        const start = Date.now();
        try {
          await this.pool.ensureRelay(url);
          this.updateHealth(url, true, Date.now() - start);
        } catch {
          console.debug("nostr-sync: relay connect failed", url);
          this.updateHealth(url, false);
        }
      }),
    );
    this.emitHealth();

    // Start periodic health checks if not already running
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => void this.checkAllHealth(), HEALTH_CHECK_INTERVAL_MS);
    }
  }

  /**
   * Publish an event with failover: try relays one at a time in health order.
   * On first success, stop and update that relay's stats.
   * If ALL fail, throw the last error.
   */
  async publish(event: Event): Promise<void> {
    const sorted = this.getSortedRelays();
    if (sorted.length === 0) throw new Error("No relays configured");

    let lastError: Error | null = null;
    for (const h of sorted) {
      try {
        const start = Date.now();
        await this.pool.publish([h.url], event);
        this.updateHealth(h.url, true, Date.now() - start);
        this.emitHealth();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // "replaced: have newer event" means the relay accepted a newer version.
        // This is not a failure — treat it as success for our purposes (Fix 3).
        if (msg.includes("replaced")) {
          this.updateHealth(h.url, true);
          this.emitHealth();
          return;
        }
        lastError = e instanceof Error ? e : new Error(String(e));
        console.debug("nostr-sync: relay publish failed, trying next", h.url, lastError.message);
        this.updateHealth(h.url, false, undefined, lastError.message);
        // Continue to next relay
      }
    }

    this.emitHealth();
    throw lastError ?? new Error("Publish failed on all relays");
  }

  /**
   * Subscribe to events matching the given filter across all relays.
   * Tracks which relays deliver events (updates lastChecked).
   * @returns An opaque subscription ID that can be passed to {@link unsubscribe}.
   */
  subscribe(
    filter: Filter,
    onEvent: (event: Event) => void,
  ): string {
    const id = Math.random().toString(36).slice(2, 10);
    const arr = Array.from(this.urls);
    const sub = this.pool.subscribeMany(arr, filter, {
      onevent: (event: Event) => {
        // Don't mark all relays as connected — a single event delivery
        // doesn't prove all relays are healthy. Let periodic checks handle it.
        onEvent(event);
      },
    });
    this.subs.set(id, sub);
    return id;
  }

  /** Close a subscription created by {@link subscribe}. */
  unsubscribe(id: string): void {
    this.subs.get(id)?.close();
    this.subs.delete(id);
  }

  /** Close all subscriptions and relay connections, stop health checks. */
  disconnect(): void {
    for (const [, sub] of Array.from(this.subs)) sub.close();
    this.subs.clear();
    this.pool.close(Array.from(this.urls));
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** Return all relay health stats sorted by healthScore (best first). */
  getHealth(): RelayHealth[] {
    return this.getSortedRelays();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private initHealth(url: string): void {
    this.health.set(url, {
      url,
      connected: false,
      latency: -1,
      consecutiveErrors: 0,
      lastError: null,
      lastChecked: 0,
      healthScore: 999999,
    });
  }

  /** Unified health update: called from connect(), publish(), and checkAllHealth(). */
  private updateHealth(url: string, success: boolean, latency?: number, error?: string): void {
    const h = this.health.get(url);
    if (!h) return;
    h.connected = success;
    h.lastChecked = Date.now();
    if (success) {
      h.latency = latency ?? -1;
      h.consecutiveErrors = 0;
      h.lastError = null;
    } else {
      h.consecutiveErrors++;
      if (error) h.lastError = error;
    }
    h.healthScore = this.computeHealthScore(h);
  }

  /**
   * healthScore formula: lower is better.
   * (latency === -1 ? 5000 : latency) + (consecutiveErrors * 2000)
   */
  private computeHealthScore(h: RelayHealth): number {
    const latencyMs = h.latency === -1 ? 5000 : h.latency;
    return latencyMs + h.consecutiveErrors * 2000;
  }

  private getSortedRelays(): RelayHealth[] {
    const result: RelayHealth[] = [];
    for (const url of this.urls) {
      const h = this.health.get(url);
      if (h) result.push(h);
    }
    result.sort((a, b) => a.healthScore - b.healthScore);
    return result;
  }

  private emitHealth(): void {
    if (this.onHealthChange) {
      this.onHealthChange(this.getHealth());
    }
  }

  /** Periodically re-measure relay latency (concurrent) and update health scores. */
  private async checkAllHealth(): Promise<void> {
    await Promise.all(
      Array.from(this.urls).map(async (url) => {
        const start = Date.now();
        try {
          await this.pool.ensureRelay(url);
          this.updateHealth(url, true, Date.now() - start);
        } catch {
          console.debug("nostr-sync: health check failed for", url);
          this.updateHealth(url, false);
        }
      }),
    );
    this.emitHealth();
  }
}
