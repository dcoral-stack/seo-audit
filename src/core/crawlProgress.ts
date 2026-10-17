/**
 * Crawl progress arithmetic (#52): pages/sec and an ETA the client can read while a long crawl
 * runs, so a 20-40 minute job never looks stalled. Pure, so it is testable without a network.
 */
export type CrawlStage =
  | 'fetching'            // the page crawl itself
  | 'writing-links'       // final buffered page/link/resource flush
  | 'image-weights'       // header-only sample of <img> sources
  | 'resource-headers'    // optional header-only pass over css/js/fonts (headResources:true)
  | 'link-graph'          // in-degree, internal PageRank, click depth
  | 'revalidation-probe'  // conditional re-requests (304 check)
  | 'snapshot'            // page_snapshots for change detection
  | 'external-links'      // outbound link status (#36)
  | 'done';

export interface CrawlRate {
  elapsedSeconds: number;
  pagesPerSec: number | null;   // null until at least one page landed
  /** Pages still expected: the queue plus what is in flight, capped by maxPages. */
  pagesRemaining: number;
  /** Seconds to finish the fetch stage at the current rate; null before a rate exists. */
  etaSeconds: number | null;
}

/**
 * @param crawled  pages fetched so far (success)
 * @param failed   pages that errored (they also consumed budget time)
 * @param queued   URLs still in the frontier
 * @param maxPages the crawl cap
 * @param elapsedMs wall time since the crawl started
 */
export function crawlRate(crawled: number, failed: number, queued: number, maxPages: number, elapsedMs: number): CrawlRate {
  const elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  const done = crawled + failed;
  const pagesRemaining = Math.max(0, Math.min(maxPages, crawled + queued) - crawled);
  const pagesPerSec = done > 0 && elapsedMs > 0 ? Math.round((done / (elapsedMs / 1000)) * 10) / 10 : null;
  const etaSeconds = pagesPerSec && pagesPerSec > 0 ? Math.round(pagesRemaining / pagesPerSec) : null;
  return { elapsedSeconds, pagesPerSec, pagesRemaining, etaSeconds };
}

/** "4m 12s" style, for the status line. */
export function fmtDuration(seconds: number | null): string {
  if (seconds == null) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
