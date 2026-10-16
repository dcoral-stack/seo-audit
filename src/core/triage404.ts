/**
 * 404 triage (#31). A crawl seeded from GSC reports every URL Google has seen, so the 404 list
 * mixes a few genuinely lost pages (traffic, backlinks: they need a 301) with many mangled
 * variants of real slugs from scraped or AI-rewritten links (a handful of impressions, no links:
 * noise). This classifies each 404 by discovery source, search traffic and backlinks, finds the
 * closest live URL by slug similarity, and buckets it: redirect / review / ignore.
 */
import type Database from 'better-sqlite3';

export interface Triage404Row {
  urlKey: string;
  url: string;
  status: number;
  sources: string[];                 // internal-link | sitemap | gsc | backlink
  internalLinks: number;
  inSitemap: boolean;
  clicks: number;
  impressions: number;
  lastSeen: string | null;           // last GSC date with impressions
  backlinks: number;
  referringDomains: number;
  bestMatch: string | null;          // closest live, indexable URL
  score: number;                     // 0..1 slug similarity
  bucket: 'redirect' | 'review' | 'ignore';
  reason: string;
}

export interface TriageOptions { minImpressions?: number; minScore?: number; limit?: number }

const tokens = (path: string): string[] => path.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0);
const pathOf = (u: string): string => { try { return decodeURIComponent(new URL(u).pathname).toLowerCase(); } catch { return u.toLowerCase(); } };

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Slug similarity: the better of token Dice overlap (reordered/extra words) and edit similarity (typos).
 *  Dice rather than Jaccard: a renamed post that gained or lost a couple of words keeps a fair score. */
export function slugSimilarity(a: string, b: string): number {
  const pa = pathOf(a).replace(/\/+$/, ''), pb = pathOf(b).replace(/\/+$/, '');
  const ta = new Set(tokens(pa)), tb = new Set(tokens(pb));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const dice = ta.size + tb.size ? (2 * inter) / (ta.size + tb.size) : 0;
  const lev = 1 - levenshtein(pa, pb) / Math.max(pa.length, pb.length, 1);
  return Math.max(dice, lev);
}

export function triage404s(db: Database.Database, opts: TriageOptions = {}): Triage404Row[] {
  const minImpressions = opts.minImpressions ?? 50;
  const minScore = opts.minScore ?? 0.6;
  const limit = opts.limit ?? 500;

  // No LIMIT here: value signals are cheap, so every 404 is scored and the limit applies AFTER sorting
  // by value. Truncating first dropped high-value 404s on GSC-seeded crawls with thousands of them.
  const dead = db.prepare(`SELECT url_key, url, status_code FROM pages WHERE is_internal=1 AND status_code IN (404, 410)`).all() as { url_key: string; url: string; status_code: number }[];
  if (!dead.length) return [];
  const live = db.prepare(`SELECT url FROM pages WHERE status_code=200 AND indexable=1`).all() as { url: string }[];

  // Inverted index on meaningful tokens (≥3 chars) so only plausible candidates get edit distance.
  const byToken = new Map<string, number[]>();
  live.forEach((p, i) => { for (const t of new Set(tokens(pathOf(p.url)))) if (t.length >= 3) (byToken.get(t) ?? byToken.set(t, []).get(t)!).push(i); });

  const q = {
    links: db.prepare(`SELECT COUNT(DISTINCT source_key) n FROM links WHERE target_key=? AND is_internal=1`),
    sitemap: db.prepare(`SELECT 1 FROM sitemap_urls WHERE url_key=? LIMIT 1`),
    gsc: db.prepare(`SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i, MAX(CASE WHEN impressions>0 THEN date END) last FROM search_analytics WHERE page_key=?`),
    bl: db.prepare(`SELECT backlinks, referring_domains FROM page_backlinks WHERE url_key=?`),
  };
  const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } }; // tables absent on a crawl-only DB

  const scored = dead.map(d => {
    const internalLinks = (q.links.get(d.url_key) as { n: number }).n;
    const inSitemap = safe(() => !!q.sitemap.get(d.url_key), false);
    const g = safe(() => q.gsc.get(d.url_key) as { c: number; i: number; last: string | null }, { c: 0, i: 0, last: null });
    const b = safe(() => q.bl.get(d.url_key) as { backlinks: number; referring_domains: number } | undefined, undefined);
    return { d, internalLinks, inSitemap, g, backlinks: b?.backlinks ?? 0, referringDomains: b?.referring_domains ?? 0 };
  }).sort((a, b) => (b.g.c - a.g.c) || (b.referringDomains - a.referringDomains) || (b.g.i - a.g.i) || (b.internalLinks - a.internalLinks)).slice(0, limit);

  return scored.map(({ d, internalLinks, inSitemap, g, backlinks, referringDomains }) => {

    // Candidates: share a meaningful token; ranked by shared-token count, top 300 get edit distance.
    const counts = new Map<number, number>();
    for (const t of new Set(tokens(pathOf(d.url)))) if (t.length >= 3) for (const i of byToken.get(t) ?? []) counts.set(i, (counts.get(i) ?? 0) + 1);
    let bestMatch: string | null = null, score = 0;
    for (const [i] of [...counts].sort((x, y) => y[1] - x[1]).slice(0, 300)) {
      const s = slugSimilarity(d.url, live[i].url);
      if (s > score) { score = s; bestMatch = live[i].url; }
    }
    score = Math.round(score * 100) / 100;

    const sources = [internalLinks ? 'internal-link' : '', inSitemap ? 'sitemap' : '', g.i > 0 ? 'gsc' : '', backlinks > 0 ? 'backlink' : ''].filter(Boolean);
    const valuable = g.c > 0 || g.i >= minImpressions || referringDomains > 0;
    const linked = internalLinks > 0 || inSitemap;
    let bucket: Triage404Row['bucket'], reason: string;
    if (valuable && bestMatch && score >= minScore) {
      bucket = 'redirect';
      reason = `${[g.c ? `${g.c} clicks` : '', g.i ? `${g.i} impressions` : '', referringDomains ? `${referringDomains} referring domains` : ''].filter(Boolean).join(', ')}; confident match (${score})`;
    } else if (!valuable && !linked && backlinks === 0 && g.i < 10) {
      bucket = 'ignore';
      reason = `${g.i} impressions, no clicks, no internal links, not in sitemap, no backlinks${score >= minScore ? `: likely a mangled variant of ${bestMatch}` : ''}`;
    } else {
      bucket = 'review';
      reason = valuable ? `has value but no confident match (best ${score})` : linked ? `${internalLinks ? `${internalLinks} internal link(s) point here: fix them at source` : 'listed in the sitemap: remove it'}` : 'some signal; check by hand';
    }
    return { urlKey: d.url_key, url: d.url, status: d.status_code, sources, internalLinks, inSitemap, clicks: g.c, impressions: g.i, lastSeen: g.last, backlinks, referringDomains, bestMatch, score, bucket, reason };
  }).sort((a, b) => (b.clicks - a.clicks) || (b.referringDomains - a.referringDomains) || (b.impressions - a.impressions));
}
