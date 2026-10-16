// End-to-end crawl against a local fixture server: sitemap discovery, the crawler's DB writes
// for extractor fields, and data_storage.lastCrawl. No network beyond 127.0.0.1.
// Run: node scripts/probe-crawl-local.mjs   (after npm run build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Crawler } from '../dist/core/Crawler.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { storageSummary } from '../dist/core/dataStorage.js';
import { dbPathFor } from '../dist/core/paths.js';
import { CHECKS } from '../dist/audit/checks.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

let origin = '';
const page = (body, head = '') => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
const routes = {
  '/robots.txt': () => ['text/plain', `User-agent: *\nAllow: /\nSitemap: ${origin}/post-sitemap.xml\n`],
  '/sitemap_index.xml': () => ['application/xml', `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/post-sitemap.xml</loc></sitemap><sitemap><loc>${origin}/category-sitemap.xml</loc></sitemap></sitemapindex>`],
  '/post-sitemap.xml': () => ['application/xml', `<?xml version="1.0"?><urlset><url><loc>${origin}/post/</loc></url></urlset>`],
  '/category-sitemap.xml': () => ['application/xml', `<?xml version="1.0"?><urlset><url><loc>${origin}/category/news/</loc></url></urlset>`],
  '/': () => ['text/html', page(`<main><a href="/post/">p</a><a href="areas/">rel</a><a href="//${new URL(origin).host}/abs-proto/">pr</a></main><script src="/app.js" defer></script>`, '<meta name="description" content="Home"><link rel="stylesheet" href="/site.css">')],
  '/site.css': () => ['text/css', 'body{}'],
  '/app.js': () => ['application/javascript', '1'],
  '/post/': () => ['text/html', page(`<main><figure><img src="a.png" alt=""></figure><img src="b.png"></main>`)],
  '/category/news/': () => ['text/html', page('<p>news</p>', '<meta name="description" content="">')],
  '/areas/': () => ['text/html', page('<p>areas</p>')],
  '/abs-proto/': () => ['text/html', page('<p>x</p>')],
};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, origin).pathname;
  // Backlinked URLs that now redirect: one to a fresh page, one to a page already reached by links.
  if (pathname === '/old-review/') { res.writeHead(301, { location: `${origin}/areas/` }); return res.end(); }
  if (pathname === '/old-post/') { res.writeHead(302, { location: `${origin}/old-post-2/` }); return res.end(); }
  if (pathname === '/old-post-2/') { res.writeHead(301, { location: `${origin}/post/` }); return res.end(); }
  const r = routes[pathname];
  if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
  const [ct, body] = r();
  res.writeHead(200, { 'content-type': `${ct}; charset=utf-8` }); res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;
const site = `${origin}/`;
const dir = mkdtempSync(path.join(tmpdir(), 'sac-crawl-'));

// Backlink data pulled before the redirects were added: both stored as 404.
{
  const pre = new AuditDatabase(dbPathFor(dir, site));
  const ins = pre.db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code,fetched_at) VALUES (?,?,?,?,404,'2026-09-01 10:00:00')`);
  const key = u => urlKey(u, { hostForm: hostFormForProperty(site) }); // same keying as pull_backlinks
  ins.run(key(`${origin}/old-review/`), `${origin}/old-review/`, 9, 4);
  ins.run(key(`${origin}/old-post/`), `${origin}/old-post/`, 3, 2);
  pre.close();
}

try {
  const result = await new Crawler(dir).run(site, { maxPages: 50, delayMs: 0, maxConcurrency: 2, headResources: true }, () => {}, new AbortController().signal);
  const db = new AuditDatabase(dbPathFor(dir, site));
  const sm = db.db.prepare(`SELECT url FROM sitemap_urls`).all().map(r => r.url);
  const pages = Object.fromEntries(db.db.prepare(`SELECT url, meta_description_length mdl, images_without_alt nwa, images_empty_alt ea, images_empty_alt_content eac FROM pages`).all().map(r => [new URL(r.url).pathname, r]));
  const forms = Object.fromEntries(db.db.prepare(`SELECT target_url, href_form FROM links WHERE source_url = ?`).all(site).map(r => [new URL(r.target_url).pathname, r.href_form]));
  const res = db.db.prepare(`SELECT resource_url, type, position, is_defer FROM page_resources WHERE page_key = (SELECT url_key FROM pages WHERE url = ?)`).all(site).map(r => [new URL(r.resource_url).pathname, r.type, r.position, r.is_defer].join(':')).sort();
  const assets = db.db.prepare(`SELECT url, type, status, content_length, used_on FROM resource_assets ORDER BY url`).all().map(r => [new URL(r.url).pathname, r.type, r.status, r.used_on].join(':'));
  const redirects = db.db.prepare(`SELECT url, status, final_url FROM redirect_sources`).all().map(r => new URL(r.url).pathname).sort();
  const chain = JSON.parse(db.db.prepare(`SELECT chain FROM redirect_sources WHERE url LIKE '%/old-post/'`).get()?.chain ?? '[]').map(h => `${h.status} ${new URL(h.from).pathname}→${new URL(h.to).pathname}`);
  const b404 = CHECKS.find(c => c.id === 'backlinks-to-404').run({ db: db.db, gscMaxDate: null });
  db.close();

  // #37: subresources recorded per page; optional HEAD pass over css/js.
  check('page_resources records the home page css + deferred js', JSON.stringify(res) === '["/app.js:js:body:1","/site.css:css:head:0"]', JSON.stringify(res));
  check('headResources pass stores status per css/js asset', JSON.stringify(assets) === '["/app.js:js:200:1","/site.css:css:200:1"]', JSON.stringify(assets));

  // #32: backlinked URLs are seeded, redirect sources recorded even when the target was already crawled.
  check('redirect sources recorded (incl. one landing on an already-crawled page)', JSON.stringify(redirects) === '["/old-post/","/old-review/"]', JSON.stringify(redirects));
  check('every hop of a redirect chain is logged', JSON.stringify(chain) === '["302 /old-post/→/old-post-2/","301 /old-post-2/→/post/"]', JSON.stringify(chain));
  check('backlinks-to-404 no longer flags URLs that now 301', b404.length === 0, JSON.stringify(b404));

  // #25: robots.txt declares only post-sitemap.xml; the category sitemap is reachable only via the index.
  check('child sitemap of an undeclared sitemap_index.xml is read', sm.some(u => u.endsWith('/category/news/')), JSON.stringify(sm));
  check('declared sitemap still read', sm.some(u => u.endsWith('/post/')), JSON.stringify(sm));
  check('crawl result reports the undeclared index', result.sitemaps?.undeclared.some(u => u.endsWith('/sitemap_index.xml')), JSON.stringify(result.sitemaps));
  check('post-sitemap fetched once despite being declared and in the index', result.sitemaps?.fetched <= 5, JSON.stringify(result.sitemaps));

  // #21/#24 persisted by the crawler.
  check('missing meta description stored as NULL', pages['/post/']?.mdl === null, JSON.stringify(pages['/post/']));
  check('empty meta description stored as 0', pages['/category/news/']?.mdl === 0, JSON.stringify(pages['/category/news/']));
  check('present meta description stored as its length', pages['/']?.mdl === 4, JSON.stringify(pages['/']));
  check('empty-alt counts persisted', pages['/post/']?.nwa === 1 && pages['/post/']?.ea === 1 && pages['/post/']?.eac === 1, JSON.stringify(pages['/post/']));

  // #26 persisted by the crawler.
  check('href_form persisted per link', forms['/post/'] === 'root-relative' && forms['/areas/'] === 'relative' && forms['/abs-proto/'] === 'protocol-relative', JSON.stringify(forms));

  // #20: a completed crawl is the lastCrawl.
  const p = storageSummary(dir, site).properties[0];
  check('completed crawl reported as lastCrawl', !!p.lastCrawl && !p.latestCrawlRun, JSON.stringify({ lastCrawl: p.lastCrawl, latestCrawlRun: p.latestCrawlRun }));
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
