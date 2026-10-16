// Regression test for probe_urls + the url-variant preset (#30), against a local server that
// mimics the field report: any capitalisation serves 200 with a lowercase canonical, a missing
// trailing slash 301s, index.php 404s. Run: node scripts/probe-probeurls.mjs (after build:server)
import http from 'node:http';
import { probeUrls, urlVariants, judgeVariants } from '../dist/core/probeUrls.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
let origin = '';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, origin);
  const p = u.pathname;
  if (p.toLowerCase() === '/sim-racing-wheels') { res.writeHead(301, { location: `${origin}/sim-racing-wheels/` }); return res.end(); }
  if (p === '/chain/') { res.writeHead(302, { location: `${origin}/chain2/` }); return res.end(); }
  if (p === '/chain2/') { res.writeHead(301, { location: `${origin}/sim-racing-wheels/` }); return res.end(); }
  if (p.toLowerCase() === '/sim-racing-wheels/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cf-cache-status': p === '/sim-racing-wheels/' ? 'HIT' : 'BYPASS' });
    return res.end(`<html><head><title>Wheels</title><link rel="canonical" href="/sim-racing-wheels/"><meta name="robots" content="index,follow"></head><body><h1>Wheels</h1><p>Same page</p></body></html>`);
  }
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>nope</h1>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}/sim-racing-wheels/`;

try {
  const [ok, chain, missing] = await probeUrls([{ url: base }, { url: `${origin}/chain/` }, { url: `${origin}/gone/` }], '127.0.0.1');
  check('200 page: title, canonical, robots, hash, cache header', ok.finalStatus === 200 && ok.title === 'Wheels' && ok.canonical === base && ok.metaRobots === 'index,follow' && !!ok.contentHash && ok.cache.cfCacheStatus === 'HIT', JSON.stringify(ok));
  check('redirect chain recorded hop by hop', chain.redirectChain.map(h => h.status).join(',') === '302,301' && chain.finalUrl === base, JSON.stringify(chain));
  check('404 reported', missing.finalStatus === 404, JSON.stringify(missing));

  const [first] = await probeUrls([{ url: `${origin}/chain/` }], '127.0.0.1', { followRedirects: false });
  check('followRedirects:false stops at the first response', first.finalStatus === 302 && first.redirectChain.length === 1, JSON.stringify(first));

  let threw = '';
  try { await probeUrls([{ url: 'https://other.example/' }], '127.0.0.1'); } catch (e) { threw = e.message; }
  check('refuses hosts other than the property', threw.includes("own host"), threw);

  const variants = urlVariants(base);
  const results = await probeUrls(variants, '127.0.0.1');
  const v = Object.fromEntries(judgeVariants(results).map(j => [j.variantType, j]));
  check('uppercase variant: 200 contained by canonical, same content, cache bypass visible', v['uppercase-path']?.verdict === 'serves-200-canonicalised' && v['uppercase-path'].detail.includes('same content') && v['uppercase-path'].detail.includes('BYPASS'), JSON.stringify(v['uppercase-path']));
  check('no-trailing-slash variant: one 301 to the baseline', v['no-trailing-slash']?.verdict === 'redirects', JSON.stringify(v['no-trailing-slash']));
  check('index.php variant: error status', v['index-php']?.verdict === 'error-status', JSON.stringify(v['index-php']));
  check('no host variant generated for an IP host', !v['www-host'] && !v['apex-host'], JSON.stringify(Object.keys(v)));
  const dom = Object.fromEntries(urlVariants('https://www.example.com/Path/').map(x => [x.variantType, x.url]));
  check('domain host gets scheme and apex variants', dom['http-scheme'] === 'http://www.example.com/Path/' && dom['apex-host'] === 'https://example.com/Path/', JSON.stringify(dom));
} finally { server.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
