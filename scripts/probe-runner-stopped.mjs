// Probe (0.16.1): after a clean stop the runner keeps its registry row, marked stopped, so the
// queued-job advice says "the last runner stopped at <time>" instead of "no runner has ever checked
// in to this data directory". A stopped runner never counts as alive.
// Run: node scripts/probe-runner-stopped.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { JobManager, jobsDbPath, liveJobTypes } from '../dist/core/JobManager.js';
import { submitJob } from '../dist/core/jobKinds.js';
import { JobRunner } from '../dist/core/jobRunner.js';
import { Crawler } from '../dist/core/Crawler.js';
import { jobScopeFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const root = mkdtempSync(path.join(tmpdir(), 'sac-runner-stopped-'));
const opened = [];
const JM = (o) => { const m = new JobManager(o); opened.push(m); return m; };
const site = 'https://example.test/';
const info = { pid: 1, host: 'h', version: 'v', concurrency: 1, running: 0 };

try {
  // ── Never a runner ──
  {
    const m = JM({ dbPath: jobsDbPath(path.join(root, 'never')), runner: 'external' });
    check('no runner ever: says so', /no runner has ever checked in/.test(m.noRunnerAdvice()) && m.lastRunnerSeen() === null);
  }

  // ── A runner that stopped cleanly ──
  {
    const dir = path.join(root, 'stopped');
    const runnerSide = JM({ dbPath: jobsDbPath(dir), runner: 'external' });
    const mcp = JM({ dbPath: jobsDbPath(dir), runner: 'external', runnerStaleMs: 200, queuedFreshMs: 200 });
    runnerSide.beatRunner(info);
    check('a beating runner is alive', mcp.runnerAlive());
    runnerSide.removeRunner();
    check('stopped: no longer alive, at once', !mcp.runnerAlive() && mcp.lastRunnerBeat() === null, String(mcp.lastRunnerBeat()));
    const seen = mcp.lastRunnerSeen();
    check('stopped: the row is kept with its stop time', !!seen?.stoppedAt && !!seen.heartbeatAt, JSON.stringify(seen));
    const advice = mcp.noRunnerAdvice();
    check('advice: "the last runner stopped at <time>"', advice.includes(`the last runner stopped at ${seen.stoppedAt}`) && !/ever checked in/.test(advice), advice.slice(0, 200));
    const id = submitJob(mcp, 'crawl', { siteUrl: site, maxPages: 1 }, {}, jobScopeFor(dir, site));
    await sleep(300);
    check('a queued job past the fresh window carries the stopped wording', /the last runner stopped at/.test(mcp.get(id)?.note ?? ''), mcp.get(id)?.note);
    { const raw = new Database(jobsDbPath(dir)); const old = new Date(Date.now() - 5 * 60_000).toISOString(); raw.prepare(`UPDATE jobs SET started_at = ?, updated_at = ? WHERE id = ?`).run(old, old, id); raw.close(); }
    const lt = liveJobTypes(dir, jobScopeFor(dir, site));
    check('liveJobTypes: a stopped runner does not make an old queued job live', !!lt && !lt.queued?.has('crawl') && lt.queuedNoRunner?.has('crawl'), JSON.stringify({ q: lt && [...lt.queued], nr: lt && [...lt.queuedNoRunner] }));
    runnerSide.beatRunner(info);
    check('the same runner starting again clears its stop', runnerSide.lastRunnerSeen()?.stoppedAt === null && mcp.runnerAlive());
    runnerSide.removeRunner();
  }

  // ── A runner that died without stopping (crash / kill -9): last heartbeat wording ──
  {
    const dir = path.join(root, 'died');
    const runnerSide = JM({ dbPath: jobsDbPath(dir), runner: 'external' });
    const mcp = JM({ dbPath: jobsDbPath(dir), runner: 'external', runnerStaleMs: 100 });
    runnerSide.beatRunner(info);
    await sleep(200);
    check('died: not alive after the stale window, advice gives the last heartbeat', !mcp.runnerAlive() && /the last runner heartbeat was at/.test(mcp.noRunnerAdvice()), mcp.noRunnerAdvice().slice(0, 160));
  }

  // ── A real JobRunner's graceful stop ──
  {
    const dir = path.join(root, 'graceful');
    const deps = { dataDir: () => dir, crawler: new Crawler(dir), sync: null, inspector: null, refresh: null, rankTracker: null, backlinks: null, entities: null, dfs: null };
    const runner = new JobRunner({ dataDir: dir, pollMs: 50, heartbeatMs: 50, shutdownGraceMs: 1000, deps, log: () => {} });
    runner.start();
    await sleep(200);
    await runner.stop();
    const mcp = JM({ dbPath: jobsDbPath(dir), runner: 'external' });
    check('JobRunner.stop(): marked stopped, advice uses it', !!mcp.lastRunnerSeen()?.stoppedAt && /the last runner stopped at/.test(mcp.noRunnerAdvice()), JSON.stringify(mcp.lastRunnerSeen()));
  }

  // ── A registry from 0.16.0 (runners table without stopped_at) is upgraded on open ──
  {
    const dir = path.join(root, 'legacy');
    { const first = new JobManager({ dbPath: jobsDbPath(dir), runner: 'external' }); first.close(); }
    const raw = new Database(jobsDbPath(dir));
    raw.exec(`ALTER TABLE runners DROP COLUMN stopped_at;
              INSERT INTO runners (instance_id, started_at, heartbeat_at, info) VALUES ('old', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', NULL);`);
    raw.close();
    check('liveJobTypes reads a pre-0.16.1 registry', liveJobTypes(dir, null) !== null);
    const m = JM({ dbPath: jobsDbPath(dir), runner: 'external' });
    const cols = new Database(jobsDbPath(dir), { readonly: true });
    const has = cols.prepare(`PRAGMA table_info(runners)`).all().some(c => c.name === 'stopped_at');
    cols.close();
    check('stopped_at added to an old registry', has && /the last runner heartbeat was at 2026-10-01/.test(m.noRunnerAdvice()), m.noRunnerAdvice().slice(0, 160));
  }
} finally {
  for (const m of opened) { try { m.close(); } catch { /* closed */ } }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
