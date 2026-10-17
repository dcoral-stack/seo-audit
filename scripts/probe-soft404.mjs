// #55 group D, item 8: soft-404-handling + host-variant-split. Pure verdict and phrasing cases, the
// probe plan on a fixture DB, the site probes against a simulated pair of hosts (a fetch that maps
// http/https x www/apex onto one local server, so no DNS or TLS is needed), and an end-to-end crawl
// of a local server that soft-404s. No network beyond 127.0.0.1.
// Run: node scripts/probe-soft404.mjs (after npm run build:server)
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
import { NOT_FOUND_RE, notFoundText } from '../dist/audit/checks-probes.js';
import { planSiteProbes, runSiteProbes, judgeSoft404, judgeHostVariant, MAX_SITE_PROBES } from '../dist/core/siteProbes.js';
import { Crawler } from '../dist/core/Crawler.js';
import { BOT_UA, CHROME_UA } from '../dist/core/userAgents.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
const ctxOf = (db) => ({ db, gscMaxDate: gscFreshness(db).effectiveMax, brand: null });
const chk = (id) => CHECKS.find(c => c.id === id);
const runCheck = (db, id) => chk(id).run(ctxOf(db));
const noteOf = (db, id) => chk(id).collected(ctxOf(db));
const result = (o) => ({ url: 'u', status: 200, redirectChain: [], finalUrl: 'u', finalStatus: 200, contentType: 'text/html', title: null, canonical: null, metaRobots: null, xRobotsTag: null, contentHash: null, cache: {}, ms: 1, fetchedAs: 'bot', ...o });

/** A fixture property: pages rows for the plan (home, two blog posts, a not-found page, an article about 404s). */
function fixture(site, origin) {
  const dir = tmp('sac-soft404-');
  const adb = new AuditDatabase(dbPathFor(dir, site));
  adb.upsertProperty(site, hostFormForProperty(site));
  const keyOpts = { hostForm: hostFormForProperty(site) };
  adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, ?, 'completed', '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z')`).run(`${origin}/`, new URL(origin).hostname);
  const ins =adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,inlink_count,title,h1) VALUES ('c1',?,?,200,'text/html',1,?,?,?,?)`);
  const pg = (p, { indexable = 1, inlinks = 1, title = 't', h1 = 'h' } = {}) => ins.run(`${origin}${p}`, urlKey(`${origin}${p}`, keyOpts), indexable, inlinks, title, h1);
  pg('/', { inlinks: 50 });
  pg('/blog/post-1', { inlinks: 30 });
  pg('/blog/post-2', { inlinks: 5 });
  pg('/missing-thing', { inlinks: 0, title: 'Page not found – Example', h1: 'Oops!' });
  pg('/fix-404', { inlinks: 2, title: 'How to fix 404 errors | Example', h1: 'How to fix 404 errors' });
  adb.db.prepare(`INSERT INTO probes (url, variant_type, status, verdict) VALUES (?, 'baseline', 200, NULL)`).run(`${origin}/manual`); // a probe_urls row: never touched
  return { dir, adb };
}

try {
  // ── 1. Not-found phrasing ─────────────────────────────────────────────────────────────────
  {
    const pos = ['404', 'Error 404', '404 Error', '404 - Page not found', '404 Not Found', 'Page not found', 'Oops! Page not found', 'Not Found', 'Sorry, this page can’t be found', "The page couldn't be found", 'Nothing found', 'This page doesn’t exist', 'Product not found'];
    const neg = ['How to fix 404 errors', '404 errors explained', 'Found: the best budget app', 'Page found', 'Lost and found', 'Why pages are not found by Google', 'The 404 page is a feature'];
    const badPos = pos.filter(s => !NOT_FOUND_RE.test(s));
    const badNeg = neg.filter(s => NOT_FOUND_RE.test(s));
    check('NOT_FOUND_RE: every not-found message matches', !badPos.length, JSON.stringify(badPos));
    check('NOT_FOUND_RE: articles about 404s and look-alikes do not', !badNeg.length, JSON.stringify(badNeg));
    check('notFoundText: a site-name suffix is split off; the H1 is checked too',
      notFoundText('Page Not Found | Example', null)?.field === 'title' && notFoundText('Example :: 404', 'x')?.field === 'title'
      && notFoundText('Example', 'Page not found')?.field === 'h1' && notFoundText('How to fix 404 errors - Example', 'How to fix 404 errors') === null);
  }

  // ── 2. Verdicts (pure) ────────────────────────────────────────────────────────────────────
  {
    const H = 'https://www.example.test/';
    const s4 = (o) => judgeSoft404(result(o), H).verdict;
    check('judgeSoft404: 404/410 ok (a slash redirect first is fine); 200 serves; to home; to another 200; 403 other; rate-limited/timeout unknown',
      s4({ finalStatus: 404 }) === 'ok' && s4({ redirectChain: [{ status: 301 }], finalStatus: 410 }) === 'ok'
      && s4({ finalStatus: 200 }) === 'serves-200'
      && s4({ redirectChain: [{ status: 302 }], finalUrl: H, finalStatus: 200 }) === 'redirects-to-home'
      && s4({ redirectChain: [{ status: 301 }], finalUrl: `${H}blog/`, finalStatus: 200 }) === 'redirects-to-200'
      && s4({ finalStatus: 403 }) === 'other-status'
      && s4({ rateLimited: true, status: null, finalStatus: null, error: 'rate limited' }) === 'unknown'
      && s4({ error: 'timed out', finalStatus: null }) === 'unknown');
    const E = 'https://www.example.test/blog/post-1';
    const hv = (o) => judgeHostVariant(result(o), E).verdict;
    check('judgeHostVariant: one 301/308 ok; 302 temporary; 2 hops chain; elsewhere wrong-target; 200 serves; 404 error-status; DNS failure unknown',
      hv({ redirectChain: [{ status: 301 }], finalUrl: E }) === 'ok' && hv({ redirectChain: [{ status: 308 }], finalUrl: `${E}/` }) === 'ok'
      && hv({ redirectChain: [{ status: 302 }], finalUrl: E }) === 'temporary-redirect'
      && hv({ redirectChain: [{ status: 301 }, { status: 301 }], finalUrl: E }) === 'redirect-chain'
      && hv({ redirectChain: [{ status: 301 }], finalUrl: 'https://www.example.test/' }) === 'wrong-target'
      && hv({ redirectChain: [{ status: 301 }], finalUrl: 'http://www.example.test/blog/post-1' }) === 'wrong-target'
      && hv({}) === 'serves-200' && hv({ finalStatus: 404 }) === 'error-status'
      && hv({ error: 'getaddrinfo ENOTFOUND', status: null, finalStatus: null }) === 'unknown');
  }

  // ── 3. The plan ───────────────────────────────────────────────────────────────────────────
  {
    const { adb } = fixture('sc-domain:example.test', 'https://www.example.test');
    const n = { i: 0 };
    const { plan, home } = planSiteProbes(adb.db, 'sc-domain:example.test', () => `slug${++n.i}`);
    check('plan: canonical home from the crawl (www), 5 probes, the busiest section, the most-linked deep page with scheme+host flipped',
      home === 'https://www.example.test/' && plan.length === MAX_SITE_PROBES && same(plan.map(p => p.url), [
        'https://www.example.test/slug1', 'https://www.example.test/blog/slug2', 'http://www.example.test/', 'https://example.test/', 'http://example.test/blog/post-1',
      ]), JSON.stringify(plan.map(p => p.url)));
    adb.close();
    const { adb: ip } = fixture('http://127.0.0.1:8080/', 'http://127.0.0.1:8080');
    const p2 = planSiteProbes(ip.db, 'http://127.0.0.1:8080/');
    check('plan: an IP host with a port gets only the two soft-404 probes (no host or scheme twin exists)', same(p2.plan.map(p => p.kind), ['soft404-root', 'soft404-section']) && p2.skipped.length === 3, JSON.stringify(p2));
    ip.close();
  }

  // ── 4. Site probes against simulated hosts ────────────────────────────────────────────────
  {
    let lastUa = null;
    const server = http.createServer((req, res) => {
      const orig = new URL(req.headers['x-orig-url']);
      lastUa = req.headers['user-agent'];
      const send = (status, headers = {}, body = '') => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body); };
      const page = (title) => send(200, {}, `<html><head><title>${title}</title></head><body><p>${title}</p></body></html>`);
      const p = orig.pathname;
      const known = ['/', '/blog/post-1', '/blog/post-2'];
      if (orig.hostname === 'nowww.test') return orig.protocol === 'http:' ? send(301, { location: `https://nowww.test${p}` }) : known.includes(p) ? page(p) : send(404, {}, 'nope');
      if (orig.hostname.endsWith('bad.test')) {
        // Bad: http://www 302s to https://www (temporary); http://apex 301s to https://apex, which 301s deep paths on to
        // https://www (a chain) but serves its own homepage (a split); unknown root paths serve 200; unknown /blog/ paths 302 home.
        if (orig.protocol === 'http:' && orig.hostname === 'www.bad.test') return send(302, { location: `https://www.bad.test${p}` });
        if (orig.protocol === 'http:') return send(301, { location: `https://bad.test${p}` });
        if (orig.hostname === 'bad.test') return p === '/' ? page('Home') : send(301, { location: `https://www.bad.test${p}` });
        if (known.includes(p)) return page(p);
        if (p.startsWith('/blog/')) return send(302, { location: 'https://www.bad.test/' });
        return page('Page not found');
      }
      // Good: unknown -> 404; every twin -> one 301 to https://www.good.test, keeping the path.
      if (orig.protocol === 'http:' || orig.hostname === 'good.test') return send(301, { location: `https://www.good.test${p}` });
      return known.includes(p) ? page(p) : send(404, {}, 'nope');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const fetchImpl = (url, init = {}) => { const u = new URL(url); return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...(init.headers ?? {}), 'x-orig-url': url } }); };
    const rowsOf = (db) => db.prepare(`SELECT variant_type k, verdict v, source, crawl_id FROM probes WHERE source = 'site-probe' ORDER BY id`).all();
    try {
      const bad = fixture('sc-domain:bad.test', 'https://www.bad.test');
      check('not collected before any site probe (both checks)', /not collected/.test(noteOf(bad.adb.db, 'soft-404-handling') ?? '') && /not collected/.test(noteOf(bad.adb.db, 'host-variant-split') ?? ''));
      const sum = await runSiteProbes(bad.adb.db, 'sc-domain:bad.test', { crawlId: 'c1', userAgent: BOT_UA, chromeFallback: false, delayMs: 0, fetchImpl });
      check('bad site: 5 probes stored with the site-probe marker and crawl id; verdicts per kind', sum.probed === 5 && same(rowsOf(bad.adb.db).map(r => `${r.k}:${r.v}:${r.crawl_id}`), [
        'soft404-root:serves-200:c1', 'soft404-section:redirects-to-home:c1', 'host-home-scheme:temporary-redirect:c1', 'host-home-host:serves-200:c1', 'host-deep:redirect-chain:c1',
      ]), JSON.stringify(rowsOf(bad.adb.db)));
      check('the probes went out under the crawler UA', lastUa === BOT_UA, String(lastUa));
      const s4 = runCheck(bad.adb.db, 'soft-404-handling');
      check('soft-404-handling (bad): one site-setup finding on the home key + the not-found page, not the 404 article',
        s4.length === 2 && s4[0].evidence.kind === 'site-setup' && s4[0].urlKey === urlKey('https://www.bad.test/', { hostForm: 'apex' }) && s4[0].evidence.failing === 2
        && s4[1].evidence.kind === 'not-found-text' && s4[1].urlKey.endsWith('/missing-thing') && !!s4[1].evidence.equity && !!s4[1].evidence.rule,
        JSON.stringify(s4.map(f => [f.urlKey, f.evidence.kind])));
      const hv = runCheck(bad.adb.db, 'host-variant-split');
      const hvHome = hv.find(f => f.evidence.canonicalUrl === 'https://www.bad.test/');
      const hvDeep = hv.find(f => f.evidence.verdicts === 'redirect-chain');
      check('host-variant-split (bad): one finding per page (home + deep), not one per twin; equity attached', hv.length === 2 && new Set(hv.map(f => f.urlKey)).size === 2
        && !!hvHome && !!hvDeep && hvDeep.urlKey.endsWith('/blog/post-1') && hv.every(f => f.evidence.equity), JSON.stringify(hv.map(f => [f.urlKey, f.evidence.verdicts])));
      check('host-variant-split (bad): the homepage finding lists both failing twins in its evidence and summary',
        hvHome?.evidence.failing === 2 && hvHome.evidence.probed === 2 && same(hvHome.evidence.twins.map(t => t.verdict).sort(), ['serves-200', 'temporary-redirect'])
        && /^2 of 2 variants not redirected in one 301: http:\/\/www\.bad\.test\/ \(temporary redirect\), https:\/\/bad\.test\/ \(answers 200\)$/.test(hvHome.evidence.summary),
        JSON.stringify(hvHome?.evidence));
      check('host-variant-split (bad): the deep finding reads "1 of 1"', /^1 of 1 variant not redirected in one 301: .*\(redirect chain\)$/.test(hvDeep?.evidence.summary ?? ''), hvDeep?.evidence.summary);
      check('collected() is null once probed', noteOf(bad.adb.db, 'soft-404-handling') === null && noteOf(bad.adb.db, 'host-variant-split') === null);
      // A second run replaces the site-probe rows, and never the probe_urls row.
      await runSiteProbes(bad.adb.db, 'sc-domain:bad.test', { crawlId: 'c2', userAgent: BOT_UA, preferChrome: true, delayMs: 0, fetchImpl });
      check('a re-run as Chrome (the crawl switched) sends Chrome\'s UA', lastUa === CHROME_UA, String(lastUa));
      const n = (sql) => bad.adb.db.prepare(sql).get().n;
      check('a re-run replaces the previous crawl\'s site probes; the probe_urls row stays', n(`SELECT COUNT(*) n FROM probes WHERE source='site-probe'`) === 5 && n(`SELECT COUNT(*) n FROM probes WHERE crawl_id='c1'`) === 0 && n(`SELECT COUNT(*) n FROM probes WHERE source IS NULL`) === 1);
      bad.adb.close();

      const good = fixture('sc-domain:good.test', 'https://www.good.test');
      await runSiteProbes(good.adb.db, 'sc-domain:good.test', { crawlId: 'c1', userAgent: BOT_UA, delayMs: 0, fetchImpl });
      check('good site: every probe ok', rowsOf(good.adb.db).length === 5 && rowsOf(good.adb.db).every(r => r.v === 'ok'), JSON.stringify(rowsOf(good.adb.db)));
      const g4 = runCheck(good.adb.db, 'soft-404-handling');
      check('good site: no site-setup finding (the not-found-titled page is still listed); no host-variant findings',
        same(g4.map(f => f.evidence.kind), ['not-found-text']) && runCheck(good.adb.db, 'host-variant-split').length === 0);
      good.adb.close();

      // No www DNS record: the twin is unknown, and the deep probe falls back to the scheme twin alone.
      const nowww = fixture('sc-domain:nowww.test', 'https://nowww.test');
      const noDns = (url, init) => (new URL(url).hostname.startsWith('www.') ? Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })) : fetchImpl(url, init));
      const nw = await runSiteProbes(nowww.adb.db, 'sc-domain:nowww.test', { crawlId: 'c1', delayMs: 0, fetchImpl: noDns });
      const nwRows = nowww.adb.db.prepare(`SELECT url, variant_type k, verdict v, error FROM probes WHERE source = 'site-probe' ORDER BY id`).all();
      check('twin host without DNS: unknown (ENOTFOUND named); the deep probe uses the scheme twin only; no host finding',
        nwRows.find(r => r.k === 'host-home-host')?.v === 'unknown' && /ENOTFOUND/.test(nwRows.find(r => r.k === 'host-home-host')?.error ?? '')
        && nwRows.find(r => r.k === 'host-deep')?.url === 'http://nowww.test/blog/post-1' && nwRows.find(r => r.k === 'host-deep')?.v === 'ok'
        && nw.skipped.some(x => /scheme only/.test(x)) && runCheck(nowww.adb.db, 'host-variant-split').length === 0 && noteOf(nowww.adb.db, 'host-variant-split') === null, JSON.stringify(nwRows));
      nowww.adb.close();

      // Every request fails (a twin host that doesn't resolve): unknown, never a finding, and reported as not collected.
      const dead = fixture('sc-domain:dead.test', 'https://www.dead.test');
      await runSiteProbes(dead.adb.db, 'sc-domain:dead.test', { crawlId: 'c1', delayMs: 0, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
      check('unreachable: all verdicts unknown, no site-setup or host finding, notes say no usable answer',
        rowsOf(dead.adb.db).every(r => r.v === 'unknown') && runCheck(dead.adb.db, 'host-variant-split').length === 0
        && !runCheck(dead.adb.db, 'soft-404-handling').some(f => f.evidence.kind === 'site-setup')
        && /no usable answer/.test(noteOf(dead.adb.db, 'soft-404-handling')) && /no usable answer/.test(noteOf(dead.adb.db, 'host-variant-split')));
      dead.adb.close();
      const r = runAudit(dead.dir, 'sc-domain:dead.test', {});
      check('runAudit: notCollected names both checks', ['soft-404-handling', 'host-variant-split'].every(id => (r.notCollected ?? []).some(x => x.checkId === id)), JSON.stringify(r.notCollected));
    } finally { server.close(); }
  }

  // ── 5. End to end: a crawl of a local server that soft-404s ───────────────────────────────
  {
    const probeUas = [];
    const server = http.createServer((req, res) => {
      const u = req.url;
      if (u.includes('seo-audit-probe-')) probeUas.push(req.headers['user-agent']);
      const html = (t, links = '') => `<!doctype html><html lang="en"><head><title>${t}</title></head><body><h1>${t}</h1>${links}<p>${'word '.repeat(60)}</p></body></html>`;
      if (u === '/robots.txt' || u.includes('sitemap')) { res.writeHead(404); return res.end(); }
      if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html('Home', '<a href="/guides/one">1</a><a href="/guides/two">2</a>')); }
      if (u === '/guides/one' || u === '/guides/two') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(u)); }
      if (u.startsWith('/guides/')) { res.writeHead(302, { location: '/' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('Page not found')); // the soft 404
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${server.address().port}/`;
    const dir = tmp('sac-soft404-crawl-');
    try {
      const out = await new Crawler(dir).run(site, { maxPages: 10, delayMs: 0, checkExternal: false }, () => {}, new AbortController().signal);
      check('crawl -> siteProbes summary: 2 probes (root + /guides/), host twins skipped for an IP:port', out.siteProbes?.probed === 2 && same(out.siteProbes.results.map(x => `${x.kind}:${x.verdict}`), ['soft404-root:serves-200', 'soft404-section:redirects-to-home']), JSON.stringify(out.siteProbes));
      check('crawl -> probes sent with the crawler UA', probeUas.length === 2 && probeUas.every(x => x === BOT_UA), JSON.stringify(probeUas));
      const adb = new AuditDatabase(dbPathFor(dir, site));
      const f = runCheck(adb.db, 'soft-404-handling');
      check('crawl -> soft-404-handling: the site-setup finding', f.some(x => x.evidence.kind === 'site-setup' && x.evidence.failing === 2), JSON.stringify(f.map(x => x.evidence.kind)));
      check('crawl -> host-variant-split reports not collected (no twin of an IP:port)', /not collected/.test(noteOf(adb.db, 'host-variant-split') ?? ''));
      adb.close();
      const out2 = await new Crawler(dir).run(site, { maxPages: 10, delayMs: 0, checkExternal: false, siteProbes: false }, () => {}, new AbortController().signal);
      check('siteProbes:false skips the phase', out2.siteProbes === undefined && probeUas.length === 2);
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
