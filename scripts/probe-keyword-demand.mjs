#!/usr/bin/env node
// SEOCoral fork: Keyword Planner demand stored per property and joined to GSC + crawl
// (src/core/keywordDemand.ts), plus its place in the dashboard payload.
// Run:  npm run build:server && node scripts/probe-keyword-demand.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { saveKeywords, deleteKeywords, keywordDemandPayload } from '../dist/core/keywordDemand.js';
import { getDashboardData } from '../dist/core/dashboardData.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-kwd-${Date.now()}`);
const site = 'https://gestoria.test/';
const adb = new AuditDatabase(dbPathFor(dataDir, site));
adb.upsertProperty(site, 'prefix');
const db = adb.db;

ok(keywordDemandPayload(db) === null, 'no keywords saved: payload is null');

// GSC: 28 days. "gestorías en madrid" (accents + plural + stop word) is the same demand as "gestoria madrid".
const ins = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,?)`);
const home = 'https://gestoria.test/', fiscal = 'https://gestoria.test/gestoria-fiscal-madrid/';
db.transaction(() => {
  for (let t = Date.parse('2026-09-01'); t <= Date.parse('2026-09-28'); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    ins.run(d, 'gestoria madrid', home, home, 2, 40, 6);
    ins.run(d, 'gestorías en madrid', home, home, 1, 10, 8);
    ins.run(d, 'gestoría fiscal madrid', fiscal, fiscal, 0, 20, 14);
    ins.run(d, 'gestoria fiscal madrid', home, home, 0, 2, 30);
  }
})();
// Crawl: an indexable page about autónomos that does not rank yet.
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status) VALUES ('c1','https://gestoria.test','gestoria.test','completed')`).run();
const pg = db.prepare(`INSERT INTO pages (crawl_id, url_key, url, status_code, indexable, title, h1) VALUES ('c1',?,?,?,?,?,?)`);
pg.run('https://gestoria.test/gestoria-autonomos-madrid/', 'https://gestoria.test/gestoria-autonomos-madrid/', 200, 1, 'Gestoría para autónomos en Madrid', 'Gestoría de autónomos');
// The home mentions autónomos too (shorter URL): the specific service page must still win.
pg.run('https://gestoria.test/', 'https://gestoria.test/', 200, 1, 'Gestoría en Madrid para autónomos, empresas y particulares', 'Tu gestoría en Madrid');
// A page that only shares one of two distinctive words must not be suggested.
pg.run('https://gestoria.test/verifactu/', 'https://gestoria.test/verifactu/', 200, 1, 'Verifactu para empresas en Madrid', 'Verifactu');

const series = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((m, i) => ({ year: m >= 10 ? 2025 : 2026, month: m, searches: i < 9 ? 1000 : 2000 }));
const n = saveKeywords(db, [
  { keyword: 'Gestoría Madrid', searchVolume: 1600, competition: 0.4, competitionLevel: 'MEDIUM', cpc: 4, lowTopOfPageBid: 1.5, highTopOfPageBid: 6.5, monthly: series },
  { keyword: 'gestoria fiscal madrid', searchVolume: 880, competition: 0.26, competitionLevel: 'LOW', cpc: 3.05, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: [] },
  { keyword: 'gestoría autónomos madrid', searchVolume: 170, competition: 0.57, competitionLevel: 'MEDIUM', cpc: 8.27, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: [] },
  { keyword: 'asesoria empresas madrid', searchVolume: 30, competition: null, competitionLevel: null, cpc: null, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: [] },
  { keyword: 'gestoria laboral madrid', searchVolume: 110, competition: 0.75, competitionLevel: 'HIGH', cpc: 4.27, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: [] },
], { source: 'ideas', seed: 'gestoría madrid', location: 2724, language: 'es' });
ok(n === 5, `5 keywords saved (${n})`);

const p = keywordDemandPayload(db);
const row = k => p.rows.find(r => r.keyword === k);
ok(p.rows[0].keyword === 'gestoría madrid', `stored lower-cased, ordered by volume (${p.rows.map(r => r.keyword).join(', ')})`);
const g = row('gestoría madrid');
ok(g.impressions === 28 * 50 && g.clicks === 28 * 3, `accent/plural/stop-word variants of the query are summed (${g.impressions} impr, ${g.clicks} clicks)`);
ok(g.position === 6.4 && g.status === 'page1' && g.page === home, `impression-weighted position ${g.position}, ${g.status}, page ${g.page}`);
ok(g.trend === 'rising' && g.peakMonth === '2026-07', `trend ${g.trend}, peak ${g.peakMonth}`);
const f = row('gestoria fiscal madrid');
ok(f.page === fiscal && f.status === 'striking', `page picked by impressions when no clicks (${f.page}, ${f.status}, pos ${f.position})`);
const a = row('gestoría autónomos madrid');
ok(a.status === 'gap' && a.suggestedPage === 'https://gestoria.test/gestoria-autonomos-madrid/', `gap with a suggested page (${a.suggestedPage})`);
const l = row('gestoria laboral madrid');
ok(l.status === 'gap' && l.suggestedPage === null, 'gap with no fitting page: no suggestion (content to create)');
ok(row('asesoria empresas madrid').suggestedPage === null, 'one of two distinctive words is not enough for a suggestion');
ok(p.totals.volume === 2790 && p.totals.capturedVolume === 1600 && p.totals.byStatus.gap === 3, `totals ${JSON.stringify(p.totals)}`);

// Re-saving updates in place; "volume" source is not downgraded by a later ideas call.
saveKeywords(db, [{ keyword: 'gestoria laboral madrid', searchVolume: 140, competition: null, competitionLevel: null, cpc: null, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: [] }], { source: 'volume' });
saveKeywords(db, [{ keyword: 'gestoria laboral madrid', searchVolume: 140, competition: null, competitionLevel: null, cpc: null, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: [] }], { source: 'ideas' });
const l2 = keywordDemandPayload(db).rows.find(r => r.keyword === 'gestoria laboral madrid');
ok(l2.searchVolume === 140 && l2.source === 'volume', 'upsert updates the volume and keeps the explicit-volume source');

ok(deleteKeywords(db, ['GESTORIA LABORAL MADRID']) === 1 && keywordDemandPayload(db).totals.keywords === 4, 'delete one keyword (case-insensitive)');
adb.close();

// Dashboard payload carries it (both cache miss and hit).
const d1 = getDashboardData(dataDir, site);
const d2 = getDashboardData(dataDir, site);
ok(d1.keywordDemand?.totals.keywords === 4 && d2.keywordDemand?.totals.keywords === 4, 'dashboard payload includes keywordDemand (miss and cached hit)');

const adb2 = new AuditDatabase(dbPathFor(dataDir, site));
ok(deleteKeywords(adb2.db) === 4 && keywordDemandPayload(adb2.db) === null, 'delete all');
adb2.close();

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
