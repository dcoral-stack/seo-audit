// Display rules the dashboard applies to every number it shows. Pure and dependency-free: the UI
// bundles this module (like summaryVerdict.ts) and scripts/probe-dashboard-rules.mjs tests it, so
// a rule is written once and every tab reads it the same way. Each rule is a stated product
// convention, not a benchmark, and the UI says so where it applies.

// ── Small-base changes ───────────────────────────────────────────────────────────────────────
/**
 * Below this prior value a change is shown in absolute terms ("+1 click"), never as a percentage:
 * 0 -> 1 is not "+100%", and 2 -> 6 is not "+200%". The Summary's gaining and losing pages rank
 * only pages at or above it, for the same reason.
 */
export const SMALL_BASE_MIN = 10;

export interface ChangeView {
  /** 'pct' when the prior value is a big enough base, 'abs' otherwise. */
  mode: 'pct' | 'abs';
  /** Percent (mode 'pct') or the absolute difference (mode 'abs'). */
  value: number;
  /** The absolute difference, whatever the mode (a sort key comparable across modes). */
  diff: number;
}
/** How to show a count's change: a percentage on a base of SMALL_BASE_MIN or more, else the difference. */
export function countChange(current: number, prior: number, minBase = SMALL_BASE_MIN): ChangeView {
  const diff = current - prior;
  if (prior >= minBase) return { mode: 'pct', value: (diff / prior) * 100, diff };
  return { mode: 'abs', value: diff, diff };
}

// ── Shares ───────────────────────────────────────────────────────────────────────────────────
/**
 * One rounding rule for every share: a non-zero part that rounds to 0 reads "<1", and a part short
 * of the whole that rounds to 100 reads ">99". Returns the number text without the % sign.
 */
export function shareText(part: number, whole: number): string {
  if (!whole || !part) return '0';
  const p = (part / whole) * 100;
  if (p < 1) return '<1';
  if (part < whole && p >= 99.5) return '>99';
  return String(Math.round(p));
}
export const sharePct = (part: number, whole: number): string => `${shareText(part, whole)}%`;

// ── Health score ─────────────────────────────────────────────────────────────────────────────
/**
 * The health score never reads 100 while any page carries a critical or high issue: rounding
 * (1 of 495 pages = 99.8%) would otherwise say "nothing to fix". Capped at 99 in that case.
 */
export function capHealth(score: number, errorPages: number | null | undefined): number {
  return (errorPages ?? 0) > 0 && score >= 100 ? 99 : score;
}

// ── Rank changes ─────────────────────────────────────────────────────────────────────────────
export interface RankChange {
  /** Positions moved, always >= 0, one decimal. */
  positions: number;
  /** True when the rank improved (the position number fell). */
  better: boolean;
  /** Under 0.05 positions either way. */
  flat: boolean;
}
/** A position change in positions, never a percentage of a rank. Lower position = better. */
export function rankChange(current: number, prior: number): RankChange {
  const d = current - prior;
  const positions = Math.round(Math.abs(d) * 10) / 10;
  return { positions, better: d < 0, flat: positions < 0.05 };
}

// ── Freshness ────────────────────────────────────────────────────────────────────────────────
/** Search Console is stale when its latest day is older than this. */
export const GSC_STALE_DAYS = 7;
/** A crawl, audit, URL inspection or rank snapshot is stale when older than this. */
export const SNAPSHOT_STALE_DAYS = 30;
const DAY = 86_400_000;

/** Parse a SQLite datetime ('YYYY-MM-DD HH:MM:SS', UTC), an ISO string or a bare date. NaN if absent. */
export function parseAt(at: string | null | undefined): number {
  if (!at) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return Date.parse(`${at}T00:00:00Z`);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);
}

export interface SourceFreshness {
  stale: boolean;
  /** Days since the reference date (the latest GSC day for Search Console, else the run). */
  ageDays: number | null;
  /** The stated rule, for the tooltip. */
  rule: string;
}
/**
 * The ONE staleness rule, read by the Summary freshness strip and the sidebar dots alike.
 * Search Console ages from its latest data day (`gscEnd`); every other source from when it ran.
 */
export function sourceFreshness(kind: string, s: { state: string; at: string | null }, opts: { gscEnd?: string | null; now?: number } = {}): SourceFreshness {
  const now = opts.now ?? Date.now();
  if (s.state === 'never') return { stale: false, ageDays: null, rule: '' };
  if (kind === 'sync') {
    const t = parseAt(opts.gscEnd ?? s.at);
    const ageDays = Number.isFinite(t) ? (now - t) / DAY : null;
    return { stale: ageDays != null && ageDays > GSC_STALE_DAYS, ageDays, rule: `Stale when the latest Search Console day is more than ${GSC_STALE_DAYS} days old (a product rule).` };
  }
  const t = parseAt(s.at);
  const ageDays = Number.isFinite(t) ? (now - t) / DAY : null;
  return { stale: ageDays != null && ageDays > SNAPSHOT_STALE_DAYS, ageDays, rule: `Stale when older than ${SNAPSHOT_STALE_DAYS} days (a product rule).` };
}
/** The dot class for a source: failed/interrupted, running, never, stale, else ok. */
export function freshnessDot(state: string, stale: boolean): string {
  if (state === 'failed' || state === 'interrupted') return 'dot-bad';
  if (state === 'running' || state === 'queued') return 'dot-run';
  if (state === 'never') return 'dot-never';
  return stale ? 'dot-high' : 'dot-ok';
}

// ── Run labels ───────────────────────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * Axis labels for a run of timestamps: "17 Oct", with the time (UTC) added to every run that
 * shares its day with another, so two same-day audits read "17 Oct 16:20" and "17 Oct 16:21".
 */
export function runLabels(ats: (string | null | undefined)[]): string[] {
  const ts = ats.map(parseAt);
  const day = ts.map(t => (Number.isFinite(t) ? `${new Date(t).getUTCDate()} ${MONTHS[new Date(t).getUTCMonth()]}` : '-'));
  const count = new Map<string, number>();
  for (const d of day) count.set(d, (count.get(d) ?? 0) + 1);
  return day.map((d, i) => {
    if (d === '-' || (count.get(d) ?? 0) < 2) return d;
    const t = new Date(ts[i]);
    return `${d} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  });
}

// ── Quick wins ───────────────────────────────────────────────────────────────────────────────
/** A query enters the quick-wins matrix with at least this many impressions in the last 28 days ... */
export const QUICK_WIN_MIN_IMPRESSIONS = 50;
/** ... at an average position of this or better. */
export const QUICK_WIN_MAX_POSITION = 20;

/**
 * Why the quick-wins chart or table is empty, in words that name the real reason. `plotted` is
 * how many queries passed the matrix's filter; `wins` how many carry a recoverable-click estimate.
 * Null when there is something to show.
 */
export function quickWinsEmptyReason(o: { hasGsc: boolean; plotted: number; wins: number }): string | null {
  if (!o.hasGsc) return 'No Search Console data yet - run sync_gsc.';
  if (!o.plotted) return `No quick wins: no query reached ${QUICK_WIN_MIN_IMPRESSIONS} impressions at an average position of ${QUICK_WIN_MAX_POSITION} or better in the last 28 days.`;
  if (!o.wins) return `No quick wins: each of the ${o.plotted} ${o.plotted === 1 ? 'query' : 'queries'} at positions 1-${QUICK_WIN_MAX_POSITION} with ${QUICK_WIN_MIN_IMPRESSIONS}+ impressions is clicking at or near the expected rate for its position, or has a near-zero CTR that points to a SERP feature to check first.`;
  return null;
}

// ── Trapped authority ────────────────────────────────────────────────────────────────────────
/** A trapped page has at least this many referring domains ... */
export const TRAPPED_MIN_REF_DOMAINS = 2;
/** ... and sits at least this many in-content clicks from the homepage (or can't be reached). */
export const TRAPPED_MIN_DEPTH = 3;
/**
 * Why Trapped authority is empty, from the STORED backlink rows (not from whether an API key is
 * set: a profile pulled earlier still counts, and the Links tab shows it).
 */
export function trappedEmptyReason(o: { backlinkPages: number; hasKey: boolean | null }): string {
  if (o.backlinkPages > 0) {
    return `None of the ${o.backlinkPages} backlinked page${o.backlinkPages === 1 ? '' : 's'} stored is trapped: a trapped page has ${TRAPPED_MIN_REF_DOMAINS}+ referring domains and sits ${TRAPPED_MIN_DEPTH}+ in-content clicks from the homepage (or can't be reached through content links).`;
  }
  return o.hasKey === false
    ? 'No backlink data stored. Pulling it needs a DataForSEO key with the Backlinks subscription (pull_backlinks).'
    : 'No backlink data stored yet - run pull_backlinks to bring in referring-domain counts, then reload.';
}
