#!/usr/bin/env node
// Issue #61 regression: a GSC day stored in more than one row shape (all-country "lite" rows AND
// per-country / per-device rows) is counted ONCE by every reader - the dashboard KPIs, a movement
// list, an audit period comparison and query_data - via the gsc_rows views (src/core/gscRows.ts).
// Since #65 that mixed layout only exists in databases written before it (the guard refuses segment
// rows in search_analytics), so the fixtures build it explicitly; section 4 then migrates one and
// checks every reader gives the same answer. The #65 storage regression is probe-gsc-storage.mjs.
// Run:  npm run build:server && node scripts/probe-gsc-rows.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { runSingleCheck } from '../dist/audit/engine.js';
import { runQueryData } from '../dist/core/queryData.js';
import { dbPathFor } from '../dist/core/paths.js';
import { migrateGscStorage } from '../dist/core/gscMigrate.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-gscrows-${Date.now()}`);
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const days = (from, to) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) out.push(iso(t)); return out; };

function property(name) {
  const site = `sc-domain:${name}.test`;
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  // The #64 layout: no guard, layout undetected, so mixed shapes can be written and the next open sees them.
  adb.db.exec(`DROP TRIGGER IF EXISTS sa_totals_only; DROP TRIGGER IF EXISTS sa_totals_only_upd; DELETE FROM gsc_storage_state;`);
  return { site, adb, db: adb.db, file: dbPathFor(dataDir, site) };
}
const insert = (db) => db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
/** One (query, page) on one day in every requested shape; each shape alone sums to (clicks, impr). */
function day(ins, d, q, url, clicks, impr, shapes) {
  if (shapes.includes('lite')) ins.run(d, q, url, url, '', '', clicks, impr, clicks / impr, 4);
  if (shapes.includes('country')) {
    const a = Math.round(clicks * 0.6);
    ins.run(d, q, url, url, '', 'gbr', a, impr / 2, 0, 4);
    ins.run(d, q, url, url, '', 'usa', clicks - a, impr / 2, 0, 4);
  }
  if (shapes.includes('device')) {
    const a = Math.round(clicks * 0.7);
    ins.run(d, q, url, url, 'MOBILE', '', a, impr / 2, 0, 4);
    ins.run(d, q, url, url, 'DESKTOP', '', clicks - a, impr / 2, 0, 4);
  }
}

// ── 1. Overlapping shapes: the SRC case, plus device rows ──────────────────────────────────────
// History 2026-07-01 .. 2026-09-30. The current 28-day window (09-03 .. 09-30) holds lite rows
// only; everything before it holds lite AND per-country rows, and July also per-device rows.
// /a is flat (10/day), /b really declines (20/day -> 8/day), /c is flat (10/day) - so a doubled
// prior window would make /c look like a page losing half its clicks.
{
  const { site, adb, db, file } = property('overlap');
  const ins = insert(db);
  db.transaction(() => {
    for (const d of days('2026-07-01', '2026-09-30')) {
      const shapes = d >= '2026-09-03' ? ['lite'] : d < '2026-08-01' ? ['lite', 'country', 'device'] : ['lite', 'country'];
      day(ins, d, 'acme widgets', 'https://x.test/a', 10, 100, shapes);
      day(ins, d, 'blue widgets', 'https://x.test/b', d >= '2026-09-03' ? 8 : 20, 200, shapes);
      day(ins, d, 'red widgets', 'https://x.test/c', 10, 100, shapes);
    }
  })();
  adb.close();

  const d = getDashboardData(dataDir, site);
  ok(d.gscShape?.mixedDays === 64 && d.gscShape.from === '2026-07-01' && d.gscShape.to === '2026-09-02', `gscShape: 64 mixed days, 1 Jul to 2 Sep (${JSON.stringify(d.gscShape)})`);
  // KPIs: current 28d = 28 x (10 + 8 + 10) = 784; prior 28d (08-06 .. 09-02) = 28 x (10 + 20 + 10) = 1120, once.
  ok(d.summary.current.clicks === 784, `KPI: current 28-day clicks 784 (${d.summary.current.clicks})`);
  ok(d.summary.prior.clicks === 1120, `KPI: prior 28-day clicks counted once, 1120 not 2240 (${d.summary.prior.clicks})`);
  ok(d.summary.prior.impressions === 28 * 400, `KPI: prior impressions counted once (${d.summary.prior.impressions})`);
  ok(d.clickWindows.prior === d.summary.prior.clicks, 'Summary clickWindows and the KPI totals agree');
  const jul = d.monthly.months.find(m => m.month === '2026-07');
  ok(jul.clicks === 31 * 40 && jul.impressions === 31 * 400, `monthly: July (three shapes per day) counted once (${jul.clicks} / ${jul.impressions})`);
  // Movement: /c is flat, so it is in no losing list; /b is the real loser.
  const decay = Object.fromEntries((d.contentDecay ?? []).map(r => [r.urlKey, r]));
  ok(!decay['https://x.test/c'], 'content decay: flat /c is not reported as decaying');
  ok(decay['https://x.test/b']?.prevClicks === 560 && decay['https://x.test/b']?.clicks === 224, `content decay: /b 560 -> 224 (${JSON.stringify(decay['https://x.test/b'])})`);
  const perf = Object.fromEntries(d.pagePerformance.map(r => [r.urlKey, r]));
  ok(perf['https://x.test/c']?.prevClicks === 280 && perf['https://x.test/c']?.clicksChangePct === 0, `page performance: /c 280 -> 280, 0% (${JSON.stringify(perf['https://x.test/c'])})`);
  ok(d.pageMovers.losing.length === 1 && d.pageMovers.losing[0].urlKey === 'https://x.test/b' && d.pageMovers.losing[0].change === -336, `page movers: /b is the only loser, -336 (${JSON.stringify(d.pageMovers.losing)})`);
  // Segment breakdowns read the per-segment rows on purpose, once each (the current window holds
  // lite rows only, so the dashboard's country and device breakdowns are empty, never filled from them).
  ok(d.countryBreakdown.length === 0 && d.deviceBreakdown.length === 0, 'breakdowns: no per-country / per-device rows in the window, none invented from lite rows');
  {
    const r = new Database(file, { readonly: true });
    const seg = (v) => r.prepare(`SELECT SUM(clicks) c, SUM(country = '') blankC, SUM(device = '') blankD FROM ${v} WHERE date = '2026-07-15'`).get();
    const c = seg('gsc_country_rows'), dv = seg('gsc_device_rows');
    r.close();
    ok(c.c === 40 && c.blankC === 0 && dv.c === 40 && dv.blankD === 0, `segment views on a three-shape day: country rows sum 40, device rows sum 40 (${c.c} / ${dv.c})`);
  }

  // Audit period comparison: traffic-decay (title "Page losing clicks").
  const decayCheck = runSingleCheck(dataDir, site, 'traffic-decay');
  const flagged = decayCheck.findings.map(f => f.urlKey);
  ok(flagged.includes('https://x.test/b') && !flagged.includes('https://x.test/c') && !flagged.includes('https://x.test/a'), `traffic-decay: only /b (${flagged.join(', ')})`);

  // query_data aggregate over search_analytics.
  const all = runQueryData(file, { table: 'search_analytics', metrics: [{ fn: 'sum', column: 'clicks' }] });
  const expected = days('2026-07-01', '2026-09-02').length * 40 + 28 * 28;
  ok(all.structured.source === 'gsc_rows' && all.structured.groups[0].sum_clicks === expected, `query_data: total clicks counted once, ${expected} (${all.structured.groups[0].sum_clicks})`);
  const byDate = runQueryData(file, { table: 'search_analytics', groupBy: ['date'], metrics: [{ fn: 'sum', column: 'clicks' }], filters: [{ column: 'date', op: 'eq', value: '2026-07-15' }] });
  ok(byDate.structured.groups[0].sum_clicks === 40, `query_data: a three-shape day sums to 40 (${byDate.structured.groups[0].sum_clicks})`);
  const byCountry = runQueryData(file, { table: 'search_analytics', groupBy: ['country'], metrics: [{ fn: 'sum', column: 'clicks' }], filters: [{ column: 'date', op: 'eq', value: '2026-07-15' }] });
  const cSum = byCountry.structured.groups.reduce((s, g) => s + g.sum_clicks, 0);
  ok(byCountry.structured.source === 'gsc_country_rows' && !byCountry.structured.groups.some(g => g.country === '') && cSum === 40, `query_data by country: country rows only, sums to 40 (${JSON.stringify(byCountry.structured.groups)})`);
  const byDevice = runQueryData(file, { table: 'search_analytics', groupBy: ['device'], metrics: [{ fn: 'sum', column: 'clicks' }], filters: [{ column: 'date', op: 'eq', value: '2026-07-15' }] });
  ok(byDevice.structured.source === 'gsc_device_rows' && byDevice.structured.groups.reduce((s, g) => s + g.sum_clicks, 0) === 40, 'query_data by device: device rows only, sums to 40');

  // Freshness: rows added after the choice was made are picked up on the next writable open.
  const w = new Database(file);
  insert(w).run('2026-09-10', 'acme widgets', 'https://x.test/a', 'https://x.test/a', '', 'gbr', 10, 100, 0.1, 4);
  w.close();
  const re = new AuditDatabase(file);
  const n = re.db.prepare(`SELECT COUNT(*) n FROM gsc_day_shape`).get().n;
  const sep10 = re.db.prepare(`SELECT SUM(clicks) c FROM gsc_rows WHERE date = '2026-09-10'`).get().c;
  re.close();
  ok(n === 65 && sep10 === 28, `a newly mixed day is picked up on the next open (${n} mixed days; 10 Sep = ${sep10})`);
}

// ── 2. Which shape a mixed day reads: the fuller one ───────────────────────────────────────────
// Day 1: lite rows hold only the clicked rows (impressions short) -> per-country rows are read.
// Day 2: the per-country rows are a partial day -> lite rows are read. Day 3: identical -> lite.
{
  const { adb, db } = property('choice');
  const ins = insert(db);
  db.transaction(() => {
    ins.run('2026-06-01', 'q1', 'https://x.test/p', 'https://x.test/p', '', '', 5, 50, 0.1, 3);
    ins.run('2026-06-01', 'q1', 'https://x.test/p', 'https://x.test/p', '', 'gbr', 5, 50, 0.1, 3);
    ins.run('2026-06-01', 'q2', 'https://x.test/p', 'https://x.test/p', '', 'gbr', 0, 400, 0, 9);  // zero-click row the lite set dropped
    ins.run('2026-06-02', 'q1', 'https://x.test/p', 'https://x.test/p', '', '', 90, 900, 0.1, 3);
    ins.run('2026-06-02', 'q1', 'https://x.test/p', 'https://x.test/p', '', 'gbr', 14, 130, 0.1, 3); // sync stopped part-way
    ins.run('2026-06-03', 'q1', 'https://x.test/p', 'https://x.test/p', '', '', 7, 70, 0.1, 3);
    ins.run('2026-06-03', 'q1', 'https://x.test/p', 'https://x.test/p', '', 'gbr', 7, 70, 0.1, 3);
    // Day 4: per-country rows AND per-device-and-country rows -> the country breakdown reads one of them.
    ins.run('2026-06-04', 'q1', 'https://x.test/p', 'https://x.test/p', '', 'gbr', 6, 60, 0.1, 3);
    ins.run('2026-06-04', 'q1', 'https://x.test/p', 'https://x.test/p', 'MOBILE', 'gbr', 4, 40, 0.1, 3);
    ins.run('2026-06-04', 'q1', 'https://x.test/p', 'https://x.test/p', 'DESKTOP', 'gbr', 2, 20, 0.1, 3);
  })();
  adb.close();
  const a = new AuditDatabase(dbPathFor(dataDir, 'sc-domain:choice.test'));
  const pick = Object.fromEntries(a.db.prepare(`SELECT date, total_shape s FROM gsc_day_shape`).all().map(r => [r.date, r.s]));
  const tot = Object.fromEntries(a.db.prepare(`SELECT date, SUM(clicks) c, SUM(impressions) i FROM gsc_rows GROUP BY date`).all().map(r => [r.date, [r.c, r.i]]));
  const gbr4 = a.db.prepare(`SELECT SUM(clicks) c FROM gsc_country_rows WHERE date = '2026-06-04' AND country = 'gbr'`).get().c;
  const dev4 = a.db.prepare(`SELECT SUM(clicks) c FROM gsc_device_rows WHERE date = '2026-06-04'`).get().c;
  a.close();
  ok(tot['2026-06-04'].join() === '6,60' && gbr4 === 6 && dev4 === 6, `country-only + device x country day: totals, country and device views each count it once (${tot['2026-06-04']}, gbr ${gbr4}, devices ${dev4})`);
  ok(pick['2026-06-01'] === 1 && tot['2026-06-01'].join() === '5,450', `short lite impressions: per-country rows read (${tot['2026-06-01']})`);
  ok(pick['2026-06-02'] === 0 && tot['2026-06-02'].join() === '90,900', `partial per-country day: lite rows read (${tot['2026-06-02']})`);
  ok(pick['2026-06-03'] === 0 && tot['2026-06-03'].join() === '7,70', `identical shapes: lite first (${tot['2026-06-03']})`);
}

// ── 3. One shape only: the views are plain pass-throughs (no per-row test, no slowdown) ─────────
{
  const { adb, db } = property('single');
  const ins = insert(db);
  for (const d of days('2026-06-01', '2026-06-10')) day(ins, d, 'q', 'https://x.test/p', 3, 30, ['country']);
  adb.close();
  const a = new AuditDatabase(dbPathFor(dataDir, 'sc-domain:single.test'));
  const sql = a.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'gsc_rows'`).get().sql;
  const n = a.db.prepare(`SELECT COUNT(*) n FROM gsc_day_shape`).get().n;
  const c = a.db.prepare(`SELECT SUM(clicks) c FROM gsc_rows`).get().c;
  a.close();
  ok(n === 0 && !/WHERE/.test(sql) && c === 30, `single shape: no mixed day, gsc_rows has no filter, sums 30 (${c})`);
}

// ── 4. Migrate the overlap property (#65): every reader gives the same answer, faster ────────────
{
  const site = 'sc-domain:overlap.test';
  const file = dbPathFor(dataDir, site);
  const snapshot = () => {
    const d = getDashboardData(dataDir, site);
    const q = (input) => runQueryData(file, { table: 'search_analytics', ...input }).structured.groups.map(g => JSON.stringify(g)).sort(); // no orderBy: group order is unspecified
    return JSON.stringify({
      summary: d.summary, monthly: d.monthly, contentDecay: d.contentDecay, pagePerformance: d.pagePerformance,
      pageMovers: d.pageMovers, clickWindows: d.clickWindows,
      decay: runSingleCheck(dataDir, site, 'traffic-decay').findings.map(f => f.urlKey).sort(),
      total: q({ metrics: [{ fn: 'sum', column: 'clicks' }] }),
      byCountry: q({ groupBy: ['country'], metrics: [{ fn: 'sum', column: 'clicks' }], filters: [{ column: 'date', op: 'eq', value: '2026-07-15' }] }),
      byDevice: q({ groupBy: ['device'], metrics: [{ fn: 'sum', column: 'clicks' }], filters: [{ column: 'date', op: 'eq', value: '2026-07-15' }] }),
    });
  };
  const before = snapshot();
  const adb = new AuditDatabase(file);
  const r = await migrateGscStorage(adb.db, file, { freeBytes: () => 1e15 });
  adb.close();
  const after = snapshot();
  ok(r.state === 'done' && r.segmentRowsMoved > 0, `migrated (${r.segmentRowsMoved} segment rows moved over ${r.days} days)`);
  ok(after === before, 'dashboard totals, monthly, decay, page performance, movers, traffic-decay and query_data are identical after the migration');
  const v = new Database(file, { readonly: true });
  const sql = v.prepare(`SELECT sql FROM sqlite_master WHERE name = 'gsc_rows'`).get().sql;
  v.close();
  ok(!/WHERE/.test(sql), 'gsc_rows is a straight pass-through after the migration');
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
