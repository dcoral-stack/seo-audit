/**
 * #55 summary slice 4, group A: site-level signals that feed the summary page.
 *   - site-wide-indexing-alarm  (item 1)  the one critical finding an owner must never miss
 *   - snippet-restricted, ai-search-bot-blocked (item 2)  AI-search visibility controls
 *   - crux-field-lcp / -inp / -cls, crux-regression (item 4)  field Core Web Vitals (CrUX)
 *   - nonbrand-decline-masked (item 5)  a ranking loss hidden inside a flat total
 *
 * Same contract as checks.ts: each check is a pure read over stored rows, deterministic, and its
 * thresholds come from Google's documentation or are stated in the check. Missing data means no
 * finding, never a zero. Appended to CHECKS in checks.ts.
 */
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { latestRobotsTxt } from '../core/robotsStore.js';
import { robotsVerdict, rulesFromText } from '../core/robots.js';
import { AI_BOTS } from '../core/aiBots.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);
const tableExists = (c: CheckContext, name: string): boolean => !!one(c, `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, name);
const pct = (now: number, before: number): number => Math.round(((now - before) / before) * 1000) / 10;

/** robots.txt from the latest crawl, when it answered 2xx with a body. 4xx = no rules (Google treats it as allow-all); 5xx / no response = unknown. */
function storedRobots(c: CheckContext): { origin: string; body: string; fetchedAt: string } | null {
  if (!tableExists(c, 'robots_txt')) return null;
  const r = latestRobotsTxt(c.db);
  return r && r.status >= 200 && r.status < 300 && r.body != null ? { origin: r.origin, body: r.body, fetchedAt: r.fetchedAt } : null;
}

// ── Item 1: site-wide-indexing-alarm ─────────────────────────────────────────────────────────
/** Thresholds, stated: a sitemap "majority" is more than half of its crawled 200 URLs, and needs at least this many. */
export const SITEMAP_NOINDEX_MIN_URLS = 5;
/** Week-on-week drop in distinct pages earning impressions that raises the alarm (#55: "more than 20%"). */
export const IMPRESSION_PAGES_DROP = 0.2;
/** The prior week needs at least this many pages with impressions, or a small site's noise reads as a collapse. */
export const IMPRESSION_PAGES_MIN = 20;

const NOINDEXED = (alias: string): string => `(${alias}indexable_reason IN ('noindex-meta','noindex-header') OR ${alias}noindex=1)`;

function indexingTriggers(c: CheckContext): Record<string, unknown>[] {
  const triggers: Record<string, unknown>[] = [];

  // (a) The homepage carries noindex (the crawl's root: click depth 0).
  const hp = one(c, `SELECT url, indexable_reason reason, robots, x_robots_tag xrt FROM pages WHERE status_code=200 AND click_depth=0 AND ${NOINDEXED('')} LIMIT 1`);
  if (hp) triggers.push({ trigger: 'homepage-noindex', url: hp.url, reason: hp.reason, metaRobots: hp.robots ?? null, xRobotsTag: hp.xrt ?? null });

  // (b) Most of the sitemap's crawled 200 URLs carry noindex (a staging noindex shipped to production).
  const sm = one(c, `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${NOINDEXED('p.')} THEN 1 ELSE 0 END),0) ni
    FROM sitemap_urls s JOIN pages p ON p.url_key = s.url_key WHERE p.status_code=200`);
  if (sm && sm.n >= SITEMAP_NOINDEX_MIN_URLS && sm.ni / sm.n > 0.5) {
    const sample = rows(c, `SELECT p.url FROM sitemap_urls s JOIN pages p ON p.url_key = s.url_key WHERE p.status_code=200 AND ${NOINDEXED('p.')} LIMIT 5`).map(r => r.url);
    triggers.push({ trigger: 'sitemap-majority-noindex', sitemapUrlsCrawled: sm.n, noindex: sm.ni, sharePct: Math.round((sm.ni / sm.n) * 1000) / 10, threshold: `> 50% of crawled sitemap URLs (min ${SITEMAP_NOINDEX_MIN_URLS})`, sample });
  }

  // (c) robots.txt disallows '/' for Googlebot (RFC 9309 most-specific group, as the crawl gate reads it).
  const rb = storedRobots(c);
  if (rb) {
    const v = robotsVerdict(rb.body, 'Googlebot');
    if (!v.allowed) triggers.push({ trigger: 'robots-disallow-googlebot', robotsTxt: `${rb.origin}/robots.txt`, fetchedAt: rb.fetchedAt, group: v.named ? 'Googlebot' : '*', note: 'Googlebot may not fetch "/" under the group that applies to it' });
  }

  // (d) Distinct pages earning impressions fell > 20% week on week (last 7 finalised days vs the 7 before).
  const d = c.gscMaxDate;
  if (d) {
    const week = (endOffset: number): { pages: number; days: number; from: string; to: string } => one(c,
      `SELECT COUNT(DISTINCT CASE WHEN impressions > 0 THEN page_key END) pages, COUNT(DISTINCT date) days,
              date(?, '${-endOffset - 6} days') "from", date(?, '${-endOffset} days') "to"
       FROM search_analytics WHERE page_key IS NOT NULL AND date >= date(?, '${-endOffset - 6} days') AND date <= date(?, '${-endOffset} days')`, d, d, d, d);
    const cur = week(0), prior = week(7);
    if (cur.days === 7 && prior.days === 7 && prior.pages >= IMPRESSION_PAGES_MIN && cur.pages < prior.pages * (1 - IMPRESSION_PAGES_DROP)) {
      triggers.push({ trigger: 'impression-pages-drop', currentWeek: cur, priorWeek: prior, changePct: pct(cur.pages, prior.pages), threshold: `> ${IMPRESSION_PAGES_DROP * 100}% fewer pages with impressions, prior week >= ${IMPRESSION_PAGES_MIN} pages, finalised GSC days only` });
    }
  }
  return triggers;
}

// ── Item 2: snippet-restricted ───────────────────────────────────────────────────────────────
// Robots directive names that take a value after a colon (so "max-snippet: 0" is not a UA prefix).
const VALUED = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);
/**
 * The snippet restrictions that apply to Google in a meta robots value and an X-Robots-Tag header.
 * X-Robots-Tag may scope directives to a crawler ("otherbot: nosnippet"); only unscoped or
 * googlebot-scoped ones count. Returns the restricting directives with where each was found.
 */
export function snippetRestrictions(metaRobots: string | null, xRobotsTag: string | null): { directive: string; source: 'meta' | 'header' }[] {
  const out: { directive: string; source: 'meta' | 'header' }[] = [];
  const scan = (value: string, source: 'meta' | 'header'): void => {
    let scope: string | null = null; // null = all crawlers
    for (const raw of value.toLowerCase().split(',')) {
      let tok = raw.trim();
      const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(tok);
      if (m && !VALUED.has(m[1]) && source === 'header') { scope = m[1]; tok = m[2].trim(); }
      if (scope && scope !== 'googlebot') continue;
      if (tok === 'nosnippet') out.push({ directive: 'nosnippet', source });
      else if (/^max-snippet\s*:\s*0$/.test(tok)) out.push({ directive: 'max-snippet:0', source });
    }
  };
  if (metaRobots) scan(metaRobots, 'meta');
  if (xRobotsTag) scan(xRobotsTag, 'header');
  return out;
}

// ── Item 2: ai-search-bot-blocked ────────────────────────────────────────────────────────────
/** How many of the top pages by GSC clicks are tested per search bot for a partial block. */
export const AI_BOT_TOP_PAGES = 50;

function aiSearchBotFindings(c: CheckContext): RawFinding[] {
  const rb = storedRobots(c);
  if (!rb) return [];
  // Top pages by clicks (28 finalised days) - a block on these costs the most citations.
  const top: string[] = c.gscMaxDate
    ? rows(c, `SELECT page_key FROM search_analytics WHERE page_key IS NOT NULL AND date > date(?, '-28 days') AND date <= ? GROUP BY page_key HAVING SUM(clicks) > 0 ORDER BY SUM(clicks) DESC LIMIT ?`, c.gscMaxDate, c.gscMaxDate, AI_BOT_TOP_PAGES).map(r => r.page_key)
    : [];
  const pathOf = (u: string): string | null => { try { const x = new URL(u); return x.pathname + x.search; } catch { return null; } };
  const blocked: Record<string, unknown>[] = [];
  for (const b of AI_BOTS.filter(x => x.group === 'search')) {
    const v = robotsVerdict(rb.body, b.token);
    if (!v.allowed) { blocked.push({ bot: b.token, operator: b.operator, use: b.note, scope: 'site', group: v.named ? b.token : '*' }); continue; }
    const rules = rulesFromText(rb.body, b.token);
    const paths = top.map(pathOf).filter((p): p is string => !!p && !rules.isAllowed(p));
    if (paths.length) blocked.push({ bot: b.token, operator: b.operator, use: b.note, scope: 'pages', group: v.named ? b.token : '*', topPagesBlocked: paths.length, of: top.length, sample: paths.slice(0, 10) });
  }
  if (!blocked.length) return [];
  // Training bots are reported for context only: blocking them is a choice, not an issue.
  const trainingBlocked = AI_BOTS.filter(x => x.group === 'training' && !robotsVerdict(rb.body, x.token).allowed).map(x => x.token);
  return [{ urlKey: null, evidence: { robotsTxt: `${rb.origin}/robots.txt`, fetchedAt: rb.fetchedAt, searchBotsBlocked: blocked, trainingBotsBlocked: trainingBlocked, note: 'search/citation bots only; training-bot blocks are listed for context and are not an issue' } }];
}

// ── The registry entries ─────────────────────────────────────────────────────────────────────
export const SIGNAL_CHECKS: CheckDef[] = [
  {
    id: 'site-wide-indexing-alarm', category: 'indexation', severity: 'crit', labels: ['D', 'G'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Site-wide indexing alarm',
    fix: 'Something is stopping Google indexing the site as a whole: the homepage or most sitemap URLs carry noindex, robots.txt disallows "/" for Googlebot, or the number of pages earning impressions fell sharply week on week. Usually a staging setting (noindex, Disallow: /) that shipped to production, or a template/plugin change. Remove it today, then resubmit the sitemap and request indexing of the homepage in Search Console.',
    run: (c) => {
      const triggers = indexingTriggers(c);
      return triggers.length ? [{ urlKey: null, evidence: { triggers, note: 'one site-level finding; each trigger cites the stored rows it came from' } }] : [];
    },
  },
  {
    id: 'snippet-restricted', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Snippets blocked (nosnippet / max-snippet:0)',
    fix: 'This indexable page tells Google to show no text snippet (nosnippet, or max-snippet:0) in its robots meta tag or X-Robots-Tag header. Google documents that the same directives also keep the page\'s content out of AI Overviews and AI Mode, so it is listed without a description and cannot be quoted. Remove the directive (or set max-snippet:-1), unless there is a legal reason to restrict it; to hide one passage only, wrap it in data-nosnippet instead.',
    run: (c) => rows(c, `SELECT url_key urlKey, robots, x_robots_tag xrt FROM pages WHERE status_code=200 AND indexable=1
        AND (LOWER(robots) LIKE '%snippet%' OR LOWER(x_robots_tag) LIKE '%snippet%')`)
      .flatMap(r => {
        const hits = snippetRestrictions(r.robots, r.xrt);
        return hits.length ? [{ urlKey: r.urlKey, evidence: { directives: hits, metaRobots: r.robots ?? null, xRobotsTag: r.xrt ?? null } }] : [];
      }),
  },
  {
    id: 'ai-search-bot-blocked', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'AI search bots blocked in robots.txt',
    fix: 'robots.txt stops one or more AI SEARCH crawlers (the ones that fetch pages to cite in answers: OAI-SearchBot and ChatGPT-User for ChatGPT, Claude-SearchBot and Claude-User for Claude, PerplexityBot for Perplexity) from the site or from your top pages, so those assistants cannot cite you. Training crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended...) are a separate choice and blocking them does not affect citations. To be cited while still opting out of training, allow the search bots and keep the training-bot Disallow lines.',
    run: aiSearchBotFindings,
  },
];
