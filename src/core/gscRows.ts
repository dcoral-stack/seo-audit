/**
 * gscRows — count every GSC day ONCE.
 *
 * `search_analytics` stores one row per (date, query, page, device, country). A sync writes one
 * row SHAPE: lite rows (device = '' AND country = '', the all-country totals) or segmented rows
 * (country-only, device-only, or device × country, depending on the dimensions requested). Each
 * shape on its own adds up to the day's totals, but a database can hold MORE than one shape for
 * the same day: simracingcockpit.gg holds lite AND country rows for 111 days (18 May to 5 Sep
 * 2026), because a country-only sync is not caught by GscSync's lite/segmented guard (which keys
 * on `device`). A plain `SUM(clicks)` over those days counts every click twice (issue #61).
 *
 * The fix is one row set per day, chosen ONCE and shared by every reader:
 *
 *   - `gsc_day_shape` (table) holds, for each day stored in more than one shape, the shape to
 *     read. Days held in a single shape are not listed and pass through untouched.
 *   - `gsc_rows` (view) = `search_analytics` minus the rows of the shapes not chosen. Every
 *     total (KPIs, trends, movers, audit period comparisons, query_data) reads this view.
 *   - `gsc_country_rows` / `gsc_device_rows` (views) = the rows that carry a country / device,
 *     with the same one-shape-per-day rule among the shapes that carry it (country-only vs
 *     device × country rows). The country and device breakdowns read these on purpose.
 *
 * The rule for a mixed day: read the shape with the MOST impressions (then most clicks, then lite
 * first). One shape is read whole, so clicks, impressions and position stay internally
 * consistent for that day. Why impressions and not "lite wins": on simracingcockpit.gg the lite
 * rows written for 1 Jun to 13 Aug 2026 held only the query/page rows that got a click, so their
 * clicks match the country rows exactly but their impressions are a fraction (June: 1.13M vs
 * 2.52M); and on 5 Sep the country rows are a partial day (141 clicks vs 903). A truncated row
 * set always loses impressions, so the shape with the most impressions is the complete one.
 *
 * Freshness: the choice depends on the data, so it is recomputed whenever `search_analytics`
 * changes. The writer (GscSync) refreshes it after every sync, and every writable open
 * (AuditDatabase) re-checks a cheap fingerprint (MAX/MIN rowid; ids are AUTOINCREMENT, so any
 * insert or wipe-and-reinsert moves it) and recomputes only when it moved. A read-only handle
 * reads whatever was last computed.
 *
 * Rule for readers: a TOTAL reads `gsc_rows`; a breakdown BY country or device reads
 * `gsc_country_rows` / `gsc_device_rows`. Never `SUM` over `search_analytics` directly.
 * (Raw `search_analytics` is still right for row counts, MIN/MAX(date) and the writers.)
 */
import type Database from 'better-sqlite3';

/** Totals view: one row set per day. */
export const GSC_ROWS = 'gsc_rows';
/** Rows that carry a country, one country-carrying shape per day. */
export const GSC_COUNTRY_ROWS = 'gsc_country_rows';
/** Rows that carry a device, one device-carrying shape per day. */
export const GSC_DEVICE_ROWS = 'gsc_device_rows';

/** Shape code of a row: 0 lite, 1 country-only, 2 device-only, 3 device × country. NULL counts as ''. */
export const shapeSql = (alias = ''): string => {
  const a = alias ? `${alias}.` : '';
  return `((COALESCE(${a}device,'') <> '') * 2 + (COALESCE(${a}country,'') <> ''))`;
};
const SHAPE_NAMES = ['all-country', 'per-country', 'per-device', 'per-device-and-country'] as const;

/**
 * View definitions. With no mixed day (every property synced in one shape, the usual case) a view is
 * a plain pass-through, so SQLite keeps using the covering indexes on (date, clicks, impressions...)
 * and nothing gets slower. Only when `gsc_day_shape` lists days does the view carry the per-row shape
 * test, which has to read device and country from the table (no covering index holds them).
 */
const viewSql = (name: string, filtered: boolean): string => {
  const col = name === GSC_COUNTRY_ROWS ? 'country_shape' : name === GSC_DEVICE_ROWS ? 'device_shape' : 'total_shape';
  const carries = name === GSC_COUNTRY_ROWS ? `COALESCE(sa.country,'') <> ''` : name === GSC_DEVICE_ROWS ? `COALESCE(sa.device,'') <> ''` : '';
  const pick = filtered
    ? `(sa.date NOT IN (SELECT date FROM gsc_day_shape WHERE ${col} IS NOT NULL)
       OR ${shapeSql('sa')} = (SELECT g.${col} FROM gsc_day_shape g WHERE g.date = sa.date))`
    : '';
  const where = [carries, pick].filter(Boolean).join('\n      AND ');
  return `CREATE VIEW ${name} AS SELECT sa.* FROM search_analytics sa${where ? `\n    WHERE ${where}` : ''}`;
};

/** Create the shape table and its state row (idempotent), then bring the three views in line with it. */
export function ensureGscRowsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gsc_day_shape (
      date TEXT PRIMARY KEY,
      total_shape INTEGER NOT NULL,   -- the shape gsc_rows reads on this day
      country_shape INTEGER,          -- the shape gsc_country_rows reads (NULL = only one carries country)
      device_shape INTEGER,           -- the shape gsc_device_rows reads (NULL = only one carries device)
      shapes TEXT NOT NULL            -- JSON [{shape, clicks, impressions, rows}] behind the choice (evidence)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS gsc_day_shape_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fingerprint TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );
  `);
  syncViews(db);
}

/** (Re)create each view whose definition no longer matches what `gsc_day_shape` needs. */
function syncViews(db: Database.Database): void {
  const need = db.prepare(`SELECT EXISTS(SELECT 1 FROM gsc_day_shape) t,
    EXISTS(SELECT 1 FROM gsc_day_shape WHERE country_shape IS NOT NULL) c,
    EXISTS(SELECT 1 FROM gsc_day_shape WHERE device_shape IS NOT NULL) d`).get() as { t: number; c: number; d: number };
  const want: Record<string, string> = {
    [GSC_ROWS]: viewSql(GSC_ROWS, !!need.t),
    [GSC_COUNTRY_ROWS]: viewSql(GSC_COUNTRY_ROWS, !!need.c),
    [GSC_DEVICE_ROWS]: viewSql(GSC_DEVICE_ROWS, !!need.d),
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

interface ShapeStat { shape: number; clicks: number; impressions: number; rows: number }
/** The shape to read: most impressions, then most clicks, then the lower code (lite first). */
const pick = (stats: ShapeStat[]): number =>
  [...stats].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.shape - b.shape)[0].shape;

/** Recompute `gsc_day_shape` from the data. Returns the number of days stored in more than one shape. */
export function refreshGscDayShapes(db: Database.Database): number {
  ensureGscRowsSchema(db);
  const fp = fingerprint(db);
  // Mixed days first (min shape <> max shape), then per-shape totals for just those days.
  const S = shapeSql();
  const mixed = (db.prepare(`SELECT date FROM search_analytics GROUP BY date HAVING MIN(${S}) <> MAX(${S}) ORDER BY date`).all() as { date: string }[]).map(r => r.date);
  const rows: { date: string; total: number; country: number | null; device: number | null; shapes: string }[] = [];
  if (mixed.length) {
    const stat = db.prepare(`SELECT ${S} shape, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COUNT(*) rows
                             FROM search_analytics WHERE date = ? GROUP BY shape ORDER BY shape`);
    for (const date of mixed) {
      const stats = stat.all(date) as ShapeStat[];
      const withCountry = stats.filter(s => s.shape === 1 || s.shape === 3);
      const withDevice = stats.filter(s => s.shape === 2 || s.shape === 3);
      rows.push({
        date,
        total: pick(stats),
        country: withCountry.length > 1 ? pick(withCountry) : null,
        device: withDevice.length > 1 ? pick(withDevice) : null,
        shapes: JSON.stringify(stats),
      });
    }
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
 * Make sure the views exist and the per-day choice matches the data; recompute only when
 * `search_analytics` changed since the last computation. Writable handles only (a read-only
 * handle reads what the last writer computed). Cheap when nothing changed: two index lookups.
 */
export function ensureGscRows(db: Database.Database): void {
  if (db.readonly) return;
  ensureGscRowsSchema(db);
  const stored = (db.prepare(`SELECT fingerprint FROM gsc_day_shape_state WHERE id = 1`).get() as { fingerprint: string } | undefined)?.fingerprint;
  if (stored !== fingerprint(db)) refreshGscDayShapes(db);
}

/** True when the views are present (a read-only handle on a database never opened by this version has none). */
export function hasGscRows(db: Database.Database): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?`).get(GSC_ROWS);
}

/** Days stored in more than one row shape, for the UI note. Null when every day has one shape. */
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
