/** Small, dependency-free concurrency and pacing primitives. */

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Chunk size must be a positive integer.");
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Token-bucket limiter used to pace provider API requests. It has no background
 * timer and holds no more than `burst` tokens, so it cannot grow unbounded.
 */
export class RateLimiter {
  private tokens: number;
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private lastRefill: number;

  constructor(ratePerSecond: number, burst = Math.max(1, Math.ceil(ratePerSecond))) {
    if (!(ratePerSecond > 0)) throw new Error("Rate must be positive.");
    this.ratePerSecond = ratePerSecond;
    this.burst = Math.max(1, burst);
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  private refill(now: number): void {
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = now;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
      await sleep(waitMs, signal);
    }
  }
}

/**
 * Run `fn` over items with a bounded number of concurrent workers. Results keep
 * input order. If the signal aborts, no new items are started; already started
 * work is awaited so callers can report accurate outcomes.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<R | undefined>> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export function abortError(): Error {
  const error = new Error("The operation was cancelled.");
  error.name = "AbortError";
  return error;
}
