// Regression test for triage_404s (#31) using the field report's real mangled slugs.
// Run: node scripts/probe-triage404.mjs (after build:server)
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { triage404s, slugSimilarity } from '../dist/core/triage404.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dbPath = path.join(tmpdir(), `sac-triage-${process.pid}.db`);
rmSync(dbPath, { force: true });
const wrap = new AuditDatabase(dbPath);
const db = wrap.db;
const S = 'https://simracing.example';
const P = s => `${S}/${s}/`;
db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','${S}','simracing.example','completed')`).run();
const page = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,is_internal,indexable) VALUES ('c1',?,?,?,1,?)`);
for (const s of ['assetto-corsa-race-cancelled-fix', 'best-ps5-racing-games', 'quest-3-vs-pimax-crystal-light', 'sim-racing-wheels', 'about'])
  page.run(P(s), P(s), 200, 1);
// 404s
const dead = { mangled: 'assetto-corss-race-cancelled-fix', mangled2: 'best-phosphorus-racing-games', lost: 'pimax-crystal-light-review', linked: 'old-wheels-guide', nothing: 'zzqx-unrelated' };
for (const s of Object.values(dead)) page.run(P(s), P(s), 404, 0);
const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,5)`);
sa.run('2026-09-01', 'q1', P(dead.mangled), P(dead.mangled), 0, 3);
sa.run('2026-09-02', 'q2', P(dead.mangled2), P(dead.mangled2), 0, 8);
sa.run('2026-08-01', 'pimax review', P(dead.lost), P(dead.lost), 14, 900);
db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code) VALUES (?,?,?,?,404)`).run(P(dead.lost), P(dead.lost), 22, 6);
db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1',?,?,?,?,1)`).run(P('about'), P('about'), P(dead.linked), P(dead.linked));

check('unrelated short slug stays below the bar', slugSimilarity(P('about-us-old'), P('about')) < 0.6, slugSimilarity(P('about-us-old'), P('about')));
check('typo slug scores high', slugSimilarity(P(dead.mangled), P('assetto-corsa-race-cancelled-fix')) > 0.9, slugSimilarity(P(dead.mangled), P('assetto-corsa-race-cancelled-fix')));

const rows = Object.fromEntries(triage404s(db).map(r => [r.url.replace(S + '/', '').replace(/\/$/, ''), r]));
check('lost page with traffic + backlinks → redirect to the closest live URL', rows[dead.lost]?.bucket === 'redirect' && rows[dead.lost].bestMatch === P('quest-3-vs-pimax-crystal-light'), JSON.stringify(rows[dead.lost]));
check('redirect row carries sources, clicks and referring domains', rows[dead.lost]?.sources.join(',') === 'gsc,backlink' && rows[dead.lost].clicks === 14 && rows[dead.lost].referringDomains === 6, JSON.stringify(rows[dead.lost]));
check('mangled typo variant → ignore, matched to its real slug', rows[dead.mangled]?.bucket === 'ignore' && rows[dead.mangled].bestMatch === P('assetto-corsa-race-cancelled-fix'), JSON.stringify(rows[dead.mangled]));
check('second mangled variant → ignore', rows[dead.mangled2]?.bucket === 'ignore' && rows[dead.mangled2].bestMatch === P('best-ps5-racing-games'), JSON.stringify(rows[dead.mangled2]));
check('404 still linked internally → review (fix at source)', rows[dead.linked]?.bucket === 'review' && rows[dead.linked].reason.includes('internal link'), JSON.stringify(rows[dead.linked]));
check('unrelated noise → ignore with no match', rows[dead.nothing]?.bucket === 'ignore' && rows[dead.nothing].bestMatch === null, JSON.stringify(rows[dead.nothing]));
check('sorted by value: the lost page comes first', triage404s(db)[0].url === P(dead.lost), triage404s(db)[0].url);

check('limit applies after ranking by value (the lost page survives limit:1)', triage404s(db, { limit: 1 })[0]?.url === P(dead.lost), JSON.stringify(triage404s(db, { limit: 1 }).map(r => r.url)));

wrap.close();
rmSync(dbPath, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
