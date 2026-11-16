const DEFAULT_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

/**
 * Bounded per-key window rate limiter. Expired buckets are pruned on access, and if more than `MAX_TRACKED_KEYS` active keys
 * accumulate (for instance, spoofed client addresses behind a misconfigured network), the oldest entry is evicted so memory
 * stays bounded.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();
  private readonly maxCount: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { max: number; windowMs?: number; now?: () => number }) {
    this.maxCount = options.max;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  admit(key: string): boolean {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (existing && now - existing.startedAt < this.windowMs && now >= existing.startedAt) {
      if (existing.count >= this.maxCount) return false;
      existing.count += 1;
      return true;
    }
    this.buckets.delete(key);
    if (this.buckets.size >= MAX_TRACKED_KEYS) {
      for (const [candidate, entry] of this.buckets) {
        if (now - entry.startedAt >= this.windowMs || now < entry.startedAt) this.buckets.delete(candidate);
      }
      if (this.buckets.size >= MAX_TRACKED_KEYS) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    this.buckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
}
