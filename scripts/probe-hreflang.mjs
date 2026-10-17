// #55 group C, item 6: canonical-cross-host, hreflang-invalid-code, hreflang-missing-self,
// hreflang-duplicate-locale, hreflang-canonical-conflict, and the extended broken-hreflang-target /
// hreflang-no-return-tag. A fixture DB with each check firing and not firing, then an end-to-end crawl
// of a local server (no network beyond 127.0.0.1).
// Run: node scripts/probe-hreflang.mjs (after npm run build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { CHECKS } from '../dist/audit/checks.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';
import { hreflangCodeProblem } from '../dist/audit/checks-hreflang.js';
import { Crawler } from '../dist/core/Crawler.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const SITE = 'sc-domain:example.test';
const W = 'https://www.example.test';
const EXT = 'https://example.de';
const keyOpts = { hostForm: hostFormForProperty(SITE) };
const K = (p) => urlKey(p.startsWith('http') ? p : `${W}${p}`, keyOpts);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
const runCheck = (db, id) => CHECKS.find(c => c.id === id).run({ db, gscMaxDate: gscFreshness(db).effectiveMax, brand: null });
const paths = (fs) => fs.map(f => f.urlKey.replace(/^https?:\/\/[^/]+/, '')).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NEW_IDS = ['canonical-cross-host', 'hreflang-invalid-code', 'hreflang-missing-self', 'hreflang-duplicate-locale', 'hreflang-canonical-conflict'];

try {
  // ── 1. The code validator ─────────────────────────────────────────────────────────────────
  {
    const ok = ['en', 'en-GB', 'en-gb', 'EN-us', 'pt-BR', 'x-default', 'X-Default', 'zh-Hant', 'zh-Hant-TW', 'fr-CA'];
    const bad = ['en-uk', 'en_US', 'eng', 'es-419', 'en-EU', 'xx', 'iw', 'de-DE-1996', '', 'en-'];
    check('hreflangCodeProblem: valid values pass', ok.every(v => hreflangCodeProblem(v) === null), JSON.stringify(ok.map(v => [v, hreflangCodeProblem(v)])));
    check('hreflangCodeProblem: invalid values are named', bad.every(v => typeof hreflangCodeProblem(v) === 'string'), JSON.stringify(bad.map(v => [v, hreflangCodeProblem(v)])));
    check('hreflangCodeProblem: en-uk names GB', /GB/.test(hreflangCodeProblem('en-uk') ?? ''), hreflangCodeProblem('en-uk'));
  }

  // ── 2. Fixture DB ─────────────────────────────────────────────────────────────────────────
  const dir = tmp('sac-hreflang-');
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    adb.upsertProperty(SITE, 'apex');
    const db = adb.db;
    db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, 'example.test', 'completed', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`).run(`${W}/`);
    const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,indexable_reason,noindex,canonical_url,canonical_key,hreflang,fetch_state,ipr,inlink_count)
      VALUES ('c1',?,?,?,'text/html',1,?,?,?,?,?,?,?,1,1)`);
    const H = (pairs) => JSON.stringify(pairs.map(([lang, href]) => ({ lang, href: href.startsWith('http') ? href : `${W}${href}` })));
    const page = (p, { status = 200, noindex = 0, canonical = null, hreflang = null, fetchState = null } = {}) => {
      const ck = canonical ? K(canonical) : K(p);
      const reason = status !== 200 ? `http-${status}` : noindex ? 'noindex-meta' : ck !== K(p) ? 'canonicalised' : null;
      pg.run(`${W}${p}`, K(p), status, reason ? 0 : 1, reason, noindex, canonical ?? `${W}${p}`, ck, hreflang ? H(hreflang) : null, fetchState);
    };
    // A clean, reciprocated cluster with x-default: no check fires on it.
    page('/en', { hreflang: [['en', '/en'], ['fr', '/fr'], ['x-default', '/en']] });
    page('/fr', { hreflang: [['fr', '/fr'], ['en', '/en']] });
    // Codes (alternates on another domain are unknown to every target check, isolating the code check).
    page('/codes', { hreflang: [['en-GB', '/codes'], ['en-uk', `${EXT}/a`], ['en_US', `${EXT}/b`], ['eng', `${EXT}/c`], ['es-419', `${EXT}/d`], ['zh-Hant-TW', `${EXT}/e`], ['x-default', `${EXT}/f`], ['EN-us', `${EXT}/g`]] });
    page('/noself', { hreflang: [['de', `${EXT}/de`], ['fr', `${EXT}/fr`]] });
    page('/dup', { hreflang: [['en', '/dup'], ['en-gb', `${EXT}/x`], ['en-GB', `${EXT}/y`], ['de', `${EXT}/z`], ['de', `${EXT}/z`]] });
    // Canonical conflicts: the declaring page is canonicalised; an alternate is canonicalised.
    page('/canon-src', { canonical: `${W}/en`, hreflang: [['de', `${EXT}/cs`]] }); // no self, yet missing-self leaves it to the conflict check
    page('/alt-canon', { hreflang: [['en', '/alt-canon'], ['nl', '/nl-dup']] });
    page('/nl-dup', { canonical: `${W}/nl` });
    page('/nl', { hreflang: [['nl', '/nl']] });
    // Broken targets: 404, a redirect (redirect_sources), noindex; rate-limited and legacy 429 are unknown.
    page('/broken', { hreflang: [['en', '/broken'], ['de', '/gone'], ['es', '/moved'], ['sv', '/noidx'], ['it', '/rl'], ['pt', '/l429']] });
    page('/gone', { status: 404 });
    page('/noidx', { noindex: 1 });
    pg.run(`${W}/rl`, K('/rl'), null, null, 'rate-limited', null, null, null, null, 'rate_limited');
    page('/l429', { status: 429 });
    db.prepare(`INSERT INTO redirect_sources (url_key,url,status,final_url,final_key,hops,chain,crawl_id) VALUES (?,?,301,?,?,1,?,'c1')`)
      .run(K('/moved'), `${W}/moved`, `${W}/fr`, K('/fr'), JSON.stringify([{ from: `${W}/moved`, to: `${W}/fr`, status: 301 }]));
    // One-way annotation: /fr never lists /oneway.
    page('/oneway', { hreflang: [['en', '/oneway'], ['fr', '/fr']] });
    // Cross-host canonicals: another host and a subdomain fire; the www/apex twin, http and relative don't.
    page('/xhost', { canonical: 'https://other.test/xhost' });
    page('/xhost-eq', { canonical: 'https://other.test/xhost-eq' });
    page('/sub', { canonical: 'https://shop.example.test/sub' });
    page('/twin', { canonical: 'https://example.test/twin' });
    page('/http', { canonical: 'http://www.example.test/http' });
    page('/rel', { canonical: '/rel' });
    pg.run(`${W}/rl-xh`, K('/rl-xh'), null, null, 'rate-limited', null, 'https://other.test/rl', null, null, 'rate_limited');
    const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,0,5)`);
    for (let k = 0; k < 20; k++) sa.run(new Date(Date.parse(D) - k * 86400000).toISOString().slice(0, 10), 'q', `${W}/xhost-eq`, K('/xhost-eq'), '', '', 3, 30);
    adb.close();
  }

  // ── 3. Each check against the fixture ─────────────────────────────────────────────────────
  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    const db = adb.db;
    const got = (id) => runCheck(db, id);
    const p = (id) => paths(got(id));

    check('canonical-cross-host: other host and subdomain fire; www twin, http, relative and rate-limited do not',
      same(p('canonical-cross-host'), ['/sub', '/xhost', '/xhost-eq']), JSON.stringify(p('canonical-cross-host')));
    check('canonical-cross-host: the page with GSC equity is listed first', got('canonical-cross-host')[0]?.urlKey === K('/xhost-eq') && got('canonical-cross-host')[0].evidence.hasEquity === true);

    const inv = got('hreflang-invalid-code');
    check('hreflang-invalid-code: only /codes fires', same(paths(inv), ['/codes']), JSON.stringify(paths(inv)));
    const vals = (inv[0]?.evidence.invalid ?? []).map(x => x.value).sort();
    check('hreflang-invalid-code: en-uk, en_US, eng, es-419 named; en-GB, zh-Hant-TW, x-default, EN-us not', same(vals, ['en-uk', 'en_US', 'eng', 'es-419'].sort()), JSON.stringify(vals));

    check('hreflang-missing-self: /noself fires; a canonicalised page and complete sets do not', same(p('hreflang-missing-self'), ['/noself']), JSON.stringify(p('hreflang-missing-self')));

    const dup = got('hreflang-duplicate-locale');
    check('hreflang-duplicate-locale: /dup fires on en-gb (case-insensitive), not on de listed twice to one URL',
      same(paths(dup), ['/dup']) && same(dup[0].evidence.duplicates.map(d => d.lang), ['en-gb']), JSON.stringify(dup.map(d => d.evidence)));

    const cc = got('hreflang-canonical-conflict');
    const kinds = Object.fromEntries([...cc].sort((a, b) => a.urlKey.localeCompare(b.urlKey)).map(f => [f.urlKey.replace(/^https?:\/\/[^/]+/, ''), f.evidence.kind]));
    check('hreflang-canonical-conflict: declaring page canonicalised + alternate canonicalised', same(kinds, { '/alt-canon': 'alternate-canonicalised', '/canon-src': 'page-canonicalised' }), JSON.stringify(kinds));

    const br = got('broken-hreflang-target');
    check('broken-hreflang-target (extended): only /broken fires', same(paths(br), ['/broken']), JSON.stringify(paths(br)));
    const reasons = (br[0]?.evidence.alternates ?? []).map(a => `${a.lang}:${a.reason.split(' ')[0]}`).sort();
    check('broken-hreflang-target: 404 + redirect (new) + noindex; rate-limited and legacy 429 are unknown',
      same(reasons, ['de:http-404', 'es:redirects', 'sv:noindex']), JSON.stringify(reasons));

    check('hreflang-no-return-tag (extended): /oneway fires; canonicalised alternate and canonicalised page do not',
      same(p('hreflang-no-return-tag'), ['/oneway']), JSON.stringify(p('hreflang-no-return-tag')));

    const bad = [...NEW_IDS, 'broken-hreflang-target', 'hreflang-no-return-tag'].filter(id => { const c = CHECKS.find(x => x.id === id); return !c || !c.category || !c.labels?.length || c.certainty !== 1 || !c.title || !c.fix || CHECKS.filter(x => x.id === id).length !== 1; });
    check('registry: item 6 checks registered once, complete, deterministic', bad.length === 0, JSON.stringify(bad));
    adb.close();
  }

  // ── 4. End to end: crawl a local server, then the checks read what the crawler recorded ───────
  {
    const page = (head, links = '') => `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${links}<p>${'word '.repeat(80)}</p></body></html>`;
    let origin = '';
    const alt = (lang, p) => `<link rel="alternate" hreflang="${lang}" href="${origin}${p}">`;
    const server = http.createServer((req, res) => {
      const send = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
      const u = req.url;
      if (u === '/') return send(page(alt('en', '/') + alt('en-uk', '/uk') + alt('fr', '/fr'), ['/uk', '/fr', '/xh', '/dupe'].map(h => `<a href="${h}">${h}</a>`).join(' ')));
      if (u === '/uk') return send(page(alt('en-GB', '/uk') + alt('en', '/')));
      if (u === '/fr') return send(page(''));
      if (u === '/xh') return send(page('<link rel="canonical" href="https://elsewhere.test/xh">'));
      if (u === '/dupe') return send(page(alt('de', '/dupe') + alt('de', '/fr')));
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404</h1>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    const site = `${origin}/`;
    const dir3 = tmp('sac-hreflang-crawl-');
    try {
      await new Crawler(dir3).run(site, { maxPages: 20, delayMs: 0, checkExternal: false }, () => {}, new AbortController().signal);
      const adb = new AuditDatabase(dbPathFor(dir3, site));
      const got = (id) => JSON.stringify(paths(runCheck(adb.db, id)));
      check('crawl -> hreflang stored for /, /uk and /dupe', adb.db.prepare(`SELECT COUNT(*) n FROM pages WHERE hreflang IS NOT NULL`).get().n === 3);
      check('crawl -> hreflang-invalid-code: / (en-uk)', got('hreflang-invalid-code') === JSON.stringify(['/']), got('hreflang-invalid-code'));
      check('crawl -> hreflang-duplicate-locale: /dupe', got('hreflang-duplicate-locale') === JSON.stringify(['/dupe']), got('hreflang-duplicate-locale'));
      check('crawl -> hreflang-missing-self: none (every set lists itself)', got('hreflang-missing-self') === '[]', got('hreflang-missing-self'));
      check('crawl -> hreflang-no-return-tag: / and /dupe (/fr declares nothing)', got('hreflang-no-return-tag') === JSON.stringify(['/', '/dupe']), got('hreflang-no-return-tag'));
      check('crawl -> canonical-cross-host: /xh', got('canonical-cross-host') === JSON.stringify(['/xh']), got('canonical-cross-host'));
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
