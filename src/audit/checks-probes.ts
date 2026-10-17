/**
 * #55 summary slice 4, group D, item 8: what the crawl's own site probes found (core/siteProbes.ts).
 *   - soft-404-handling   a random non-existent URL answers 200 or redirects to a 200 page (usually the
 *                         homepage), instead of 404/410; plus crawled 200 pages whose title or H1 reads
 *                         as a not-found page
 *   - host-variant-split  an http/https or www/apex twin of the homepage or a deep URL answers 200, a
 *                         temporary redirect, a chain, or lands somewhere other than the canonical URL,
 *                         instead of one 301/308 to the canonical host
 *
 * Data: `probes` rows with source = 'site-probe' (written at the end of every crawl since 0.16.0, the
 * latest crawl's only), `pages` (latest crawl). Same contract as checks.ts: a pure read, thresholds
 * stated, and collected() reports "not collected" when no site probe has run. A probe that was rate
 * limited, timed out or failed is unknown (verdict 'unknown'), never a finding.
 */
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { HTML_CT } from '../core/sql.js';
import { SITE_PROBE_SOURCE, SOFT404_FAIL, HOST_FAIL } from '../core/siteProbes.js';
import { equityLookup, equityWeight, EQUITY_RULE, type Equity } from './checks-redirects.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);
const hasSource = (c: CheckContext): boolean => (rows(c, `PRAGMA table_info(probes)`) as { name: string }[]).some(x => x.name === 'source');
const siteProbes = (c: CheckContext, kindLike: string): any[] => (hasSource(c)
  ? rows(c, `SELECT * FROM probes WHERE source = ? AND variant_type LIKE ? ORDER BY id`, SITE_PROBE_SOURCE, kindLike)
  : []);
const parseChain = (s: string | null): { url: string; status: number; location: string | null }[] => { try { const a = JSON.parse(s ?? '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
/** The latest-crawl page row for an absolute URL (pages are keyed by the final URL). */
const keyOf = (c: CheckContext, url: string | null): string | null => (url ? (one(c, `SELECT url_key k FROM pages WHERE url = ? LIMIT 1`, url)?.k ?? null) : null);

// ── Not-found phrasing ───────────────────────────────────────────────────────────────────────
/**
 * A title segment or H1 that IS a not-found message, matched whole (anchored at both ends), so an
 * article ABOUT 404 errors ("How to fix 404 errors") never matches. Kept short and generic: "404",
 * "Error 404", "404 - Page not found", "Page not found", "Oops! Page not found", "Not found",
 * "Sorry, this page can't be found", "Nothing found", "This page doesn't exist". English only.
 */
export const NOT_FOUND_RE = new RegExp('^(?:'
  + '(?:error\\s+)?404(?:\\s+error)?(?:\\s*[-–:]?\\s*(?:page\\s+)?not\\s+found)?'
  + '|(?:oops[!,.]*\\s*)?(?:the\\s+|this\\s+)?(?:page|post|article|product)\\s+(?:was\\s+|is\\s+)?not\\s+found'
  + '|(?:sorry[!,.]*\\s*)?(?:the\\s+|this\\s+|that\\s+)?page\\s+(?:can(?:\'|’)?t|cannot|could\\s+not|couldn[\'’]t)\\s+be\\s+found'
  + '|not\\s+found|nothing\\s+(?:was\\s+)?found(?:\\s+here)?'
  + '|(?:the\\s+|this\\s+)?page\\s+(?:does\\s+not|doesn[\'’]t)\\s+exist'
  + ')[\\s!.]*$', 'i');
/** Title separators: a site name is usually appended after one of these. */
const TITLE_SEP = /\s+[|–—·•:-]\s+|\s*::\s*/;
/** The title segment or H1 that reads as not-found, or null. */
export function notFoundText(title: string | null, h1: string | null): { field: 'title' | 'h1'; text: string } | null {
  for (const seg of (title ?? '').split(TITLE_SEP)) if (NOT_FOUND_RE.test(seg.trim())) return { field: 'title', text: title! };
  if (h1 && NOT_FOUND_RE.test(h1.trim())) return { field: 'h1', text: h1 };
  return null;
}

// ── soft-404-handling ────────────────────────────────────────────────────────────────────────
const SOFT404_NOTE: Record<string, string> = {
  'serves-200': 'answers 200 for a URL that does not exist: every typo or removed URL is an indexable soft 404',
  'redirects-to-home': 'redirects a URL that does not exist to the homepage: Google reads that as a soft 404, and visitors land somewhere they did not ask for',
  'redirects-to-200': 'redirects a URL that does not exist to another 200 page: Google reads an irrelevant redirect as a soft 404',
};

function soft404Handling(c: CheckContext): RawFinding[] {
  const out: RawFinding[] = [];
  const probes = siteProbes(c, 'soft404%');
  const failing = probes.filter(p => (SOFT404_FAIL as string[]).includes(p.verdict));
  if (failing.length) {
    const home = probes[0]?.variant_of ?? null;
    out.push({ urlKey: keyOf(c, home), evidence: {
      kind: 'site-setup', home, probed: probes.length, failing: failing.length, crawlId: failing[0].crawl_id, probedAt: failing[0].probed_at,
      probes: probes.map(p => ({ url: p.url, kind: p.variant_type, verdict: p.verdict, status: p.status, redirects: parseChain(p.redirect_chain).map(h => `${h.status} ${h.location}`), finalUrl: p.final_url, finalStatus: p.final_status, title: p.title })),
      note: SOFT404_NOTE[failing[0].verdict],
    } });
  }
  const equity = equityLookup(c);
  const pages: { f: RawFinding; eq: Equity }[] = [];
  for (const p of rows(c, `SELECT url_key k, url, title, h1 FROM pages WHERE status_code = 200 AND ${HTML_CT} AND (title IS NOT NULL OR h1 IS NOT NULL)`)) {
    const m = notFoundText(p.title, p.h1);
    if (!m) continue;
    const eq = equity(p.k);
    pages.push({ eq, f: { urlKey: p.k, evidence: {
      kind: 'not-found-text', url: p.url, status: 200, matched: m.field, title: p.title, h1: p.h1, equity: eq, rule: EQUITY_RULE,
      note: `the ${m.field} reads as a not-found page, but the URL answers 200`,
    } } });
  }
  return [...out, ...pages.sort((a, b) => equityWeight(b.eq) - equityWeight(a.eq)).map(x => x.f)];
}

function soft404Note(c: CheckContext): string | null {
  const probes = siteProbes(c, 'soft404%');
  if (!probes.length) return 'not collected: no soft-404 probe has run. Every crawl since 0.16.0 requests two random non-existent URLs at the end (start_crawl or refresh_property). Crawled pages with not-found titles are still checked.';
  if (probes.every(p => p.verdict === 'unknown')) return `not collected: the soft-404 probes got no usable answer (${probes.map(p => p.error ?? 'no response').join('; ')}). Re-crawl, or check with probe_urls.`;
  return null;
}

// ── host-variant-split ───────────────────────────────────────────────────────────────────────
const HOST_NOTE: Record<string, string> = {
  'serves-200': 'answers 200 without redirecting: the same pages are served on a second host or scheme, splitting links and crawl budget between them',
  'temporary-redirect': 'redirects once, but with a temporary status: use 301 or 308 so Google consolidates on the canonical host',
  'redirect-chain': 'reaches the canonical URL only through more than one redirect: make it one hop',
  'wrong-target': 'redirects somewhere other than the same page on the canonical host',
};
const KIND_LABEL: Record<string, string> = { 'host-home-scheme': 'homepage, other scheme', 'host-home-host': 'homepage, other host (www/apex)', 'host-deep': 'deep URL, other scheme and/or host' };

/** What a failing twin did, in a few words, for the one-line summary. */
const HOST_SHORT: Record<string, string> = {
  'serves-200': 'answers 200', 'temporary-redirect': 'temporary redirect', 'redirect-chain': 'redirect chain', 'wrong-target': 'redirects elsewhere',
};

/**
 * ONE finding per page (the homepage, the deep URL), listing every twin of it that failed: the
 * homepage's scheme twin and host twin used to be two rows with the same title on the same URL,
 * which read as a duplicate. `summary` names them all ("2 of 2 variants not redirected in one 301:
 * http://..., https://www..."); `twins` holds each one's status, redirects and verdict.
 */
function hostVariantSplit(c: CheckContext): RawFinding[] {
  const equity = equityLookup(c);
  const byPage = new Map<string, any[]>();
  for (const p of siteProbes(c, 'host-%')) {
    const key = String(p.variant_of ?? '');
    (byPage.get(key) ?? byPage.set(key, []).get(key)!).push(p);
  }
  const out: { eq: Equity | null; f: RawFinding }[] = [];
  for (const [canonicalUrl, probes] of byPage) {
    const failing = probes.filter(p => (HOST_FAIL as string[]).includes(p.verdict));
    if (!failing.length) continue;
    const answered = probes.filter(p => p.verdict !== 'unknown').length;
    const k = keyOf(c, canonicalUrl || null);
    const eq = k ? equity(k) : null;
    const twins = failing.map(p => {
      const chain = parseChain(p.redirect_chain);
      return {
        variant: p.url, tests: KIND_LABEL[p.variant_type] ?? p.variant_type, verdict: p.verdict, firstStatus: p.status,
        redirects: chain.map(h => `${h.status} ${h.location}`), hops: chain.length, finalUrl: p.final_url, finalStatus: p.final_status,
        canonical: p.canonical, note: HOST_NOTE[p.verdict],
      };
    });
    const list = twins.map(t => `${t.variant} (${HOST_SHORT[t.verdict] ?? t.verdict})`).join(', ');
    out.push({ eq, f: { urlKey: k, evidence: {
      summary: `${failing.length} of ${answered} ${answered === 1 ? 'variant' : 'variants'} not redirected in one 301: ${list}`,
      canonicalUrl, failing: failing.length, probed: answered,
      verdicts: [...new Set(twins.map(t => t.verdict))].join(', '),
      twins, crawlId: failing[0].crawl_id, probedAt: failing[0].probed_at,
      ...(eq ? { equity: eq, rule: EQUITY_RULE } : {}),
      note: twins.map(t => `${t.variant} ${t.note}`).join('; '),
    } } });
  }
  return out
    .sort((a, b) => (b.eq ? equityWeight(b.eq) : 0) - (a.eq ? equityWeight(a.eq) : 0))
    .map(x => x.f);
}

function hostVariantNote(c: CheckContext): string | null {
  const probes = siteProbes(c, 'host-%');
  if (!probes.length) return 'not collected: no host-variant probe has run. Every crawl since 0.16.0 requests the http/https and www/apex twins of the homepage and one deep URL at the end (start_crawl or refresh_property). Not run for an IP address, localhost or a host with a port.';
  if (probes.every(p => p.verdict === 'unknown')) return `not collected: the host-variant probes got no usable answer (${probes.map(p => p.error ?? 'no response').join('; ')}). A twin host that does not resolve is unknown, not a pass.`;
  return null;
}

export const PROBE_CHECKS: CheckDef[] = [
  {
    id: 'soft-404-handling', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Non-existent URLs answer 200 (soft 404)',
    fix: 'Make URLs that do not exist answer 404 (or 410 when removed on purpose), not 200 and not a redirect to the homepage. Google reads either as a soft 404 (https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors), and a site that answers 200 to every typo lets junk URLs into the index. On a single-page app, have the server answer 404 for unknown routes, or add a noindex robots meta tag on the client-side error view (https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics). Evidence: at the end of every crawl, two random URLs that cannot exist (one at the root, one under the busiest section) are requested; and a crawled 200 page whose title or H1 is a not-found message is listed per page, highest equity first.',
    run: soft404Handling, collected: soft404Note,
  },
  {
    id: 'host-variant-split', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 2, fixType: 'global',
    title: 'http/https or www/apex variant not redirected in one 301',
    fix: 'Every http:// and www/apex twin of a URL should answer ONE permanent redirect (301 or 308) to the same path on the canonical scheme and host. A twin that answers 200 splits links and crawl budget between two copies of the site; a 302/307 or a chain slows consolidation. Set the redirect at the CDN or server for the whole host, keeping the path and query. Evidence: at the end of every crawl, the scheme and host twins of the homepage and of the most-linked deep page are requested (at most three requests); one finding per page lists every twin of it that failed. A twin that does not resolve or times out is unknown, not a finding.',
    run: hostVariantSplit, collected: hostVariantNote,
  },
];
