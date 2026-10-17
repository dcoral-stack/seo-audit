import { AuditDatabase } from './AuditDatabase.js';
import { addQueries } from './fts.js';
import { refreshGscDayShapes } from './gscRows.js';
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
}

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
      try { mx = (db.db.prepare('SELECT MAX(date) d FROM search_analytics').get() as { d: string | null }).d; } finally { db.close(); }
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
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      const hostForm = hostFormForProperty(siteUrl);
      db.upsertProperty(siteUrl, hostForm ?? 'asis');

      const insert = db.db.prepare(
        `INSERT INTO search_analytics
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
      let options2: FetchOptions = { ...options, dimensions: options.dimensions ?? LITE_DIMENSIONS };
      let dims = options2.dimensions!;

      // Summary/totals SUM across one grouping. Mixing lite (device='') with segmented
      // (device='DESKTOP'…) rows would double-count, so the table holds ONE grouping shape.
      const cnt = (sql: string): number => (db.db.prepare(sql).get() as { n: number }).n;
      const hasLite = cnt(`SELECT COUNT(*) n FROM search_analytics WHERE device = ''`) > 0;
      const hasSegmented = cnt(`SELECT COUNT(*) n FROM search_analytics WHERE device <> ''`) > 0;
      // PRESERVE existing history: a routine (default/lite) sync over segmented history must NOT
      // wipe it — keep segmenting instead, so a short window sync never destroys months of data.
      if (!dims.includes('device') && hasSegmented && !hasLite) {
        options2 = { ...options2, dimensions: FULL_DIMENSIONS };
        dims = options2.dimensions!;
      }
      const wantsSegments = dims.includes('device');
      // Only wipe on a genuine, unavoidable shape conflict (e.g. an explicit lite→segmented
      // upgrade, or a pre-existing mixed table) — never on the routine preserve path above.
      // The wipe is DEFERRED into the same transaction as the first fetched batch: if the
      // API call fails or the job is aborted before any rows arrive, months of history are
      // NOT destroyed and replaced by nothing.
      let mustWipe = (wantsSegments && hasLite) || (!wantsSegments && hasSegmented);
      // Search-type guard (mirrors the lite/segmented shape-guard): the unique index
      // (date,query,page,device,country) does NOT include search_type — rebuilding it on existing
      // rows would rewrite months of history — so the table holds ONE search type at a time.
      // Syncing a different type (e.g. discover over web history) would silently mix/overwrite
      // rows; treat it as a shape conflict instead, and let the wipe ride the first batch's
      // transaction exactly like the lite/segmented wipe (a failed fetch destroys nothing).
      const wantType = options.searchType ?? 'web';
      const storedTypes = (db.db
        .prepare(`SELECT DISTINCT COALESCE(search_type, 'web') t FROM search_analytics`)
        .all() as { t: string }[]).map(r => r.t);
      if (storedTypes.length && (storedTypes.length > 1 || storedTypes[0] !== wantType)) mustWipe = true;
      const wipeAndInsert = db.db.transaction((records: Record<string, unknown>[]) => {
        db.db.exec('DELETE FROM search_analytics');
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
        db.db.prepare('DELETE FROM search_analytics WHERE date >= ? AND date <= ?').run(from, to);
        db.db.exec(`INSERT INTO search_analytics (${STAGE_COLS}) SELECT ${STAGE_COLS} FROM sa_stage WHERE true
          ON CONFLICT(date, query, page, device, country) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
            search_type = excluded.search_type, ctr = excluded.ctr, position = excluded.position, page_key = excluded.page_key`);
        db.db.exec(`INSERT OR IGNORE INTO sa_queries(query) SELECT DISTINCT query FROM sa_stage WHERE query IS NOT NULL`);
        db.db.exec('DELETE FROM sa_stage');
      });

      // ── Incremental resume ─────────────────────────────────────────────────────────────────
      // The first sync pulls the requested window; every sync after that only fetches from the
      // last stored date minus a lag buffer (GSC restates the most recent few days), instead of
      // re-pulling the whole window. Turns a 30-minute, 1.8M-row refresh into a seconds-long delta.
      // Runs AFTER the mode-guard: if the table was just wiped (shape conflict) MAX(date) is null →
      // full window. `fullResync` forces the full window. Only ever NARROWS the window (never widens
      // past the requested start), and resumes from wherever the data left off (covers any gap).
      // Re-pulled lag days are REPLACED, not merged (#22): GSC can drop or merge rows while a day
      // finalises, and an upsert would leave those stale rows behind. See stageRows/applyStaged.
      let replaceFrom: string | null = null;
      if (!options.fullResync && !mustWipe) { // a pending wipe means the stored MAX(date) is the OLD shape's — pull the full window
        const mx = (db.db.prepare('SELECT MAX(date) d FROM search_analytics').get() as { d: string | null }).d;
        const plan = planIncremental(mx, options2.startDate, options2.endDate);
        // Already synced past the requested window (e.g. a historical/comparison pull whose
        // endDate predates the stored data): no-op instead of calling GSC with start > end.
        if (plan.noop) {
          db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
          return { siteUrl, rowsFetched: 0, startDate: options2.startDate, endDate: options2.endDate };
        }
        if (plan.replaceFrom) { options2 = { ...options2, startDate: plan.startDate }; replaceFrom = plan.replaceFrom; }
      }

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
            device: rec.device ?? '', // '' = not segmented (lite); keeps the unique index dedup working
            country: rec.country ?? '',
            search_type: wantType,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          };
        });
        if (mustWipe) { wipeAndInsert(records); mustWipe = false; }
        else if (replaceFrom) stageRows(records);
        else insertMany(records);
        total += records.length;
        update({ siteUrl, rowsFetched: total });
      });

      if (replaceFrom) {
        if (signal.aborted) return { siteUrl, rowsFetched: 0, startDate: options2.startDate, endDate: options2.endDate }; // staged rows discarded with the connection
        if (total > 0) applyStaged(replaceFrom, options2.endDate); // an empty response never wipes stored days
      }
      // The writer owns the evidence: recompute which row shape each day is read from (gsc_rows, #61)
      // now, rather than leaving it to the next reader's fingerprint check.
      if (total > 0) refreshGscDayShapes(db.db);
      db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
      return { siteUrl, rowsFetched: total, startDate: options2.startDate, endDate: options2.endDate };
    } finally {
      db.close();
    }
  }
}
