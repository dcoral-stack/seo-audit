// Extended end-to-end smoke test. Seeds ONE realistic property covering crawl + GSC +
// URL-inspection + backlinks + intent + CWV + entities, then exercises the whole pipeline:
//   - every check runs without throwing
//   - runAudit (full + judgement) fires a broad, sane set of findings with finite, sorted priority
//   - template detection, new-page opportunities, and dashboard data all build
// Run:  npm run smoke
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { detectTemplates } from '../dist/audit/templates.js';
import { suggestPages } from '../dist/audit/opportunities.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { dbPathFor } from '../dist/core/paths.js';
import { crawlRate, fmtDuration } from '../dist/core/crawlProgress.js';
import { urlKey } from '../dist/core/url-key.js';

const k = (u) => urlKey(u, { hostForm: 'apex' });
const dataDir = path.join(tmpdir(), `sac-smoke-${Date.now()}`);
const site = 'sc-domain:smoke.test';
const dbPath = dbPathFor(dataDir, site);
const adb = new AuditDatabase(dbPath);
const db = adb.db;
adb.upsertProperty(site, 'apex');
const TODAY = '2026-06-20';

db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,max_pages) VALUES ('c1','https://smoke.test','smoke.test','completed',60,1000)`).run();

const PAGE_DEFAULTS = {
  crawl_id: 'c1', url: '', url_key: '', status_code: 200, content_type: 'text/html', content_encoding: 'gzip', bytes: 20000, response_time_ms: 200,
  depth: 1, is_internal: 1, indexable: 1, noindex: 0, title: 'Default Title', title_length: 13, meta_description: 'A description here', meta_description_length: 18,
  h1: 'Default H1', h1_count: 1, word_count: 600, lang: 'en', canonical_url: null, canonical_key: null, robots: null, x_robots_tag: null, viewport: 'width=device-width, initial-scale=1',
  json_ld: null, og_tags: '{"og:title":"x"}', hreflang: null, redirects: null, internal_links: 5, external_links: 1,
  canonical_count: 0, canonical_relative: 0, h2_count: 2, heading_skips: 0, rel_next: 0, rel_prev: 0, mixed_content_count: 0, twitter_tags: '{"twitter:card":"summary"}',
  inlink_count: 3, ipr: 10, click_depth: 2, security_headers: '{"hsts":"max-age=63072000"}',
};
const COLS = Object.keys(PAGE_DEFAULTS);
const pStmt = db.prepare(`INSERT INTO pages (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`);
const page = (url, o = {}) => pStmt.run({ ...PAGE_DEFAULTS, ...o, url, url_key: o.url_key ?? k(url) });
// Real json_ld column format = JSON array of RAW BLOCK STRINGS (one per <script>), per extract.ts.
const ld = (...objs) => JSON.stringify(objs.map(o => (typeof o === 'string' ? o : JSON.stringify(o))));
const link = (from, to, internal = 1) => db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1',?,?,?,?,?)`).run(from, k(from), to, k(to), internal);
const gsc = (q, u, clicks, impr, pos) => db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,clicks,impressions,position) VALUES (?,?,?,?,?,?,?)`).run(TODAY, q, u, u ? k(u) : null, clicks, impr, pos);

// ── Home + a healthy hub
page('https://smoke.test/', { url_key: k('https://smoke.test/'), ipr: 100, inlink_count: 20, h1: 'Home', title: 'Smoke Test — Home' });

// ── Product template (4) — Product schema; one missing offers (missing-required-fields),
//    one is the intent-mismatch target
const PROD = ['red-racing-wheel', 'blue-pedal-set', 'green-shifter', 'grey-handbrake'];
PROD.forEach((s, i) => page(`https://smoke.test/product/${s}`, {
  title: `${s} for sale`, title_length: 20, h1: s,
  json_ld: i === 0
    ? ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'x' }) /* missing offers */
    : ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'x', offers: { '@type': 'Offer', price: '9', priceCurrency: 'USD' } }),
}));
// Product page whose top query is informational -> intent-vs-pagetype-mismatch
gsc('how to install a handbrake', 'https://smoke.test/product/grey-handbrake', 2, 500, 12);
db.prepare(`INSERT INTO keyword_intent (keyword,intent,probability) VALUES ('how to install a handbrake','informational',0.97)`).run();

// ── Blog template (4) — Article schema; one has illogical dates
const BLOG = ['getting-started', 'advanced-tips', 'common-mistakes', 'date-bug'];
BLOG.forEach((s) => page(`https://smoke.test/blog/${s}`, {
  title: `${s} guide`, h1: s,
  json_ld: s === 'date-bug'
    ? ld({ '@context': 'https://schema.org', '@type': 'Article', headline: 'x', image: 'https://smoke.test/i.jpg', author: { '@type': 'Person', name: 'A' }, datePublished: '2024-05-01', dateModified: '2024-04-01' })
    : ld({ '@context': 'https://schema.org', '@type': 'Article', headline: 'x', image: 'https://smoke.test/i.jpg', author: { '@type': 'Person', name: 'A' }, datePublished: '2024-01-01', dateModified: '2024-02-01' }),
}));

// ── On-page issue pages
page('https://smoke.test/no-title', { title: '', title_length: 0 });            // missing-title
page('https://smoke.test/dupe-a', { title: 'Same Title Twice' });               // duplicate-title
page('https://smoke.test/dupe-b', { title: 'Same Title Twice' });               // duplicate-title
page('https://smoke.test/no-meta', { meta_description: '', meta_description_length: 0 }); // missing-meta-description
page('https://smoke.test/no-h1', { h1: null, h1_count: 0 });                    // missing-h1
page('https://smoke.test/many-h1', { h1_count: 3 });                            // multiple-h1
page('https://smoke.test/long-title', { title_length: 80 });                    // title-too-long
page('https://smoke.test/long-meta', { meta_description_length: 200 });         // meta-description-length
page('https://smoke.test/no-viewport', { viewport: '' });                       // missing-viewport
page('https://smoke.test/no-social', { og_tags: null, twitter_tags: null });    // missing-social-tags
page('https://smoke.test/nofollow', { robots: 'nofollow' });                    // meta-nofollow
page('http://smoke.test/insecure', { url_key: k('http://smoke.test/insecure') });// non-https
page('https://smoke.test/mixed', { mixed_content_count: 3 });                   // mixed-content
page('https://smoke.test/no-hsts', { security_headers: '{}' });                 // missing-hsts
page('https://smoke.test/no-schema', { json_ld: null });                        // missing-structured-data
page('https://smoke.test/bad-schema', { json_ld: ld({ name: 'no type or context' }) }); // invalid-schema (no @type/@context)
page('https://smoke.test/deep', { click_depth: 6 });                            // deep-pages

// ── Crawlability / indexation
page('https://smoke.test/dead', { status_code: 404, indexable: 0 });            // 404 target
link('https://smoke.test/', 'https://smoke.test/dead');                         // ipr-bleed (home ipr 100 -> dead)
page('https://smoke.test/bad-canon', { canonical_url: 'https://smoke.test/dead', canonical_key: k('https://smoke.test/dead'), canonical_count: 1 }); // broken-canonical-target
page('https://smoke.test/redir', { redirects: '["https://smoke.test/a","https://smoke.test/b"]' }); // redirect-chain
link('https://smoke.test/', 'https://smoke.test/redir');                        // internal-links-to-redirects
page('https://smoke.test/list?cat=1&sort=asc', { url_key: k('https://smoke.test/list?cat=1&sort=asc') }); // faceted-spider-trap (no GSC)
page('https://smoke.test/shop/page/2', { canonical_url: 'https://smoke.test/shop', canonical_key: k('https://smoke.test/shop'), canonical_count: 1, rel_prev: 1 }); // pagination-canonical
page('https://smoke.test/noindex-traffic', { noindex: 1 });                     // noindex-with-traffic
gsc('noindex query', 'https://smoke.test/noindex-traffic', 40, 800, 6);
page('https://smoke.test/orphan-impr', { inlink_count: 0 });                    // orphan-with-impressions
gsc('orphan query', 'https://smoke.test/orphan-impr', 1, 300, 14);

// hreflang cluster: /en -> /fr (ok-but-no-return) + /gone (404, broken)
page('https://smoke.test/en', { hreflang: JSON.stringify([{ lang: 'en', href: 'https://smoke.test/en' }, { lang: 'fr', href: 'https://smoke.test/fr' }, { lang: 'de', href: 'https://smoke.test/gone' }]) });
page('https://smoke.test/fr', { hreflang: JSON.stringify([{ lang: 'fr', href: 'https://smoke.test/fr' }]) });
page('https://smoke.test/gone', { status_code: 404, indexable: 0 });

// ── URL inspection
db.prepare(`INSERT INTO url_inspection (url_key,url,coverage_state,page_fetch_state,google_canonical,user_canonical) VALUES (?,?,?,?,?,?)`)
  .run(k('https://smoke.test/no-schema'), 'https://smoke.test/no-schema', 'Crawled - currently not indexed', 'SUCCESSFUL', null, null); // coverage-not-indexed
db.prepare(`INSERT INTO url_inspection (url_key,url,coverage_state,page_fetch_state) VALUES (?,?,?,?)`)
  .run(k('https://smoke.test/long-title'), 'https://smoke.test/long-title', 'Submitted and indexed', 'SOFT_404'); // soft-404-shell
db.prepare(`INSERT INTO url_inspection (url_key,url,google_canonical,user_canonical) VALUES (?,?,?,?)`)
  .run(k('https://smoke.test/dupe-a'), 'https://smoke.test/dupe-a', 'https://smoke.test/dupe-b', 'https://smoke.test/dupe-a'); // canonical-conflict

// ── Backlinks (gate for orphan-no-links + backlinks-to-404)
db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code) VALUES (?,?,?,?,?)`)
  .run(k('https://smoke.test/dead'), 'https://smoke.test/dead', 42, 9, 404);     // backlinks-to-404
page('https://smoke.test/true-orphan', { inlink_count: 0 });                     // orphan-no-links
db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code) VALUES (?,?,?,?,?)`)
  .run(k('https://smoke.test/true-orphan'), 'https://smoke.test/true-orphan', 0, 0, 200);

// ── CWV (high-yield-cwv-fail) — failing + has clicks
page('https://smoke.test/slow', {});
gsc('slow page query', 'https://smoke.test/slow', 250, 4000, 5);
db.prepare(`INSERT INTO page_cwv (url_key,url,performance,lcp_ms,cls,tbt_ms) VALUES (?,?,?,?,?,?)`)
  .run(k('https://smoke.test/slow'), 'https://smoke.test/slow', 0.3, 5200, 0.04, 700);

// ── Entities (entity-internal-link-gap) — SEO -> Technical SEO related, no link
page('https://smoke.test/seo', { h1: 'SEO' });
page('https://smoke.test/technical-seo', { h1: 'Technical SEO' });
db.prepare(`INSERT INTO page_entity (url_key,qid,label,source) VALUES (?,?,?,'h1')`).run(k('https://smoke.test/seo'), 'Q1', 'SEO');
db.prepare(`INSERT INTO page_entity (url_key,qid,label,source) VALUES (?,?,?,'h1')`).run(k('https://smoke.test/technical-seo'), 'Q2', 'Technical SEO');
db.prepare(`INSERT INTO entity_edge (qid,related_qid,relation) VALUES ('Q2','Q1','subclass_of')`).run();

// ── GSC merged checks
gsc('striking term', 'https://smoke.test/blog/advanced-tips', 3, 900, 15);       // striking-distance
gsc('cannibal term', 'https://smoke.test/blog/getting-started', 5, 600, 8);      // keyword-cannibalisation
gsc('cannibal term', 'https://smoke.test/blog/common-mistakes', 4, 500, 9);
gsc('low ctr term', 'https://smoke.test/product/blue-pedal-set', 2, 5000, 3);    // ctr-below-expected (pos 3, tiny CTR)
gsc('ghost term', 'https://smoke.test/ghost-page', 10, 600, 7);                  // ghost-pages (not crawled)
gsc('underlinked demand', 'https://smoke.test/orphan-impr', 1, 500, 9);          // underlinked-high-demand (ipr<30, low inlinks)
gsc('coffee machine reviews', 'https://smoke.test/blog/getting-started', 1, 1200, 22); // suggest_pages gap (incidental, rank 22)

// Performance proxies (from captured columns)
page('https://smoke.test/slow-server', { response_time_ms: 3200 });   // slow-response
page('https://smoke.test/heavy-page', { bytes: 320000 });             // large-html
page('https://smoke.test/no-compression', { content_encoding: null }); // uncompressed-html

// Sitemap reconciliation: list /dead (404 → sitemap-non-indexable) + /true-orphan (in sitemap,
// no inlinks → sitemap-orphan). Indexable pages NOT listed → indexable-not-in-sitemap.
const sm = (u) => db.prepare(`INSERT INTO sitemap_urls (url_key,url) VALUES (?,?)`).run(k(u), u);
sm('https://smoke.test/dead'); sm('https://smoke.test/true-orphan'); sm('https://smoke.test/');

adb.close();

// ── Run the pipeline ───────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); cond ? pass++ : fail++; };

// 1) Every check runs without throwing
{
  const adb2 = new AuditDatabase(dbPath);
  const ctx = { db: adb2.db, gscMaxDate: TODAY };
  const threw = [];
  for (const chk of CHECKS) { try { chk.run(ctx); } catch (e) { threw.push(`${chk.id}: ${e.message}`); } }
  ok(threw.length === 0, `all ${CHECKS.length} checks run without throwing${threw.length ? ` — ${JSON.stringify(threw)}` : ''}`);
  adb2.close();
}

// 2) Full audit
const res = runAudit(dataDir, site, { scope: 'full', includeJudgement: true });
const fired = new Set(res.byCheck.map(c => c.checkId));
console.log(`\naudit: ${res.total} findings across ${fired.size} checks`);
ok(res.total >= 30, `>=30 findings (got ${res.total})`);
ok(fired.size >= 25, `>=25 distinct checks fired (got ${fired.size})`);

const must = [
  'missing-title', 'duplicate-title', 'missing-h1', 'title-too-long', 'missing-viewport', 'non-https', 'mixed-content',
  'redirect-chain', 'ipr-bleed-by-status', 'broken-canonical-target', 'faceted-spider-trap', 'pagination-canonical-to-page-1',
  'backlinks-to-404', 'orphan-no-links', 'noindex-with-traffic', 'canonical-conflict', 'coverage-not-indexed', 'soft-404-shell',
  'broken-hreflang-target', 'hreflang-no-return-tag', 'striking-distance', 'keyword-cannibalisation', 'ctr-below-expected',
  'ghost-pages', 'underlinked-high-demand', 'missing-required-fields', 'invalid-schema', 'article-date-illogical',
  'intent-vs-pagetype-mismatch', 'high-yield-cwv-fail', 'entity-internal-link-gap',
  'sitemap-non-indexable', 'indexable-not-in-sitemap', 'sitemap-orphan',
  'slow-response', 'large-html', 'uncompressed-html',
];
const missing = must.filter(m => !fired.has(m));
ok(missing.length === 0, `all ${must.length} must-fire checks present${missing.length ? ` — MISSING: ${JSON.stringify(missing)}` : ''}`);

// 3) Priority sane: finite, sorted desc, top finding has real expected-clicks basis
const pr = res.top.map(f => f.priority);
ok(pr.every(p => Number.isFinite(p)) && pr.every((p, i) => i === 0 || p <= pr[i - 1]), 'priorities finite & sorted desc');
const top = res.top[0];
ok(top && JSON.parse(top.effort).expectedClicks != null, `top finding has expectedClicks basis (${top?.check_id})`);
console.log(`  top 3: ${res.top.slice(0, 3).map(f => `${f.check_id}(${f.priority.toFixed(0)})`).join(', ')}`);

// 4) Templates, opportunities, dashboard
const adb3 = new AuditDatabase(dbPath);
const templates = detectTemplates(adb3.db);
ok(templates.length >= 2, `>=2 templates detected (got ${templates.length}: ${templates.map(t => t.morphology).join(', ')})`);
const sp = suggestPages(adb3.db, { minImpressions: 50 });
ok(sp.proposals.length >= 1, `>=1 new-page proposal (got ${sp.proposals.length}${sp.proposals[0] ? `: "${sp.proposals[0].headTerm}"` : ''})`);
adb3.close();

let dash;
try { dash = getDashboardData(dataDir, site); } catch (e) { dash = { __error: e.message }; }
ok(dash && !dash.__error && typeof dash === 'object', `dashboard data builds${dash?.__error ? ` — ${dash.__error}` : ''}`);

// 5) Data freshness (job/status panel, read from the DB) + the canonical/redirect/404 breakdown
const fr = dash?.freshness;
const kinds = new Set((fr?.sources ?? []).map(s => s.kind));
ok(['sync', 'crawl', 'audit', 'inspect'].every(x => kinds.has(x)), `freshness lists sync/crawl/audit/inspect (got ${[...kinds].join(',')})`);
const crawlSrc = fr?.sources?.find(s => s.kind === 'crawl');
ok(crawlSrc?.state === 'completed' && /URLs crawled/.test(crawlSrc.detail), `freshness crawl source reads crawl_metadata (${crawlSrc?.state}: ${crawlSrc?.detail})`);
ok(fr?.sources?.find(s => s.kind === 'audit')?.state === 'completed', 'freshness audit source reads the audit run');
ok(Array.isArray(fr?.crawlRuns) && fr.crawlRuns.length === 1, `freshness lists crawl runs (got ${fr?.crawlRuns?.length})`);
const flow = dash?.crawlHealth?.urlFlow ?? [];
const nf = flow.find(r => r.label === 'Not found (404)');
ok(nf && nf.count >= 1 && typeof nf.example === 'string', `urlFlow has a 404 bucket with an example (${JSON.stringify(nf)})`);
// A cache hit must still carry live freshness (it is read outside the payload cache).
const dash2 = getDashboardData(dataDir, site);
ok(Array.isArray(dash2?.freshness?.sources) && dash2.freshness.sources.length === (fr?.sources?.length ?? -1), 'cached payload still carries live freshness');

// ── Dashboard review fixes (post-0.14.0) ───────────────────────────────────────────────────
{
  const { getDataFreshness } = await import('../dist/core/dataFreshness.js');
  // The fixture connection is closed above (the audit/dashboard open their own); reopen for these checks.
  const adb4 = new AuditDatabase(dbPathFor(dataDir, site));
  const db = adb4.db;
  const page = (url, o = {}) => db.prepare(`INSERT INTO pages (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`).run({ ...PAGE_DEFAULTS, ...o, url, url_key: o.url_key ?? k(url) });
  // A failed run that wrote nothing leaves c1's pages on screen: shownCrawl must say so.
  db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at,error) VALUES ('c2','https://smoke.test','smoke.test','failed',0,datetime('now'),datetime('now'),'boom')`).run();
  let fz = getDataFreshness(db);
  const crawl = fz.sources.find(s => s.kind === 'crawl');
  ok(crawl?.state === 'failed' && /last completed crawl/.test(crawl.detail) && fz.shownCrawl?.crawlId === 'c1' && fz.shownCrawl.partial === false,
    `failed crawl that wrote nothing: shownCrawl is the last completed run (${fz.shownCrawl?.crawlId}, "${crawl?.detail}")`);
  // A failed run that DID write pages is what's on screen (the crawler wiped the previous snapshot).
  db.prepare(`UPDATE crawl_metadata SET urls_crawled=7 WHERE crawl_id='c2'`).run();
  fz = getDataFreshness(db);
  ok(fz.shownCrawl?.crawlId === 'c2' && fz.shownCrawl.partial === true && /partial snapshot/.test(fz.sources.find(s => s.kind === 'crawl').detail), 'failed crawl that wrote pages: shownCrawl is that run, flagged partial');
  db.prepare(`DELETE FROM crawl_metadata WHERE crawl_id='c2'`).run();
  // Audit state: the engine writes status; a crashed run reads failed, a dead pre-status row reads interrupted.
  const latestAudit = db.prepare(`SELECT status FROM audit_runs ORDER BY started_at DESC LIMIT 1`).get();
  ok(latestAudit?.status === 'completed', `engine records audit status (${latestAudit?.status})`);
  db.prepare(`INSERT INTO audit_runs (run_id, scope, started_at, status, error) VALUES ('r-fail','core',datetime('now','+1 second'),'failed','check exploded')`).run();
  ok(getDataFreshness(db).sources.find(s => s.kind === 'audit')?.state === 'failed', 'a failed audit run reads failed, not running');
  // The newest row must be the dead one for this check, so age every other run past it, then restore.
  const origStarts = db.prepare(`SELECT run_id, started_at FROM audit_runs`).all();
  db.prepare(`UPDATE audit_runs SET started_at=datetime('now','-5 hours')`).run();
  db.prepare(`INSERT INTO audit_runs (run_id, scope, started_at) VALUES ('r-dead','core',datetime('now','-2 hours'))`).run();
  ok(getDataFreshness(db).sources.find(s => s.kind === 'audit')?.state === 'interrupted', 'an old run with no status and no finish reads interrupted');
  db.prepare(`DELETE FROM audit_runs WHERE run_id IN ('r-fail','r-dead')`).run();
  for (const r of origStarts) db.prepare(`UPDATE audit_runs SET started_at=? WHERE run_id=?`).run(r.started_at, r.run_id);
  // Missing canonical excludes non-indexable pages.
  const before = (getDashboardData(dataDir, site).crawlHealth?.urlFlow ?? []).find(r => r.label === 'Missing canonical')?.count ?? 0;
  page('https://smoke.test/noindex-tag', { status_code: 200, indexable: 0, indexable_reason: 'noindex', noindex: 1, canonical_url: null });
  const after = (getDashboardData(dataDir, site).crawlHealth?.urlFlow ?? []).find(r => r.label === 'Missing canonical')?.count ?? 0;
  ok(after === before, `Missing canonical ignores noindex pages (${before} → ${after})`);
  // A crawled-but-unsynced property still reports freshness in the empty payload.
  const site2 = 'sc-domain:nosync.test';
  const adb5 = new AuditDatabase(dbPathFor(dataDir, site2));
  const db2 = adb5.db;
  db2.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled) VALUES ('x1','https://nosync.test','nosync.test','completed',3)`).run();
  const emptyDash = getDashboardData(dataDir, site2);
  ok(emptyDash.empty === true && Array.isArray(emptyDash.freshness?.sources) && emptyDash.freshness.sources.some(s => s.kind === 'crawl' && s.state === 'completed'), 'empty (no GSC) payload still carries freshness');
  adb5.close();
  adb4.close();
}

// #52: crawl progress arithmetic.
{
  const r0 = crawlRate(0, 0, 5, 10000, 0);
  ok(r0.pagesPerSec === null && r0.etaSeconds === null && r0.pagesRemaining === 5, 'crawlRate: no rate or ETA before the first page');
  const r1 = crawlRate(600, 0, 9400, 10000, 300_000);
  ok(r1.pagesPerSec === 2 && r1.etaSeconds === 4700 && r1.pagesRemaining === 9400, `crawlRate: 600 pages in 5 min = 2 pages/s, ETA 4700 s (${JSON.stringify(r1)})`);
  const r2 = crawlRate(3900, 100, 5000, 4000, 60_000);
  ok(r2.pagesRemaining === 100 && r2.pagesPerSec === 66.7, `crawlRate: the queue is capped by maxPages and failures count toward the rate (${JSON.stringify(r2)})`);
  ok(fmtDuration(4700) === '1h 18m' && fmtDuration(252) === '4m 12s' && fmtDuration(9) === '9s' && fmtDuration(null) === 'unknown', 'fmtDuration formats s / m s / h m');
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dataDir, { recursive: true, force: true });
if (fail) process.exitCode = 1;
