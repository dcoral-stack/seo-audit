// Probe (0.16.1): accessibility findings roll up per template. The extractor records WHICH elements
// failed (a template-stable selector + the href's shape), and a11y-link-name / a11y-button-name /
// a11y-duplicate-id report one finding per shared set of elements plus one per page for its extras.
// Pages crawled before 0.16.1 (no samples) keep one finding per page.
// Run: node scripts/probe-a11y-rollup.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { extractPage } from '../dist/core/extract.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { TEMPLATE_MIN_PAGES } from '../dist/audit/templateRollup.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const SITE = 'sc-domain:a11y.test';
const W = 'https://www.a11y.test';
const keyOpts = { hostForm: hostFormForProperty(SITE) };
const K = (p) => urlKey(`${W}${p}`, keyOpts);

// ── 1. The extractor records template-stable signatures ──
const page = (p, body = '') => `<!doctype html><html><head><title>t</title></head><body>
  <header><a class="logo-link" href="/"><img src="/logo.svg" alt=""></a>
    <a class="social fb" href="https://facebook.com/sharer.php?u=${encodeURIComponent(W + p)}"><svg></svg></a>
    <button class="menu-toggle" id="post-12345-toggle"></button><a href="/ok">Named</a></header>
  <main>${body}</main></body></html>`;
const exA = extractPage(page('/a'), `${W}/a`, 'www.a11y.test', keyOpts);
const exB = extractPage(page('/b', '<a href="/products/widget"><img src="/w.jpg"></a><div id="dup"></div><div id="dup"></div>'), `${W}/b`, 'www.a11y.test', keyOpts);
check('counts unchanged by sampling', exA.a11yLinksNoName === 2 && exA.a11yButtonsNoName === 1 && exB.a11yLinksNoName === 3 && exB.a11yDuplicateIds === 1, JSON.stringify([exA.a11yLinksNoName, exA.a11yButtonsNoName, exB.a11yLinksNoName, exB.a11yDuplicateIds]));
const la = Object.keys(exA.a11ySamples.links).sort(), lb = Object.keys(exB.a11ySamples.links).sort();
check('share link signature ignores the per-page ?u= value', la.includes('a.social.fb[href="facebook.com/sharer.php"]') && lb.includes('a.social.fb[href="facebook.com/sharer.php"]'), JSON.stringify(la));
check('the logo link is a.logo-link[href="/"] on both pages', la.includes('a.logo-link[href="/"]') && lb.includes('a.logo-link[href="/"]'), JSON.stringify(lb));
check('a body link gets its own signature', lb.includes('a[href="/products/widget"]') && !la.includes('a[href="/products/widget"]'), JSON.stringify(lb));
check('ids with long numbers are dropped from the selector', JSON.stringify(exA.a11ySamples.buttons) === JSON.stringify({ 'button.menu-toggle': 1 }), JSON.stringify(exA.a11ySamples.buttons));
check('duplicate ids recorded with their occurrences', exB.a11ySamples.dupIds['#dup'] === 2, JSON.stringify(exB.a11ySamples.dupIds));

// ── 2. Rollup on a fixture DB ──
const dir = mkdtempSync(path.join(tmpdir(), 'sac-a11y-rollup-'));
try {
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const adb = new AuditDatabase(dbPathFor(dir, SITE));
  adb.upsertProperty(SITE, 'apex');
  const db = adb.db;
  db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, 'a11y.test', 'completed', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`).run(`${W}/`);
  const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,ipr,inlink_count,a11y_links_no_name,a11y_buttons_no_name,a11y_duplicate_ids,a11y_samples) VALUES ('c1',?,?,200,'text/html',1,1,1,1,?,?,?,?)`);
  const T = { 'a.logo-link[href="/"]': 1, 'a.social.fb[href="facebook.com/sharer.php"]': 2 };
  // p0-p4 also carry a related-posts card with a nameless image link: shared by 5 pages, so it is its
  // own template finding and must not split the header's finding into two combinations.
  for (let i = 0; i < 20; i++) pg.run(`${W}/p${i}`, K(`/p${i}`), i < 5 ? 4 : 3, 1, 0, JSON.stringify({ links: i < 5 ? { ...T, 'a[href="/related/"]': 1 } : T, buttons: { 'button.menu-toggle': 1 }, dupIds: {} }));
  pg.run(`${W}/extra`, K('/extra'), 4, 1, 1, JSON.stringify({ links: { ...T, 'a[href="/products/widget"]': 1 }, buttons: { 'button.menu-toggle': 1 }, dupIds: { '#x': 2 } }));
  pg.run(`${W}/extra2`, K('/extra2'), 3, 1, 1, JSON.stringify({ links: T, buttons: { 'button.menu-toggle': 1 }, dupIds: { '#x': 2 } }));
  pg.run(`${W}/old1`, K('/old1'), 3, 1, 0, null); // crawled before 0.16.1
  pg.run(`${W}/old2`, K('/old2'), 3, 1, 0, null);
  const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,5)`);
  sa.run(D, 'q', `${W}/p7`, K('/p7'), 90, 900); // p7 earns the most: template findings are keyed to it
  adb.close();

  const adb2 = new AuditDatabase(dbPathFor(dir, SITE));
  const ctx = { db: adb2.db, gscMaxDate: gscFreshness(adb2.db).effectiveMax, brand: null, siteUrl: SITE };
  const run = (id) => CHECKS.find(c => c.id === id).run(ctx);
  const links = run('a11y-link-name');
  const tmpl = links.filter(f => f.evidence.scope === 'template');
  const own = links.filter(f => f.evidence.scope === 'page' && !String(f.evidence.note ?? '').startsWith('crawled before'));
  const legacy = links.filter(f => String(f.evidence.note ?? '').startsWith('crawled before'));
  check('links: 24 pages -> 2 template (header, related card) + 1 page extra + 2 legacy = 5 findings', links.length === 5 && tmpl.length === 2 && own.length === 1 && legacy.length === 2, JSON.stringify(links.map(f => [f.urlKey, f.evidence.scope])));
  check('the related card is its own template finding on its 5 pages', tmpl[1]?.evidence.pages === 5 && JSON.stringify(tmpl[1].evidence.elements) === JSON.stringify(['a[href="/related/"]']), JSON.stringify(tmpl[1]));
  check('links template finding: 22 pages, both elements, 3 nameless per page, keyed to the top page', tmpl[0].evidence.pages === 22 && tmpl[0].evidence.elementCount === 2 && tmpl[0].evidence.namelessLinks === 3 && tmpl[0].urlKey === K('/p7'), JSON.stringify(tmpl[0]));
  check('links template finding: sample pages and an element signature', tmpl[0].evidence.samplePages.length === 10 && tmpl[0].evidence.elements.includes('a.logo-link[href="/"]'), JSON.stringify(tmpl[0].evidence.elements));
  check('links page finding: /extra with its 1 unique body link', own[0].urlKey === K('/extra') && own[0].evidence.namelessLinks === 1 && JSON.stringify(own[0].evidence.elements) === JSON.stringify(['a[href="/products/widget"]']), JSON.stringify(own[0]));
  const buttons = run('a11y-button-name');
  check('buttons: 1 template finding + 2 legacy', buttons.length === 3 && buttons[0].evidence.scope === 'template' && buttons[0].evidence.pages === 22, JSON.stringify(buttons.map(f => f.evidence)));
  const dup = run('a11y-duplicate-id');
  check(`duplicate ids on fewer than ${TEMPLATE_MIN_PAGES} pages stay per page`, dup.length === 2 && dup.every(f => f.evidence.scope === 'page' && f.evidence.duplicateIds === 1), JSON.stringify(dup));
  adb2.close();

  const r = runAudit(dir, SITE, {});
  const n = (id) => r.byCheck.find(b => b.checkId === id)?.count ?? 0;
  check('run_audit byCheck: link 5, button 3 (was 24 each)', n('a11y-link-name') === 5 && n('a11y-button-name') === 3, JSON.stringify(r.byCheck.filter(b => b.checkId.startsWith('a11y'))));
  // 0.16.2: the run records the roll-up grain, so it is never diffed against per-page findings.
  const adb3 = new AuditDatabase(dbPathFor(dir, SITE));
  const ids = JSON.parse(adb3.db.prepare(`SELECT check_ids FROM audit_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`).get().check_ids);
  adb3.close();
  check('check_ids record the roll-up grain (a11y-link-name@2, a11y-button-name@2)', ids.includes('a11y-link-name@2') && ids.includes('a11y-button-name@2') && !ids.includes('a11y-link-name') && ids.includes('a11y-form-label'), JSON.stringify(ids.filter(i => i.startsWith('a11y'))));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
