const DEFAULT_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

type Bucket = {
  timestamps: number[];
  head: number;
};

/**
 * Bounded per-key sliding-window rate limiter. Stores timestamps per key (up to `max` active entries per key) so callers
 * cannot burst `2 * max` across a fixed-window boundary, and caps active keys at `MAX_TRACKED_KEYS` by evicting expired or
 * oldest buckets.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxCount: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { max: number; windowMs?: number; now?: () => number }) {
    this.maxCount = options.max;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  admit(key: string): boolean {
    if (this.maxCount <= 0) return false;
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.pruneBucket(bucket, now);
      if (bucket.timestamps.length - bucket.head >= this.maxCount) {
        return false;
      }
      if (bucket.head >= 32 && bucket.head * 2 >= bucket.timestamps.length) {
        bucket.timestamps = bucket.timestamps.slice(bucket.head);
        bucket.head = 0;
      }
      bucket.timestamps.push(now);
      return true;
    }

    if (this.buckets.size >= MAX_TRACKED_KEYS) {
      for (const [candidate, entry] of this.buckets) {
        this.pruneBucket(entry, now);
        if (entry.head >= entry.timestamps.length) {
          this.buckets.delete(candidate);
        }
      }
      if (this.buckets.size >= MAX_TRACKED_KEYS) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }

    bucket = { timestamps: [now], head: 0 };
    this.buckets.set(key, bucket);
    return true;
  }

  private pruneBucket(bucket: Bucket, now: number): void {
    while (bucket.head < bucket.timestamps.length) {
      const ts = bucket.timestamps[bucket.head]!;
      if (now - ts >= this.windowMs || now < ts) {
        bucket.head += 1;
      } else {
        break;
      }
    }
  }
}
