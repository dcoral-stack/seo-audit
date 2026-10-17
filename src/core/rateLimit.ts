/**
 * Host rate limiting (#54): AIMD concurrency, Retry-After parsing and Shopify detection.
 *
 * Found on ehi.com.au (Shopify): at the default concurrency of 8 the host 429s `/collections/`
 * URLs. The old answer, retry each 429 in place up to 6 times while a pool-wide gate paused every
 * worker, cost 46-91 s per URL, dropped throughput from ~4 to ~1 page/s and then stored the 429 as
 * the page's status, so the audit reported real pages as errors. Instead the crawl now backs its
 * own concurrency off (multiplicative decrease), creeps it back up when the host is happy
 * (additive increase) and re-queues rate-limited URLs rather than stalling a worker on them.
 * Pure (no I/O) so the arithmetic is testable without a network.
 */

/** What a crawl reports about rate limiting, in its progress and its result. */
export interface RateLimitReport {
  /** 429 responses (and 503s carrying Retry-After) seen. */
  events: number;
  /** The effective concurrency right now. */
  currentConcurrency: number;
  /** The lowest effective concurrency the crawl dropped to. */
  minConcurrency: number;
  /** The ceiling additive increase climbs back to (maxConcurrency). */
  maxConcurrency: number;
  /** Distinct URLs re-queued at least once after being rate limited. */
  retried: number;
  /** URLs still rate limited after every retry: stored with fetch_state='rate_limited', status NULL. */
  unfetched: number;
}

/**
 * Additive-increase / multiplicative-decrease over the crawl's worker pool.
 * - A rate-limit halves the limit (floor 1) - but only once per "generation": a 429 on a request
 *   that was already in flight when the limit last dropped reflects the OLD concurrency, so eight
 *   simultaneous 429s from eight in-flight requests halve once (8 -> 4), not eight times (-> 1).
 * - `growAfter` consecutive clean responses add 1, up to `max`.
 */
export class AimdLimiter {
  readonly max: number;
  private _limit: number;
  private _min: number;
  private streak = 0;
  private lastDecreaseAt = -Infinity;
  /** 429s in a row with no clean response between them: drives the no-Retry-After fallback wait. */
  consecutive = 0;
  events = 0;

  constructor(max: number, start = max, private readonly growAfter = 20) {
    this.max = Math.max(1, Math.floor(max));
    this._limit = Math.max(1, Math.min(this.max, Math.floor(start)));
    this._min = this._limit;
  }

  get limit(): number { return this._limit; }
  get min(): number { return this._min; }

  /** Lower the current limit, e.g. when a Shopify host is detected on the first responses. */
  capAt(n: number): void {
    this._limit = Math.max(1, Math.min(this._limit, Math.floor(n)));
    this._min = Math.min(this._min, this._limit);
  }

  /** A rate-limited response to a request that started at `startedAt` (ms). Returns true if it lowered the limit. */
  onRateLimited(startedAt: number, now = Date.now()): boolean {
    this.events++;
    this.consecutive++;
    this.streak = 0;
    if (startedAt < this.lastDecreaseAt) return false; // already reacted to this generation of requests
    this.lastDecreaseAt = now;
    const next = Math.max(1, Math.floor(this._limit / 2));
    if (next === this._limit) return false;
    this._limit = next;
    this._min = Math.min(this._min, next);
    return true;
  }

  /** A response that was not rate limited. Returns true if it raised the limit. */
  onSuccess(): boolean {
    this.consecutive = 0;
    if (this._limit >= this.max) { this.streak = 0; return false; }
    if (++this.streak < this.growAfter) return false;
    this.streak = 0;
    this._limit++;
    return true;
  }
}

/** Never let a hostile or silly Retry-After stall the crawl longer than this. */
export const RETRY_AFTER_CAP_MS = 30_000;
/** Fallback when the host gives no Retry-After: 1 s, doubling per consecutive 429, capped. */
export const RATE_LIMIT_BACKOFF_CAP_MS = 15_000;

/**
 * Retry-After as milliseconds: delta-seconds ("120") or an HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT").
 * Null when absent or unparseable; a date in the past is 0. Uncapped: callers apply the cap.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  const v = (header ?? '').trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/** How long the pool should pause after a rate-limit: Retry-After (capped), else exponential. */
export function rateLimitWaitMs(retryAfter: string | null | undefined, consecutive: number, now = Date.now()): number {
  const ra = parseRetryAfter(retryAfter, now);
  if (ra != null) return Math.min(ra, RETRY_AFTER_CAP_MS);
  return Math.min(1000 * 2 ** Math.max(0, consecutive - 1), RATE_LIMIT_BACKOFF_CAP_MS);
}

/** 429 always; 503 only when it carries Retry-After (a plain 503 is a server error, retried as one). */
export const isRateLimited = (status: number, header: (name: string) => string | null): boolean =>
  status === 429 || (status === 503 && !!header('retry-after'));

/** The extra attempts a rate-limited URL gets (re-queued at the end of the frontier), and their spacing. */
export const RATE_LIMIT_RETRIES = 2;
export const retrySpacingMs = (attempt: number, waitMs: number): number => Math.max(waitMs, 5000 * attempt);

/** Shopify storefront response headers. Any one is enough; read from the first responses of a crawl. */
export function looksLikeShopify(header: (name: string) => string | null): boolean {
  if (header('x-shopid') || header('x-shopify-stage') || header('x-sorting-hat-shopid')) return true;
  return /shopify/i.test(header('powered-by') ?? '') || /shopify/i.test(header('x-powered-by') ?? '');
}
/** Where a Shopify crawl starts unless the user chose maxConcurrency (AIMD still climbs from here). */
export const SHOPIFY_START_CONCURRENCY = 3;
/** How many of a crawl's first responses are checked for Shopify headers. */
export const PLATFORM_SNIFF_RESPONSES = 5;

/** "rate limited by the host: concurrency reduced to 2; 37 URLs retried, 3 not fetched" - or null when nothing happened. */
export function rateLimitSummary(r: RateLimitReport | undefined | null): string | null {
  if (!r || r.events === 0) return null;
  const conc = r.currentConcurrency < r.maxConcurrency
    ? `concurrency reduced to ${r.currentConcurrency}${r.minConcurrency < r.currentConcurrency ? ` (low ${r.minConcurrency})` : ''}`
    : `concurrency back at ${r.currentConcurrency} after dropping to ${r.minConcurrency}`;
  const urls = (n: number): string => `${n.toLocaleString('en-GB')} URL${n === 1 ? '' : 's'}`;
  return `rate limited by the host: ${conc}; ${urls(r.retried)} retried, ${r.unfetched.toLocaleString('en-GB')} not fetched`;
}
