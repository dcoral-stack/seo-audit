import type { AuditResult } from './engine.js';
import { CATEGORY_LABEL, categoryLabel } from '../core/displayRules.js';

/**
 * Concise executive markdown summary of an audit run. Shared by the `run_audit` tool (returned
 * as the model-facing text) and the local shakedown/CLI path so both emit identical reports.
 */
export const SEV_ICON: Record<string, string> = { crit: '🔴', high: '🟠', med: '🟡', low: '⚪', info: '·' };
// The shared area labels (displayRules.ts), with the report's own wording for two of them.
export const CAT_NAME: Record<string, string> = { ...CATEGORY_LABEL, performance: 'Performance (CWV)', agentic: 'AI readiness' };

export function buildAuditMarkdown(r: AuditResult & { elapsedMs?: number }, siteUrl: string): string {
  const sev = r.bySeverity ?? {};
  const out: string[] = [
    `# SEO audit — ${siteUrl.replace(/^sc-domain:/, '')}`,
    `**${r.total} findings** · 🔴 ${sev.crit ?? 0} critical · 🟠 ${sev.high ?? 0} high · 🟡 ${sev.med ?? 0} medium · ⚪ ${sev.low ?? 0} low`,
  ];
  if (!r.integrityOk) out.push('> ⚠ Crawl integrity not verified — treat findings as provisional.');
  // Impact = priority normalised to the run's top finding (preserves magnitude: the #1 issue is
  // 100, a 10x-smaller one is 10). Shown as a size + index instead of a clicks "forecast" — the
  // raw expected-clicks figure reads as a promise, which it isn't. Real measured traffic stays.
  const maxPrio = Math.max(1, ...(r.top ?? []).map(f => f.priority || 0));
  const sizeOf = (idx: number): string => idx >= 50 ? 'XL' : idx >= 20 ? 'L' : idx >= 5 ? 'M' : 'S';
  out.push('', '## Top priorities (impact vs effort)');
  // Each check's fix is printed once, under its first finding: repeating it per finding was most of
  // the reply on a big site (0.16.1).
  const fixShown = new Set<string>();
  (r.top ?? []).forEach((f, i) => {
    const chk = r.checks?.[f.checkId];
    const pth = (f.url || '—').replace(/^https?:\/\/[^/]+/, '') || '/';
    const tr = (f.traffic.clicks || f.traffic.impressions) ? ` · ${f.traffic.clicks || 0} clicks / ${f.traffic.impressions || 0} impr` : '';
    const idx = Math.round((f.priority || 0) / maxPrio * 100);
    const effort = f.effort?.hours != null ? ` · ~${f.effort.hours}h` : '';
    out.push(`${i + 1}. ${SEV_ICON[f.severity] ?? '·'} **${chk?.title || f.checkId}** — \`${pth}\` · impact ${sizeOf(idx)} (${idx}/100)${effort}${tr} · finding #${f.id}`);
    if (chk?.fix && !fixShown.has(f.checkId)) { fixShown.add(f.checkId); out.push(`   ${chk.fix}`); }
  });
  out.push('', `_Showing the top ${(r.top ?? []).length} by priority. \`query_audit\` with a check id lists every finding with full evidence; \`run_audit topLimit\` (up to 50) widens this list._`);
  const byCat: Record<string, string[]> = {};
  for (const c of r.byCheck ?? []) (byCat[c.category] ??= []).push(`${c.checkId ?? (c as any).check_id} (${c.count})`);
  out.push('', '## All issues by category');
  for (const [cat, checks] of Object.entries(byCat)) out.push(`- **${categoryLabel(cat, CAT_NAME)}** — ${checks.join(', ')}`);
  const idx = r.indexability ?? {};
  const notIndexable = Object.entries(idx).filter(([k]) => k !== 'indexable');
  if (notIndexable.length) {
    out.push('', '## Indexability (crawled URLs)', `- ✅ indexable: ${idx.indexable ?? 0}`);
    for (const [reason, n] of notIndexable) out.push(`- ✗ ${reason}: ${n}`);
  }
  if (r.notCollected?.length) {
    out.push('', '## Not collected (unknown, not passed)');
    for (const n of r.notCollected) out.push(`- \`${n.checkId}\`: ${n.note}`);
  }
  if (r.elapsedMs != null) out.push('', `_Audit computed in ${(r.elapsedMs / 1000).toFixed(1)}s._`);
  out.push('', `_\`export_report siteUrl:"${siteUrl}"\` → a shareable interactive HTML dashboard._`);
  return out.join('\n');
}
