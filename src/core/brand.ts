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
 * A caveat for descriptive domains: when the stem IS the category ("sim racing cockpit"), the
 * spaced spelling is also the generic search, so the branded share reads high. The variants that
 * matched are returned so the UI can show what was counted.
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
  /** How many distinct queries matched. */
  queries: number;
  /** The spellings that matched (e.g. "sim racing cockpit"), most queries first, at most 8. */
  variants: string[];
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
  const hits = new Set<string>();
  const spellings = new Map<string, number>();
  for (const { q } of cands) {
    const run = brandRun(q, token);
    if (!run) continue;
    hits.add(q.toLowerCase());
    spellings.set(run, (spellings.get(run) ?? 0) + 1);
  }
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS brand_query (q TEXT PRIMARY KEY)`);
  const ins = db.prepare(`INSERT OR IGNORE INTO temp.brand_query (q) VALUES (?)`);
  db.transaction(() => { db.exec(`DELETE FROM temp.brand_query`); for (const q of hits) ins.run(q); })();
  const match: BrandMatch = {
    token,
    queries: hits.size,
    variants: [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([v]) => v),
  };
  loaded.set(db, { token, match });
  return match;
}

/** SQL predicate "this row's query is branded" (call `loadBrandQueries` first on the same handle). `col` defaults to `query`. */
export const brandPredicate = (col = 'query'): string => `LOWER(${col}) IN (SELECT q FROM temp.brand_query)`;
