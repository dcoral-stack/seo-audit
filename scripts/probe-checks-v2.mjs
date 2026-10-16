// Regression test for checks changed after the 0.13.1 field test:
// article-no-author / duplicate-article-entities (#28), backlinks-to-404 (#32),
// image-empty-alt-content (#21). Run: node scripts/probe-checks-v2.mjs (after build:server)
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dbPath = path.join(tmpdir(), `sac-checks-v2-${process.pid}.db`);
rmSync(dbPath, { force: true });
const wrap = new AuditDatabase(dbPath);
const db = wrap.db;
const S = 'https://example.com';
db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','${S}','example.com','completed')`).run();
const page = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,json_ld,image_count,images_empty_alt,images_empty_alt_content) VALUES ('c1',?,?,?,?,?,?,?,?)`);
const ld = (...blocks) => JSON.stringify(blocks.map(b => JSON.stringify(b)));
const P = k => `${S}/${k}`;

// #28 fixtures
const yoast = { '@context': 'https://schema.org', '@graph': [
  { '@type': ['Article', 'BlogPosting'], '@id': `${P('dup')}#article`, headline: 'H', author: { '@id': `${S}/#/schema/person/1` } },
  { '@type': 'Person', '@id': `${S}/#/schema/person/1`, name: 'Jane Doe' },
] };
const embedded = { '@context': 'https://schema.org', '@type': 'Article', headline: 'H (theme)', author: null };
page.run(P('dup'), P('dup'), 200, 1, ld(yoast, embedded), 0, 0, 0);                                        // author via @id + 2nd Article without author
page.run(P('none'), P('none'), 200, 1, ld({ '@type': 'BlogPosting', headline: 'x' }), 0, 0, 0);            // single Article, no author
page.run(P('same-id'), P('same-id'), 200, 1, ld({ '@type': 'Article', '@id': '#a', author: 'Ann' }, { '@type': 'Article', '@id': '#a' }), 0, 0, 0); // same entity twice
page.run(P('list'), P('list'), 200, 1, ld({ '@type': 'ItemList', itemListElement: [{ '@type': 'BlogPosting' }, { '@type': 'BlogPosting' }] }), 0, 0, 0); // blog index

// #21 fixture
page.run(P('figs'), P('figs'), 200, 1, null, 5, 3, 2);

// #32 fixtures: stored pull status 404 on all three
page.run(P('new-home'), P('new-home'), 200, 1, null, 0, 0, 0);
page.run(P('still-dead'), P('still-dead'), 404, 0, null, 0, 0, 0);
db.prepare(`INSERT INTO redirect_sources (url_key,url,status,final_url,final_key,hops,crawl_id) VALUES (?,?,?,?,?,?,?)`)
  .run(P('old-review'), P('old-review'), 301, P('new-home'), P('new-home'), 1, 'c1');
const bl = db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code,fetched_at) VALUES (?,?,?,?,?,?)`);
bl.run(P('old-review'), P('old-review'), 12, 5, 404, '2026-09-01 10:00:00'); // since 301'd → not dead
bl.run(P('still-dead'), P('still-dead'), 8, 3, 404, '2026-09-01 10:00:00');  // crawl confirms 404
bl.run(P('never-crawled'), P('never-crawled'), 4, 2, 404, '2026-09-01 10:00:00'); // crawl never reached it

const ctx = { db, gscMaxDate: null };
const run = id => { const c = CHECKS.find(x => x.id === id); if (!c) throw new Error(`no check ${id}`); return c.run(ctx); };
const keys = fs => fs.map(f => f.urlKey.replace(S + '/', '')).sort().join(',');

const noAuthor = run('article-no-author');
check('article-no-author: not fired when another Article node names the author (via @id)', !keys(noAuthor).includes('dup'), keys(noAuthor));
check('article-no-author: fires for a lone authorless Article', keys(noAuthor) === 'none', keys(noAuthor));

const dup = run('duplicate-article-entities');
check('duplicate-article-entities: flags graph Article + embedded Article', keys(dup) === 'dup', keys(dup));
check('duplicate-article-entities: evidence shows which entity has the author', JSON.stringify(dup[0]?.evidence.entities.map(e => e.hasAuthor)) === '[true,false]', JSON.stringify(dup[0]?.evidence));

const empty = run('image-empty-alt-content');
check('image-empty-alt-content flags content images with empty alt', keys(empty) === 'figs' && empty[0].evidence.emptyAltInContent === 2, JSON.stringify(empty));

const b404 = run('backlinks-to-404');
check('backlinks-to-404: URL redirected in the current crawl is not reported', !keys(b404).includes('old-review'), keys(b404));
check('backlinks-to-404: crawl-confirmed 404 reported with source crawl', b404.find(f => f.urlKey.endsWith('still-dead'))?.evidence.statusSource === 'crawl', JSON.stringify(b404));
const stale = b404.find(f => f.urlKey.endsWith('never-crawled'));
check('backlinks-to-404: uncrawled URL falls back to pull status, labelled with its age', stale?.evidence.statusSource === 'backlink pull' && stale?.evidence.statusCheckedAt === '2026-09-01 10:00:00', JSON.stringify(stale));

wrap.close();
rmSync(dbPath, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
