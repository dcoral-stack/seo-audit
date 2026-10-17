/**
 * gscMigrate — the one-time move from the #64 layout (all-country and segment rows mixed in
 * `search_analytics`) to the #65 layout (segment rows in `search_analytics_segments`, totals only
 * in `search_analytics`). See gscRows.ts for the layout and the views.
 *
 * Non-destructive and resumable:
 *   1. Backup first: an online SQLite backup of the whole file to `<db>.bak-<stamp>` (the
 *      `data_storage repair` naming), after a free-disk check. Not enough room = a clear refusal,
 *      nothing touched.
 *   2. Then day by day, a batch of days per transaction: copy the day's segment rows into the
 *      segment table; where #64 chose a segment shape as that day's totals (the all-country rows
 *      were short), replace the day's all-country rows with that shape aggregated to the totals
 *      grain; delete the day's segment rows from search_analytics; mark the day migrated in
 *      `gsc_day_shape` (totals_from = the shape chosen, total_shape = 0). Progress is recorded in
 *      `gsc_storage_state` in the same transaction.
 *   3. When no segment row is left in search_analytics: state `done`, the guard trigger, and the
 *      views switch to straight pass-throughs.
 *
 * Readers stay correct throughout: until `done` the views keep #64's per-day filter, and the
 * segment views read both tables (a day's segment rows are wholly in one table at every commit).
 * Re-running is safe: a migrated day holds no segment rows in search_analytics, so it is skipped.
 * The only rows dropped are all-country rows on days where #64 already read the per-country rows
 * instead (the short ones); the backup holds them.
 */
import Database from 'better-sqlite3';
import { existsSync, statSync, statfsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { removeEmptySidecars } from './dataStorage.js';
import {
  AGGREGATE_DAY_SQL, DATA_COLS, SEGMENTS, ensureGscRows, ensureTotalsGuard, gscStorageState, pickShape,
  segmentSql, setGscStorageState, shapeSql, syncViews, type GscStorageState, type ShapeStat,
} from './gscRows.js';

export interface GscMigrationProgress { phase: 'backup' | 'moving'; days: number; daysDone: number; segmentRowsMoved: number }

export interface GscMigrationResult {
  /** False when there was nothing to do (already migrated or never mixed), or the migration was refused. */
  ran: boolean;
  state: GscStorageState;
  /** Set when the migration refused to start (e.g. not enough free disk); nothing was changed. */
  refused?: string;
  /** With a disk refusal: the free bytes it needed, and what the volume had. */
  needBytes?: number;
  freeBytes?: number;
  backup: string | null;
  /** Days that held segment rows in search_analytics. */
  days: number;
  daysDone: number;
  segmentRowsMoved: number;
  /** Days whose totals now come from segment rows aggregated (the all-country rows were short). */
  daysFromSegments: number;
  /** Totals rows written by aggregating segment rows. */
  totalsRowsDerived: number;
  /** All-country rows replaced on those days (kept in the backup). */
  allCountryRowsReplaced: number;
  backupMs: number;
  moveMs: number;
  rows?: { before: { searchAnalytics: number }; after: { searchAnalytics: number; segments: number } };
  bytes?: { before: number; backup: number; after: number; freelist: number };
}

export interface GscMigrationOptions {
  onProgress?: (p: GscMigrationProgress) => void;
  signal?: AbortSignal;
  /** Rows per transaction (whole days; a day is never split). */
  batchRows?: number;
  /** Free bytes on the volume holding `dir` (overridable for tests). */
  freeBytes?: (dir: string) => number;
}

const MB = 1024 * 1024;
/** Room needed beyond the backup: the segment table grows before the space its rows held in
 *  search_analytics is reused, plus the WAL of the largest batch. */
const headroomFor = (dbBytes: number): number => Math.ceil(dbBytes * 0.5) + 256 * MB;

export const diskFree = (dir: string): number => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };
const fileBytes = (f: string): number => ['', '-wal'].reduce((n, s) => { try { return n + statSync(f + s).size; } catch { return n; } }, 0);
export const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(2)} GB`;
const tick = (): Promise<void> => new Promise(r => setImmediate(r));
const count = (db: Database.Database, table: string): number => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

/**
 * Migrate one property database (open, writable `db` on `dbFile`). Safe to call on any database:
 * a migrated or never-mixed one returns `{ ran: false }` without touching anything.
 */
export async function migrateGscStorage(db: Database.Database, dbFile: string, opts: GscMigrationOptions = {}): Promise<GscMigrationResult> {
  ensureGscRows(db); // schema + (pending) #64's per-day choice brought up to date: that is the choice we keep
  const state = gscStorageState(db) ?? 'done';
  const result: GscMigrationResult = {
    ran: false, state, backup: null, days: 0, daysDone: 0, segmentRowsMoved: 0, daysFromSegments: 0,
    totalsRowsDerived: 0, allCountryRowsReplaced: 0, backupMs: 0, moveMs: 0,
  };
  if (state === 'done') return result;

  const dir = path.dirname(dbFile);
  const free = (opts.freeBytes ?? diskFree)(dir);
  const bytesBefore = fileBytes(dbFile);
  const recorded = db.prepare(`SELECT backup, detail FROM gsc_storage_state WHERE id = 1`).get() as { backup: string | null; detail: string | null };
  const needBackup = state === 'pending';
  const need = (needBackup ? bytesBefore : 0) + headroomFor(bytesBefore);
  if (free < need) {
    // Recorded so data_storage can say the migration is deferred, and why (state stays as it was).
    const prev = (() => { try { return recorded.detail ? JSON.parse(recorded.detail) as Record<string, unknown> : {}; } catch { return {}; } })();
    setGscStorageState(db, state, { detail: { ...prev, deferred: {
      at: new Date().toISOString(), needBytes: need, freeBytes: free,
      reason: `not enough free disk: needs ${gb(need)} next to the database${needBackup ? ` (a ${gb(bytesBefore)} backup plus working room)` : ''}, the volume had ${gb(free)}. Sync again after freeing space.`,
    } } });
    return {
      ...result,
      needBytes: need,
      freeBytes: free,
      refused: `GSC storage migration (#65) not started: it needs ${gb(need)} free next to ${dbFile} ` +
        `(${needBackup ? `a ${gb(bytesBefore)} backup plus ` : ''}${gb(headroomFor(bytesBefore))} working room) and the volume has ${gb(free)}. ` +
        `Nothing was changed; the dashboard and audit keep reading correct figures, only slower. Free some space ` +
        `(data_storage lists sizes; old *.bak-* files next to the databases are safe to delete once you're satisfied) and sync again.`,
    };
  }
  const rowsBefore = recorded.detail ? (JSON.parse(recorded.detail).rowsBefore as number | undefined) ?? count(db, 'search_analytics') : count(db, 'search_analytics');

  // ── 1. Backup (once; a resumed migration already has one) ─────────────────────────────────────
  let backup = recorded.backup;
  if (needBackup) {
    opts.onProgress?.({ phase: 'backup', days: 0, daysDone: 0, segmentRowsMoved: 0 });
    const t0 = Date.now();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    backup = `${dbFile}.bak-${stamp}`;
    for (let i = 1; existsSync(backup); i++) backup = `${dbFile}.bak-${stamp}-${i}`;
    // Online backup API, not a file copy: it yields a consistent snapshot even if another
    // connection (a crawl, the dashboard sidecar) checkpoints the WAL into the file meanwhile.
    await db.backup(backup);
    // Verify on a writable handle switched to a rollback journal: the copy inherits WAL mode, and a
    // read-only handle on a WAL database leaves an empty -wal and a -shm beside it that it can't
    // delete on close (0.16.0 left both next to every backup). DELETE mode removes them on close.
    const check = new Database(backup, { fileMustExist: true });
    let copied = -1;
    try { check.pragma('journal_mode = DELETE'); copied = count(check, 'search_analytics'); } finally { check.close(); }
    removeEmptySidecars(backup);
    if (copied !== rowsBefore) {
      for (const s of ['', '-wal', '-shm']) rmSync(backup + s, { force: true });
      throw new Error(`GSC storage migration (#65) stopped before changing anything: the backup at ${backup} holds ${copied} search_analytics rows, the database ${rowsBefore}.`);
    }
    result.backupMs = Date.now() - t0;
    setGscStorageState(db, 'migrating', { backup, detail: { rowsBefore, startedAt: new Date().toISOString() } });
  }
  result.backup = backup;
  result.ran = true;

  // ── 2. Move, a batch of whole days per transaction ────────────────────────────────────────────
  const t1 = Date.now();
  const batchRows = opts.batchRows ?? 250_000;
  const SEG = segmentSql();
  const dayList = db.prepare(`SELECT date, COUNT(*) n FROM search_analytics WHERE ${SEG} GROUP BY date ORDER BY date`);
  const listed = db.prepare(`SELECT total_shape s FROM gsc_day_shape WHERE date = ? AND totals_from IS NULL`);
  const dayStats = db.prepare(`SELECT ${shapeSql()} shape, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COUNT(*) rows
                               FROM search_analytics WHERE date = ? GROUP BY shape`);
  const copySeg = db.prepare(`INSERT OR IGNORE INTO ${SEGMENTS} (${DATA_COLS})
    SELECT date, query, page, page_key, COALESCE(device,''), COALESCE(country,''), search_appearance, clicks, impressions, ctr, position, created_at, search_type
    FROM search_analytics WHERE date = ? AND ${SEG}`);
  const delAll = db.prepare(`DELETE FROM search_analytics WHERE date = ? AND NOT ${SEG}`);
  const aggregate = db.prepare(AGGREGATE_DAY_SQL);
  const delSeg = db.prepare(`DELETE FROM search_analytics WHERE date = ? AND ${SEG}`);
  const mark = db.prepare(`UPDATE gsc_day_shape SET totals_from = total_shape, total_shape = 0 WHERE date = ? AND totals_from IS NULL`);
  const moveDay = (date: string): void => {
    // The totals source: #64's recorded choice for a mixed day; otherwise (a day held only in
    // segment shapes) the same rule applied now.
    const pick = listed.get(date) as { s: number } | undefined;
    const chosen = pick ? pick.s : pickShape(dayStats.all(date) as ShapeStat[]);
    copySeg.run(date);
    if (chosen !== 0) {
      result.allCountryRowsReplaced += delAll.run(date).changes;
      result.totalsRowsDerived += aggregate.run(date, chosen).changes;
      result.daysFromSegments++;
    }
    result.segmentRowsMoved += delSeg.run(date).changes;
    mark.run(date);
  };

  // Loop until no segment row is left (a pass also picks up a day written meanwhile by an older version).
  for (;;) {
    const days = dayList.all() as { date: string; n: number }[];
    if (!days.length) break;
    result.days = Math.max(result.days, result.daysDone + days.length);
    for (let i = 0; i < days.length;) {
      const batch: string[] = [];
      for (let rows = 0; i < days.length && (batch.length === 0 || rows + days[i].n <= batchRows); i++) { batch.push(days[i].date); rows += days[i].n; }
      db.transaction(() => {
        for (const d of batch) moveDay(d);
        result.daysDone += batch.length;
        setGscStorageState(db, 'migrating', { detail: { rowsBefore, daysDone: result.daysDone, segmentRowsMoved: result.segmentRowsMoved, lastDate: batch[batch.length - 1] } });
      })();
      opts.onProgress?.({ phase: 'moving', days: result.days, daysDone: result.daysDone, segmentRowsMoved: result.segmentRowsMoved });
      await tick(); // let the event loop breathe between batches (MCP stdio, job heartbeat)
      if (opts.signal?.aborted) { result.moveMs = Date.now() - t1; result.state = 'migrating'; return result; }
    }
  }

  // ── 3. Done: guard on, views straight through ─────────────────────────────────────────────────
  const segments = count(db, SEGMENTS);
  const after = count(db, 'search_analytics');
  db.transaction(() => {
    setGscStorageState(db, 'done', { detail: {
      rowsBefore, rowsAfter: after, segmentRows: segments, daysDone: result.daysDone, segmentRowsMoved: result.segmentRowsMoved,
      daysFromSegments: result.daysFromSegments, totalsRowsDerived: result.totalsRowsDerived, allCountryRowsReplaced: result.allCountryRowsReplaced,
      finishedAt: new Date().toISOString(),
    } });
    ensureTotalsGuard(db);
    syncViews(db);
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  result.moveMs = Date.now() - t1;
  result.state = 'done';
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const freelist = (db.pragma('freelist_count', { simple: true }) as number) * pageSize;
  result.rows = { before: { searchAnalytics: rowsBefore }, after: { searchAnalytics: after, segments } };
  result.bytes = { before: bytesBefore, backup: backup && existsSync(backup) ? statSync(backup).size : 0, after: fileBytes(dbFile), freelist };
  return result;
}
