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
 */
import type Database from 'better-sqlite3';
import { tokens } from './text.js';
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
  totals: { keywords: number; volume: number; byStatus: Record<DemandStatus, number>; capturedVolume: number };
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
  meta: { source: 'volume' | 'ideas'; seed?: string; location?: string | number; language?: string },
): number {
  ensureKeywordTable(db);
  const st = db.prepare(`INSERT INTO keyword_planner (keyword, search_volume, competition, competition_level, cpc, low_bid, high_bid, trend, peak_month, monthly_json, grouped_under, source, seed, location, language, fetched_at)
    VALUES (@keyword, @sv, @comp, @lvl, @cpc, @low, @high, @trend, @peak, @monthly, @grouped, @source, @seed, @loc, @lang, datetime('now'))
    ON CONFLICT(keyword) DO UPDATE SET search_volume=excluded.search_volume, competition=excluded.competition, competition_level=excluded.competition_level,
      cpc=excluded.cpc, low_bid=excluded.low_bid, high_bid=excluded.high_bid, trend=excluded.trend, peak_month=excluded.peak_month, monthly_json=excluded.monthly_json,
      grouped_under=excluded.grouped_under, source=CASE WHEN keyword_planner.source='volume' THEN 'volume' ELSE excluded.source END,
      seed=COALESCE(excluded.seed, keyword_planner.seed), location=excluded.location, language=excluded.language, fetched_at=datetime('now')`);
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
const statusFor = (pos: number | null, impressions: number): DemandStatus =>
  !impressions || pos == null ? 'gap' : pos <= 3 ? 'top3' : pos <= 10 ? 'page1' : pos <= 20 ? 'striking' : 'weak';

export function keywordDemandPayload(db: Database.Database): DemandPayload | null {
  ensureKeywordTable(db);
  const kws = db.prepare(`SELECT keyword, search_volume sv, competition comp, competition_level lvl, cpc, trend, peak_month peak, grouped_under grouped, source, fetched_at
    FROM keyword_planner ORDER BY COALESCE(search_volume, -1) DESC, keyword`).all() as Array<{ keyword: string; sv: number | null; comp: number | null; lvl: string | null; cpc: number | null; trend: string | null; peak: string | null; grouped: string | null; source: string; fetched_at: string }>;
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
          return { url: p.url_key, toks: new Set(tokens(`${p.title ?? ''} ${p.h1 ?? ''} ${slug}`)) };
        })
    : [];
  // Words on more than half the pages ("gestoría", "madrid" on a Madrid gestoría) say nothing about
  // WHICH page fits; only the keyword's distinctive words decide. A keyword made only of site-wide
  // words goes to the shortest URL that has them all (usually the home page).
  const df = new Map<string, number>();
  for (const p of pages) for (const t of p.toks) df.set(t, (df.get(t) ?? 0) + 1);
  const siteWide = (t: string): boolean => pages.length > 0 && (df.get(t) ?? 0) / pages.length > 0.5;
  const suggest = (kw: string): string | null => {
    const kt = [...new Set(tokens(kw))];
    if (!kt.length || !pages.length) return null;
    const distinctive = kt.filter(t => !siteWide(t));
    const pool = distinctive.length ? distinctive : kt;
    // Short keywords need every distinctive word ("asesoría empresas" is not served by a page that only
    // says "empresas"); longer ones two thirds. Ties go to the most SPECIFIC page: the one whose own
    // words are mostly the keyword's (Jaccard), so a service page beats a home page that mentions it.
    const need = distinctive.length ? (pool.length <= 2 ? 1 : 2 / 3) : 1;
    let best: string | null = null, bestCov = 0, bestJac = -1;
    for (const p of pages) {
      const cov = pool.filter(t => p.toks.has(t)).length / pool.length;
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
      page, position, impressions, clicks: a?.clicks ?? 0,
      suggestedPage: page ? null : suggest(k.keyword),
      status: statusFor(position, impressions),
    };
  });

  const byStatus: Record<DemandStatus, number> = { top3: 0, page1: 0, striking: 0, weak: 0, gap: 0 };
  let volume = 0, captured = 0;
  for (const r of out) {
    byStatus[r.status]++;
    volume += r.searchVolume ?? 0;
    if (r.status === 'top3' || r.status === 'page1') captured += r.searchVolume ?? 0;
  }
  const updatedAt = kws.reduce((m, k) => (k.fetched_at > m ? k.fetched_at : m), '');
  return { updatedAt: updatedAt || null, totals: { keywords: out.length, volume, byStatus, capturedVolume: captured }, rows: out };
}
