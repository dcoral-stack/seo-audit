// Regression test for async-job reporting, data_storage lastCrawl and incremental GSC replace.
// Run: node scripts/probe-jobs.mjs   (after npm run build:server)
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { JobManager, corruptionHint } from '../dist/core/JobManager.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { GscSync } from '../dist/core/GscSync.js';
import { storageSummary } from '../dist/core/dataStorage.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dir = mkdtempSync(path.join(tmpdir(), 'sac-jobs-'));
const site = 'https://example.com/';

// ── JobManager: failure reason kept, corruption hint only for SQLite corruption (#33) ──────
{
  const jm = new JobManager();
  const origErr = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' '));
  const id = jm.start('sync', async () => { throw new Error('database disk image is malformed'); });
  await new Promise(r => setTimeout(r, 20));
  console.error = origErr;
  const job = jm.get(id);
  check('failed job keeps its error', job.state === 'failed' && job.error === 'database disk image is malformed', JSON.stringify(job));
  check('failure logged to stderr with job id', logged.some(l => l.includes(id) && l.includes('malformed')), JSON.stringify(logged));
  check('corruption hint for malformed DB', corruptionHint(job.error).includes('data_storage'), corruptionHint(job.error));
  check('no corruption hint for ordinary errors', corruptionHint('fetch failed') === '', corruptionHint('fetch failed'));
}

// ── data_storage.lastCrawl counts only completed crawls (#20, #29) ──────────────────────────
{
  const db = new AuditDatabase(dbPathFor(dir, site));
  db.db.prepare(`INSERT OR IGNORE INTO property_meta (site_url) VALUES (?)`).run(site);
  const ins = db.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES (?,?,?,?,?,?)`);
  ins.run('c1', site, 'example.com', 'completed', '2026-10-07T09:00:00.000Z', '2026-10-07T09:30:00.000Z');
  ins.run('c2', site, 'example.com', 'running', '2026-10-16T17:45:45.414Z', null);
  db.close();
  const p = storageSummary(dir, site).properties[0];
  check('lastCrawl is the last COMPLETED crawl', p.lastCrawl === '2026-10-07T09:30:00.000Z', p.lastCrawl);
  check('incomplete latest run is surfaced', p.latestCrawlRun?.status === 'running' && p.latestCrawlRun.startedAt.startsWith('2026-10-16'), JSON.stringify(p.latestCrawlRun));
}

// ── GSC incremental sync replaces the lag days instead of merging into them (#22) ───────────
{
  const row = (date, query, clicks) => ({ keys: [date, query, `${site}p`], clicks, impressions: clicks * 10, ctr: 0.1, position: 3 });
  let served = [];
  const fakeGsc = { fetchSearchAnalytics: async (_s, opts, _sig, onBatch) => { served.push(opts.startDate); await onBatch({ rows: served.length === 1 ? first : second }); } };
  const first = [row('2026-10-01', 'a', 10), row('2026-10-05', 'a', 9), row('2026-10-06', 'partial', 2), row('2026-10-06', 'dropped-later', 1)];
  const second = [row('2026-10-03', 'a', 11), row('2026-10-06', 'partial', 40), row('2026-10-07', 'a', 12)];
  const sync = new GscSync(fakeGsc, dir);
  await sync.run(site, { startDate: '2026-09-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  const r2 = await sync.run(site, { startDate: '2026-09-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  const db = new AuditDatabase(dbPathFor(dir, site));
  const rows = db.db.prepare(`SELECT date, query, clicks FROM search_analytics ORDER BY date, query`).all();
  db.close();
  check('second sync resumed from max date minus lag days', served[1] === '2026-10-02' && r2.startDate === '2026-10-02', JSON.stringify({ served, r2 }));
  check('day before the window is untouched', rows.some(r => r.date === '2026-10-01' && r.clicks === 10), JSON.stringify(rows));
  check('partial final day replaced with the finalised figure', rows.find(r => r.date === '2026-10-06' && r.query === 'partial')?.clicks === 40, JSON.stringify(rows));
  check('row Google dropped from a re-pulled day is removed', !rows.some(r => r.query === 'dropped-later'), JSON.stringify(rows));
  const plan = sync.plannedRange(site, { startDate: '2026-09-01', endDate: '2026-10-16' });
  check('plannedRange reports the incremental start the job will use', plan.incremental && plan.startDate === '2026-10-03', JSON.stringify(plan));
  check('plannedRange with full:true keeps the requested window', sync.plannedRange(site, { startDate: '2026-09-01', endDate: '2026-10-16', fullResync: true }).startDate === '2026-09-01', '');
  check('day inside the window but absent from the re-pull is removed', !rows.some(r => r.date === '2026-10-05'), JSON.stringify(rows));
}

// ── Review findings: the lag-day replace is bounded and atomic ──────────────────────────────
{
  const site2 = 'https://atomic.example/';
  const row = (date, query, clicks) => ({ keys: [date, query, `${site2}p`], clicks, impressions: clicks * 10, ctr: 0.1, position: 3 });
  const seed = [row('2026-10-05', 'a', 5), row('2026-10-08', 'a', 8), row('2026-10-09', 'later', 9), row('2026-10-10', 'later', 10)];
  const stored = () => { const d = new AuditDatabase(dbPathFor(dir, site2)); try { return d.db.prepare(`SELECT date, query, clicks FROM search_analytics ORDER BY date`).all(); } finally { d.close(); } };
  await new GscSync({ fetchSearchAnalytics: async (_s, _o, _sig, onBatch) => onBatch({ rows: seed }) }, dir)
    .run(site2, { startDate: '2026-10-01', endDate: '2026-10-16', fullResync: true }, () => {}, new AbortController().signal);

  // Historical pull ending before the stored max: rows after endDate must survive.
  await new GscSync({ fetchSearchAnalytics: async (_s, opts, _sig, onBatch) => onBatch({ rows: [row('2026-10-07', 'a', 7)] }) }, dir)
    .run(site2, { startDate: '2026-10-01', endDate: '2026-10-08' }, () => {}, new AbortController().signal);
  const afterHist = stored();
  check('sync ending before stored data keeps rows after its endDate', afterHist.some(r => r.date === '2026-10-09') && afterHist.some(r => r.date === '2026-10-10'), JSON.stringify(afterHist));

  // Failure on page 2: nothing in the lag window is lost.
  const before = JSON.stringify(stored());
  let threw = false;
  try {
    await new GscSync({ fetchSearchAnalytics: async (_s, _o, _sig, onBatch) => { await onBatch({ rows: [row('2026-10-07', 'x', 1)] }); throw new Error('429 on page 2'); } }, dir)
      .run(site2, { startDate: '2026-10-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  } catch { threw = true; }
  check('a failure on a later page leaves the stored lag days untouched', threw && JSON.stringify(stored()) === before, JSON.stringify(stored()));

  // Empty response: stored days are not wiped.
  await new GscSync({ fetchSearchAnalytics: async () => {} }, dir).run(site2, { startDate: '2026-10-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  check('an empty response never wipes stored days', JSON.stringify(stored()) === before, JSON.stringify(stored()));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
