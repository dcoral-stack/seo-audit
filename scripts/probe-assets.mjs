// #55 group C, item 7: broken-subresource, render-blocking-head-resources, static-asset-uncached,
// image-oversized, image-legacy-format, broken-image, and the "not collected" notes. A fixture DB with
// each check firing and not firing, then an end-to-end crawl of a local server (headResources:true; no
// network beyond 127.0.0.1) that checks the crawler's stored rows reach the checks.
// Run: node scripts/probe-assets.mjs (after npm run build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';
import { cacheLifetime } from '../dist/audit/checks-assets.js';
import { Crawler, IMAGE_ACCEPT } from '../dist/core/Crawler.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const SITE = 'sc-domain:example.test';
const W = 'https://www.example.test';
const keyOpts = { hostForm: hostFormForProperty(SITE) };
const K = (p) => urlKey(p.startsWith('http') ? p : `${W}${p}`, keyOpts);
const A = (p) => (p.startsWith('http') ? p : `${W}${p}`);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
const ctxOf = (db) => ({ db, gscMaxDate: gscFreshness(db).effectiveMax, brand: null });
const chk = (id) => CHECKS.find(c => c.id === id);
const runCheck = (db, id) => chk(id).run(ctxOf(db));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tail = (u) => String(u).replace(/^https?:\/\/[^/]+/, '');
const IDS = ['broken-subresource', 'render-blocking-head-resources', 'static-asset-uncached', 'image-oversized', 'image-legacy-format', 'broken-image'];

try {
  // ── 1. Cache-Control parsing ──────────────────────────────────────────────────────────────
  {
    check('cacheLifetime: max-age read, s-maxage ignored, no-store/no-cache are 0, missing is null',
      cacheLifetime('public, max-age=31536000, immutable').seconds === 31536000 && cacheLifetime('s-maxage=999').seconds === null
      && cacheLifetime('no-cache, max-age=600').seconds === 0 && cacheLifetime('no-store').seconds === 0 && cacheLifetime(null).seconds === null
      && cacheLifetime('Max-Age="120"').seconds === 120);
  }

  // ── 2. Fixture DB ─────────────────────────────────────────────────────────────────────────
  const dir = tmp('sac-assets-');
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    adb.upsertProperty(SITE, 'apex');
    const db = adb.db;
    db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, 'example.test', 'completed', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`).run(`${W}/`);
    const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,ipr,inlink_count) VALUES ('c1',?,?,?,?,1,1,1,1)`);
    for (const p of ['/a', '/b', '/c', '/d', '/e']) pg.run(A(p), K(p), 200, 'text/html');
    pg.run(A('/feed'), K('/feed'), 200, 'application/rss+xml'); // not HTML: never judged for render-blocking
    const pr = db.prepare(`INSERT INTO page_resources (crawl_id,page_key,resource_url,type,party,position,is_async,is_defer,is_preload,is_module,media) VALUES ('c1',?,?,?,?,?,?,?,?,?,?)`);
    const res = (page, url, type, { party = 'first', position = 'head', async = 0, defer = 0, preload = 0, module = 0, media = null } = {}) =>
      pr.run(K(page), A(url), type, party, position, async, defer, preload, module, media);
    // /a and /b: the same template, one sync head script + one stylesheet -> one rolled-up finding.
    for (const p of ['/a', '/b']) { res(p, '/app.js', 'js'); res(p, '/broken.css', 'css'); res(p, '/ok.css', 'css', { position: 'body' }); }
    // /c: nothing blocking enough: defer, module, preload hint, body script, 2 blocking sheets + a print sheet.
    res('/c', '/d.js', 'js', { defer: 1 }); res('/c', '/m.js', 'js', { module: 1 }); res('/c', '/p.js', 'js', { preload: 1 });
    res('/c', '/body.js', 'js', { position: 'body' }); res('/c', '/s1.css', 'css'); res('/c', '/s2.css', 'css', { media: 'all' }); res('/c', '/print.css', 'css', { media: 'print' });
    // /d: three render-blocking stylesheets (none, screen, all) -> fires on the stylesheet threshold.
    res('/d', '/s1.css', 'css'); res('/d', '/s2.css', 'css', { media: 'screen' }); res('/d', '/s3.css', 'css', { media: 'all' });
    res('/feed', '/app.js', 'js');
    // Cache fixtures (all loaded by /e).
    for (const u of ['/short.js', '/none.css', '/nocache.js', '/day.css', '/smax.css', '/forever.css', '/rl.js', '/l503.js']) res('/e', u, u.endsWith('.js') ? 'js' : 'css', { position: 'body' });
    res('/e', 'https://thirdparty.test/lib.js', 'js', { party: 'third', position: 'body' });
    res('/e', '/font.woff2', 'font', { position: 'body' });
    for (const u of ['/big.jpg', '/mid.jpg', '/broken.jpg']) res('/e', u, 'img', { position: 'body' });
    res('/b', '/broken.jpg', 'img', { position: 'body' });
    const ra = db.prepare(`INSERT INTO resource_assets (url,type,status,content_length,content_type,cache_control,used_on,checked_at) VALUES (?,?,?,NULL,'',?,?,'2026-09-01 01:00:00')`);
    ra.run(A('/broken.css'), 'css', 404, null, 2);
    ra.run(A('/ok.css'), 'css', 200, 'public, max-age=31536000, immutable', 2);
    ra.run(A('/app.js'), 'js', 200, 'max-age=604800', 3);
    ra.run(A('/rl.js'), 'js', 0, null, 1);       // probe failed / rate-limited: unknown
    ra.run(A('/l503.js'), 'js', 503, null, 1);   // unknown, not broken
    ra.run(A('/short.js'), 'js', 200, 'public, max-age=3600', 1);
    ra.run(A('/none.css'), 'css', 200, null, 1);
    ra.run(A('/nocache.js'), 'js', 200, 'no-cache', 1);
    ra.run(A('/day.css'), 'css', 200, 'max-age=86400', 1);
    ra.run(A('/smax.css'), 'css', 200, 's-maxage=999999', 1);
    ra.run(A('/forever.css'), 'css', 200, 'max-age=31536000', 1);
    ra.run('https://thirdparty.test/lib.js', 'js', 200, 'max-age=60', 1); // third party: not the site's to change
    ra.run(A('/font.woff2'), 'font', 200, 'max-age=60', 1);
    const ia = db.prepare(`INSERT INTO image_assets (url,bytes,status,content_type,used_on,accept) VALUES (?,?,?,?,?,?)`);
    const acc = IMAGE_ACCEPT;
    ia.run(A('/big.jpg'), 400000, 200, 'image/jpeg', 1, acc);
    ia.run(A('/big.webp'), 500000, 200, 'image/webp', 1, acc);
    ia.run(A('/edge.jpg'), 300000, 200, 'image/jpeg', 1, acc);   // exactly 300,000: legacy's, not oversized
    ia.run(A('/mid.jpg'), 100000, 200, 'image/jpeg', 1, acc);
    ia.run(A('/small.png'), 20000, 200, 'image/png', 1, acc);
    ia.run(A('/mid.webp'), 100000, 200, 'image/webp', 1, acc);
    ia.run(A('/nolen.jpg'), null, 200, 'image/jpeg', 1, acc);    // no Content-Length: unknown size
    ia.run(A('/broken.jpg'), null, 404, 'text/html', 2, acc);
    ia.run(A('/html.jpg'), 5000, 200, 'text/html', 1, acc);
    ia.run(A('/rl.jpg'), null, 0, '', 1, acc);
    ia.run(A('/l429.jpg'), null, 429, '', 1, acc);
    ia.run(A('/old.jpg'), 900000, 200, 'image/jpeg', 1, null);     // sampled without a browser Accept: not judged
    // GSC: /b earns the clicks, so findings on files both /a and /b load are keyed to /b.
    const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,0,5)`);
    for (let k = 0; k < 10; k++) sa.run(new Date(Date.parse(D) - k * 86400000).toISOString().slice(0, 10), 'q', A('/b'), K('/b'), '', '', 2, 20);
    adb.close();
  }

  // ── 3. Each check against the fixture ─────────────────────────────────────────────────────
  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    const db = adb.db;
    const got = (id) => runCheck(db, id);

    const bs = got('broken-subresource');
    check('broken-subresource: /broken.css (404) only; status 0 and 503 are unknown', same(bs.map(f => tail(f.evidence.asset)), ['/broken.css']), JSON.stringify(bs.map(f => f.evidence)));
    check('broken-subresource: keyed to the loading page with the most clicks, with the pages listed', bs[0]?.urlKey === K('/b') && bs[0].evidence.pagesLoadingIt === 2, JSON.stringify(bs[0]));

    const rb = got('render-blocking-head-resources');
    const rbPages = rb.map(f => f.evidence.samplePages.map(tail).sort());
    check('render-blocking: /a+/b rolled up (1 sync script), /d (3 sheets); /c (defer/module/preload/body/print, 2 sheets) and non-HTML not',
      same(rbPages, [['/a', '/b'], ['/d']]), JSON.stringify(rb.map(f => f.evidence)));
    check('render-blocking: counts and the keyed page', rb[0].evidence.syncHeadScriptCount === 1 && rb[0].evidence.blockingStylesheetCount === 1 && rb[0].urlKey === K('/b') && rb[1].evidence.blockingStylesheetCount === 3);

    const su = got('static-asset-uncached').map(f => `${tail(f.evidence.asset)}:${f.evidence.why}`).sort();
    check('static-asset-uncached: short max-age, none, no-cache, s-maxage only, short font; not >=1 day, third party or unknown',
      same(su, ['/font.woff2:max-age=60', '/nocache.js:no-cache (revalidated on every use)', '/none.css:no Cache-Control header', '/short.js:max-age=3600', '/smax.css:Cache-Control has no max-age']), JSON.stringify(su));

    const ov = got('image-oversized').map(f => tail(f.evidence.image));
    check('image-oversized: > 300,000 bytes of any format; not the boundary, not an old no-Accept row', same(ov.sort(), ['/big.jpg', '/big.webp']), JSON.stringify(ov));
    const lf = got('image-legacy-format').map(f => tail(f.evidence.image));
    check('image-legacy-format: JPEG 32 KiB-300 KB (incl. the 300,000 boundary); not small, not WebP, not oversized, not unknown size', same(lf.sort(), ['/edge.jpg', '/mid.jpg']), JSON.stringify(lf));
    const bi = got('broken-image').map(f => `${tail(f.evidence.image)}:${f.evidence.kind}`).sort();
    check('broken-image: 404 and HTML-served-as-image; status 0 and 429 are unknown', same(bi, ['/broken.jpg:http-error', '/html.jpg:not-an-image']), JSON.stringify(bi));

    const notes = IDS.map(id => chk(id).collected?.(ctxOf(db)) ?? null);
    check('collected(): every asset check reports its data as collected on the full fixture', notes.every(n => n === null), JSON.stringify(notes));
    const bad = IDS.filter(id => { const c = chk(id); return !c || !c.category || !c.labels?.length || c.certainty !== 1 || !c.title || !c.fix || !c.collected || CHECKS.filter(x => x.id === id).length !== 1; });
    check('registry: the six asset checks registered once, complete, deterministic, with collected()', bad.length === 0, JSON.stringify(bad));
    adb.close();
  }

  // ── 4. Not collected: empty tables say so, and runAudit surfaces it ─────────────────────────
  {
    const dir2 = tmp('sac-assets-empty-');
    const adb = new AuditDatabase(dbPathFor(dir2, SITE));
    adb.upsertProperty(SITE, 'apex');
    adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, 'example.test', 'completed', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`).run(`${W}/`);
    adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable) VALUES ('c1',?,?,200,'text/html',1,1)`).run(A('/'), K('/'));
    adb.db.prepare(`INSERT INTO image_assets (url,bytes,status,content_type,used_on,accept) VALUES (?,900000,200,'image/jpeg',1,NULL)`).run(A('/old.jpg'));
    const note = (id) => chk(id).collected(ctxOf(adb.db)) ?? '';
    check('not collected: page_resources empty (pre-0.15 crawl)', /page_resources is empty/.test(note('render-blocking-head-resources')), note('render-blocking-head-resources'));
    check('not collected: resource_assets empty names headResources:true', /headResources:true/.test(note('broken-subresource')) && /headResources:true/.test(note('static-asset-uncached')));
    check('not collected: image weights probed without a browser Accept', /Accept/.test(note('image-oversized')) && /Accept/.test(note('image-legacy-format')) && runCheck(adb.db, 'image-oversized').length === 0);
    check('collected: broken-image reads old rows (status needs no Accept)', note('broken-image') === '');
    adb.close();
    const r = runAudit(dir2, SITE, {});
    const ids = (r.notCollected ?? []).map(n => n.checkId).filter(id => IDS.includes(id)).sort(); // this probe's checks only (others report their own)
    check('runAudit: notCollected lists the five checks', same(ids, ['broken-subresource', 'image-legacy-format', 'image-oversized', 'render-blocking-head-resources', 'static-asset-uncached']), JSON.stringify(ids));
  }

  // ── 5. End to end: crawl a local server with headResources:true ───────────────────────────────
  {
    const big = Buffer.alloc(400000, 1), mid = Buffer.alloc(100000, 1), small = Buffer.alloc(50000, 1);
    let imgAccept = null;
    const server = http.createServer((req, res) => {
      const u = req.url;
      const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'content-length': body.length, ...headers }); res.end(body); };
      if (u === '/') return send(200, 'text/html', Buffer.from(`<!doctype html><html lang="en"><head><title>t</title>
        <script src="/sync.js"></script><script src="/deferred.js" defer></script><link rel="stylesheet" href="/missing.css"></head>
        <body><img src="/big.jpg" alt="a"><img src="/neg.jpg" alt="b"><img src="/mid.png" alt="c"><img src="/gone.png" alt="d"><img src="/fake.jpg" alt="e">
        <p>${'word '.repeat(80)}</p></body></html>`));
      if (u === '/sync.js') return send(200, 'application/javascript', Buffer.from('1'));
      if (u === '/deferred.js') return send(200, 'application/javascript', Buffer.from('1'), { 'cache-control': 'public, max-age=31536000' });
      if (u === '/big.jpg') return send(200, 'image/jpeg', big);
      if (u === '/mid.png') return send(200, 'image/png', mid);
      if (u === '/neg.jpg') { // a negotiating CDN: WebP for a browser Accept, a 400 KB JPEG otherwise
        imgAccept = req.headers.accept ?? null;
        return /image\/webp/.test(req.headers.accept ?? '') ? send(200, 'image/webp', small) : send(200, 'image/jpeg', big);
      }
      if (u === '/fake.jpg') return send(200, 'text/html', Buffer.from('<html><body>home</body></html>'));
      send(404, 'text/html', Buffer.from('<h1>404</h1>'));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${server.address().port}/`;
    const dir3 = tmp('sac-assets-crawl-');
    try {
      await new Crawler(dir3).run(site, { maxPages: 10, delayMs: 0, checkExternal: false, headResources: true }, () => {}, new AbortController().signal);
      const adb = new AuditDatabase(dbPathFor(dir3, site));
      const db = adb.db;
      const n = (sql) => db.prepare(sql).get().n;
      check('crawl -> page_resources, resource_assets and image_assets populated', n(`SELECT COUNT(*) n FROM page_resources`) >= 8 && n(`SELECT COUNT(*) n FROM resource_assets`) === 3 && n(`SELECT COUNT(*) n FROM image_assets WHERE accept IS NOT NULL`) === 5,
        JSON.stringify([n(`SELECT COUNT(*) n FROM page_resources`), n(`SELECT COUNT(*) n FROM resource_assets`), n(`SELECT COUNT(*) n FROM image_assets WHERE accept IS NOT NULL`)]));
      check('crawl -> the image probe sent a browser Accept', imgAccept === IMAGE_ACCEPT, String(imgAccept));
      const t = (id, f) => runCheck(db, id).map(f).sort();
      check('crawl -> broken-subresource: /missing.css', same(t('broken-subresource', x => tail(x.evidence.asset)), ['/missing.css']));
      check('crawl -> render-blocking-head-resources: / (sync /sync.js; the deferred script is not counted)', same(t('render-blocking-head-resources', x => `${tail(x.urlKey)}:${x.evidence.syncHeadScripts.map(tail)}`), ['/:/sync.js']));
      check('crawl -> static-asset-uncached: /sync.js (no Cache-Control); /deferred.js (1 year) not', same(t('static-asset-uncached', x => tail(x.evidence.asset)), ['/sync.js']));
      check('crawl -> image-oversized: /big.jpg, not the negotiated /neg.jpg', same(t('image-oversized', x => tail(x.evidence.image)), ['/big.jpg']), JSON.stringify(t('image-oversized', x => tail(x.evidence.image))));
      check('crawl -> image-legacy-format: /mid.png', same(t('image-legacy-format', x => tail(x.evidence.image)), ['/mid.png']));
      check('crawl -> broken-image: /gone.png (404) and /fake.jpg (HTML)', same(t('broken-image', x => tail(x.evidence.image)), ['/fake.jpg', '/gone.png']));
      adb.close();
    } finally { server.close(); }
  }
} catch (e) {
  fail++;
  console.log(`FAIL  probe threw :: ${e?.stack ?? e}`);
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { console.log(`  (cleanup: ${e.code} on ${d})`); } }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
