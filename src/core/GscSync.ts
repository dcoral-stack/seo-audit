import { AuditDatabase } from './AuditDatabase.js';
import { addQueries } from './fts.js';
import { SEGMENTS, gscStorageState, settleGscTotals, type SettleResult } from './gscRows.js';
import { migrateGscStorage, type GscMigrationResult } from './gscMigrate.js';
import { GscClient } from './GscClient.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';
import type { FetchOptions, GscApiRow } from './types.js';

// Lean default: date×query×page is everything the audit + merged checks need, without
// the device×country multiplication that explodes row counts on large sites. Pass
// FULL_DIMENSIONS (segments) to also populate the device/country breakdowns.
const LITE_DIMENSIONS = ['date', 'query', 'page'];
export const FULL_DIMENSIONS = ['date', 'query', 'page', 'device', 'country'];

/** Days re-pulled (and replaced) before the last stored date: GSC restates the most recent days. */
export const LAG_DAYS = 4;

/** Where an incremental sync resumes: last stored date minus LAG_DAYS, never before the requested start. */
export function incrementalStart(maxStoredDate: string | null, requestedStart: string): string {
  return planIncremental(maxStoredDate, requestedStart, '9999-12-31').startDate;
}

/** The one incremental rule, shared by run() and plannedRange(): the range to fetch, whether the
 *  re-pulled lag days are replaced (from replaceFrom), and whether there is nothing to fetch. */
export function planIncremental(maxStoredDate: string | null, start: string, end: string): { startDate: string; replaceFrom: string | null; noop: boolean } {
  if (!maxStoredDate) return { startDate: start, replaceFrom: null, noop: false };
  const resume = new Date(Date.parse(maxStoredDate) - LAG_DAYS * 86400000).toISOString().slice(0, 10);
  if (resume > end) return { startDate: start, replaceFrom: null, noop: true }; // already synced past the requested window
  return resume > start ? { startDate: resume, replaceFrom: resume, noop: false } : { startDate: start, replaceFrom: null, noop: false };
}

export interface SyncResult {
  siteUrl: string;
  rowsFetched: number;
  startDate: string;
  endDate: string;
  /** Where the rows went: search_analytics (all-country totals) or search_analytics_segments (#65). */
  table?: string;
  /** Totals settled from segment rows over the synced window (#65). */
  settled?: SettleResult;
  /** The one-time storage migration, when this sync ran it (#65). */
  migration?: GscMigrationResult;
}

/** True when a dimension set produces segment rows (a device or a country). */
export const isSegmentSync = (dims: string[]): boolean => dims.includes('device') || dims.includes('country');

const daysBefore = (date: string, n: number): string => new Date(Date.parse(date) - n * 86400000).toISOString().slice(0, 10);

/**
 * Fetch GSC search analytics into a property's SQLite DB, computing the
 * normalised `page_key` on write so it joins to crawl data later.
 */
export class GscSync {
  constructor(private readonly gsc: GscClient, private readonly dataDir: string) {}

  /** The range a sync with these options will fetch, for the start reply (#33). A shape change
   *  (lite ↔ segmented, or a different search type) still forces the full window; the finished job
   *  reports the range actually used. */
  plannedRange(siteUrl: string, options: FetchOptions): { startDate: string; endDate: string; incremental: boolean; noop?: boolean } {
    if (options.fullResync) return { startDate: options.startDate, endDate: options.endDate, incremental: false };
    let mx: string | null = null;
    try {
      const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
      const table = isSegmentSync(options.dimensions ?? LITE_DIMENSIONS) ? SEGMENTS : 'search_analytics';
      try { mx = (db.db.prepare(`SELECT MAX(date) d FROM ${table}`).get() as { d: string | null }).d; } finally { db.close(); }
    } catch { /* no DB yet */ }
    const plan = planIncremental(mx, options.startDate, options.endDate);
    return { startDate: plan.startDate, endDate: options.endDate, incremental: plan.startDate !== options.startDate, ...(plan.noop ? { noop: true } : {}) };
  }

  async run(
    siteUrl: string,
    options: FetchOptions,
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<SyncResult> {
    const dbFile = dbPathFor(this.dataDir, siteUrl);
    const db = new AuditDatabase(dbFile);
    try {
      const hostForm = hostFormForProperty(siteUrl);
      db.upsertProperty(siteUrl, hostForm ?? 'asis');

      // ── One-time storage migration (#65) ───────────────────────────────────────────────────
      // A database still in the #64 layout (segment rows mixed into search_analytics) is moved
      // first: backup, then day-by-day batches. Refused for lack of disk = this sync fails with the
      // reason and nothing changes. Aborted part-way = it resumes on the next sync.
      let migration: GscMigrationResult | undefined;
      if (gscStorageState(db.db) !== 'done') {
        // Progress rides its own key: `phase` belongs to the caller (refresh_property's widget).
        update({ siteUrl, storageMigration: { phase: 'starting' } });
        migration = await migrateGscStorage(db.db, dbFile, { signal, onProgress: p => update({ siteUrl, storageMigration: p }) });
        if (migration.refused) throw new Error(migration.refused);
        if (gscStorageState(db.db) !== 'done') return { siteUrl, rowsFetched: 0, startDate: options.startDate, endDate: options.endDate, migration };
      }

      let options2: FetchOptions = { ...options, dimensions: options.dimensions ?? LITE_DIMENSIONS };
      let dims = options2.dimensions!;
      // The stored grain is date × query × page: a sync without one of them would write rows that
      // every reader mistakes for that grain (and the totals aggregation could not rebuild).
      const missing = ['date', 'query', 'page'].filter(d => !dims.includes(d));
      if (missing.length) throw new Error(`GSC sync needs the date, query and page dimensions (the stored grain); missing ${missing.join(', ')} in [${dims.join(', ')}].`);
      const maxDate = (table: string): string | null => (db.db.prepare(`SELECT MAX(date) d FROM ${table}`).get() as { d: string | null }).d;
      // Keep segmenting a property whose segment rows are kept current: before #65 a lite sync over
      // segmented history re-aimed to segments so the breakdowns never went stale. Same rule, now
      // judged by whether the segment table reaches the totals' last days.
      if (!isSegmentSync(dims)) {
        const segMax = maxDate(SEGMENTS), totMax = maxDate('search_analytics');
        if (segMax && (!totMax || segMax >= daysBefore(totMax, LAG_DAYS))) {
          options2 = { ...options2, dimensions: FULL_DIMENSIONS };
          dims = options2.dimensions!;
        }
      }
      // The sync guard (#65): segment rows go to search_analytics_segments, all-country rows to
      // search_analytics, never the other way (each table's trigger refuses the wrong shape too).
      const segments = isSegmentSync(dims);
      const table = segments ? SEGMENTS : 'search_analytics';

      const insert = db.db.prepare(
        `INSERT INTO ${table}
           (date, query, page, page_key, device, country, search_type, clicks, impressions, ctr, position)
         VALUES (@date, @query, @page, @page_key, @device, @country, @search_type, @clicks, @impressions, @ctr, @position)
         ON CONFLICT(date, query, page, device, country) DO UPDATE SET
           clicks = excluded.clicks, impressions = excluded.impressions, search_type = excluded.search_type,
           ctr = excluded.ctr, position = excluded.position, page_key = excluded.page_key`,
      );
      // Distinct-query FTS index (#35): each batch's NEW distinct queries go in inside the batch's
      // own transaction. seenQueries spans the run so repeat queries across batches cost nothing.
      const seenQueries = new Set<string>();
      const indexQueries = (records: Record<string, unknown>[]): void => {
        const fresh: string[] = [];
        for (const r of records) { const q = r.query; if (typeof q === 'string' && !seenQueries.has(q)) { seenQueries.add(q); fresh.push(q); } }
        if (fresh.length) addQueries(db.db, fresh);
      };
      const insertMany = db.db.transaction((records: Record<string, unknown>[]) => {
        for (const r of records) insert.run(r);
        indexQueries(records);
      });

      let total = 0;
      // Search-type guard: the unique indexes (date,query,page,device,country) do NOT include
      // search_type (rebuilding them on existing rows would rewrite months of history), so the
      // property holds ONE search type at a time. Syncing a different type (e.g. discover over web
      // history) would silently mix/overwrite rows; it wipes both tables instead, and the wipe rides
      // the first fetched batch's transaction, so a failed fetch destroys nothing.
      const wantType = options.searchType ?? 'web';
      const storedTypes = (db.db
        .prepare(`SELECT COALESCE(search_type, 'web') t FROM search_analytics UNION SELECT COALESCE(search_type, 'web') FROM ${SEGMENTS}`)
        .all() as { t: string }[]).map(r => r.t);
      let mustWipe = storedTypes.length > 0 && (storedTypes.length > 1 || storedTypes[0] !== wantType);
      const wipeAndInsert = db.db.transaction((records: Record<string, unknown>[]) => {
        db.db.exec(`DELETE FROM search_analytics; DELETE FROM ${SEGMENTS}; DELETE FROM gsc_day_shape;`);
        for (const r of records) insert.run(r);
        indexQueries(records);
      });
      // Lag-day replace (#22), made atomic: re-pulled rows are STAGED in a temp table while GSC pages
      // in, then one transaction deletes exactly the re-pulled window [from, endDate] and inserts the
      // staged rows — only after the whole fetch succeeded and returned rows. A failure or abort on
      // any page leaves the stored days untouched, and rows after endDate are never touched.
      const STAGE_COLS = 'date, query, page, page_key, device, country, search_type, clicks, impressions, ctr, position';
      const stageRows = (records: Record<string, unknown>[]): void => {
        db.db.exec(`CREATE TEMP TABLE IF NOT EXISTS sa_stage (${STAGE_COLS})`);
        const ins = db.db.prepare(`INSERT INTO sa_stage (${STAGE_COLS}) VALUES (@date, @query, @page, @page_key, @device, @country, @search_type, @clicks, @impressions, @ctr, @position)`);
        db.db.transaction(() => { for (const r of records) ins.run(r); })();
      };
      const applyStaged = db.db.transaction((from: string, to: string) => {
        db.db.prepare(`DELETE FROM ${table} WHERE date >= ? AND date <= ?`).run(from, to);
        db.db.exec(`INSERT INTO ${table} (${STAGE_COLS}) SELECT ${STAGE_COLS} FROM sa_stage WHERE true
          ON CONFLICT(date, query, page, device, country) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
            search_type = excluded.search_type, ctr = excluded.ctr, position = excluded.position, page_key = excluded.page_key`);
        db.db.exec(`INSERT OR IGNORE INTO sa_queries(query) SELECT DISTINCT query FROM sa_stage WHERE query IS NOT NULL`);
        db.db.exec('DELETE FROM sa_stage');
      });

      // ── Incremental resume ─────────────────────────────────────────────────────────────────
      // The first sync pulls the requested window; every sync after that only fetches from the
      // last stored date (in the table this sync writes) minus a lag buffer (GSC restates the most
      // recent few days), instead of re-pulling the whole window. Turns a 30-minute, 1.8M-row refresh
      // into a seconds-long delta. A pending search-type wipe pulls the full window. `fullResync`
      // forces the full window. Only ever NARROWS the window (never widens past the requested start).
      // Re-pulled lag days are REPLACED, not merged (#22): GSC can drop or merge rows while a day
      // finalises, and an upsert would leave those stale rows behind. See stageRows/applyStaged.
      const result = (rowsFetched: number, extra: Partial<SyncResult> = {}): SyncResult =>
        ({ siteUrl, rowsFetched, startDate: options2.startDate, endDate: options2.endDate, table, ...extra, ...(migration ? { migration } : {}) });
      let replaceFrom: string | null = null;
      if (!options.fullResync && !mustWipe) {
        const plan = planIncremental(maxDate(table), options2.startDate, options2.endDate);
        // Already synced past the requested window (e.g. a historical/comparison pull whose
        // endDate predates the stored data): no-op instead of calling GSC with start > end.
        if (plan.noop) {
          db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
          return result(0);
        }
        if (plan.replaceFrom) { options2 = { ...options2, startDate: plan.startDate }; replaceFrom = plan.replaceFrom; }
      }
      // A full-window segment sync over stored segment rows replaces that window (deferred into the
      // first batch's transaction, like the wipe), so a day never holds two segment shapes.
      let replaceWindow = segments && !mustWipe && !replaceFrom
        && !!db.db.prepare(`SELECT 1 FROM ${SEGMENTS} WHERE date >= ? AND date <= ? LIMIT 1`).get(options2.startDate, options2.endDate);
      const windowAndInsert = db.db.transaction((records: Record<string, unknown>[]) => {
        db.db.prepare(`DELETE FROM ${SEGMENTS} WHERE date >= ? AND date <= ?`).run(options2.startDate, options2.endDate);
        for (const r of records) insert.run(r);
        indexQueries(records);
      });

      await this.gsc.fetchSearchAnalytics(siteUrl, options2, signal, ({ rows }) => {
        const records = rows.map((row: GscApiRow) => {
          const keys = row.keys ?? [];
          const rec: Record<string, string | null> = {};
          dims.forEach((d, i) => (rec[d] = keys[i] ?? null));
          const page = rec.page;
          return {
            date: rec.date,
            query: rec.query ?? null,
            page: page ?? null,
            page_key: page ? urlKey(page, { hostForm }) : null,
            device: rec.device ?? '', // '' = not segmented; keeps the unique index dedup working
            country: rec.country ?? '',
            search_type: wantType,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          };
        });
        if (mustWipe) { wipeAndInsert(records); mustWipe = false; }
        else if (replaceWindow) { windowAndInsert(records); replaceWindow = false; }
        else if (replaceFrom) stageRows(records);
        else insertMany(records);
        total += records.length;
        update({ siteUrl, rowsFetched: total });
      });

      if (replaceFrom) {
        if (signal.aborted) return result(0); // staged rows discarded with the connection
        if (total > 0) applyStaged(replaceFrom, options2.endDate); // an empty response never wipes stored days
      }
      // The writer owns the totals: over the synced window, each day's totals in search_analytics
      // become the fuller of the all-country rows and the segment rows aggregated (#65).
      const settled = total > 0 ? settleGscTotals(db.db, options2.startDate, options2.endDate, segments) : undefined;
      db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
      return result(total, settled ? { settled } : {});
    } finally {
      db.close();
    }
  }
}
