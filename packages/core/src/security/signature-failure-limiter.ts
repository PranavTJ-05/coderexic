/**
 * Per-key fixed-window counter for requests that fail webhook signature
 * verification (ROADMAP.md Phase 16). These are, by definition, not
 * legitimate GitHub traffic (GitHub signs every real delivery), so they can
 * be throttled aggressively and independently of the generous cap applied
 * to signature-verified traffic - rate-limiting legitimate webhook bursts
 * too aggressively would silently drop real PR reviews, since GitHub does
 * not automatically redeliver a failed delivery (confirmed against
 * GitHub's webhook docs - see docs/security-audit.md).
 *
 * In-memory and per-process by design: this only needs to survive a single
 * abusive burst, not coordinate across replicas, and avoids adding a Redis
 * round-trip to the pre-signature-check hot path it protects.
 */
export interface SignatureFailureLimiter {
  /** Records a failure for `key` and returns whether it is now blocked. */
  recordFailure(key: string): boolean;
  /** True if `key` is currently blocked, without recording a new failure. */
  isBlocked(key: string): boolean;
}

export interface SignatureFailureLimiterOptions {
  /** Failures allowed within one window before the key is blocked. */
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

export function createSignatureFailureLimiter(
  options: SignatureFailureLimiterOptions = {},
): SignatureFailureLimiter {
  const maxFailures = options.maxFailures ?? 20;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; windowStart: number }>();

  function currentWindow(key: string): { count: number; windowStart: number } {
    const nowMs = now();
    const existing = windows.get(key);
    if (existing && nowMs - existing.windowStart < windowMs) return existing;
    const fresh = { count: 0, windowStart: nowMs };
    windows.set(key, fresh);
    return fresh;
  }

  return {
    recordFailure(key) {
      const window = currentWindow(key);
      window.count += 1;
      return window.count > maxFailures;
    },
    isBlocked(key) {
      const window = currentWindow(key);
      return window.count > maxFailures;
    },
  };
}
