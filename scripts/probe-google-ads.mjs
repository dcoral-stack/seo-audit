#!/usr/bin/env node
// SEOCoral fork: Google Ads Keyword Planner client (src/core/GoogleAdsClient.ts) against a mocked API.
// Checks credentials loading, the request shape (URL, headers, body), response parsing (string
// int64s, micros, months, close variants), batching, caching, error hints and provider choice.
// Run:  npm run build:server && node scripts/probe-google-ads.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { GoogleAdsClient, googleAdsCredentials, geoTarget, languageConstant, parseMetrics, explainAdsError } from '../dist/core/GoogleAdsClient.js';
import { pickVolumeProvider, keywordVolumes, compactMonthly } from '../dist/core/volume.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dir = path.join(tmpdir(), `sac-gads-${Date.now()}`);
mkdirSync(dir, { recursive: true });

// ── 1. Credentials ──────────────────────────────────────────────────────────────────────────────
const file = path.join(dir, 'google-ads.json');
writeFileSync(file, JSON.stringify({ developer_token: 'DEVTOK', client_id: 'cid', client_secret: 'csec', refresh_token: 'rtok', login_customer_id: '123-456-7890' }));
const c = googleAdsCredentials({ GOOGLE_ADS_CREDENTIALS: file });
ok(c && c.loginCustomerId === '1234567890' && c.customerId === '1234567890', 'file credentials: dashes stripped, customer defaults to the MCC');
ok(c.apiVersion === 'v26', `default API version ${c.apiVersion}`);
const c2 = googleAdsCredentials({ GOOGLE_ADS_CREDENTIALS: file, GOOGLE_ADS_CUSTOMER_ID: '111-222-3333', GOOGLE_ADS_API_VERSION: 'v27' });
ok(c2.customerId === '1112223333' && c2.apiVersion === 'v27', 'env overrides the file field by field');
ok(googleAdsCredentials({ GOOGLE_ADS_DEVELOPER_TOKEN: 'x' }) === null, 'incomplete credentials leave the tier off');
ok(googleAdsCredentials({}) === null, 'nothing set: off');

// ── 2. Geo / language mapping ─────────────────────────────────────────────────────────────────
ok(geoTarget(undefined) === 'geoTargetConstants/2724' && geoTarget('2484') === 'geoTargetConstants/2484', 'geo: default Spain, numeric strings accepted');
let threw = false; try { geoTarget('Spain'); } catch { threw = true; }
ok(threw, 'geo: a location name is refused with a clear message');
ok(languageConstant(undefined) === 'languageConstants/1003' && languageConstant('ca') === 'languageConstants/1038' && languageConstant('es-ES') === 'languageConstants/1003', 'language: es default, ca, es-ES');

// ── 3. Parsing ──────────────────────────────────────────────────────────────────────────────────
const m = parseMetrics('agencia seo', {
  avgMonthlySearches: '2900', competition: 'HIGH', competitionIndex: '87',
  lowTopOfPageBidMicros: '1500000', highTopOfPageBidMicros: '6230000',
  monthlySearchVolumes: [{ year: '2026', month: 'SEPTEMBER', monthlySearches: '2400' }],
});
ok(m.searchVolume === 2900 && m.competition === 0.87 && m.competitionLevel === 'HIGH', 'int64 strings and competition index parsed');
ok(m.lowTopOfPageBid === 1.5 && m.highTopOfPageBid === 6.23 && m.cpc === 3.87, `micros to currency; cpc falls back to the bid midpoint (${m.cpc})`);
ok(m.monthly[0].month === 9 && m.monthly[0].year === 2026 && m.monthly[0].searches === 2400, 'month enum to number');
ok(parseMetrics('x', { averageCpcMicros: '2100000', lowTopOfPageBidMicros: '1000000', highTopOfPageBidMicros: '5000000' }).cpc === 2.1, 'average CPC preferred when present');

// ── 4. Requests against a mocked API ────────────────────────────────────────────────────────────
const calls = [];
let tokenCalls = 0;
const fetchImpl = async (url, init) => {
  calls.push({ url, init });
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    tokenCalls++;
    const body = new URLSearchParams(init.body);
    const good = body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'rtok';
    return { ok: good, status: good ? 200 : 400, json: async () => (good ? { access_token: 'AT', expires_in: 3600 } : { error: 'invalid_grant' }), text: async () => '' };
  }
  const body = JSON.parse(init.body);
  if (url.endsWith(':generateKeywordHistoricalMetrics')) {
    const results = body.keywords.filter(k => k !== 'agencias seo').map(k => ({
      text: k,
      ...(k === 'agencia seo' ? { closeVariants: ['agencias seo'] } : {}),
      keywordMetrics: { avgMonthlySearches: String(k.length * 10), competition: 'MEDIUM', competitionIndex: '50' },
    }));
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => JSON.stringify({ results }) };
  }
  if (url.endsWith(':generateKeywordIdeas')) {
    const results = [
      { text: 'seo local', keywordIdeaMetrics: { avgMonthlySearches: '880' } },
      { text: 'seo madrid', keywordIdeaMetrics: { avgMonthlySearches: '1600' } },
      { text: 'seo raro', keywordIdeaMetrics: {} },
    ];
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => JSON.stringify({ results }) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
};
const ads = new GoogleAdsClient(c, path.join(dir, 'cache.db'), 30, fetchImpl);
const r1 = await ads.historicalMetrics(['agencia seo', 'agencias seo', 'auditoría web'], 2724, 'es');
const call = calls.find(x => x.url.includes(':generateKeywordHistoricalMetrics'));
ok(call.url === 'https://googleads.googleapis.com/v26/customers/1234567890:generateKeywordHistoricalMetrics', `endpoint ${call.url}`);
ok(call.init.headers.authorization === 'Bearer AT' && call.init.headers['developer-token'] === 'DEVTOK' && call.init.headers['login-customer-id'] === '1234567890', 'auth, developer-token and login-customer-id headers');
const b = JSON.parse(call.init.body);
ok(b.language === 'languageConstants/1003' && b.geoTargetConstants[0] === 'geoTargetConstants/2724' && b.keywordPlanNetwork === 'GOOGLE_SEARCH' && b.historicalMetricsOptions.includeAverageCpc === true, 'request body shape');
ok(r1.items.length === 3 && r1.items[0].searchVolume === 110 && !r1.cached, 'results in request order, live');
ok(r1.items[1].keyword === 'agencias seo' && r1.items[1].groupedUnder === 'agencia seo' && r1.items[1].searchVolume === 110, 'close variant reported with its group head');
ok(r1.items[2].keyword === 'auditoría web' && r1.items[2].searchVolume === 130, 'accented keyword kept as typed');

const before = calls.length;
const r2 = await ads.historicalMetrics(['agencia seo', 'agencias seo', 'auditoría web'], 2724, 'es');
ok(r2.cached && calls.length === before, 'second identical request served from cache (no API call)');
ok(tokenCalls === 1, `access token reused (${tokenCalls} token call)`);

const many = Array.from({ length: 2300 }, (_, i) => `kw ${i}`);
const n0 = calls.length;
const r3 = await ads.historicalMetrics(many, 2724, 'es');
ok(calls.length - n0 === 3 && r3.items.length === 2300, `2,300 keywords sent in 3 batches (${calls.length - n0})`);

const ideas = await ads.keywordIdeas({ keywords: ['seo'], url: 'https://seocoral.com/', limit: 2 });
const ic = JSON.parse(calls.at(-1).init.body);
ok(ic.keywordAndUrlSeed?.url === 'https://seocoral.com/' && ic.keywordAndUrlSeed.keywords[0] === 'seo' && ic.pageSize === 2, 'ideas: keyword+url seed');
ok(ideas.items.length === 2 && ideas.items[0].keyword === 'seo madrid', 'ideas sorted by volume and capped');
await ads.keywordIdeas({ site: 'seocoral.com' });
ok(JSON.parse(calls.at(-1).init.body).siteSeed?.site === 'seocoral.com', 'ideas: site seed');

// ── 5. Errors ───────────────────────────────────────────────────────────────────────────────────
const errBody = { error: { code: 403, message: 'The caller does not have permission', details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'The developer token is only approved for use with test accounts.' }] }] } };
ok(/Test access/.test(explainAdsError(errBody, '')), 'test-only developer token explained');
const explorerBody = { error: { details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'This method is not allowed for use with explorer access. Please apply for basic or standard access.' }] }] } };
const ex = explainAdsError(explorerBody, '');
ok(/Explorer access cannot use Keyword Planner/.test(ex) && !/Test access/.test(ex), 'explorer token: one hint, the right one');
const bad = new GoogleAdsClient({ ...c, refreshToken: 'expired' }, path.join(dir, 'cache2.db'), 30, fetchImpl);
let msg = ''; try { await bad.historicalMetrics(['x']); } catch (e) { msg = e.message; }
ok(/invalid_grant/.test(msg) && /google-ads-auth/.test(msg), 'expired refresh token tells you to re-run the auth script');
bad.close();

// ── 6. Provider choice ──────────────────────────────────────────────────────────────────────────
const fakeDfs = { searchVolume: async () => ({ tasks: [{ result: [{ keyword: 'a', search_volume: 5, cpc: 1, competition: 0.1 }] }], cached: false, cost: 0.05 }) };
ok(pickVolumeProvider(ads, fakeDfs, {}) === 'google-ads', 'Google Ads preferred when both are set');
ok(pickVolumeProvider(ads, fakeDfs, { SAC_VOLUME_PROVIDER: 'dataforseo' }) === 'dataforseo', 'SAC_VOLUME_PROVIDER forces DataForSEO');
ok(pickVolumeProvider(null, fakeDfs, {}) === 'dataforseo' && pickVolumeProvider(null, null, {}) === null, 'fallback and none');
const v = await keywordVolumes(null, fakeDfs, ['a']);
ok(v.provider === 'dataforseo' && v.keywords[0].searchVolume === 5 && v.cost === 0.05, 'DataForSEO path keeps the old shape');
let none = ''; try { await keywordVolumes(null, null, ['a']); } catch (e) { none = e.message; }
ok(/GOOGLE_ADS_CREDENTIALS/.test(none), 'no provider: the error names the free option');

const series = [8,9,10,11,12,1,2,3,4,5,6,7].map((mo, i) => ({ year: mo >= 8 ? 2025 : 2026, month: mo, searches: i < 9 ? 100 : 300 }));
const lean = compactMonthly({ keyword: 'x', monthly: series });
ok(!('monthly' in lean) && lean.trend === 'rising' && lean.peakMonth === '2026-05', `compact row: no series, trend ${lean.trend}, peak ${lean.peakMonth}`);
ok(Array.isArray(compactMonthly({ keyword: 'x', monthly: series }, true).monthly), 'includeMonthly keeps the series');

ads.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
