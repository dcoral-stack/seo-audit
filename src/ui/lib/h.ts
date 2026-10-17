// Tiny DOM/string helpers shared by the display library. No framework - the
// library renders HTML strings (matching the dashboard's innerHTML pipeline)
// plus a small h() element factory for components that need live wiring.

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));

/** Element factory: h('button', { class: 'btn', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') (el as any)[k] = v;
    else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.append(c);
  return el;
}

// One number rule for the whole dashboard: tables, lists and sentences print the full grouped
// figure (14,659); only headline KPI values and chart labels use the compact form (14.7K), via
// fmtCompact. Mixing the two in one column read as two different kinds of number.
/** Full grouped number: 14659 -> 14,659 · 2.25 -> 2.3. */
export const fmtNum = (n: number): string =>
  new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(n);
/** Compact number for headline values and chart labels: 56700 -> 56.7K · 1234 -> 1,234. */
export const fmtCompact = (n: number): string =>
  new Intl.NumberFormat('en-GB', { notation: Math.abs(n) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);

// One date rule: prose and labels "15 Oct 2026"; axes and compact chips "15 Oct"; months "Jul 26".
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD…' -> "15 Oct 2026" (or "15 Oct" with short). Unparseable input is returned as-is. */
export const fmtDate = (iso: string | null | undefined, short = false): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  return `${Number(m[3])} ${MON[Number(m[2]) - 1]}${short ? '' : ` ${m[1]}`}`;
};
/** 'YYYY-MM' -> "Jul 26". */
export const fmtMonth = (ym: string): string => { const m = /^(\d{4})-(\d{2})/.exec(ym); return m ? `${MON[Number(m[2]) - 1]} ${m[1].slice(2)}` : ym; };
/** 'YYYY-WW' (SQLite %W) -> "W28". */
export const fmtWeek = (w: string): string => w.replace(/^\d{4}-/, 'W');

/** Axis-discipline formatter (brief pattern #4): 14M not 14,000,000. */
export const fmtAxis = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
};

/** Null-vs-zero discipline (brief pattern #2): 0 renders as 0; missing as a dash. */
export const fmtCell = (v: number | null | undefined, fmt: (n: number) => string = fmtNum): string =>
  v == null || Number.isNaN(v) ? '<span class="cell-null">–</span>' : fmt(v);
