// Audit history (summary page, slice 2): the health score per run, the check set each run used,
// and the opened / resolved / carried deltas between consecutive comparable runs.
//
// One formula, two page sets. `computeHealth` is THE health-score SQL: the dashboard's headline
// tile, the value `runAudit` stores on its own row, and the backfill of past runs all call it.
// The only thing that varies is which page set the run is measured against:
//   - live:     `pages` (is_internal = 1), i.e. the crawl on screen when the run happened;
//   - snapshot: `page_snapshots` for one crawl_id, which is how a PAST run's page set is rebuilt.
// Every `pages` row is internal by construction (both crawler INSERTs write is_internal = 1), and
// `snapshotCrawl` copies `pages` verbatim, so the two sets mean the same thing.
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { capHealth } from '../core/displayRules.js';

export const HEALTH_DEFINITION = 'Share of crawled internal pages with no critical or high finding (never 100 while any page has one).';

/** Product-convention bands (not an industry benchmark). */
export function healthBand(score: number): 'Excellent' | 'Good' | 'Fair' | 'Weak' {
  return score >= 91 ? 'Excellent' : score >= 71 ? 'Good' : score >= 31 ? 'Fair' : 'Weak';
}

export interface Health { score: number; errorPages: number; totalPages: number }

/**
 * Health for one audit run: % of the page set carrying no crit/high finding from that run.
 * `crawlId` given → the page set is that crawl's `page_snapshots`; omitted → the live `pages` table.
 * Returns null when the page set is empty (no score is better than a fake 100).
 */
export function computeHealth(db: Database.Database, runId: string, crawlId?: string): Health | null {
  const set = crawlId
    ? { sql: `SELECT url_key FROM page_snapshots WHERE crawl_id = ?`, args: [crawlId] }
    : { sql: `SELECT url_key FROM pages WHERE is_internal = 1`, args: [] as string[] };
  const totalPages = (db.prepare(`SELECT COUNT(*) n FROM (${set.sql})`).get(...set.args) as { n: number }).n;
  if (totalPages <= 0) return null;
  // Only findings on a page IN the set count, so a check whose url_key is not a crawled page
  // (ghost-pages, backlinks-to-404) can't push errorPages past the total.
  const errorPages = (db.prepare(
    `SELECT COUNT(DISTINCT f.url_key) n FROM findings f JOIN (${set.sql}) p ON p.url_key = f.url_key
     WHERE f.run_id = ? AND f.severity IN ('crit','high') AND f.url_key IS NOT NULL`,
  ).get(...set.args, runId) as { n: number }).n;
  // Never 100 while any page carries a crit/high finding (1 of 495 rounds to 100 otherwise):
  // capHealth is the one display rule the dashboard applies to stored scores too.
  const score = capHealth(Math.max(0, Math.min(100, Math.round((1 - errorPages / totalPages) * 100))), errorPages);
  return { score, errorPages, totalPages };
}

/** Canonical form of a run's check set: sorted, de-duplicated ids as a JSON array. */
export function checkIdsJson(ids: string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
}

let cachedVersion: string | null | undefined;
/** package.json version (dist/audit/history.js → ../../package.json); null if unreadable. */
export function serverVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? null;
  } catch { cachedVersion = null; }
  return cachedVersion;
}

// A run counts as finished-and-good when it says so, or is a pre-status legacy row with a finish.
const COMPLETED_SQL = `(status = 'completed' OR (status IS NULL AND finished_at IS NOT NULL))`;

/**
 * Backfill health for past completed runs, honestly. Lazy and idempotent: each run is visited once,
 * because the attempt always writes `health_basis` (a 'none:<reason>' when no score can be rebuilt).
 * Cheap once done: the probe is one query over the small audit_runs table.
 *
 * Old runs never recorded their crawl, so it is inferred, and only when unambiguous:
 *   candidate = the latest COMPLETED crawl that finished at or before the run started;
 *   ambiguous = any other crawl (any status) started between the candidate's start and the run's
 *               start, because it could have written `pages` before the run read it.
 * (A crawl that started BEFORE the candidate can't be on screen: the candidate wipes `pages` on its
 * first write.) The score is then rebuilt from that crawl's `page_snapshots`; with no snapshot, NULL.
 * Never estimated. `check_ids` stays NULL for past runs: the check set wasn't recorded.
 */
export function backfillAuditHealth(db: Database.Database): { visited: number; scored: number } {
  const runs = db.prepare(
    `SELECT run_id, crawl_id, started_at FROM audit_runs WHERE health_basis IS NULL AND ${COMPLETED_SQL}`,
  ).all() as { run_id: string; crawl_id: string | null; started_at: string | null }[];
  if (!runs.length) return { visited: 0, scored: 0 };
  const crawls = db.prepare(
    `SELECT crawl_id, status, julianday(started_at) s, julianday(finished_at) f FROM crawl_metadata`,
  ).all() as { crawl_id: string; status: string | null; s: number | null; f: number | null }[];
  const hasSnap = db.prepare(`SELECT 1 FROM page_snapshots WHERE crawl_id = ? LIMIT 1`);
  const jd = db.prepare(`SELECT julianday(?) j`);
  const write = db.prepare(
    `UPDATE audit_runs SET health_score=?, health_error_pages=?, health_total_pages=?, health_basis=? WHERE run_id=?`,
  );
  let scored = 0;
  db.transaction(() => {
    for (const r of runs) {
      let crawlId = r.crawl_id;
      if (!crawlId) {
        const rs = r.started_at ? (jd.get(r.started_at) as { j: number | null }).j : null;
        const cand = rs == null ? undefined : crawls
          .filter(c => c.status === 'completed' && c.f != null && c.s != null && c.f <= rs)
          .sort((a, b) => b.f! - a.f!)[0];
        if (rs == null || !cand) { write.run(null, null, null, 'none:no-crawl-before-run', r.run_id); continue; }
        const rival = crawls.some(c => c.crawl_id !== cand.crawl_id && c.s != null && c.s >= cand.s! && c.s <= rs);
        if (rival) { write.run(null, null, null, 'none:ambiguous-crawl', r.run_id); continue; }
        crawlId = cand.crawl_id;
      }
      if (!hasSnap.get(crawlId)) { write.run(null, null, null, 'none:no-snapshot', r.run_id); continue; }
      const h = computeHealth(db, r.run_id, crawlId);
      write.run(h?.score ?? null, h?.errorPages ?? null, h?.totalPages ?? null, h ? `snapshot:${crawlId}` : 'none:no-pages', r.run_id);
      if (h) scored++;
    }
  })();
  return { visited: runs.length, scored };
}

export interface HealthPoint {
  runId: string; at: string | null; score: number | null; errorPages: number | null; totalPages: number | null;
  /** 'audit' = written by runAudit; 'snapshot:<crawlId>' = rebuilt from snapshots; 'none:<reason>' = not computable. */
  basis: string | null;
}
export type DeltaSkip = 'different-scope' | 'check-set-changed' | 'check-set-unknown' | `run-${string}`;
export interface AuditDelta {
  runId: string; at: string | null; prevRunId: string | null;
  opened: number | null; resolved: number | null; carried: number | null;
  skipped?: DeltaSkip;
}
export interface AuditHistory {
  healthHistory: HealthPoint[];
  auditDeltas: AuditDelta[];
  /** Set when the run list was bounded — never cap silently. */
  truncated?: { shownRuns: number; totalRuns: number };
}

const MAX_RUNS = 60;

/**
 * Health per completed run + deltas between consecutive COMPLETED runs, oldest first.
 * Delta key = check_id + url_key ("site" when null). Opened = in run N, not N-1; resolved = in N-1,
 * not N; carried = in both. A pair is compared only with the same scope AND the same recorded check
 * set; otherwise it carries a `skipped` reason and null counts. Failed / interrupted / running runs
 * get their own skipped entry and are stepped over (the next completed run compares to the last
 * completed one).
 */
export function auditHistory(db: Database.Database): AuditHistory {
  const totalRuns = (db.prepare(`SELECT COUNT(*) n FROM audit_runs`).get() as { n: number }).n;
  const rows = (db.prepare(
    `SELECT run_id, scope, status, started_at, finished_at, check_ids, health_score, health_error_pages, health_total_pages, health_basis,
            ${COMPLETED_SQL} done
     FROM audit_runs ORDER BY started_at DESC, rowid DESC LIMIT ${MAX_RUNS}`,
  ).all() as {
    run_id: string; scope: string | null; status: string | null; started_at: string | null; finished_at: string | null; check_ids: string | null;
    health_score: number | null; health_error_pages: number | null; health_total_pages: number | null; health_basis: string | null; done: number;
  }[]).reverse();

  const healthHistory: HealthPoint[] = rows.filter(r => r.done).map(r => ({
    runId: r.run_id, at: r.finished_at, score: r.health_score, errorPages: r.health_error_pages,
    totalPages: r.health_total_pages, basis: r.health_basis,
  }));

  const keys = `SELECT DISTINCT check_id, COALESCE(url_key, 'site') FROM findings WHERE run_id = ?`;
  const countOf = (sql: string, a: string, b: string): number => (db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(a, b) as { n: number }).n;
  const auditDeltas: AuditDelta[] = [];
  let prev: (typeof rows)[number] | null = null;
  for (const r of rows) {
    if (!r.done) {
      // Not completed: failed / running / interrupted (a legacy row with no status and no finish).
      const state = r.status ?? 'interrupted';
      auditDeltas.push({ runId: r.run_id, at: r.finished_at ?? r.started_at, prevRunId: prev?.run_id ?? null, opened: null, resolved: null, carried: null, skipped: `run-${state}` });
      continue;
    }
    if (prev) {
      const base = { runId: r.run_id, at: r.finished_at, prevRunId: prev.run_id };
      const skip: DeltaSkip | null = (prev.scope ?? '') !== (r.scope ?? '') ? 'different-scope'
        : prev.check_ids == null || r.check_ids == null ? 'check-set-unknown'
        : prev.check_ids !== r.check_ids ? 'check-set-changed'
        : null;
      if (skip) auditDeltas.push({ ...base, opened: null, resolved: null, carried: null, skipped: skip });
      else auditDeltas.push({
        ...base,
        opened: countOf(`${keys} EXCEPT ${keys}`, r.run_id, prev.run_id),
        resolved: countOf(`${keys} EXCEPT ${keys}`, prev.run_id, r.run_id),
        carried: countOf(`${keys} INTERSECT ${keys}`, r.run_id, prev.run_id),
      });
    }
    prev = r;
  }
  return totalRuns > rows.length
    ? { healthHistory, auditDeltas, truncated: { shownRuns: rows.length, totalRuns } }
    : { healthHistory, auditDeltas };
}
