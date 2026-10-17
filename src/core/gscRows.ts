/**
 * gscRows — where GSC rows live, and the views every reader goes through.
 *
 * Storage (#65). A GSC sync writes one row SHAPE: all-country rows (device = '' AND country = '',
 * the totals) or segment rows (country-only, device-only, or device × country). They are stored
 * in two tables:
 *
 *   - `search_analytics` holds TOTALS rows only (one row per date × query × page). A guard trigger
 *     refuses a segment row, so no sync, old or new, can mix shapes in it again.
 *   - `search_analytics_segments` holds the segment rows (same columns). A guard trigger refuses
 *     an all-country row there.
 *
 * The views:
 *   - `gsc_rows` = `search_analytics`, straight through. Every total (KPIs, trends, movers, audit
 *     period comparisons, query_data) reads it, and the covering indexes on search_analytics apply.
 *   - `gsc_country_rows` / `gsc_device_rows` = the segment rows that carry a country / device. The
 *     country and device breakdowns read these.
 *
 * Totals for a day are the fuller of the two sources: the all-country rows, or the segment rows
 * aggregated to the totals grain (clicks and impressions summed, position impression-weighted).
 * "Fuller" is the #64 rule: most impressions, then most clicks, then all-country first. On
 * simracingcockpit.gg the all-country rows for 9 Jun to 12 Aug 2026 held only the rows that got a
 * click (impressions short, clicks exact), and on 5 Sep the per-country rows were a partial day; a
 * truncated row set always loses impressions. The writer applies the rule (`settleGscTotals`) after
 * every sync, so readers never choose.
 *
 * Before #65 both shapes lived in `search_analytics`, and #64 picked one shape per day at READ time
 * (a per-row shape test the covering indexes cannot serve). A database in that layout is `pending`
 * until the one-time migration (gscMigrate.ts) moves it; until then the views keep #64's per-day
 * filter so every figure stays correct, only slower. `gsc_storage_state` records the layout.
 *
 * `gsc_day_shape` is #64's per-day table. Before the migration it drives the filtered views. After
 * it, it is evidence: the days whose all-country and segment rows were both stored when the
 * migration ran, plus any day where a later sync found the two disagreeing, with `totals_from` =
 * the shape the totals came from and `shapes` = the per-shape figures behind the choice. Its
 * `country_shape` / `device_shape` still pick one segment shape on a legacy day holding two segment
 * shapes that both carry country (or device); with none listed, the segment views are plain
 * pass-throughs too.
 *
 * Rule for readers: a TOTAL reads `gsc_rows`; a breakdown BY country or device reads
 * `gsc_country_rows` / `gsc_device_rows`. Raw `search_analytics` is right for row counts,
 * MIN/MAX(date), distinct queries/pages and the writers.
 */
import type Database from 'better-sqlite3';

/** Totals view. */
export const GSC_ROWS = 'gsc_rows';
/** Segment rows that carry a country. */
export const GSC_COUNTRY_ROWS = 'gsc_country_rows';
/** Segment rows that carry a device. */
export const GSC_DEVICE_ROWS = 'gsc_device_rows';
/** The segment table. */
export const SEGMENTS = 'search_analytics_segments';

/** Columns of search_analytics and search_analytics_segments, in table order (the views select these). */
const COLS = ['id', 'date', 'query', 'page', 'page_key', 'device', 'country', 'search_appearance',
  'clicks', 'impressions', 'ctr', 'position', 'created_at', 'search_type'] as const;
/** The columns a copy carries (id is the target's own). */
export const DATA_COLS = COLS.filter(c => c !== 'id').join(', ');

/** Shape code of a row: 0 all-country, 1 country-only, 2 device-only, 3 device × country. NULL counts as ''. */
export const shapeSql = (alias = ''): string => {
  const a = alias ? `${alias}.` : '';
  return `((COALESCE(${a}device,'') <> '') * 2 + (COALESCE(${a}country,'') <> ''))`;
};
/** True for a segment row (any shape but all-country). */
export const segmentSql = (alias = ''): string => {
  const a = alias ? `${alias}.` : '';
  return `(COALESCE(${a}device,'') <> '' OR COALESCE(${a}country,'') <> '')`;
};
const SHAPE_NAMES = ['all-country', 'per-country', 'per-device', 'per-device-and-country'] as const;

export type GscStorageState = 'pending' | 'migrating' | 'done';

export const GUARD_MSG_TOTALS = 'search_analytics holds all-country totals rows only (device and country empty); segment rows belong in search_analytics_segments (#65)';
const GUARD_MSG_SEGMENTS = 'search_analytics_segments holds segment rows only (a device or a country); all-country rows belong in search_analytics (#65)';

/** Create the segment table, the state tables and (once migrated) the guard; then bring the views in line. Idempotent. */
export function ensureGscRowsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SEGMENTS} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      query TEXT,
      page TEXT,
      page_key TEXT,
      device TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      search_appearance TEXT,
      clicks INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      ctr REAL NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      search_type TEXT DEFAULT 'web'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sas_unique ON ${SEGMENTS}(date, query, page, device, country);
    -- Covering indexes for the dashboard's country and device breakdowns (a date window, grouped).
    CREATE INDEX IF NOT EXISTS idx_sas_date_country ON ${SEGMENTS}(date, country, clicks, impressions, position);
    CREATE INDEX IF NOT EXISTS idx_sas_date_device  ON ${SEGMENTS}(date, device, clicks, impressions, position);
    CREATE TRIGGER IF NOT EXISTS sas_segments_only BEFORE INSERT ON ${SEGMENTS}
      WHEN NOT ${segmentSql('NEW')}
      BEGIN SELECT RAISE(ABORT, '${GUARD_MSG_SEGMENTS}'); END;

    CREATE TABLE IF NOT EXISTS gsc_day_shape (
      date TEXT PRIMARY KEY,
      total_shape INTEGER NOT NULL,   -- the shape gsc_rows reads on this day (0 once migrated)
      country_shape INTEGER,          -- the segment shape gsc_country_rows reads (NULL = only one carries country)
      device_shape INTEGER,           -- the segment shape gsc_device_rows reads (NULL = only one carries device)
      shapes TEXT NOT NULL            -- JSON [{shape, clicks, impressions, rows}] behind the choice (evidence)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS gsc_day_shape_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fingerprint TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gsc_storage_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL,            -- pending | migrating | done
      backup TEXT,                    -- the backup file the migration made (NULL when none was needed)
      detail TEXT,                    -- JSON: migration progress and stats
      updated_at TEXT NOT NULL
    );
  `);
  // totals_from: the shape the stored totals were taken from (set by the migration and by settle).
  if (!(db.prepare(`PRAGMA table_info(gsc_day_shape)`).all() as { name: string }[]).some(c => c.name === 'totals_from')) {
    db.exec(`ALTER TABLE gsc_day_shape ADD COLUMN totals_from INTEGER`);
  }
  let state = gscStorageState(db);
  if (!state) {
    // First open by this version: a database with no segment row in search_analytics (every new
    // database, and every property only ever synced lite) has nothing to migrate. One scan, once.
    const legacy = !!db.prepare(`SELECT 1 FROM search_analytics WHERE ${segmentSql()} LIMIT 1`).get();
    state = legacy ? 'pending' : 'done';
    setGscStorageState(db, state);
  }
  if (state === 'done') ensureTotalsGuard(db);
  syncViews(db);
}

/** The guard: search_analytics refuses a segment row (insert or update). Created once migrated: a
 *  pending database still holds segment rows, and the migration never writes one. */
export function ensureTotalsGuard(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sa_totals_only BEFORE INSERT ON search_analytics
      WHEN ${segmentSql('NEW')}
      BEGIN SELECT RAISE(ABORT, '${GUARD_MSG_TOTALS}'); END;
    CREATE TRIGGER IF NOT EXISTS sa_totals_only_upd BEFORE UPDATE OF device, country ON search_analytics
      WHEN ${segmentSql('NEW')}
      BEGIN SELECT RAISE(ABORT, '${GUARD_MSG_TOTALS}'); END;
  `);
}

export function gscStorageState(db: Database.Database): GscStorageState | null {
  try {
    return (db.prepare(`SELECT state FROM gsc_storage_state WHERE id = 1`).get() as { state: GscStorageState } | undefined)?.state ?? null;
  } catch { return null; } // read-only handle on a database this version never opened
}

export function setGscStorageState(db: Database.Database, state: GscStorageState, extra: { backup?: string | null; detail?: unknown } = {}): void {
  db.prepare(`INSERT INTO gsc_storage_state (id, state, backup, detail, updated_at) VALUES (1, ?, ?, ?, datetime('now'))
              ON CONFLICT(id) DO UPDATE SET state = excluded.state,
                backup = COALESCE(excluded.backup, gsc_storage_state.backup),
                detail = COALESCE(excluded.detail, gsc_storage_state.detail),
                updated_at = excluded.updated_at`)
    .run(state, extra.backup ?? null, extra.detail === undefined ? null : JSON.stringify(extra.detail));
}

/**
 * View SQL. Migrated: `gsc_rows` is search_analytics as is, and the segment views read the segment
 * table. Pending or migrating: #64's per-day filter on search_analytics, and the segment views read
 * BOTH tables (UNION ALL), because the migration moves a day's segment rows in one transaction, so
 * at every commit a day's segment rows sit wholly in one table or the other.
 */
const select = `SELECT ${COLS.join(', ')}`;
const dayPick = (alias: string, col: 'total_shape' | 'country_shape' | 'device_shape'): string =>
  `(${alias}.date NOT IN (SELECT date FROM gsc_day_shape WHERE ${col} IS NOT NULL)
       OR ${shapeSql(alias)} = (SELECT g.${col} FROM gsc_day_shape g WHERE g.date = ${alias}.date))`;
function viewSql(name: string, migrated: boolean, filter: { t: boolean; c: boolean; d: boolean }): string {
  if (name === GSC_ROWS) {
    return migrated || !filter.t
      ? `CREATE VIEW ${name} AS ${select} FROM search_analytics`
      : `CREATE VIEW ${name} AS ${select} FROM search_analytics sa\n    WHERE ${dayPick('sa', 'total_shape')}`;
  }
  const country = name === GSC_COUNTRY_ROWS;
  const filtered = country ? filter.c : filter.d;
  const part = (table: string, alias: string): string => {
    const where = [`COALESCE(${alias}.${country ? 'country' : 'device'},'') <> ''`];
    if (filtered) where.push(dayPick(alias, country ? 'country_shape' : 'device_shape'));
    return `${select} FROM ${table} ${alias}\n    WHERE ${where.join('\n      AND ')}`;
  };
  return migrated
    ? `CREATE VIEW ${name} AS ${part(SEGMENTS, 'ss')}`
    : `CREATE VIEW ${name} AS ${part('search_analytics', 'sa')}\n  UNION ALL ${part(SEGMENTS, 'ss')}`;
}

/** (Re)create each view whose definition no longer matches the layout and `gsc_day_shape`. */
export function syncViews(db: Database.Database): void {
  const migrated = gscStorageState(db) === 'done';
  const need = db.prepare(`SELECT EXISTS(SELECT 1 FROM gsc_day_shape) t,
    EXISTS(SELECT 1 FROM gsc_day_shape WHERE country_shape IS NOT NULL) c,
    EXISTS(SELECT 1 FROM gsc_day_shape WHERE device_shape IS NOT NULL) d`).get() as { t: number; c: number; d: number };
  const filter = { t: !!need.t, c: !!need.c, d: !!need.d };
  const want: Record<string, string> = {
    [GSC_ROWS]: viewSql(GSC_ROWS, migrated, filter),
    [GSC_COUNTRY_ROWS]: viewSql(GSC_COUNTRY_ROWS, migrated, filter),
    [GSC_DEVICE_ROWS]: viewSql(GSC_DEVICE_ROWS, migrated, filter),
  };
  const have = new Map((db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'view' AND name IN (?, ?, ?)`)
    .all(GSC_ROWS, GSC_COUNTRY_ROWS, GSC_DEVICE_ROWS) as { name: string; sql: string }[]).map(r => [r.name, r.sql]));
  for (const [name, sql] of Object.entries(want)) {
    if (have.get(name) === sql) continue;
    db.exec(`DROP VIEW IF EXISTS ${name}`);
    db.exec(sql);
  }
}

const fingerprint = (db: Database.Database): string => {
  // Two scalar subqueries, not MAX and MIN in one SELECT: SQLite's O(log n) min/max shortcut only
  // applies to a lone aggregate (together they scan the table: ~0.7s on a 6M-row property).
  const r = db.prepare(`SELECT COALESCE((SELECT MAX(rowid) FROM search_analytics),0) mx, COALESCE((SELECT MIN(rowid) FROM search_analytics),0) mn`).get() as { mx: number; mn: number };
  return `${r.mx}:${r.mn}`;
};

export interface ShapeStat { shape: number; clicks: number; impressions: number; rows: number }
/** The fuller shape: most impressions, then most clicks, then the lower code (all-country first). */
export const pickShape = (stats: ShapeStat[]): number =>
  [...stats].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.shape - b.shape)[0].shape;

/** Per-shape figures of one day's rows in search_analytics (the #64 layout holds every shape there). */
const LEGACY_DAY_STATS_SQL = `SELECT ${shapeSql()} shape, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COUNT(*) rows
                             FROM search_analytics WHERE date = ? GROUP BY shape ORDER BY shape`;
interface DayChoice { total: number; country: number | null; device: number | null; shapes: string }
/** #64's choice for a day holding several shapes: the totals shape, and (when two segment shapes
 *  both carry a country / a device) the one the segment views read. */
function dayChoice(stats: ShapeStat[]): DayChoice {
  const withCountry = stats.filter(s => s.shape === 1 || s.shape === 3);
  const withDevice = stats.filter(s => s.shape === 2 || s.shape === 3);
  return {
    total: pickShape(stats),
    country: withCountry.length > 1 ? pickShape(withCountry) : null,
    device: withDevice.length > 1 ? pickShape(withDevice) : null,
    shapes: JSON.stringify(stats),
  };
}

/**
 * A NOT-yet-migrated layout (pending, or migrating with the migration deferred, e.g. for lack of
 * disk): after a sync wrote rows into search_analytics the #64 way, bring `gsc_day_shape` in line
 * for the days in [from, to], so the views never sum two shapes of one day. A day holding more than
 * one shape gets #64's choice (and, if it had been migrated, is handed back to the migration with
 * that choice); a pre-migration entry for a day no longer mixed is dropped; a migrated day's
 * evidence entry is kept. Then the views, in the same transaction. Returns the mixed days.
 */
export function refreshLegacyDayShapes(db: Database.Database, from: string, to: string): number {
  const stat = db.prepare(LEGACY_DAY_STATS_SQL);
  const dates = (db.prepare(`SELECT DISTINCT date FROM search_analytics WHERE date >= ? AND date <= ?
                             UNION SELECT date FROM gsc_day_shape WHERE date >= ? AND date <= ?`).all(from, to, from, to) as { date: string }[]).map(r => r.date);
  const upsert = db.prepare(`INSERT INTO gsc_day_shape (date, total_shape, country_shape, device_shape, shapes, totals_from) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(date) DO UPDATE SET total_shape = excluded.total_shape, country_shape = excluded.country_shape,
      device_shape = excluded.device_shape, shapes = excluded.shapes, totals_from = NULL`);
  const drop = db.prepare(`DELETE FROM gsc_day_shape WHERE date = ? AND totals_from IS NULL`);
  let mixed = 0;
  db.transaction(() => {
    for (const date of dates) {
      const stats = stat.all(date) as ShapeStat[];
      if (stats.length > 1) {
        const c = dayChoice(stats);
        upsert.run(date, c.total, c.country, c.device, c.shapes);
        mixed++;
      } else drop.run(date);
    }
    syncViews(db);
  })();
  return mixed;
}

/**
 * PENDING layout only: recompute #64's per-day choice from search_analytics. Returns the number of
 * days stored in more than one shape. Once the migration has started, `gsc_day_shape` is frozen
 * (the migration keeps it in step day by day), so this returns the listed days and changes nothing.
 */
export function refreshGscDayShapes(db: Database.Database): number {
  ensureGscRowsSchema(db);
  if (gscStorageState(db) !== 'pending') return (db.prepare(`SELECT COUNT(*) n FROM gsc_day_shape`).get() as { n: number }).n;
  const fp = fingerprint(db);
  const S = shapeSql();
  const mixed = (db.prepare(`SELECT date FROM search_analytics GROUP BY date HAVING MIN(${S}) <> MAX(${S}) ORDER BY date`).all() as { date: string }[]).map(r => r.date);
  const rows: ({ date: string } & DayChoice)[] = [];
  if (mixed.length) {
    const stat = db.prepare(LEGACY_DAY_STATS_SQL);
    for (const date of mixed) rows.push({ date, ...dayChoice(stat.all(date) as ShapeStat[]) });
  }
  const ins = db.prepare(`INSERT INTO gsc_day_shape (date, total_shape, country_shape, device_shape, shapes) VALUES (?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.exec('DELETE FROM gsc_day_shape');
    for (const r of rows) ins.run(r.date, r.total, r.country, r.device, r.shapes);
    db.prepare(`INSERT INTO gsc_day_shape_state (id, fingerprint, computed_at) VALUES (1, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint, computed_at = excluded.computed_at`).run(fp);
    syncViews(db); // same transaction: a reader never sees new choices behind an old view, or the reverse
  })();
  return mixed.length;
}

/**
 * Make sure the tables and views exist and match the layout. On a PENDING database (#64 layout,
 * not yet migrated) also recompute the per-day choice when search_analytics moved since the last
 * computation. Writable handles only. Cheap when nothing changed: two index lookups.
 */
export function ensureGscRows(db: Database.Database): void {
  if (db.readonly) return;
  ensureGscRowsSchema(db);
  if (gscStorageState(db) !== 'pending') return;
  const stored = (db.prepare(`SELECT fingerprint FROM gsc_day_shape_state WHERE id = 1`).get() as { fingerprint: string } | undefined)?.fingerprint;
  if (stored !== fingerprint(db)) refreshGscDayShapes(db);
}

/** True when the views are present (a read-only handle on a database never opened by this version has none). */
export function hasGscRows(db: Database.Database): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?`).get(GSC_ROWS);
}

/** Insert one day's segment rows of one shape into search_analytics, aggregated to the totals grain
 *  (date × query × page): clicks and impressions summed, position impression-weighted. */
export const AGGREGATE_DAY_SQL = `INSERT INTO search_analytics (${DATA_COLS})
  SELECT date, query, page, MIN(page_key), '', '', MIN(search_appearance), SUM(clicks), SUM(impressions),
         CASE WHEN SUM(impressions) > 0 THEN 1.0 * SUM(clicks) / SUM(impressions) ELSE 0 END,
         CASE WHEN SUM(impressions) > 0 THEN 1.0 * SUM(position * impressions) / SUM(impressions) ELSE AVG(position) END,
         MIN(created_at), MIN(search_type)
  FROM ${SEGMENTS} WHERE date = ? AND ${shapeSql()} = ? GROUP BY query, page`;

export interface SettleResult { days: number; derivedDays: number; recordedDays: number }

/**
 * After a sync (migrated layout): for each day in [from, to] that holds segment rows, make the
 * totals in search_analytics the fuller of (the stored all-country rows, the segment rows
 * aggregated). A day with no all-country rows gets the aggregate, so a property synced only with
 * segments keeps its totals. When both exist and disagree, the day goes in `gsc_day_shape` as
 * evidence. `segmentsReplaced`: a segment sync replaced
 * the window, so any legacy per-day segment choice in it is cleared (one segment shape per day now).
 */
export function settleGscTotals(db: Database.Database, from: string, to: string, segmentsReplaced = false): SettleResult {
  const days = (db.prepare(`SELECT DISTINCT date FROM ${SEGMENTS} WHERE date >= ? AND date <= ? ORDER BY date`).all(from, to) as { date: string }[]).map(r => r.date);
  const segStat = db.prepare(`SELECT ${shapeSql()} shape, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COUNT(*) rows
                              FROM ${SEGMENTS} WHERE date = ? GROUP BY shape ORDER BY shape`);
  const totStat = db.prepare(`SELECT 0 shape, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COUNT(*) rows FROM search_analytics WHERE date = ?`);
  const delTotals = db.prepare(`DELETE FROM search_analytics WHERE date = ?`);
  const aggregate = db.prepare(AGGREGATE_DAY_SQL);
  const evidence = db.prepare(`INSERT INTO gsc_day_shape (date, total_shape, country_shape, device_shape, shapes, totals_from) VALUES (?, 0, NULL, NULL, ?, ?)
    ON CONFLICT(date) DO UPDATE SET total_shape = 0, shapes = excluded.shapes, totals_from = excluded.totals_from`);
  let derived = 0, recorded = 0;
  db.transaction(() => {
    if (segmentsReplaced) db.prepare(`UPDATE gsc_day_shape SET country_shape = NULL, device_shape = NULL WHERE date >= ? AND date <= ?`).run(from, to);
    for (const date of days) {
      const seg = segStat.all(date) as ShapeStat[];
      const tot = totStat.get(date) as ShapeStat;
      const segPick = pickShape(seg); // the fuller segment shape is the aggregate candidate
      const chosen = pickShape(tot.rows ? [tot, ...seg] : seg);
      if (chosen !== 0) {
        delTotals.run(date);
        aggregate.run(date, segPick);
        derived++;
      }
      const s = seg.find(x => x.shape === segPick)!;
      const disagree = tot.rows > 0 && (s.clicks !== tot.clicks || s.impressions !== tot.impressions);
      if (disagree) { evidence.run(date, JSON.stringify([tot, ...seg]), chosen); recorded++; }
    }
    syncViews(db);
  })();
  return { days: days.length, derivedDays: derived, recordedDays: recorded };
}

/** Days whose all-country and segment rows were both stored, for the UI note. Null when there are none. */
export interface GscShape {
  mixedDays: number;
  from: string;
  to: string;
  /** The shapes held on those days (e.g. ["all-country", "per-country"]). */
  shapes: string[];
}
export function gscMixedShape(db: Database.Database): GscShape | null {
  if (!hasGscRows(db)) return null;
  const r = db.prepare(`SELECT COUNT(*) n, MIN(date) lo, MAX(date) hi FROM gsc_day_shape`).get() as { n: number; lo: string | null; hi: string | null };
  if (!r.n || !r.lo || !r.hi) return null;
  const codes = new Set<number>();
  for (const { shapes } of db.prepare(`SELECT shapes FROM gsc_day_shape`).all() as { shapes: string }[]) {
    for (const s of JSON.parse(shapes) as ShapeStat[]) codes.add(s.shape);
  }
  return { mixedDays: r.n, from: r.lo, to: r.hi, shapes: [...codes].sort().map(c => SHAPE_NAMES[c]) };
}
