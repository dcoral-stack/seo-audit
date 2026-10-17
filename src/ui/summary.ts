// The Summary tab (design/summary/SUMMARY-PAGE.md, slice 3): the landing view that answers, top
// to bottom, how fresh is this · how is the site doing · better or worse · what's broken · what
// to do first · what changed · AI search · what we don't measure.
//
// Rules this file keeps (the spec's honesty constraints):
//   - every number comes from the payload; nothing is estimated or written by a model;
//   - missing renders as words (an empty state naming the action that fills it), never as 0;
//   - samples say "n of M"; thresholds are stated product rules, shown where they apply;
//   - every number carries class "n" so redact mode (?redact=1) blurs it, and charts drop their
//     numeric axes and tooltips when redacted.
import { esc, fmtNum, sparkline, delta, axisDefaults, tooltipDefaults, monoFont, type ChartPalette, type EChartWrapper } from './lib/index.js';
import { buildVerdict, direction } from '../core/summaryVerdict.js';
import { ago, SEV_LABEL } from './panels.js';

const fmt = fmtNum;

export interface SummaryCtx {
  wrap: (id: string, group?: string) => EChartWrapper;
  col: ChartPalette & { green: string; red: string; amber: string; grey: string; blue: string };
  shortPath: (u: string, max?: number) => string;
  safeJson: (s: string) => any;
  redacted: boolean;
  /** Jump to Issues & fixes, optionally filtered to one check or one area. */
  gotoIssues: (f: { check?: string; area?: string }) => void;
  catLabel: Record<string, string>;
}

// Stated product rules (not benchmarks), shown in the freshness tooltips.
const GSC_STALE_DAYS = 7;
const CRAWL_AUDIT_STALE_DAYS = 30;
const DAY = 86_400_000;

const set = (id: string, html: string): void => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
const show = (id: string, on: boolean): void => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
const empty = (msg: string): string => `<div class="empty-state">${msg}</div>`;
const parseAt = (at: string | null | undefined): number => {
  if (!at) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return Date.parse(`${at}T00:00:00Z`);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);
};
const daysSince = (at: string | null | undefined): number | null => { const t = parseAt(at); return Number.isFinite(t) ? (Date.now() - t) / DAY : null; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const dayLabel = (at: string | null | undefined): string => {
  const t = parseAt(at); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const SEV_BAR: Record<string, string> = { crit: 'var(--intent-danger)', high: 'var(--intent-warning)', med: 'var(--intent-info)', low: 'var(--text-faint)', info: 'var(--text-faint)' };

/** Clicks, last 28 days vs the prior 28, each day counted once (clickWindows), else the older totals. */
const clicks28 = (d: any): { current: number; prior: number } | null =>
  d.clickWindows ? { current: d.clickWindows.current, prior: d.clickWindows.prior } : d.summary ? { current: d.summary.current.clicks, prior: d.summary.prior.clicks } : null;
/** True when the 56 days behind the 28-day comparison include days stored in both GSC row shapes. */
const windowsMixed = (d: any): boolean => {
  const sh = d.gscShape, cw = d.clickWindows;
  if (!sh) return false;
  const start = cw?.priorWindow?.start ?? '', end = cw?.window?.end ?? d.dateRange?.maxDate ?? '';
  return !(sh.to < start || sh.from > end);
};

// ── Panel 0: freshness strip ──────────────────────────────────────────────────────────────────
function freshness(d: any): string {
  const src: any[] = d.freshness?.sources ?? [];
  const LABEL: Record<string, string> = { sync: 'Search Console', crawl: 'Crawl', audit: 'Audit', inspect: 'URL inspection', ranks: 'Ranks' };
  const cells: string[] = [];
  const problems: string[] = [];
  for (const kind of ['sync', 'crawl', 'audit', 'inspect', 'ranks']) {
    const s = src.find(r => r.kind === kind);
    if (!s) continue;
    let flag = '', rule = '';
    let line = s.state === 'never' ? 'never' : s.state === 'running' ? 'running now' : s.state === 'completed' ? ago(s.at) : `${s.state} ${ago(s.at)}`;
    if (kind === 'sync' && s.state !== 'never') {
      const end = d.dateRange?.rawMaxDate ?? d.coverage?.gsc?.maxDate;
      const behind = daysSince(end);
      if (end) line += ` · to ${dayLabel(end)}`;
      if (behind != null && behind > GSC_STALE_DAYS) flag = 'stale';
      rule = `Stale when the latest Search Console day is more than ${GSC_STALE_DAYS} days old (a product rule).` +
        (d.dateRange?.trimmedDays ? ` The last ${d.dateRange.trimmedDays} unfinalised day${d.dateRange.trimmedDays > 1 ? 's are' : ' is'} left out of every figure.` : '');
    }
    if ((kind === 'crawl' || kind === 'audit') && s.state !== 'never') {
      const age = daysSince(s.at);
      if (age != null && age > CRAWL_AUDIT_STALE_DAYS) flag = 'stale';
      rule = `Stale when older than ${CRAWL_AUDIT_STALE_DAYS} days (a product rule).`;
    }
    if (kind === 'audit' && d.freshness?.auditVsCrawl?.predatesCrawl) {
      flag = 'older than crawl';
      rule += ' The latest audit ran before the latest completed crawl, so its findings describe the previous crawl: run run_audit.';
    }
    const bad = s.state === 'failed' || s.state === 'interrupted';
    const dot = bad ? 'dot-bad' : flag ? 'dot-high' : s.state === 'never' ? 'dot-never' : s.state === 'running' ? 'dot-run' : 'dot-ok';
    const tip = [s.detail, rule].filter(Boolean).join(' ');
    cells.push(`<div class="sf-cell" title="${esc(tip)}"><div class="sf-k"><span class="dot ${dot}"></span>${esc(LABEL[kind])}</div>` +
      `<div class="sf-v">${esc(line)}${flag ? ` <span class="sf-flag">${esc(flag)}</span>` : ''}</div></div>`);
    if (s.error) problems.push(`<div class="sf-err"><b>${esc(LABEL[kind])}:</b> ${esc(String(s.error).slice(0, 160))}</div>`);
  }
  if (!cells.length) return empty('No data sources recorded yet - run <code>refresh_property</code>.');
  const sh = d.gscShape;
  const shapeNote = sh ? `<div class="sf-warn">Search Console history holds two row shapes (all-country and per-country rows) on <span class="n">${fmt(sh.mixedDays)}</span> days, ${esc(dayLabel(sh.from))} to ${esc(dayLabel(sh.to))}. This page counts each of those days once; totals elsewhere in the dashboard that span them still count clicks twice.</div>` : '';
  return `<div class="sf-row">${cells.join('')}</div>${problems.join('')}${shapeNote}`;
}

// ── Panel 1: verdict line ─────────────────────────────────────────────────────────────────────
function verdict(d: any): string {
  const sum = d.summary, bs = d.brandedSplit;
  const fc = d.findings;
  const lastDelta = (d.auditDeltas ?? []).filter((a: any) => a.runId === fc?.runId).pop();
  const dr = d.drift;
  const v = buildVerdict({
    clicks: sum ? clicks28(d) : null,
    // The brand split comes from the older totals, so it isn't compared across mixed-shape days.
    nonBrand: sum && bs && !windowsMixed(d) ? { current: bs.nonBranded.clicks, prior: bs.priorNonBrandedClicks, brand: bs.brand } : null,
    criticalOpen: fc ? (fc.byCheck ?? []).filter((b: any) => b.severity === 'crit').reduce((s: number, b: any) => s + b.count, 0) : null,
    resolvedSinceLastAudit: lastDelta && !lastDelta.skipped ? lastDelta.resolved : null,
    pagesChanged: dr?.counts && !dr.staleness ? dr.counts.pagesChanged : null,
  });
  if (v.empty) return empty('Nothing to summarise yet - sync Search Console (<code>sync_gsc</code>) or run a crawl and an audit.');
  const sentence = v.segments.map(s => (s.n ? `<b class="n">${esc(s.text)}</b>` : esc(s.text))).join('');
  const chipCls: Record<string, string> = { up: 'vc-up', down: 'vc-down', flat: 'vc-flat', neutral: 'vc-flat' };
  const chips = v.chips.map(c => `<span class="vchip ${chipCls[c.direction]}"><span class="n">${esc(c.label)}</span></span>`).join('');
  return `<p class="verdict-text" title="${esc(v.tooltip)}">${sentence}</p><div class="vchips">${chips}</div>`;
}

// ── Panel 2: the five tiles ───────────────────────────────────────────────────────────────────
interface Tile { label: string; value: string; foot?: string; sub?: string; cls?: string; title?: string }
const tile = (t: Tile): string =>
  `<div class="metric-card${t.cls ? ` ${t.cls}` : ''}"${t.title ? ` title="${esc(t.title)}"` : ''}><div class="label">${esc(t.label)}</div>` +
  `<div class="value">${t.value}</div>${t.foot ? `<div class="metric-foot">${t.foot}</div>` : ''}${t.sub ? `<div class="metric-sub">${t.sub}</div>` : ''}</div>`;

function tiles(d: any): string {
  const out: string[] = [];
  const sum = d.summary;
  if (!sum) {
    out.push(`<div class="metric-card tile-connect"><div class="label">Search Console</div><div class="connect-msg">Connect Search Console to see traffic and trends.</div><div class="metric-sub">Run <code>sync_gsc</code> for this property.</div></div>`);
  } else {
    const { current: c, prior: p } = clicks28(d)!;
    const months = (d.monthly?.months ?? []).filter((m: any) => !m.partial && m.clicks != null).map((m: any) => m.clicks);
    const yoy = d.yoy;
    let yoyTxt = '';
    if (yoy?.available) {
      const yp = direction(yoy.clicks, yoy.priorYearClicks).pct;
      yoyTxt = yp == null ? 'no clicks a year ago' : `<span class="n">${yp >= 0 ? '+' : '−'}${Math.abs(Math.round(yp))}%</span> on a year ago`;
    } else if (yoy) yoyTxt = 'year-on-year needs 13 months';
    out.push(tile({
      label: 'Organic clicks · 28d', value: `<span class="n">${fmt(c)}</span>`,
      foot: `${p ? `<span class="n">${delta(((c - p) / p) * 100)}</span>` : '<span class="chg flat">no prior clicks</span>'}${months.length >= 2 ? sparkline(months) : ''}`,
      sub: yoyTxt, title: `Last 28 days to ${d.dateRange?.maxDate ?? ''} vs the prior 28.${yoy?.available ? ` Year-on-year: the same 28 days 52 weeks earlier (${yoy.priorWindow.start} to ${yoy.priorWindow.end}).` : ''}${months.length >= 2 ? ` Sparkline: ${months.length} complete months.` : ''}`,
    }));
    const bs = d.brandedSplit;
    if (bs) {
      const tot = bs.branded.clicks + bs.nonBranded.clicks;
      const share = tot ? Math.round((bs.nonBranded.clicks / tot) * 100) : null;
      const nb = bs.priorNonBrandedClicks && !windowsMixed(d) ? ((bs.nonBranded.clicks - bs.priorNonBrandedClicks) / bs.priorNonBrandedClicks) * 100 : null;
      out.push(tile({
        label: 'Non-brand share', value: share == null ? '–' : `<span class="n">${share}%</span>`,
        foot: nb != null ? `<span class="n">${delta(nb)}</span><span class="tile-note">non-brand clicks</span>` : undefined,
        sub: `of clicks · brand "${esc(bs.brand)}"`,
        title: `Non-brand = queries without "${bs.brand}" as a whole word, detected from the domain (a heuristic).${windowsMixed(d) ? ' Not compared with the prior 28 days: they include days stored in two row shapes.' : ''}`,
      }));
    } else {
      out.push(tile({ label: 'Non-brand share', value: '–', sub: 'brand not detected from the domain' }));
    }
  }

  const hs = d.healthScore;
  const hist = (d.healthHistory ?? []).map((h: any) => h.score).filter((v: any) => v != null);
  if (hs) {
    const tone = hs.band === 'Excellent' || hs.band === 'Good' ? 'var(--intent-success)' : hs.band === 'Fair' ? 'var(--intent-warning)' : 'var(--intent-danger)';
    out.push(tile({
      label: 'Site health', value: `<span class="n" style="color:${tone}">${hs.score}</span><span class="kpi-of">/100</span>`,
      foot: `<span class="tile-band" title="Bands are a product convention, not an industry benchmark">${esc(hs.band)}</span>${hist.length >= 2 ? sparkline(hist) : ''}`,
      sub: 'pages with no critical or high issue',
      title: `${hs.definition} ${hs.totalPages - hs.errorPages} of ${hs.totalPages} pages. Bands (Weak under 31, Fair, Good from 71, Excellent from 91) are a product convention, not an industry benchmark.${hist.length >= 2 ? ` Sparkline: ${hist.length} audits.` : ''}`,
    }));
  } else {
    out.push(tile({ label: 'Site health', value: '–', sub: (d.coverage?.crawlPages ?? 0) > 0 ? 'run <code>run_audit</code>' : 'run a crawl, then <code>run_audit</code>' }));
  }

  const ic = d.indexCoverage;
  out.push(ic
    ? tile({ label: 'Indexed', value: `<span class="n">${fmt(ic.indexed)}</span><span class="kpi-of"> of <span class="n">${fmt(ic.total)}</span></span>`, sub: 'inspected URLs (a sample)', title: 'From URL Inspection, which is quota-bound: a sample of URLs, never a share of the whole site.' })
    : tile({ label: 'Indexed', value: '–', sub: 'run <code>inspect_urls</code>' }));

  const ar = d.agentReadiness;
  out.push(ar
    ? tile({ label: 'AI readiness', value: `<span class="n">${ar.score}</span><span class="kpi-of">/100</span>`, foot: `<span class="tile-band">${esc(ar.level)}</span>`, sub: `checked ${esc(ago(ar.checkedAt))}`, title: 'Agent-readiness probe (check_agent_readiness): the share of discoverability, content, bot-access and capability checks the site passes. One stored result, so no trend yet.' })
    : tile({ label: 'AI readiness', value: '–', sub: 'run <code>check_agent_readiness</code>' }));
  return out.join('');
}

// ── Panel 3a: 16-month trend with event ticks ─────────────────────────────────────────────────
function trend(d: any, ctx: SummaryCtx): void {
  const m = d.monthly;
  const { col } = ctx;
  if (!m?.months?.length) {
    show('sumTrendLegend', false);
    set('sumTrendNote', d.summary ? '' : 'Connect Search Console (<code>sync_gsc</code>) to see up to 16 months of clicks.');
    set('sumTrendSrc', '');
    ctx.wrap('sumTrendChart').setEmpty(d.summary ? 'No monthly data yet' : 'No Search Console data', col);
    return;
  }
  show('sumTrendLegend', true);
  const months: any[] = m.months;
  const byMonth = new Map(months.map(mm => [mm.month, mm]));
  const yoyOk = d.yoy?.available === true;
  const ghost = months.map(mm => {
    if (!yoyOk) return null;
    const [y, mo] = mm.month.split('-').map(Number);
    const prev = byMonth.get(`${y - 1}-${String(mo).padStart(2, '0')}`) as any;
    return prev && !prev.partial && prev.clicks != null && !mm.partial && mm.clicks != null ? prev.clicks : null;
  });
  const anyGhost = ghost.some(g => g != null);
  const idx = new Map(months.map((mm, i) => [mm.month, i]));
  const events: any[] = (d.events ?? []).filter((e: any) => idx.has(e.at.slice(0, 7)));
  const pos = (at: string): number => {
    const i = idx.get(at.slice(0, 7))!;
    const dim = byMonth.get(at.slice(0, 7)).daysInMonth;
    return i - 0.5 + (Number(at.slice(8, 10)) - 0.5) / dim;
  };
  const ax = axisDefaults(col, { numeric: true });
  const evColor = { crawl: col.categorical[0], audit: col.categorical[1] } as const;
  ctx.wrap('sumTrendChart').setOption({
    aria: { enabled: true },
    animation: false,
    tooltip: ctx.redacted ? { show: false } : {
      ...tooltipDefaults(col), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps: any[]) => {
        const p = ps.find(q => q.seriesName === 'Clicks') ?? ps[0];
        const mm = months[p.dataIndex];
        if (!mm) return '';
        const g = ghost[p.dataIndex];
        return `${monthLabel(mm.month)}<br/>${mm.clicks == null ? 'no Search Console data' : `${fmt(mm.clicks)} clicks`}` +
          `${mm.partial && mm.clicks != null ? ` · partial (${mm.days} of ${mm.daysInMonth} days)` : ''}${g != null ? `<br/>same month last year ${fmt(g)}` : ''}`;
      },
    },
    grid: [{ left: 44, right: 10, top: 12, bottom: 56 }, { left: 44, right: 10, height: 16, bottom: 26 }],
    xAxis: [
      { type: 'category', gridIndex: 0, data: months.map(mm => monthLabel(mm.month)), axisTick: { show: false }, axisLine: { lineStyle: { color: col.border } }, axisLabel: { color: col.axisText, fontSize: 10.5, fontFamily: monoFont(), hideOverlap: true } },
      { type: 'value', gridIndex: 1, min: -0.5, max: months.length - 0.5, show: false },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, ...ax, axisLabel: { ...ax.axisLabel, show: !ctx.redacted }, axisLine: { show: false }, splitNumber: 3 },
      { type: 'value', gridIndex: 1, min: 0, max: 2, show: false },
    ],
    series: [
      {
        name: 'Clicks', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 28,
        data: months.map(mm => mm.clicks == null ? null : {
          value: mm.clicks,
          itemStyle: mm.partial
            ? { color: 'transparent', borderColor: col.accent, borderWidth: 1.5, borderType: 'dashed', borderRadius: [3, 3, 0, 0] }
            : { color: col.accent, borderRadius: [3, 3, 0, 0] },
        }),
      },
      ...(anyGhost ? [{
        name: 'Same month last year', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ghost, connectNulls: false,
        symbol: 'circle', symbolSize: 4, lineStyle: { type: 'dashed', width: 1.5, color: col.text, opacity: 0.5 }, itemStyle: { color: col.text, opacity: 0.5 }, z: 3,
      }] : []),
      ...(['crawl', 'audit'] as const).map((k, lane) => ({
        name: k === 'crawl' ? 'Crawl' : 'Audit', type: 'scatter', xAxisIndex: 1, yAxisIndex: 1, symbol: 'rect', symbolSize: [2, 8],
        itemStyle: { color: evColor[k] }, tooltip: { show: false }, silent: true,
        data: events.filter(e => e.kind === k).map(e => [pos(e.at), lane === 0 ? 1.45 : 0.55]),
      })),
    ],
  });
  const complete = months.filter(mm => !mm.partial && mm.clicks != null);
  const partial = months.filter(mm => mm.partial && mm.clicks != null);
  const nulls = months.filter(mm => mm.clicks == null);
  set('sumTrendLegend',
    `<span><i class="lg-bar"></i>Clicks</span><span><i class="lg-hollow"></i>Partial month</span>` +
    (anyGhost ? '<span><i class="lg-dash"></i>Same month last year</span>' : '') +
    `<span><i class="lg-tick" style="background:${evColor.crawl}"></i>Crawl</span><span><i class="lg-tick" style="background:${evColor.audit}"></i>Audit</span>`);
  const notes: string[] = [];
  if (!yoyOk) notes.push(`Same month last year needs 13 months of Search Console; this property holds <span class="n">${m.monthsHeld}</span>.`);
  if (m.truncated) notes.push(`The last <span class="n">${m.truncated.shownMonths}</span> of <span class="n">${m.truncated.monthsHeld}</span> months held.`);
  if (nulls.length) notes.push(`<span class="n">${nulls.length}</span> month${nulls.length > 1 ? 's have' : ' has'} no Search Console rows (no bar, not zero).`);
  if (partial.length) notes.push('A hollow bar is a partial month, never compared as complete.');
  set('sumTrendNote', notes.join(' '));
  set('sumTrendSrc', `GSC · ${months.length} months`);
  const s = document.getElementById('sumTrendSummary');
  if (s) s.textContent = `Monthly organic clicks for ${months.length} months; ${complete.length} complete, ${partial.length} partial.` +
    (complete.length && !ctx.redacted ? ` Latest complete month ${monthLabel(complete[complete.length - 1].month)}: ${fmt(complete[complete.length - 1].clicks)} clicks.` : '');
}

// ── Panel 3b: health per audit + opened / resolved ────────────────────────────────────────────
const SKIP_LABEL: Record<string, string> = {
  'different-scope': 'different audit scope', 'check-set-changed': 'the check set changed', 'check-set-unknown': 'check set not recorded',
};
function health(d: any, ctx: SummaryCtx): void {
  const { col } = ctx;
  const histAll: any[] = d.healthHistory ?? [];
  const deltas: any[] = d.auditDeltas ?? [];
  const MAX = 12;
  const hist = histAll.slice(-MAX);
  if (!hist.length) {
    ctx.wrap('sumHealthChart').setEmpty((d.coverage?.crawlPages ?? 0) > 0 ? 'No audit yet - run run_audit' : 'Run a crawl, then run_audit', col);
    set('sumHealthNotes', ''); set('sumHealthSrc', '');
    return;
  }
  const byRun = new Map(deltas.map(a => [a.runId, a]));
  const labels = hist.map(h => dayLabel(h.at));
  const comparable = hist.map(h => { const a = byRun.get(h.runId); return a && !a.skipped ? a : null; });
  const nComparable = comparable.filter(Boolean).length;
  const ax = axisDefaults(col);
  ctx.wrap('sumHealthChart').setOption({
    aria: { enabled: true }, animation: false,
    tooltip: ctx.redacted ? { show: false } : {
      ...tooltipDefaults(col), trigger: 'axis',
      formatter: (ps: any[]) => {
        const i = ps[0].dataIndex, h = hist[i], a = byRun.get(h.runId);
        const hs = h.score == null ? `health not computable (${String(h.basis ?? '').replace(/^none:/, '') || 'no basis'})` : `health ${h.score}/100`;
        const dl = !a ? 'first audit shown' : a.skipped ? `not compared: ${SKIP_LABEL[a.skipped] ?? a.skipped}` : `${fmt(a.opened)} opened · ${fmt(a.resolved)} resolved · ${fmt(a.carried)} carried`;
        return `${labels[i]}<br/>${hs}<br/>${dl}`;
      },
    },
    legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: col.text, fontSize: 11 }, data: ['Health', 'Opened', 'Resolved'] },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [{ left: 34, right: 10, top: 40, height: '30%' }, { left: 34, right: 10, top: '64%', bottom: 24 }],
    xAxis: [
      { type: 'category', gridIndex: 0, data: labels, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: col.border } } },
      { type: 'category', gridIndex: 1, data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: col.border } }, axisLabel: { color: col.axisText, fontSize: 10, fontFamily: monoFont(), hideOverlap: true } },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, min: 0, max: 100, splitNumber: 2, name: 'health /100', nameGap: 8, nameTextStyle: { ...ax.nameTextStyle, align: 'left', fontSize: 10 }, ...{ axisLabel: { ...ax.axisLabel, show: !ctx.redacted }, axisLine: { show: false }, splitLine: ax.splitLine } },
      { type: 'value', gridIndex: 1, splitNumber: 2, minInterval: 1, name: 'issues', nameGap: 8, nameTextStyle: { ...ax.nameTextStyle, align: 'left', fontSize: 10 }, ...{ axisLabel: { ...ax.axisLabel, show: !ctx.redacted }, axisLine: { show: false }, splitLine: ax.splitLine } },
    ],
    series: [
      { name: 'Health', type: 'line', step: 'end', xAxisIndex: 0, yAxisIndex: 0, connectNulls: false, data: hist.map(h => h.score), symbol: 'circle', symbolSize: 5, lineStyle: { width: 1.75, color: col.accent }, itemStyle: { color: col.accent } },
      { name: 'Opened', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 10, data: comparable.map(a => a ? a.opened : null), itemStyle: { color: col.amber, borderRadius: [2, 2, 0, 0] } },
      { name: 'Resolved', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 10, data: comparable.map(a => a ? a.resolved : null), itemStyle: { color: col.green, borderRadius: [2, 2, 0, 0] } },
    ],
  });
  const notes: string[] = ['Only audits with the same scope and check set are compared.'];
  const skipped = hist.map(h => byRun.get(h.runId)).filter((a: any) => a?.skipped && !String(a.skipped).startsWith('run-'));
  if (skipped.length) notes.push(`Not compared: ${skipped.map((a: any) => `${dayLabel(a.at)} (${SKIP_LABEL[a.skipped] ?? a.skipped})`).join(', ')}.`);
  const failed = deltas.filter(a => String(a.skipped ?? '').startsWith('run-'));
  if (failed.length) notes.push(`<span class="n">${failed.length}</span> audit${failed.length > 1 ? 's' : ''} didn't complete and ${failed.length > 1 ? 'are' : 'is'} stepped over.`);
  const nullScores = hist.filter(h => h.score == null).length;
  if (nullScores) notes.push(`<span class="n">${nullScores}</span> past audit${nullScores > 1 ? 's have' : ' has'} no score: the page set couldn't be rebuilt from crawl snapshots, so it isn't estimated.`);
  if (nComparable === 0) notes.push(hist.length < 2 ? 'Opened vs resolved needs two comparable audits.' : 'No comparable pair yet, so no opened / resolved bars.');
  if (histAll.length > MAX || d.auditHistoryTruncated) notes.push(`The last <span class="n">${hist.length}</span> of <span class="n">${d.auditHistoryTruncated?.totalRuns ?? histAll.length}</span> audits.`);
  set('sumHealthNotes', `<div class="sum-note">${notes.join(' ')}</div>`);
  set('sumHealthSrc', `Audit · ${hist.length} run${hist.length > 1 ? 's' : ''}`);
  const s = document.getElementById('sumHealthSummary');
  const last = hist[hist.length - 1];
  if (s) s.textContent = `Health score over ${hist.length} audits; latest ${last.score == null ? 'not computable' : `${last.score} out of 100`}. ${nComparable} comparable audit pairs.`;
}

// ── Panel 4: what's broken, by area ───────────────────────────────────────────────────────────
function areas(d: any, ctx: SummaryCtx): string {
  const fc = d.findings;
  if (!fc) return empty((d.coverage?.crawlPages ?? 0) > 0 ? 'No audit yet - run <code>run_audit</code>.' : 'No crawl yet - run <code>start_crawl</code>, then <code>run_audit</code>.');
  const rows: any[] = fc.byCategory ?? [];
  if (!rows.length) return empty('The latest audit found nothing to fix.');
  const LBL: Record<string, string> = { ...ctx.catLabel, merged: 'Search demand' };
  const cnt = (v: number, sev: string): string => `<span class="cnt${v ? ` cnt-${sev}` : ' cnt-zero'}"><span class="n">${v}</span></span>`;
  const anyCompared = rows.some(r => r.opened != null);
  const body = rows.map(r => {
    const pages = `${r.capped ? '≥' : ''}<span class="n">${fmt(r.pages)}</span>${r.site ? ' <span class="site-tag" title="Plus site-wide findings">+ site</span>' : ''}`;
    const since = r.opened == null ? '<span class="cell-null" title="No comparable previous audit">–</span>'
      : `<span class="since-o" title="opened"><span class="n">+${fmt(r.opened)}</span></span> <span class="since-r" title="resolved"><span class="n">−${fmt(r.resolved)}</span></span>`;
    return `<tr class="area-link" data-area="${esc(r.category)}" tabindex="0" role="button" title="Show these issues"><td>${esc(LBL[r.category] ?? r.category)}</td><td class="num">${pages}</td>` +
      `<td class="num sevs">${cnt(r.crit, 'crit')}${cnt(r.high, 'high')}${cnt(r.med, 'med')}${cnt(r.low, 'low')}</td><td class="num">${since}</td></tr>`;
  }).join('');
  const judgement = rows.reduce((s, r) => s + (r.judgement || 0), 0);
  const notes: string[] = ['C / H / M / L: pages (or the site) with a critical, high, medium or low issue.'];
  if (judgement) notes.push(`Includes <span class="n">${fmt(judgement)}</span> judgement findings (the audit ran with <code>includeJudgement</code>).`);
  if (rows.some(r => r.capped)) notes.push('≥: a check hit the 500-findings storage cap, so the count is a floor.');
  if (!d.summary && !rows.some(r => r.category === 'merged')) notes.push('Search-demand checks need Search Console, so they did not run.');
  if (!anyCompared) notes.push('"Since last audit" needs two comparable audits.');
  return `<div class="findings-table areas-table"><table><thead><tr><th>Area</th><th class="num">Pages</th>` +
    `<th class="num sevs"><span class="sev-h" title="Critical">C</span><span class="sev-h" title="High">H</span><span class="sev-h" title="Medium">M</span><span class="sev-h" title="Low and info">L</span></th>` +
    `<th class="num">Since last audit</th></tr></thead><tbody>${body}</tbody></table></div>` +
    `<div class="sum-note">${notes.join(' ')}</div>`;
}

/** The finding's evidence labels as a chip: D deterministic, N judgement, G from Search Console data. */
const evidenceLabel = (labels: string[]): string => { const l = labels.filter(x => ['D', 'N', 'G'].includes(x)); return l.length ? l.join('·') : 'D'; };
const evidenceTitle = (labels: string[]): string => [
  labels.includes('N') ? 'N: judgement, verify before acting' : 'deterministic: backed by the crawled bytes or stored rows',
  labels.includes('G') ? 'G: built from Search Console data' : '',
].filter(Boolean).join('; ');

// ── Panel 5: do this first ────────────────────────────────────────────────────────────────────
function actions(d: any, ctx: SummaryCtx): string {
  const fc = d.findings;
  if (!fc?.top?.length) return empty(fc ? 'The latest audit found nothing to fix.' : 'No audit yet - run <code>run_audit</code> to rank the fixes.');
  const seen = new Set<string>(); const top: any[] = [];
  for (const f of fc.top) { if (top.length >= 5) break; if (seen.has(f.check_id)) continue; seen.add(f.check_id); top.push(f); }
  const byCheck = new Map((fc.byCheck ?? []).map((b: any) => [b.check_id, b]));
  const maxImpact = Math.max(...top.map(f => Number(f.impact) || 0), 1);
  return `<ol class="do-first">${top.map((f, i) => {
    const rec = ctx.safeJson(f.recommendation);
    const b: any = byCheck.get(f.check_id) ?? {};
    const pages = b.urls ?? 0;
    const labels: string[] = (() => { try { return JSON.parse(f.labels || '[]'); } catch { return []; } })();
    const judgement = labels.includes('N');
    const w = Math.max(4, Math.round(((Number(f.impact) || 0) / maxImpact) * 100));
    const risk = b.clicksAtRisk != null && d.summary
      ? ` · <span class="n">${fmt(b.clicksAtRisk)}</span> clicks (28d) on affected pages` : '';
    return `<li class="df-row" data-check="${esc(f.check_id)}" tabindex="0" role="button" title="Show this check's findings">` +
      `<span class="df-n">${i + 1}</span><div class="df-main"><div class="df-title">${esc(rec.title || f.check_id)}</div>` +
      `<div class="df-sub">${pages ? `<span class="n">${fmt(pages)}</span> ${pages === 1 ? 'page' : 'pages'}` : 'site-wide'}${risk}</div></div>` +
      `<span class="df-chips"><span class="impact impact-${String(f.size ?? 's').toLowerCase()}" title="Impact size, relative to this audit's top finding">${esc(String(f.size ?? ''))}</span>` +
      `<span class="tag-badge ${judgement ? 'tag-warning' : 'tag-neutral'}" title="${esc(evidenceTitle(labels))}">${esc(evidenceLabel(labels))}</span></span>` +
      `<span class="ti-bar df-bar" title="${esc(SEV_LABEL[f.severity] ?? f.severity)} severity · impact ${f.impact ?? ''} of 100"><span style="width:${w}%;background:${SEV_BAR[f.severity] ?? SEV_BAR.low}"></span></span></li>`;
  }).join('')}</ol><div class="sum-note">Ranked by impact for the effort (clicks at stake × yield × certainty ÷ hours). Clicks are what the affected pages earn now, not a forecast.</div>`;
}

// ── Panel 6: changed since last crawl ─────────────────────────────────────────────────────────
function drift(d: any, ctx: SummaryCtx): string {
  const dr = d.drift;
  if (!dr || dr.snapshots === 0) return empty('No crawl yet - run <code>start_crawl</code>.');
  if (dr.staleness) return `<div class="sum-banner">This comparison isn't current: a newer crawl (${esc(dayLabel(dr.staleness.newestCrawlAt))}) has no snapshot. Run <code>run_audit</code> to snapshot it.</div>`;
  if (!dr.counts) return empty('Needs two crawls to show change. Crawl again on another day.');
  const c = dr.counts;
  const rows = [
    { k: 'Pages now erroring', v: c.nowErroring, dot: 'dot-crit' },
    { k: 'Noindex added', v: c.noindexAdded, dot: 'dot-crit' },
    { k: 'Canonical changed', v: c.canonicalChanged, dot: 'dot-high' },
    { k: 'Title changed', v: c.titleChanged, dot: 'dot-med' },
    { k: 'Pages no longer reached', v: c.removed, dot: 'dot-high' },
    { k: 'New pages', v: c.added, dot: 'dot-low' },
  ];
  const top = (dr.top ?? []).slice(0, 3).map((t: any) =>
    `<li><span class="dot dot-${t.severity === 'info' ? 'low' : t.severity}"></span><span class="url" title="${esc(t.urlKey)}">${esc(ctx.shortPath(t.urlKey, 30))}</span><span class="dr-f">${esc(t.kind === 'modified' ? t.fields.join(', ').replace(/_/g, ' ') : t.kind === 'added' ? 'new page' : 'not reached')}</span></li>`).join('');
  return `<div class="dr-rows">${rows.map(r => `<div class="dr-row"><span class="dot ${r.dot}"></span><span>${r.k}</span><b class="n">${fmt(r.v)}</b></div>`).join('')}</div>` +
    (top ? `<div class="dr-top-h">Most severe of <span class="n">${fmt(dr.total)}</span> changed</div><ul class="dr-top">${top}</ul>` : '<div class="sum-note">No changes between the two crawls.</div>') +
    `<div class="sum-note">Crawls of ${esc(dayLabel(dr.baselineAt))} and ${esc(dayLabel(dr.currentAt))}. The full diff: <code>detect_changes</code>.</div>`;
}

// ── Panel 7a: ranking mix (now vs prior 28 days) ──────────────────────────────────────────────
function rankingMix(d: any): string {
  const dist: any[] = d.rankingDistribution ?? [];
  if (!d.summary) return empty('Connect Search Console to see the ranking mix.');
  if (dist.length < 28) return empty('Needs 28 days of Search Console data.');
  const sumOf = (rows: any[]): number[] => ['b1', 'b2', 'b3', 'b4'].map(k => rows.reduce((s, r) => s + (r[k] || 0), 0));
  const cur = sumOf(dist.slice(-28));
  const prior = dist.length >= 56 ? sumOf(dist.slice(-56, -28)) : null;
  const B = [
    { k: 'Pos 1-3', c: 'var(--chart-categorical-3)' }, { k: 'Pos 4-10', c: 'var(--chart-categorical-1)' },
    { k: 'Pos 11-20', c: 'var(--chart-categorical-2)' }, { k: 'Pos 21+', c: 'var(--chart-context)' },
  ];
  const pct = (v: number[], i: number): number => { const t = v.reduce((a, b) => a + b, 0); return t ? Math.round((v[i] / t) * 100) : 0; };
  const bar = (v: number[]): string => `<div class="mix">${v.map((x, i) => (x ? `<span style="flex:${x};background:${B[i].c}" title="${B[i].k}: ${pct(v, i)}%"></span>` : '')).join('')}</div>`;
  const top10 = (v: number[]): number => pct(v, 0) + pct(v, 1);
  return `<div class="mix-row"><span class="mix-lbl">Last 28 days</span><span class="mix-val"><span class="n">${top10(cur)}%</span> in the top 10</span></div>${bar(cur)}` +
    (prior ? `<div class="mix-row"><span class="mix-lbl">Prior 28 days</span><span class="mix-val"><span class="n">${top10(prior)}%</span> in the top 10</span></div>${bar(prior)}` : '<div class="sum-note">The prior 28 days aren\'t held yet.</div>') +
    `<div class="mix-legend">${B.map((b, i) => `<span><span class="dot" style="background:${b.c}"></span>${b.k} <b class="n">${pct(cur, i)}%</b></span>`).join('')}</div>` +
    `<div class="sum-note">Share of impressions by Search Console average position, not a live SERP check.</div>`;
}

// ── Panel 7b: gaining and losing pages ────────────────────────────────────────────────────────
function movers(d: any, ctx: SummaryCtx): string {
  const pm = d.pageMovers;
  if (!d.summary || !pm) return empty('Connect Search Console to see gaining and losing pages.');
  const list = (rows: any[], up: boolean): string => rows.length
    ? rows.map(r => `<li><span class="url" title="${esc(r.urlKey)}">${esc(ctx.shortPath(r.urlKey, 30))}</span><b class="n ${up ? 'mv-up' : 'mv-down'}">${up ? '+' : '−'}${fmt(Math.abs(r.change))}</b></li>`).join('')
    : '<li class="mv-none">none</li>';
  return `<div class="mv-h">Gaining</div><ul class="mv">${list(pm.gaining, true)}</ul><div class="mv-h">Losing</div><ul class="mv">${list(pm.losing, false)}</ul>` +
    `<div class="sum-note">Change in clicks, last 28 days vs the prior 28, across <span class="n">${fmt(pm.eligible)}</span> pages with at least ${pm.minPriorClicks} clicks in the prior 28 (so 1 to 3 clicks isn't +200%).</div>`;
}

// ── Panel 8: AI search ────────────────────────────────────────────────────────────────────────
function ai(d: any): string {
  const ar = d.agentReadiness;
  const readiness = ar
    ? `<div class="ai-score"><span class="n">${ar.score}</span><span class="kpi-of">/100</span><span class="ai-level">${esc(ar.level)}</span></div>` +
      `<div class="stat-rows">${(ar.byCategory ?? []).map((c: any) => {
        const p = c.total ? Math.round((c.passed / c.total) * 100) : 0;
        return `<div class="stat-row"><div class="sr-top"><span>${esc(c.category)}</span><span><b class="n">${c.passed}</b><em class="n">of ${c.total}</em></span></div><div class="stat-track"><span style="width:${p}%;background:var(--accent)"></span></div></div>`;
      }).join('')}</div><div class="sum-note">Checked ${esc(ago(ar.checkedAt))}.</div>`
    : empty('Run <code>check_agent_readiness</code> to score how ready the site is for AI agents.');

  let botsHtml: string;
  const bots: any[] | null = ar?.bots ?? null;
  if (!ar) botsHtml = empty('Run <code>check_agent_readiness</code> to read the AI-bot rules in robots.txt.');
  else if (!bots) botsHtml = empty('Per-bot access needs a fresh <code>check_agent_readiness</code> (this result predates it), or the site has no robots.txt.');
  else {
    const pill = (b: any): string => {
      const blocked = b.verdict === 'blocked' || (b.verdict === 'not-stated' && b.inherits === 'blocked');
      const cls = blocked ? (b.group === 'search' ? 'bp-bad' : 'bp-muted') : 'bp-ok';
      const txt = b.verdict === 'not-stated' ? `* ${b.inherits === 'allowed' ? 'allows' : 'blocks'}` : b.verdict;
      return `<li title="${esc(`${b.operator}: ${b.bot}${b.verdict === 'not-stated' ? ' is not named in robots.txt, so the * group applies' : ''}`)}"><span class="bot">${esc(b.bot)}</span><span class="bp ${cls}">${esc(txt)}</span></li>`;
    };
    botsHtml = `<div class="bots"><div><div class="bots-h">Search and citation</div><ul>${bots.filter(b => b.group === 'search').map(pill).join('')}</ul></div>` +
      `<div><div class="bots-h">Training</div><ul>${bots.filter(b => b.group === 'training').map(pill).join('')}</ul></div></div>` +
      `<div class="sum-note">robots.txt rules for the site root ("* allows" = not named, the default group applies). Blocking a training crawler doesn't remove the site from AI search answers; blocking a search one does.</div>`;
  }

  const ao = d.aiOverview;
  const fp = d.serpFootprint?.features?.find((f: any) => f.feature === 'ai_overview');
  const aio: string[] = [];
  if (ao) {
    aio.push(`<p class="ai-line"><span class="n">${fmt(ao.present)}</span> of <span class="n">${fmt(ao.checked)}</span> checked queries show an AI Overview; it cites the site on <span class="n">${fmt(ao.cited)}</span>` +
      `${ao.unknown ? `, and <span class="n">${fmt(ao.unknown)}</span> ${ao.unknown === 1 ? 'is' : 'are'} unknown (the citations didn't load)` : ''}.</p>` +
      `<div class="sum-note">Content-recon queries only, checked ${esc(ago(ao.checkedAt))}.</div>`);
  } else aio.push(empty('No queries checked yet. <code>recon_targets</code> reads the AI Overview for your losing pages.'));
  if (fp) aio.push(`<p class="ai-line">AI Overviews appear on <span class="n">${fp.volumeSharePct}%</span> of sampled search volume (top <span class="n">${fmt(d.serpFootprint.sampleKeywords)}</span> keywords).</p>`);
  aio.push('<div class="not-measured">Answer share in chat assistants: <b>not measured</b>. We don\'t query ChatGPT, Perplexity or Gemini for brand mentions.</div>');

  return `<div class="ai-grid"><div><h4>Agent readiness</h4>${readiness}</div><div><h4>AI bots in robots.txt</h4>${botsHtml}</div><div><h4>AI Overviews</h4>${aio.join('')}</div></div>`;
}

// ── Panel 9: data coverage footer ─────────────────────────────────────────────────────────────
function coverageFooter(d: any): string {
  const cv = d.coverage;
  if (!cv) return '';
  const chip = (on: boolean, k: string, v: string, title = ''): string =>
    `<span class="cov-chip${on ? '' : ' cov-off'}"${title ? ` title="${esc(title)}"` : ''}><span class="dot ${on ? 'dot-ok' : 'dot-never'}"></span><span class="cov-k">${k}</span> ${v}</span>`;
  const chips = [
    chip(!!cv.gsc, 'Search Console', cv.gsc ? `<span class="n">${cv.gsc.months}</span> months` : 'none', cv.gsc ? `${cv.gsc.minDate} to ${cv.gsc.maxDate}` : 'Run sync_gsc'),
    chip(cv.crawlPages > 0, 'Crawl', cv.crawlPages ? `<span class="n">${fmt(cv.crawlPages)}</span> pages` : 'none'),
    chip(cv.inspected > 0, 'URL inspection', !cv.inspected ? 'none' : cv.inspectedIndexable == null ? `<span class="n">${fmt(cv.inspected)}</span> URLs (a sample)`
      : `<span class="n">${fmt(cv.inspectedIndexable)}</span> of <span class="n">${fmt(cv.indexablePages)}</span> indexable pages`,
      `A quota-bound sample: ${cv.inspected} URLs inspected in all, ${cv.inspectedIndexable ?? 0} of them indexable crawled pages.`),
    chip(cv.cwvPages > 0, 'Lab CWV', cv.cwvPages ? `<span class="n">${fmt(cv.cwvPages)}</span> pages` : 'none', 'Lighthouse lab data (page_lighthouse), not field data.'),
    chip(cv.backlinkPages > 0, 'Backlinks', cv.backlinkPages ? `<span class="n">${fmt(cv.backlinkPages)}</span> pages` : (d.apiKeys && !d.apiKeys.dataforseo ? 'no DataForSEO key' : 'none')),
    chip(false, 'Field CWV', 'not collected', 'Chrome UX Report field data is not collected yet.'),
    chip(false, 'Server logs', 'not collected', 'Log analysis is out of scope.'),
  ];
  return `<span class="cov-title">Data coverage</span>${chips.join('')}`;
}

export function renderSummary(d: any, ctx: SummaryCtx): void {
  set('sumFresh', freshness(d));
  set('sumVerdict', verdict(d));
  set('sumTiles', tiles(d));
  trend(d, ctx);
  health(d, ctx);
  set('sumAreas', areas(d, ctx));
  set('sumAreasSrc', d.findings?.finishedAt ? `Audit · ${ago(d.findings.finishedAt)}` : 'Audit');
  set('sumActions', actions(d, ctx));
  set('sumDrift', drift(d, ctx));
  set('sumMix', rankingMix(d));
  set('sumMovers', movers(d, ctx));
  set('sumAi', ai(d));
  set('sumCoverage', coverageFooter(d));
  // Traceability: an area row or an action opens Issues & fixes filtered to it.
  const bind = (sel: string, fn: (el: HTMLElement) => void): void => document.querySelectorAll<HTMLElement>(sel).forEach(el => {
    el.onclick = (): void => fn(el);
    el.onkeydown = (e: KeyboardEvent): void => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(el); } };
  });
  bind('#sumAreas .area-link', el => ctx.gotoIssues({ area: el.dataset.area }));
  bind('#sumActions .df-row', el => ctx.gotoIssues({ check: el.dataset.check }));
}
