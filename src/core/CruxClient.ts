/**
 * Chrome UX Report (CrUX) API client (#55 item 4): field Core Web Vitals per origin or URL.
 *
 * Two endpoints, both POST with `?key=CRUX_API_KEY`:
 *   - records:queryRecord        -> ONE 28-day rolling window (`record.collectionPeriod`)
 *   - records:queryHistoryRecord -> up to 40 weekly 28-day windows (`record.collectionPeriods[]`),
 *                                   each metric's histogram densities and p75s aligned by index.
 * Shapes were checked against live responses (17 Oct 2026), not remembered:
 *   - CLS p75s and bin edges come back as STRINGS ("0.02"); everything else as numbers.
 *   - History densities hold the string "NaN", and p75s hold null, for weeks with no data. Those
 *     stay NULL here, never 0 (a 0 ms LCP or a 0% "poor" share would be a fabricated measurement).
 *   - A target without enough traffic answers 404 NOT_FOUND: that is "insufficient_data", an
 *     expected state, not an error.
 * Quota is 150 queries/min per Cloud project; the client spaces calls to stay under it.
 */

export type CruxFormFactor = 'PHONE' | 'DESKTOP' | 'TABLET';
export type CruxScope = 'origin' | 'url';

/** The metrics we keep (the issue's "relevant, not all"). Anything else in a response is ignored. */
export const CRUX_HISTOGRAM_METRICS = [
  'largest_contentful_paint',
  'interaction_to_next_paint',
  'cumulative_layout_shift',
  'first_contentful_paint',
  'experimental_time_to_first_byte',
  'round_trip_time',
] as const;
/** p75-only metrics: the LCP sub-parts (which part of LCP to fix). */
export const CRUX_P75_METRICS = [
  'largest_contentful_paint_image_time_to_first_byte',
  'largest_contentful_paint_image_resource_load_delay',
  'largest_contentful_paint_image_resource_load_duration',
  'largest_contentful_paint_image_element_render_delay',
] as const;
/** Fraction metrics. `form_factors` only appears when no formFactor was requested. */
export const CRUX_FRACTION_METRICS = ['navigation_types', 'largest_contentful_paint_resource_type', 'form_factors'] as const;

const HISTOGRAM = new Set<string>(CRUX_HISTOGRAM_METRICS);
const P75_ONLY = new Set<string>(CRUX_P75_METRICS);
const FRACTIONS = new Set<string>(CRUX_FRACTION_METRICS);

/** One metric in one 28-day window. Every numeric field is null when the API had no value. */
export interface CruxMetricRow {
  metric: string;
  periodFirst: string;
  periodLast: string;
  p75: number | null;
  good: number | null;
  ni: number | null;
  poor: number | null;
  goodMax: number | null;
  niMax: number | null;
}
export interface CruxFractionRow { metric: string; periodLast: string; bucket: string; fraction: number | null }
export interface CruxParsed { metrics: CruxMetricRow[]; fractions: CruxFractionRow[]; periods: { first: string; last: string }[] }

/** "0.02" -> 0.02, 1854 -> 1854, "NaN" / null / "" / garbage -> null. Never coerces a gap to 0. */
export function toReal(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t || /^nan$/i.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
function isoDate(d: { year?: number; month?: number; day?: number } | undefined): string | null {
  if (!d || !Number.isInteger(d.year) || !Number.isInteger(d.month) || !Number.isInteger(d.day)) return null;
  return `${d.year}-${pad(d.month!)}-${pad(d.day!)}`;
}

/** The edges between the three bins (good / needs improvement / poor), as returned. */
function bins(hist: any[]): { goodMax: number | null; niMax: number | null } {
  return { goodMax: toReal(hist?.[0]?.end), niMax: toReal(hist?.[1]?.end) };
}

/** Parse a queryRecord `record` (one window). */
export function parseRecord(record: any): CruxParsed {
  const first = isoDate(record?.collectionPeriod?.firstDate);
  const last = isoDate(record?.collectionPeriod?.lastDate);
  const out: CruxParsed = { metrics: [], fractions: [], periods: [] };
  if (!first || !last) return out;
  out.periods.push({ first, last });
  for (const [metric, m] of Object.entries<any>(record?.metrics ?? {})) {
    if (HISTOGRAM.has(metric)) {
      const h: any[] = Array.isArray(m?.histogram) ? m.histogram : [];
      out.metrics.push({
        metric, periodFirst: first, periodLast: last, p75: toReal(m?.percentiles?.p75),
        good: toReal(h[0]?.density), ni: toReal(h[1]?.density), poor: toReal(h[2]?.density), ...bins(h),
      });
    } else if (P75_ONLY.has(metric)) {
      out.metrics.push({ metric, periodFirst: first, periodLast: last, p75: toReal(m?.percentiles?.p75), good: null, ni: null, poor: null, goodMax: null, niMax: null });
    } else if (FRACTIONS.has(metric)) {
      for (const [bucket, f] of Object.entries<any>(m?.fractions ?? {})) out.fractions.push({ metric, periodLast: last, bucket, fraction: toReal(f) });
    }
    // anything else (experimental_ad_*, *_with_softnavs, metrics added later) is ignored
  }
  return out;
}

/** Parse a queryHistoryRecord `record` (one row per metric per window). Windows overlap: never sum them. */
export function parseHistory(record: any): CruxParsed {
  const periods = (Array.isArray(record?.collectionPeriods) ? record.collectionPeriods : [])
    .map((p: any) => ({ first: isoDate(p?.firstDate), last: isoDate(p?.lastDate) }));
  const out: CruxParsed = { metrics: [], fractions: [], periods: periods.filter((p: any) => p.first && p.last) };
  for (const [metric, m] of Object.entries<any>(record?.metrics ?? {})) {
    const histogram = HISTOGRAM.has(metric), p75Only = P75_ONLY.has(metric);
    if (histogram || p75Only) {
      const h: any[] = Array.isArray(m?.histogramTimeseries) ? m.histogramTimeseries : [];
      const p75s: unknown[] = Array.isArray(m?.percentilesTimeseries?.p75s) ? m.percentilesTimeseries.p75s : [];
      const edges = histogram ? bins(h) : { goodMax: null, niMax: null };
      periods.forEach((p: { first: string | null; last: string | null }, i: number) => {
        if (!p.first || !p.last) return;
        const row: CruxMetricRow = {
          metric, periodFirst: p.first, periodLast: p.last, p75: toReal(p75s[i]),
          good: histogram ? toReal(h[0]?.densities?.[i]) : null,
          ni: histogram ? toReal(h[1]?.densities?.[i]) : null,
          poor: histogram ? toReal(h[2]?.densities?.[i]) : null,
          ...edges,
        };
        // A window with no value at all for this metric (the metric did not exist yet) is no row,
        // rather than a row of NULLs: the trend line starts where the data starts.
        if (row.p75 == null && row.good == null && row.ni == null && row.poor == null) return;
        out.metrics.push(row);
      });
    } else if (FRACTIONS.has(metric)) {
      for (const [bucket, series] of Object.entries<any>(m?.fractionTimeseries ?? {})) {
        const fr: unknown[] = Array.isArray(series?.fractions) ? series.fractions : [];
        periods.forEach((p: { last: string | null }, i: number) => {
          const v = toReal(fr[i]);
          if (p.last && v != null) out.fractions.push({ metric, periodLast: p.last, bucket, fraction: v });
        });
      }
    }
  }
  return out;
}

export type CruxQuery = { origin: string } | { url: string };
export type CruxResult =
  | { status: 'ok'; parsed: CruxParsed; normalizedUrl?: string }
  | { status: 'insufficient_data' };

export interface CruxClientOptions {
  /** Minimum spacing between calls. Default 60000/140 ms: under the 150 queries/min quota with headroom. */
  minIntervalMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Retries after a 429 / 5xx (default 2). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CruxApiError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); }
}

export const CRUX_QUOTA_PER_MIN = 150;
export const CRUX_DEFAULT_INTERVAL_MS = Math.ceil(60_000 / 140);

/** Serialised, throttled CrUX client. One instance per job, so its spacing covers every call it makes. */
export class CruxClient {
  private readonly base: string;
  private readonly interval: number;
  private readonly doFetch: typeof fetch;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  /** Calls actually sent (for the job report). */
  calls = 0;

  constructor(private readonly key: string, opts: CruxClientOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://chromeuxreport.googleapis.com/v1').replace(/\/+$/, '');
    this.interval = opts.minIntervalMs ?? CRUX_DEFAULT_INTERVAL_MS;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  }

  queryRecord(q: CruxQuery, formFactor?: CruxFormFactor): Promise<CruxResult> {
    return this.enqueue(() => this.call('records:queryRecord', { ...q, ...(formFactor ? { formFactor } : {}) }, parseRecord));
  }

  queryHistoryRecord(q: CruxQuery, formFactor?: CruxFormFactor, collectionPeriodCount = 25): Promise<CruxResult> {
    return this.enqueue(() => this.call('records:queryHistoryRecord', { ...q, ...(formFactor ? { formFactor } : {}), collectionPeriodCount }, parseHistory));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async call(endpoint: string, body: Record<string, unknown>, parse: (record: any) => CruxParsed): Promise<CruxResult> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = Date.now() + this.interval;
      this.calls++;
      const res = await this.doFetch(`${this.base}/${endpoint}?key=${encodeURIComponent(this.key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      if (res.ok) {
        const record = json?.record;
        if (!record) throw new CruxApiError(`CrUX ${endpoint}: 200 without a record`, res.status);
        const normalizedUrl = json?.urlNormalizationDetails?.normalizedUrl;
        return { status: 'ok', parsed: parse(record), ...(typeof normalizedUrl === 'string' ? { normalizedUrl } : {}) };
      }
      if (res.status === 404 && (json?.error?.status === 'NOT_FOUND' || !json)) return { status: 'insufficient_data' };
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const ra = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : 5_000 * (attempt + 1));
        continue;
      }
      // Never echo the request URL: it carries the key.
      const msg = json?.error?.message ?? (text.slice(0, 200) || res.statusText);
      throw new CruxApiError(`CrUX ${endpoint} ${res.status}${json?.error?.status ? ` ${json.error.status}` : ''}: ${msg}`, res.status);
    }
  }
}
