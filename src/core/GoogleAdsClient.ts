/**
 * SEOCoral fork: Google Ads API (Keyword Planner) as a free source of search volume and keyword
 * ideas - the same Google Ads data DataForSEO resells, read with the agency's own MCC.
 *
 *   - historicalMetrics: KeywordPlanIdeaService.GenerateKeywordHistoricalMetrics
 *     (avg monthly searches, 12-month series, competition, CPC / top-of-page bids)
 *   - keywordIdeas:      KeywordPlanIdeaService.GenerateKeywordIdeas (from seed keywords and/or a URL)
 *
 * Auth is an OAuth refresh token for a Google user with access to the MCC, plus the MCC's
 * developer token (Basic access or higher: Explorer access cannot call planning services).
 * Credentials come from a JSON file (GOOGLE_ADS_CREDENTIALS, written by
 * scripts/google-ads-auth.mjs) and/or env vars, env winning field by field.
 *
 * Accounts with recent spend get exact volumes; others get Google's rounded buckets. Google
 * groups close variants (plurals, accents) under one keyword: a requested keyword that comes
 * back as a close variant of another is reported with that keyword's metrics and `groupedUnder`.
 *
 * Responses are cached in SQLite (default 30 days, GOOGLE_ADS_CACHE_DAYS) and live calls are
 * serialised, like the DataForSEO client, so repeat questions cost no API operations.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_LANGUAGE, DEFAULT_LOCATION } from './locale.js';

export const DEFAULT_GOOGLE_ADS_API_VERSION = 'v26';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_HOST = 'https://googleads.googleapis.com';
const MAX_KEYWORDS_PER_CALL = 1000;

/** Google Ads language constants for the languages this fork is likely to meet. Any other: pass the numeric id. */
export const ADS_LANGUAGE_IDS: Record<string, number> = {
  en: 1000, de: 1001, fr: 1002, es: 1003, it: 1004, ja: 1005, nl: 1010, pt: 1014, ca: 1038,
};

export interface GoogleAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The MCC (manager) account id, digits only. Sent as login-customer-id. */
  loginCustomerId: string;
  /** The account the planner runs under; defaults to the MCC. A client account with spend gives exact volumes. */
  customerId: string;
  apiVersion: string;
}

export interface KeywordMetrics {
  keyword: string;
  searchVolume: number | null;
  /** Competition as Google reports it: LOW / MEDIUM / HIGH (null when unknown). */
  competitionLevel: string | null;
  /** Competition index 0-1 (Google's 0-100 / 100), comparable to DataForSEO's competition. */
  competition: number | null;
  /** Average CPC in the account currency, when Google returns it, else the top-of-page bid midpoint. */
  cpc: number | null;
  lowTopOfPageBid: number | null;
  highTopOfPageBid: number | null;
  monthly: Array<{ year: number; month: number; searches: number | null }>;
  /** Set when Google grouped this keyword under another close variant. */
  groupedUnder?: string;
}

export interface GoogleAdsResult<T> { items: T; cached: boolean }

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

const MONTHS: Record<string, number> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '');
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const micros = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.round(n / 10_000) / 100; };

/**
 * Credentials from GOOGLE_ADS_CREDENTIALS (JSON file) overlaid with GOOGLE_ADS_* env vars.
 * Returns null unless every required field is present, so the tier stays off rather than 401ing.
 */
export function googleAdsCredentials(env: NodeJS.ProcessEnv = process.env): GoogleAdsCredentials | null {
  let file: Record<string, unknown> = {};
  const p = (env.GOOGLE_ADS_CREDENTIALS ?? '').trim();
  if (p && existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, 'utf8')); } catch { console.error(`GOOGLE_ADS_CREDENTIALS: ${p} is not valid JSON; Google Ads tier disabled.`); return null; }
  }
  const pick = (envName: string, ...keys: string[]): string => {
    const e = (env[envName] ?? '').trim();
    if (e && !e.includes('${')) return e;
    for (const k of keys) { const v = file[k]; if (typeof v === 'string' && v.trim()) return v.trim(); if (typeof v === 'number') return String(v); }
    return '';
  };
  const c = {
    developerToken: pick('GOOGLE_ADS_DEVELOPER_TOKEN', 'developer_token', 'developerToken'),
    clientId: pick('GOOGLE_ADS_CLIENT_ID', 'client_id', 'clientId'),
    clientSecret: pick('GOOGLE_ADS_CLIENT_SECRET', 'client_secret', 'clientSecret'),
    refreshToken: pick('GOOGLE_ADS_REFRESH_TOKEN', 'refresh_token', 'refreshToken'),
    loginCustomerId: digits(pick('GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'login_customer_id', 'loginCustomerId')),
    customerId: digits(pick('GOOGLE_ADS_CUSTOMER_ID', 'customer_id', 'customerId')),
    apiVersion: pick('GOOGLE_ADS_API_VERSION', 'api_version', 'apiVersion') || DEFAULT_GOOGLE_ADS_API_VERSION,
  };
  if (!c.customerId) c.customerId = c.loginCustomerId;
  const missing = (['developerToken', 'clientId', 'clientSecret', 'refreshToken', 'customerId'] as const).filter(k => !c[k]);
  if (missing.length) {
    if (p || env.GOOGLE_ADS_DEVELOPER_TOKEN) console.error(`Google Ads tier disabled: missing ${missing.join(', ')}.`);
    return null;
  }
  return c;
}

/** Google Ads geo target constant for a location (numeric id; DataForSEO location codes are the same ids). */
export function geoTarget(location: string | number | undefined): string {
  const v = location ?? DEFAULT_LOCATION;
  const id = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
  if (!Number.isFinite(id)) throw new Error(`Google Ads needs a numeric location id (e.g. 2724 Spain, 2484 Mexico, 1005424 Madrid); got "${v}".`);
  return `geoTargetConstants/${id}`;
}

/** Google Ads language constant for an ISO code or numeric id. */
export function languageConstant(language: string | number | undefined): string {
  const v = language ?? DEFAULT_LANGUAGE;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return `languageConstants/${Number(v)}`;
  const id = ADS_LANGUAGE_IDS[String(v).toLowerCase().split('-')[0]];
  if (!id) throw new Error(`Unknown language "${v}" for Google Ads; pass its numeric language constant id.`);
  return `languageConstants/${id}`;
}

/** Map one API metrics object (historical or idea) to KeywordMetrics. Exported for the probe. */
export function parseMetrics(keyword: string, m: any): KeywordMetrics {
  const low = micros(m?.lowTopOfPageBidMicros), high = micros(m?.highTopOfPageBidMicros), avg = micros(m?.averageCpcMicros);
  const idx = num(m?.competitionIndex);
  const level = typeof m?.competition === 'string' && m.competition !== 'UNSPECIFIED' && m.competition !== 'UNKNOWN' ? m.competition : null;
  return {
    keyword,
    searchVolume: num(m?.avgMonthlySearches),
    competitionLevel: level,
    competition: idx === null ? null : idx / 100,
    cpc: avg ?? (low !== null && high !== null ? Math.round(((low + high) / 2) * 100) / 100 : high ?? low),
    lowTopOfPageBid: low,
    highTopOfPageBid: high,
    monthly: (Array.isArray(m?.monthlySearchVolumes) ? m.monthlySearchVolumes : []).map((x: any) => ({
      year: Number(x.year), month: MONTHS[String(x.month)] ?? Number(x.month), searches: num(x.monthlySearches),
    })),
  };
}

export class GoogleAdsClient {
  private readonly cache: Database.Database;
  private readonly ttlMs: number;
  private chain: Promise<unknown> = Promise.resolve();
  private token: { value: string; expires: number } | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly creds: GoogleAdsCredentials, cacheDbPath: string, ttlDays = 30, fetchImpl?: FetchLike) {
    this.ttlMs = ttlDays * 86_400_000;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    mkdirSync(dirname(cacheDbPath), { recursive: true });
    this.cache = new Database(cacheDbPath);
    this.cache.pragma('journal_mode = WAL');
    this.cache.exec(`CREATE TABLE IF NOT EXISTS google_ads_cache (
      cache_key TEXT PRIMARY KEY, method TEXT NOT NULL, request_json TEXT, response_json TEXT NOT NULL, fetched_at TEXT NOT NULL)`);
  }

  close(): void { this.cache.close(); }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn, fn);
    this.chain = r.then(() => undefined, () => undefined);
    return r;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - 60_000) return this.token.value;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.creds.clientId, client_secret: this.creds.clientSecret, refresh_token: this.creds.refreshToken }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      const hint = j.error === 'invalid_grant'
        ? ' The refresh token is no longer valid (revoked, or the OAuth app is in "Testing" mode, where tokens expire after 7 days). Run scripts/google-ads-auth.mjs again.'
        : '';
      throw new Error(`Google OAuth token refresh failed: ${res.status} ${j.error ?? ''} ${j.error_description ?? ''}`.trim() + hint);
    }
    this.token = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.token.value;
  }

  /** POST one KeywordPlanIdeaService method, through the cache. */
  private async call(method: 'generateKeywordHistoricalMetrics' | 'generateKeywordIdeas', body: Record<string, unknown>): Promise<{ json: any; cached: boolean }> {
    const key = createHash('sha256').update(method + '\n' + this.creds.customerId + '\n' + JSON.stringify(body)).digest('hex');
    const fresh = (): { response_json: string } | undefined => {
      const row = this.cache.prepare('SELECT response_json, fetched_at FROM google_ads_cache WHERE cache_key = ?').get(key) as { response_json: string; fetched_at: string } | undefined;
      return row && Date.now() - Date.parse(row.fetched_at + 'Z') < this.ttlMs ? row : undefined;
    };
    const hit = fresh();
    if (hit) return { json: JSON.parse(hit.response_json), cached: true };
    return this.serialize(async () => {
      const again = fresh();
      if (again) return { json: JSON.parse(again.response_json), cached: true };
      const headers: Record<string, string> = {
        authorization: `Bearer ${await this.accessToken()}`,
        'developer-token': this.creds.developerToken,
        'content-type': 'application/json',
      };
      if (this.creds.loginCustomerId) headers['login-customer-id'] = this.creds.loginCustomerId;
      const url = `${API_HOST}/${this.creds.apiVersion}/customers/${this.creds.customerId}:${method}`;
      const res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      let json: any = {};
      try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
      if (!res.ok) throw new Error(`Google Ads ${method} failed: ${res.status} ${explainAdsError(json, text)}`);
      this.cache.prepare(`INSERT INTO google_ads_cache (cache_key, method, request_json, response_json, fetched_at)
        VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json, fetched_at=datetime('now')`)
        .run(key, method, JSON.stringify(body), JSON.stringify(json));
      return { json, cached: false };
    });
  }

  /** Search volume and competition for up to thousands of keywords (batched 1,000 per call). */
  async historicalMetrics(keywords: string[], location?: string | number, language?: string | number): Promise<GoogleAdsResult<KeywordMetrics[]>> {
    const wanted = [...new Set(keywords.map(k => k.trim()).filter(Boolean))];
    const geo = geoTarget(location), lang = languageConstant(language);
    const byText = new Map<string, KeywordMetrics>();
    const variantOf = new Map<string, string>();
    let cachedAll = true;
    for (let i = 0; i < wanted.length; i += MAX_KEYWORDS_PER_CALL) {
      const batch = wanted.slice(i, i + MAX_KEYWORDS_PER_CALL);
      const { json, cached } = await this.call('generateKeywordHistoricalMetrics', {
        keywords: batch, language: lang, geoTargetConstants: [geo], keywordPlanNetwork: 'GOOGLE_SEARCH',
        historicalMetricsOptions: { includeAverageCpc: true },
      });
      cachedAll &&= cached;
      for (const r of json.results ?? []) {
        const text = String(r.text ?? '');
        byText.set(text.toLowerCase(), parseMetrics(text, r.keywordMetrics));
        for (const v of r.closeVariants ?? []) variantOf.set(String(v).toLowerCase(), text);
      }
    }
    const items = wanted.map((k): KeywordMetrics => {
      const own = byText.get(k.toLowerCase());
      if (own) return { ...own, keyword: k };
      const head = variantOf.get(k.toLowerCase());
      const grouped = head ? byText.get(head.toLowerCase()) : undefined;
      if (grouped) return { ...grouped, keyword: k, groupedUnder: head };
      return { keyword: k, searchVolume: null, competitionLevel: null, competition: null, cpc: null, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: [] };
    });
    return { items, cached: cachedAll };
  }

  /** Keyword ideas from seed keywords and/or a URL (or a whole site), sorted by search volume. */
  async keywordIdeas(opts: { keywords?: string[]; url?: string; site?: string; location?: string | number; language?: string | number; limit?: number }): Promise<GoogleAdsResult<KeywordMetrics[]>> {
    const kws = (opts.keywords ?? []).map(k => k.trim()).filter(Boolean).slice(0, 20);
    const seed: Record<string, unknown> =
      opts.site ? { siteSeed: { site: opts.site } }
      : kws.length && opts.url ? { keywordAndUrlSeed: { keywords: kws, url: opts.url } }
      : opts.url ? { urlSeed: { url: opts.url } }
      : kws.length ? { keywordSeed: { keywords: kws } }
      : (() => { throw new Error('keyword ideas need seed keywords, a url, or a site'); })();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const { json, cached } = await this.call('generateKeywordIdeas', {
      ...seed, language: languageConstant(opts.language), geoTargetConstants: [geoTarget(opts.location)],
      keywordPlanNetwork: 'GOOGLE_SEARCH', includeAdultKeywords: false, pageSize: limit,
    });
    const items = (json.results ?? []).map((r: any) => parseMetrics(String(r.text ?? ''), r.keywordIdeaMetrics))
      .sort((a: KeywordMetrics, b: KeywordMetrics) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1))
      .slice(0, limit);
    return { items, cached };
  }
}

/** A readable reason from a Google Ads API error body, with hints for the setup mistakes people make. */
export function explainAdsError(json: any, text: string): string {
  const details = json?.error?.details?.flatMap((d: any) => d?.errors ?? []) ?? [];
  const codes = details.map((e: any) => Object.entries(e?.errorCode ?? {}).map(([k, v]) => `${k}.${v}`).join(',')).filter(Boolean);
  const msgs = details.map((e: any) => e?.message).filter(Boolean);
  const all = [...codes, ...msgs].join(' | ') || json?.error?.message || text.slice(0, 300);
  const hints: string[] = [];
  if (/DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED/.test(all)) hints.push('the developer token only has Test access: apply for Basic access in the MCC (Tools > API Center).');
  if (/NOT_ALLOWED_FOR_EXPLORER|EXPLORER/i.test(all)) hints.push('Explorer access cannot use Keyword Planner: apply for Basic access.');
  if (/USER_PERMISSION_DENIED/.test(all)) hints.push('the Google user who authorised has no access to this account, or login-customer-id is not its MCC.');
  if (/CUSTOMER_NOT_ENABLED|CUSTOMER_NOT_FOUND/.test(all)) hints.push('check GOOGLE_ADS_CUSTOMER_ID (10 digits, no dashes) and that the account is active.');
  if (/SERVICE_DISABLED|has not been used in project|is disabled/.test(all)) hints.push('enable the Google Ads API in the Google Cloud project of the OAuth client.');
  return all + (hints.length ? ` - ${hints.join(' ')}` : '');
}
