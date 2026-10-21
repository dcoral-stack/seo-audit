/**
 * SEOCoral fork: Keyword Planner demand stored per property and joined to the site's own data.
 *
 * keyword_volume / keyword_ideas called with a siteUrl save their rows here (table
 * keyword_planner, one row per keyword, latest fetch wins). keywordDemandPayload then joins each
 * keyword to Search Console and the crawl:
 *   - GSC: every query whose language-aware token signature (accent-folded, stop words out,
 *     plurals stemmed - core/text.ts) equals the keyword's, so "gestorías en Madrid" and
 *     "gestoria madrid" are the same demand. Last 90 days up to the latest GSC date.
 *   - The page Google shows most for it (clicks, then impressions) and its weighted position.
 *   - With no GSC match, the indexable page whose title/H1/slug tokens overlap most (a suggested
 *     target, never presented as a ranking).
 * Status: top3 / page1 / striking (11-20) / weak (>20) / gap (no GSC impressions).
 *
 * Two origins share the table: Google Ads (keyword_ideas / keyword_volume) and Search Console
 * (importGscKeywords: the queries the site already shows for, with Keyword Planner metrics added).
 * A row carries both flags when both apply; a Search Console query whose words match a row that is
 * already there just flags that row instead of adding a near-duplicate.
 */
import type Database from 'better-sqlite3';
import { tokens } from './text.js';

/**
 * Sector synonyms for page SUGGESTIONS only (stems from core/text.ts): a Spanish gestoría writes
 * "pymes y sociedades" where people search "empresas". GSC matching never uses these.
 */
const SUGGEST_SYNONYMS: Record<string, string> = {
  pym: 'empresa', sociedad: 'empresa', negocio: 'empresa',
  gestor: 'gestoria', asesor: 'asesoria', asesoramiento: 'asesoria',
  freelance: 'autonomo', emprendedor: 'autonomo',
  contabilidad: 'contable', impuesto: 'fiscal', tributario: 'fiscal',
  nomina: 'laboral',
};
const canon = (t: string): string => SUGGEST_SYNONYMS[t] ?? t;
const suggestTokens = (s: string): string[] => [...new Set(tokens(s).map(canon))];
import { gscTotalsSource } from './gscRows.js';
import type { KeywordMetrics } from './GoogleAdsClient.js';

export type DemandStatus = 'top3' | 'page1' | 'striking' | 'weak' | 'gap';

export interface DemandRow {
  keyword: string;
  searchVolume: number | null;
  competition: number | null;
  competitionLevel: string | null;
  cpc: number | null;
  trend: string | null;
  peakMonth: string | null;
  groupedUnder: string | null;
  source: string;
  /** Came from Google Ads Keyword Planner (ideas / volume). */
  fromAds: boolean;
  /** Imported from Search Console, or the site has GSC impressions for it. */
  fromGsc: boolean;
  /** Page Google shows for it (GSC), or null. */
  page: string | null;
  position: number | null;
  impressions: number;
  clicks: number;
  /** Best on-site page by title/H1/slug overlap when GSC has nothing. */
  suggestedPage: string | null;
  status: DemandStatus;
}

export interface DemandPayload {
  updatedAt: string | null;
  totals: { keywords: number; volume: number; byStatus: Record<DemandStatus, number>; capturedVolume: number; byOrigin: { gsc: number; ads: number; both: number } };
  rows: DemandRow[];
}

export function ensureKeywordTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS keyword_planner (
    keyword TEXT PRIMARY KEY,
    search_volume INTEGER,
    competition REAL,
    competition_level TEXT,
    cpc REAL,
    low_bid REAL,
    high_bid REAL,
    trend TEXT,
    peak_month TEXT,
    monthly_json TEXT,
    grouped_under TEXT,
    source TEXT,              -- volume | ideas
    seed TEXT,                -- the seed keywords / url / site of an ideas call
    location TEXT,
    language TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  )`);
  // Origin flags (added after the first release): migrate older tables in place.
  const cols = new Set((db.prepare(`PRAGMA table_info(keyword_planner)`).all() as Array<{ name: string }>).map(c => c.name));
  if (!cols.has('from_ads')) {
    db.exec(`ALTER TABLE keyword_planner ADD COLUMN from_ads INTEGER DEFAULT 0;
             ALTER TABLE keyword_planner ADD COLUMN from_gsc INTEGER DEFAULT 0;
             UPDATE keyword_planner SET from_ads = 1 WHERE source IN ('volume', 'ideas');`);
  }
}

function trendOf(m: KeywordMetrics['monthly']): { trend: string | null; peak: string | null } {
  const xs = m.filter(x => x.searches != null);
  if (xs.length < 6) return { trend: null, peak: null };
  const avg = (a: typeof xs): number => a.reduce((s, x) => s + (x.searches ?? 0), 0) / a.length;
  const last = avg(xs.slice(-3)), prev = avg(xs.slice(-6, -3));
  const trend = prev === 0 ? (last > 0 ? 'rising' : 'flat') : last / prev > 1.25 ? 'rising' : last / prev < 0.8 ? 'falling' : 'flat';
  const p = xs.reduce((a, b) => ((b.searches ?? 0) > (a.searches ?? 0) ? b : a));
  return { trend, peak: `${p.year}-${String(p.month).padStart(2, '0')}` };
}

/** Upsert Keyword Planner rows into a property database. Returns how many were saved. */
export function saveKeywords(
  db: Database.Database, rows: KeywordMetrics[],
  meta: { source: 'volume' | 'ideas' | 'gsc'; seed?: string; location?: string | number; language?: string },
): number {
  ensureKeywordTable(db);
  const st = db.prepare(`INSERT INTO keyword_planner (keyword, search_volume, competition, competition_level, cpc, low_bid, high_bid, trend, peak_month, monthly_json, grouped_under, source, seed, location, language, from_ads, from_gsc, fetched_at)
    VALUES (@keyword, @sv, @comp, @lvl, @cpc, @low, @high, @trend, @peak, @monthly, @grouped, @source, @seed, @loc, @lang, @fa, @fg, datetime('now'))
    ON CONFLICT(keyword) DO UPDATE SET search_volume=excluded.search_volume, competition=excluded.competition, competition_level=excluded.competition_level,
      cpc=excluded.cpc, low_bid=excluded.low_bid, high_bid=excluded.high_bid, trend=excluded.trend, peak_month=excluded.peak_month, monthly_json=excluded.monthly_json,
      grouped_under=excluded.grouped_under, source=CASE WHEN keyword_planner.source='volume' THEN 'volume' ELSE excluded.source END,
      seed=COALESCE(excluded.seed, keyword_planner.seed), location=excluded.location, language=excluded.language,
      from_ads=MAX(keyword_planner.from_ads, excluded.from_ads), from_gsc=MAX(keyword_planner.from_gsc, excluded.from_gsc), fetched_at=datetime('now')`);
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!r.keyword?.trim()) continue;
      const t = trendOf(r.monthly ?? []);
      st.run({
        keyword: r.keyword.trim().toLowerCase(), sv: r.searchVolume, comp: r.competition, lvl: r.competitionLevel, cpc: r.cpc,
        low: r.lowTopOfPageBid, high: r.highTopOfPageBid, trend: t.trend, peak: t.peak, monthly: JSON.stringify(r.monthly ?? []),
        grouped: r.groupedUnder ?? null, source: meta.source, seed: meta.seed ?? null,
        loc: meta.location == null ? null : String(meta.location), lang: meta.language ?? null,
        fa: meta.source === 'gsc' ? 0 : 1, fg: meta.source === 'gsc' ? 1 : 0,
      });
      n++;
    }
  })();
  return n;
}

/** Remove keywords from a property (all when `keywords` is omitted). */
export function deleteKeywords(db: Database.Database, keywords?: string[]): number {
  ensureKeywordTable(db);
  if (!keywords?.length) return db.prepare('DELETE FROM keyword_planner').run().changes;
  const st = db.prepare('DELETE FROM keyword_planner WHERE keyword = ?');
  let n = 0;
  for (const k of keywords) n += st.run(k.trim().toLowerCase()).changes;
  return n;
}

const sig = (s: string): string => [...new Set(tokens(s))].sort().join(' ');

/**
 * The Search Console queries worth adding: last 90 days, ranked by impressions, one per token
 * signature (the most-shown spelling), skipping any whose words match a row already saved. Those
 * existing rows are flagged from_gsc instead. Returns the queries that still need Keyword Planner
 * metrics, plus how many existing rows were flagged.
 */
export function gscQueriesToImport(db: Database.Database, limit = 500): { queries: string[]; flagged: number; considered: number } {
  ensureKeywordTable(db);
  const hasSa = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='search_analytics'`).get();
  if (!hasSa) return { queries: [], flagged: 0, considered: 0 };
  const src = gscTotalsSource(db);
  const maxDate = (db.prepare(`SELECT MAX(date) d FROM ${src}`).get() as { d: string | null }).d;
  if (!maxDate) return { queries: [], flagged: 0, considered: 0 };
  const rows = db.prepare(`SELECT query, SUM(impressions) i FROM ${src}
    WHERE query IS NOT NULL AND query != '' AND date > date(?, '-90 days') AND date <= ? GROUP BY query ORDER BY i DESC`).all(maxDate, maxDate) as Array<{ query: string; i: number }>;
  const existing = new Map<string, string>();
  for (const r of db.prepare(`SELECT keyword FROM keyword_planner`).all() as Array<{ keyword: string }>) { const g = sig(r.keyword); if (g && !existing.has(g)) existing.set(g, r.keyword); }
  const seen = new Set<string>(); const queries: string[] = []; let flagged = 0, considered = 0;
  const flag = db.prepare(`UPDATE keyword_planner SET from_gsc = 1 WHERE keyword = ?`);
  for (const r of rows) {
    const g = sig(r.query);
    if (!g || seen.has(g)) continue;
    seen.add(g);
    if (++considered > limit) break;
    const hit = existing.get(g);
    if (hit) { flagged += flag.run(hit).changes; continue; }
    queries.push(r.query.trim().toLowerCase());
  }
  return { queries, flagged, considered: Math.min(considered, limit) };
}
const statusFor = (pos: number | null, impressions: number): DemandStatus =>
  !impressions || pos == null ? 'gap' : pos <= 3 ? 'top3' : pos <= 10 ? 'page1' : pos <= 20 ? 'striking' : 'weak';

export function keywordDemandPayload(db: Database.Database): DemandPayload | null {
  ensureKeywordTable(db);
  const kws = db.prepare(`SELECT keyword, search_volume sv, competition comp, competition_level lvl, cpc, trend, peak_month peak, grouped_under grouped, source, from_ads fa, from_gsc fg, fetched_at
    FROM keyword_planner ORDER BY COALESCE(search_volume, -1) DESC, keyword`).all() as Array<{ keyword: string; sv: number | null; comp: number | null; lvl: string | null; cpc: number | null; trend: string | null; peak: string | null; grouped: string | null; source: string; fa: number; fg: number; fetched_at: string }>;
  if (!kws.length) return null;

  // GSC: per (query, page) over the last 90 days, bucketed by token signature.
  type Agg = { impr: number; clicks: number; posW: number; pages: Map<string, { c: number; i: number }> };
  const bySig = new Map<string, Agg>();
  const hasSa = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='search_analytics'`).get();
  if (hasSa) {
    const src = gscTotalsSource(db);
    const maxDate = (db.prepare(`SELECT MAX(date) d FROM ${src}`).get() as { d: string | null }).d;
    if (maxDate) {
      const wanted = new Set(kws.map(k => sig(k.keyword)).filter(Boolean));
      const rows = db.prepare(`SELECT query, page_key, SUM(impressions) i, SUM(clicks) c, SUM(position * impressions) pw
        FROM ${src} WHERE query IS NOT NULL AND date > date(?, '-90 days') AND date <= ? GROUP BY query, page_key`).all(maxDate, maxDate) as Array<{ query: string; page_key: string | null; i: number; c: number; pw: number }>;
      for (const r of rows) {
        const s = sig(r.query);
        if (!s || !wanted.has(s)) continue;
        let a = bySig.get(s);
        if (!a) { a = { impr: 0, clicks: 0, posW: 0, pages: new Map() }; bySig.set(s, a); }
        a.impr += r.i; a.clicks += r.c; a.posW += r.pw;
        if (r.page_key) { const p = a.pages.get(r.page_key) ?? { c: 0, i: 0 }; p.c += r.c; p.i += r.i; a.pages.set(r.page_key, p); }
      }
    }
  }

  // Crawl: indexable pages with their title/H1/slug tokens, for suggested targets.
  const hasPages = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='pages'`).get();
  const pages = hasPages
    ? (db.prepare(`SELECT url_key, title, h1 FROM pages WHERE indexable = 1`).all() as Array<{ url_key: string; title: string | null; h1: string | null }>)
        .map(p => {
          let slug = '';
          try { slug = decodeURIComponent(new URL(p.url_key).pathname).replace(/[/_-]+/g, ' '); } catch { /* not a URL */ }
          return { url: p.url_key, toks: new Set(suggestTokens(`${p.title ?? ''} ${p.h1 ?? ''} ${slug}`)) };
        })
    : [];
  // Words on more than half the pages ("gestoría", "madrid" on a Madrid gestoría) say nothing about
  // WHICH page fits; only the keyword's distinctive words decide. A keyword made only of site-wide
  // words goes to the shortest URL that has them all (usually the home page).
  const df = new Map<string, number>();
  for (const p of pages) for (const t of p.toks) df.set(t, (df.get(t) ?? 0) + 1);
  // On very small sites (under 5 pages) "more than half" is meaningless; only words on every page count.
  const siteWide = (t: string): boolean => {
    const n = df.get(t) ?? 0;
    return pages.length >= 5 ? n / pages.length > 0.5 : pages.length > 0 && n === pages.length;
  };
  const suggest = (kw: string): string | null => {
    const kt = suggestTokens(kw);
    if (!kt.length || !pages.length) return null;
    const distinctive = kt.filter(t => !siteWide(t));
    // A head term made only of site-wide words ("gestoría madrid" on a Madrid gestoría) belongs on
    // the home page: the shortest URL that carries all of them.
    if (!distinctive.length) {
      let home: string | null = null;
      for (const p of pages) if (kt.every(t => p.toks.has(t)) && (!home || p.url.length < home.length)) home = p.url;
      return home;
    }
    // Distinctive words no page uses at all ("sistema" in "sistema verifactu") are modifiers the site
    // has no page for; judge on the ones it does use. If none are used ("carabanchel"), it's new content.
    const pool = distinctive.filter(t => df.has(t));
    if (!pool.length) return null;
    // ...but only when what is left is specific: an unknown word next to common ones only
    // ("laboral" in "gestoría laboral madrid") is the actual topic, and the site has no page for it.
    const rare = (t: string): boolean => (df.get(t) ?? 0) / pages.length <= 1 / 3;
    if (pool.length < distinctive.length && !pool.some(rare)) return null;
    // Coverage is judged on the specific (rare) words when there are any, else on the whole pool:
    // two words or fewer need all of them, longer sets two thirds. Ties go to the most SPECIFIC page
    // (highest Jaccard with the keyword), so a service page beats a home page that mentions it.
    const core = pool.some(rare) ? pool.filter(rare) : pool;
    const need = core.length <= 2 ? 1 : 2 / 3;
    let best: string | null = null, bestCov = 0, bestJac = -1;
    for (const p of pages) {
      const cov = core.filter(t => p.toks.has(t)).length / core.length;
      if (cov < need) continue;
      const inter = kt.filter(t => p.toks.has(t)).length;
      const jac = inter / (kt.length + p.toks.size - inter);
      if (cov > bestCov || (cov === bestCov && (jac > bestJac || (jac === bestJac && best && p.url.length < best.length)))) {
        best = p.url; bestCov = cov; bestJac = jac;
      }
    }
    return best;
  };

  const out: DemandRow[] = kws.map(k => {
    const a = bySig.get(sig(k.keyword));
    let page: string | null = null;
    if (a) {
      let bc = -1, bi = -1;
      for (const [url, v] of a.pages) if (v.c > bc || (v.c === bc && v.i > bi)) { bc = v.c; bi = v.i; page = url; }
    }
    const position = a && a.impr ? Math.round((a.posW / a.impr) * 10) / 10 : null;
    const impressions = a?.impr ?? 0;
    return {
      keyword: k.keyword, searchVolume: k.sv, competition: k.comp, competitionLevel: k.lvl, cpc: k.cpc,
      trend: k.trend, peakMonth: k.peak, groupedUnder: k.grouped, source: k.source,
      fromAds: !!k.fa, fromGsc: !!k.fg || impressions > 0,
      page, position, impressions, clicks: a?.clicks ?? 0,
      suggestedPage: page ? null : suggest(k.keyword),
      status: statusFor(position, impressions),
    };
  });

  const byStatus: Record<DemandStatus, number> = { top3: 0, page1: 0, striking: 0, weak: 0, gap: 0 };
  let volume = 0, captured = 0;
  const byOrigin = { gsc: 0, ads: 0, both: 0 };
  for (const r of out) {
    byStatus[r.status]++;
    if (r.fromGsc) byOrigin.gsc++;
    if (r.fromAds) byOrigin.ads++;
    if (r.fromGsc && r.fromAds) byOrigin.both++;
    volume += r.searchVolume ?? 0;
    if (r.status === 'top3' || r.status === 'page1') captured += r.searchVolume ?? 0;
  }
  const updatedAt = kws.reduce((m, k) => (k.fetched_at > m ? k.fetched_at : m), '');
  return { updatedAt: updatedAt || null, totals: { keywords: out.length, volume, byStatus, capturedVolume: captured, byOrigin }, rows: out };
}
