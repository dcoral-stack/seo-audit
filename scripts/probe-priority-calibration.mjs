// Probe (0.16.1): priority calibration. Asset and accessibility findings are keyed to the page with the
// most clicks, but fixing one image or header doesn't put all of that page's clicks at stake, so they
// stake PAGE_EXPERIENCE_STAKE_SHARE of them. On the same page a high-severity CTR finding must now
// outrank them; a perf issue on a far bigger page still outranks a small page's CTR finding; and the
// set of findings is unchanged (ordering only).
// Run: node scripts/probe-priority-calibration.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { runAudit, stakeShareOf, PAGE_EXPERIENCE_STAKE_SHARE } from '../dist/audit/engine.js';
import { CHECKS } from '../dist/audit/checks.js';
import { IMAGE_ACCEPT } from '../dist/core/Crawler.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const SITE = 'sc-domain:calib.test';
const W = 'https://www.calib.test';
const K = (p) => urlKey(`${W}${p}`, { hostForm: hostFormForProperty(SITE) });
const A = (p) => `${W}${p}`;
const byId = (id) => CHECKS.find(c => c.id === id);

// ── The registry: which checks stake a share ──
const ASSET = ['render-blocking-head-resources', 'static-asset-uncached', 'image-oversized', 'image-legacy-format', 'broken-image'];
check('asset checks stake PAGE_EXPERIENCE_STAKE_SHARE', ASSET.every(id => stakeShareOf(byId(id)) === PAGE_EXPERIENCE_STAKE_SHARE), JSON.stringify(ASSET.map(id => stakeShareOf(byId(id)))));
check('accessibility checks stake the share', CHECKS.filter(c => c.category === 'accessibility').every(c => stakeShareOf(c) === PAGE_EXPERIENCE_STAKE_SHARE));
check('content/indexation/merged checks keep the full stake', ['ctr-below-expected', 'traffic-decay', 'noindex-with-traffic', 'missing-title', 'high-yield-cwv-fail', 'broken-subresource'].every(id => !byId(id) || stakeShareOf(byId(id)) === 1));

const dir = mkdtempSync(path.join(tmpdir(), 'sac-calib-'));
try {
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const adb = new AuditDatabase(dbPathFor(dir, SITE));
  adb.upsertProperty(SITE, 'apex');
  const db = adb.db;
  db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, 'calib.test', 'completed', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`).run(`${W}/`);
  const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,content_encoding,is_internal,indexable,ipr,inlink_count,title,title_length,meta_description,h1_count,a11y_links_no_name) VALUES ('c1',?,?,200,'text/html','gzip',1,1,1,1,'A fine title',12,'A fine description',1,?)`);
  pg.run(A('/top'), K('/top'), 2);   // the site's biggest page: under-clicked, heavy assets, nameless links
  pg.run(A('/small'), K('/small'), 0); // a small page that is also under-clicked
  const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,?)`);
  sa.run(D, 'big query', A('/top'), K('/top'), 4000, 400000, 3);   // CTR 1% at #3: ctr-below-expected (high)
  sa.run(D, 'small query', A('/small'), K('/small'), 2, 600, 3);    // CTR 0.3% at #3 on 600 impressions
  const pr = db.prepare(`INSERT INTO page_resources (crawl_id,page_key,resource_url,type,party,position,is_async,is_defer,is_preload,is_module) VALUES ('c1',?,?,?,'first',?,0,0,0,0)`);
  pr.run(K('/top'), A('/hero.jpg'), 'img', 'body');
  pr.run(K('/top'), A('/mid.jpg'), 'img', 'body');
  pr.run(K('/top'), A('/app.js'), 'js', 'head');      // parser-blocking head script
  const ia = db.prepare(`INSERT INTO image_assets (url,bytes,status,content_type,used_on,accept) VALUES (?,?,200,'image/jpeg',1,?)`);
  ia.run(A('/hero.jpg'), 900_000, IMAGE_ACCEPT); // image-oversized
  ia.run(A('/mid.jpg'), 100_000, IMAGE_ACCEPT);  // image-legacy-format
  db.prepare(`INSERT INTO resource_assets (url,type,status,content_length,content_type,cache_control,used_on,checked_at) VALUES (?, 'js', 200, NULL, '', 'max-age=60', 1, '2026-09-01 01:00:00')`).run(A('/app.js')); // static-asset-uncached
  adb.close();

  const r = runAudit(dir, SITE, { topLimit: 50 });
  const raw = new Database(dbPathFor(dir, SITE), { readonly: true });
  const rows = raw.prepare(`SELECT check_id, url_key, priority, effort FROM findings WHERE run_id=? ORDER BY priority DESC`).all(r.runId);
  raw.close();
  const rank = (id, page) => rows.findIndex(f => f.check_id === id && f.url_key === K(page));
  const prio = (id, page) => rows[rank(id, page)]?.priority;
  const fired = (id, page) => rank(id, page) >= 0;
  const PERF = ['image-oversized', 'image-legacy-format', 'static-asset-uncached', 'render-blocking-head-resources', 'a11y-link-name'];
  check('every finding still exists (ctr x2, four asset checks, a11y)', fired('ctr-below-expected', '/top') && fired('ctr-below-expected', '/small') && PERF.every(id => fired(id, '/top')), JSON.stringify(rows.map(f => f.check_id)));
  const ctrTop = rank('ctr-below-expected', '/top');
  check('same page: the high-severity CTR finding outranks every asset/a11y finding', PERF.every(id => rank(id, '/top') > ctrTop), JSON.stringify(rows.slice(0, 8).map(f => `${f.check_id}:${Math.round(f.priority)}`)));
  check('a genuinely big perf issue (10% of a 400k-impression page) still outranks a small page\'s CTR finding', prio('image-oversized', '/top') > prio('ctr-below-expected', '/small'), `${prio('image-oversized', '/top')} vs ${prio('ctr-below-expected', '/small')}`);
  const eff = JSON.parse(rows[rank('image-oversized', '/top')].effort);
  const effCtr = JSON.parse(rows[ctrTop].effort);
  check('the share is recorded on the finding, and T is that share of the page stake', eff.stakeShare === PAGE_EXPERIENCE_STAKE_SHARE && Math.abs(eff.expectedClicks - effCtr.expectedClicks * PAGE_EXPERIENCE_STAKE_SHARE) < 1, JSON.stringify({ eff, effCtr }));
  check('full-stake findings carry no stakeShare', effCtr.stakeShare === undefined, JSON.stringify(effCtr));
  check('run_audit top leads with the CTR finding', r.top[0]?.checkId === 'ctr-below-expected' && r.top[0]?.url === K('/top'), JSON.stringify(r.top.slice(0, 3).map(f => f.checkId)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
