/**
 * Brand query detection, shared by the dashboard's branded split and the audit's branded-query
 * exclusions (keyword-cannibalisation, anchor-text-incoherent).
 *
 * The brand is the property's domain stem (`brandToken`: "simracingcockpit.gg" -> "simracingcockpit").
 * People type a concatenated stem in its natural words, so matching the token as one whole word
 * missed "sim racing cockpit" and left simracingcockpit.gg reading 100% non-brand. The rule now:
 *
 *   A query is BRANDED when a run of its consecutive words, joined without spaces, equals the
 *   brand token. Words are split on anything that isn't a letter or digit, and in a run of two
 *   or more words each word has at least 2 characters.
 *
 * So "sim racing cockpit", "simracing cockpit", "simracingcockpit.gg" and "best sim-racing cockpit"
 * are branded; "sim racing cockpits" is not (the run would need to end inside a word), and
 * "vehicle" never matches the brand "ehi" (no run of whole words spells it). It is deterministic:
 * no dictionary and no guessing where the word boundaries go - the boundaries come from the
 * queries people actually typed, so only spellings that occur are ever matched.
 *
 * Exact-match domains (the stem is a generic phrase): "directdrivewheels.com" spells "direct drive
 * wheels", which is what people type when they want any direct-drive wheel. Counting it as brand
 * turned a category search into "branded" demand. So the SPACED spellings (a run of 2+ words) are
 * judged separately from the JOINED ones (the stem typed as one word, alone or with its TLD:
 * "directdrivewheels", "directdrivewheels.com"), which only ever mean the brand:
 *
 *   Joined spellings are always branded. Spaced spellings are branded too, UNLESS both
 *     (a) they draw more impressions than the joined spellings (the phrase behaves like a
 *         category search, not a name), and
 *     (b) the joined spellings earned no click in the held history (nobody navigates to the
 *         site by its name).
 *   Then the spaced spellings are counted as non-brand and reported as `uncertain`
 *   ("uncertain (exact-match domain)" in the UI), so the reader sees what was set aside.
 *
 * Deterministic, no dictionary: "generic" is read from the property's own queries. The trade-off:
 * simracingcockpit.gg keeps "sim racing cockpit" as brand (#64's intent) because people also type
 * "simracingcockpit" and click it, although "sim racing cockpit" is partly a category search too
 * (its branded share still reads high, as #64 noted). A site whose one-word brand earns a single
 * click flips its spaced spelling back to brand; a brand nobody types as one word reads as
 * non-brand until they do. The variants that matched are returned so the UI shows what was counted.
 *
 * SQL side: the branded queries are collected once per connection into `temp.brand_query`, and
 * readers test `LOWER(query) IN (SELECT q FROM temp.brand_query)` (see `brandPredicate`). No query
 * text is ever interpolated into SQL.
 */
import type Database from 'better-sqlite3';
import { brandToken } from './url-key.js';

/** The run of consecutive whole words in `query` that, joined, spells `token` (lower-cased, single-spaced), or null. */
export function brandRun(query: string, token: string): string | null {
  if (!token) return null;
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length; j++) {
      if (j > i && (words[i].length < 2 || words[j].length < 2)) break;
      joined += words[j];
      if (joined.length > token.length || !token.startsWith(joined)) break;
      if (joined === token) return words.slice(i, j + 1).join(' ');
    }
  }
  return null;
}

export interface BrandMatch {
  /** The brand token from the domain stem. */
  token: string;
  /** How many distinct queries are counted as branded. */
  queries: number;
  /** The spellings counted as brand (e.g. "sim racing cockpit"), most queries first, at most 8. */
  variants: string[];
  /** Spaced spellings set aside on an exact-match domain (see the rule above), or null. */
  uncertain: UncertainBrand | null;
}
export interface UncertainBrand {
  reason: 'exact-match-domain';
  /** The spaced spellings set aside, most queries first, at most 8. */
  spellings: string[];
  /** Distinct queries set aside, and their impressions and clicks over the held history. */
  queries: number;
  impressions: number;
  clicks: number;
  /** The joined spellings' impressions and clicks over the held history (the brand evidence). */
  joinedImpressions: number;
  joinedClicks: number;
}

/**
 * The exact-match-domain rule on per-spelling totals: are the spaced spellings uncertain?
 * Exported for the probe. `spaced`/`joined` are summed over the held history.
 */
export function spacedIsUncertain(spaced: { impressions: number }, joined: { impressions: number; clicks: number }): boolean {
  return spaced.impressions > joined.impressions && joined.clicks === 0;
}

// The handle's temp.brand_query holds ONE token's queries: remember which, per connection.
const loaded = new WeakMap<Database.Database, { token: string | null; match: BrandMatch | null }>();

/**
 * Collect the property's branded queries into `temp.brand_query` (once per connection and token)
 * and return what matched. Null when the domain gives no usable token (under 3 characters).
 */
export function loadBrandQueries(db: Database.Database, siteUrl: string): BrandMatch | null {
  const token = brandToken(siteUrl);
  const prev = loaded.get(db);
  if (prev && prev.token === token) return prev.match;
  if (!token) { loaded.set(db, { token, match: null }); return null; }
  // Candidates: distinct queries that contain the token once separators are stripped (cheap
  // prefilter over the distinct values), then the exact whole-word-run rule in JS.
  const strip = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(q),' ',''),'-',''),'.',''),'_',''),'''','')`;
  const cands = db.prepare(`SELECT q FROM (SELECT DISTINCT query q FROM search_analytics WHERE query IS NOT NULL) WHERE INSTR(${strip}, ?) > 0`)
    .all(token) as { q: string }[];
  // Totals per matched query over the held history (an index lookup per query on query).
  const sums = db.prepare(`SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i FROM search_analytics WHERE query = ?`);
  type Hit = { q: string; run: string; spaced: boolean; c: number; i: number };
  const matched: Hit[] = [];
  for (const { q } of cands) {
    const run = brandRun(q, token);
    if (!run) continue;
    const t = sums.get(q) as { c: number; i: number };
    matched.push({ q: q.toLowerCase(), run, spaced: run.includes(' '), c: t.c, i: t.i });
  }
  const tot = (xs: Hit[]): { impressions: number; clicks: number } => ({ impressions: xs.reduce((s, x) => s + x.i, 0), clicks: xs.reduce((s, x) => s + x.c, 0) });
  const spacedHits = matched.filter(m => m.spaced), joinedHits = matched.filter(m => !m.spaced);
  const joined = tot(joinedHits);
  const setAside = spacedHits.length > 0 && spacedIsUncertain(tot(spacedHits), joined);
  const counted = setAside ? joinedHits : matched;
  const bySpelling = (xs: Hit[]): string[] => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x.run, (m.get(x.run) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([v]) => v);
  };
  const hits = new Set(counted.map(m => m.q));
  const asideQueries = new Set(spacedHits.map(m => m.q));
  const uncertain: UncertainBrand | null = setAside
    ? { reason: 'exact-match-domain', spellings: bySpelling(spacedHits), queries: asideQueries.size, ...tot(spacedHits), joinedImpressions: joined.impressions, joinedClicks: joined.clicks }
    : null;
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS brand_query (q TEXT PRIMARY KEY)`);
  const ins = db.prepare(`INSERT OR IGNORE INTO temp.brand_query (q) VALUES (?)`);
  db.transaction(() => { db.exec(`DELETE FROM temp.brand_query`); for (const q of hits) ins.run(q); })();
  const match: BrandMatch = { token, queries: hits.size, variants: bySpelling(counted), uncertain };
  loaded.set(db, { token, match });
  return match;
}

/** SQL predicate "this row's query is branded" (call `loadBrandQueries` first on the same handle). `col` defaults to `query`. */
export const brandPredicate = (col = 'query'): string => `LOWER(${col}) IN (SELECT q FROM temp.brand_query)`;
