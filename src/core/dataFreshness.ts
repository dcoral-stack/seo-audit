import type Database from 'better-sqlite3';

/**
 * Data freshness / job status for the dashboard, read from the property DB, never from the
 * in-memory JobManager: the standalone dashboard sidecar (src/dashboard.ts) runs in a separate
 * process that never sees the MCP's jobs, so the only shared truth is what the jobs wrote.
 *
 * Every query here is a cheap aggregate or a LIMIT-ed read, so this runs on every dashboard load
 * OUTSIDE the payload cache (the cache version doesn't track crawl runs that wrote no pages, or
 * a failed sync), keeping the status panel current.
 */
export interface FreshnessSource {
  kind: 'sync' | 'crawl' | 'audit' | 'inspect' | 'ranks' | 'sitemap';
  /** completed | running | failed | interrupted | cancelled | never */
  state: string;
  /** Timestamp of the last finish (or the start when still running / never finished). */
  at: string | null;
  /** One short, human line: the window or the volume covered. */
  detail: string;
  error?: string | null;
}

export interface DataFreshness {
  sources: FreshnessSource[];
  /** The last few crawl runs, newest first. */
  crawlRuns: { crawlId: string; status: string; startedAt: string | null; finishedAt: string | null; crawled: number; failed: number; durationMs: number | null }[];
}

const fmtN = (n: number): string => n.toLocaleString('en-US');

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

/** When the newest crawl run is not a completed one, name the last completed run too (its pages
 * are what the dashboard is showing). A 'running' row with no live job is a crawl that died with
 * its server process; the data on screen is still the last completed crawl. */
function lastGood(rows: { status: string | null; finished_at: string | null; started_at: string | null; urls_crawled: number | null }[], latest: { status: string | null }): string {
  if (latest.status === 'completed') return '';
  const ok = rows.find(r => r.status === 'completed');
  return ok ? `; showing the last completed crawl (${(ok.finished_at ?? ok.started_at ?? '').slice(0, 10)}, ${fmtN(ok.urls_crawled ?? 0)} URLs)` : '';
}

export function getDataFreshness(db: Database.Database): DataFreshness {
  const sources: FreshnessSource[] = [];

  // GSC sync: property_meta.last_synced_at + the stored date span.
  if (tableExists(db, 'search_analytics')) {
    const meta = tableExists(db, 'property_meta')
      ? db.prepare(`SELECT last_synced_at FROM property_meta ORDER BY COALESCE(last_synced_at,'') DESC LIMIT 1`).get() as { last_synced_at: string | null } | undefined
      : undefined;
    const span = db.prepare(`SELECT MIN(date) lo, MAX(date) hi FROM search_analytics`).get() as { lo: string | null; hi: string | null };
    sources.push({
      kind: 'sync',
      state: span.hi ? 'completed' : 'never',
      at: meta?.last_synced_at ?? null,
      detail: span.hi ? `Search Console ${span.lo} to ${span.hi}` : 'No Search Console data yet - run sync_gsc',
    });
  }

  // Crawl: the latest run of any status (a running or failed crawl is exactly what to show).
  let crawlRuns: DataFreshness['crawlRuns'] = [];
  if (tableExists(db, 'crawl_metadata')) {
    const rows = db.prepare(
      `SELECT crawl_id, status, started_at, finished_at, urls_crawled, urls_failed, duration_ms, error
       FROM crawl_metadata ORDER BY COALESCE(started_at, finished_at, '') DESC, rowid DESC LIMIT 6`,
    ).all() as { crawl_id: string; status: string | null; started_at: string | null; finished_at: string | null; urls_crawled: number | null; urls_failed: number | null; duration_ms: number | null; error: string | null }[];
    crawlRuns = rows.map(r => ({ crawlId: r.crawl_id, status: r.status ?? 'unknown', startedAt: r.started_at, finishedAt: r.finished_at, crawled: r.urls_crawled ?? 0, failed: r.urls_failed ?? 0, durationMs: r.duration_ms }));
    const latest = rows[0];
    sources.push(latest
      ? {
        kind: 'crawl',
        state: latest.status ?? 'unknown',
        at: latest.finished_at ?? latest.started_at,
        detail: `${fmtN(latest.urls_crawled ?? 0)} URLs crawled${latest.urls_failed ? `, ${fmtN(latest.urls_failed)} failed` : ''}` + lastGood(rows, latest),
        error: latest.error,
      }
      : { kind: 'crawl', state: 'never', at: null, detail: 'No crawl yet - run start_crawl or refresh_property' });
  }

  // Audit: the latest run.
  if (tableExists(db, 'audit_runs')) {
    const a = db.prepare(`SELECT scope, started_at, finished_at, finding_count FROM audit_runs ORDER BY started_at DESC LIMIT 1`).get() as
      { scope: string | null; started_at: string | null; finished_at: string | null; finding_count: number | null } | undefined;
    sources.push(a
      ? { kind: 'audit', state: a.finished_at ? 'completed' : 'running', at: a.finished_at ?? a.started_at, detail: `${fmtN(a.finding_count ?? 0)} findings${a.scope ? `, ${a.scope} scope` : ''}` }
      : { kind: 'audit', state: 'never', at: null, detail: 'No audit yet - run run_audit' });
  }

  // URL inspection: how many URLs, when last inspected.
  if (tableExists(db, 'url_inspection')) {
    const i = db.prepare(`SELECT COUNT(*) n, MAX(inspected_at) at FROM url_inspection`).get() as { n: number; at: string | null };
    sources.push(i.n
      ? { kind: 'inspect', state: 'completed', at: i.at, detail: `${fmtN(i.n)} URLs inspected` }
      : { kind: 'inspect', state: 'never', at: null, detail: 'No URL inspection yet - run inspect_urls' });
  }

  // Optional sources: only listed when present.
  if (tableExists(db, 'rank_history')) {
    const r = db.prepare(`SELECT COUNT(*) n, MIN(period) lo, MAX(period) hi, MAX(fetched_at) at FROM rank_history`).get() as { n: number; lo: string | null; hi: string | null; at: string | null };
    if (r.n) sources.push({ kind: 'ranks', state: 'completed', at: r.at, detail: `Rank history ${r.lo} to ${r.hi}` });
  }
  if (tableExists(db, 'sitemap_urls')) {
    const s = db.prepare(`SELECT COUNT(*) n, MAX(fetched_at) at FROM sitemap_urls`).get() as { n: number; at: string | null };
    if (s.n) sources.push({ kind: 'sitemap', state: 'completed', at: s.at, detail: `${fmtN(s.n)} sitemap URLs` });
  }

  return { sources, crawlRuns };
}
