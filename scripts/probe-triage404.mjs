// Regression test for triage_404s (#31) using the field report's real mangled slugs.
// Run: node scripts/probe-triage404.mjs (after build:server)
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { triage404s, slugSimilarity, tokenWeights, verifyLive } from '../dist/core/triage404.js';

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

// ── #40: shared suffix tokens, archive targets, live verification ───────────
{
  // Many buyers guides on the site: "buyers-guide" is a weak signal; the brand token is the strong one.
  const guides = ['syncmesh', 'moza', 'fanatec', 'simucube', 'asetek', 'thrustmaster', 'logitech'].map(b => P(`${b}-buyers-guide`));
  const liveUrls = [...guides, P('best-sim-rigs-on-the-market'), P('tag/simagic'), P('simagic-alpha-review')];
  const w = tokenWeights(liveUrls);
  const plain = slugSimilarity(P('stormforcegaming-buyers-guide'), P('syncmesh-buyers-guide'));
  const weighted = slugSimilarity(P('stormforcegaming-buyers-guide'), P('syncmesh-buyers-guide'), w);
  check('shared "buyers-guide" suffix no longer makes two different brands a confident match', plain >= 0.6 && weighted < 0.6, `plain ${plain.toFixed(2)} weighted ${weighted.toFixed(2)}`);
  check('a real typo of a rare token still scores high with weights', slugSimilarity(P('synkmesh-buyers-guide'), P('syncmesh-buyers-guide'), w) >= 0.85, '');

  for (const u of liveUrls) page.run(u, u, 200, 1);
  for (const s of ['stormforcegaming-buyers-guide', 'simagic']) page.run(P(s), P(s), s === 'simagic' ? 410 : 404, 0);
  sa.run('2026-09-10', 'stormforce', P('stormforcegaming-buyers-guide'), P('stormforcegaming-buyers-guide'), 20, 400);
  sa.run('2026-09-10', 'simagic', P('simagic'), P('simagic'), 30, 600);
  const r40 = Object.fromEntries(triage404s(db).map(r => [r.url.replace(S + '/', '').replace(/\/$/, ''), r]));
  check('stormforce 404 is not confidently matched to syncmesh', r40['stormforcegaming-buyers-guide']?.bucket !== 'redirect' || r40['stormforcegaming-buyers-guide'].bestMatch !== P('syncmesh-buyers-guide'), JSON.stringify(r40['stormforcegaming-buyers-guide']));
  check('/simagic/ → /tag/simagic/ is flagged as a weak archive target and discounted out of the redirect bucket', r40['simagic']?.weakTarget === true && r40['simagic'].bucket === 'review' && r40['simagic'].score < 0.6, JSON.stringify(r40['simagic']));

  // Live verification with an injected prober: one candidate already 301s to a live page, one is 200 now.
  const fakeProbe = async (targets) => targets.map(t => {
    if (t.url === P('stormforcegaming-buyers-guide')) return { url: t.url, status: 301, finalStatus: 200, finalUrl: P('best-sim-rigs-on-the-market'), redirectChain: [{ url: t.url, status: 301, location: P('best-sim-rigs-on-the-market') }] };
    if (t.url === P(dead.lost)) return { url: t.url, status: 200, finalStatus: 200, finalUrl: t.url, redirectChain: [] };
    return { url: t.url, status: 404, finalStatus: 404, finalUrl: t.url, redirectChain: [] };
  });
  const pre = triage404s(db);
  const { rows: verified, probed } = await verifyLive(pre, 'simracing.example', { probe: fakeProbe });
  const v = Object.fromEntries(verified.map(r => [r.url.replace(S + '/', '').replace(/\/$/, ''), r]));
  check('URL that already redirects live → already-redirected with its live destination', v['stormforcegaming-buyers-guide']?.bucket === 'already-redirected' && v['stormforcegaming-buyers-guide'].live.finalUrl === P('best-sim-rigs-on-the-market'), JSON.stringify(v['stormforcegaming-buyers-guide']));
  check('URL that answers 200 now → live-now', v[dead.lost]?.bucket === 'live-now', JSON.stringify(v[dead.lost]));
  const preSimagic = pre.find(r => r.url === P('simagic')).bucket;
  check('still-dead candidates keep their bucket; ignore bucket is never probed', v['simagic']?.bucket === preSimagic && v['simagic'].live?.status === 404 && probed > 0 && verified.filter(r => r.bucket === 'ignore').every(r => !r.live), JSON.stringify({ probed, pre: preSimagic, post: v['simagic']?.bucket }));
}

// Catch-all redirects and destination comparison (post-0.14.0 review)
{
  const catchAll = async (targets) => targets.map(t => ({ url: t.url, status: 301, finalStatus: 200, finalUrl: `${S}/`, redirectChain: [{ url: t.url, status: 301, location: `${S}/` }] }));
  const { rows: ca } = await verifyLive(triage404s(db), 'simracing.example', { probe: catchAll });
  const lost = ca.find(r => r.url === P(dead.lost));
  check('blanket 404→homepage rule: row keeps its redirect bucket, flagged catchAll', lost?.bucket === 'redirect' && lost.live?.catchAll === true && /catch-all/.test(lost.reason), JSON.stringify(lost));
  check('catch-all: nothing moves to already-redirected', !ca.some(r => r.bucket === 'already-redirected'), JSON.stringify(ca.map(r => r.bucket)));
  const toSuggested = async (targets) => targets.map(t => { const row = triage404s(db).find(r => r.url === t.url); return { url: t.url, status: 301, finalStatus: 200, finalUrl: row?.bestMatch ?? `${S}/x/`, redirectChain: [{ url: t.url, status: 301, location: row?.bestMatch }] }; });
  const { rows: ms } = await verifyLive(triage404s(db), 'simracing.example', { probe: toSuggested });
  const lost2 = ms.find(r => r.url === P(dead.lost));
  check('redirect already pointing at the suggested target → already-redirected, matchesSuggestion', lost2?.bucket === 'already-redirected' && lost2.live?.matchesSuggestion === true, JSON.stringify(lost2));
  let threw = false;
  try { await verifyLive(triage404s(db), 'simracing.example', { probe: async () => { throw new Error('boom'); } }); } catch { threw = true; }
  check('a failing prober propagates (the tool reports NOT VERIFIED rather than swallowing it)', threw, '');
}

wrap.close();
rmSync(dbPath, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
