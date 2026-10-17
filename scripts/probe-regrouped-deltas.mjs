// Probe (0.16.2): a change in a check's finding grain is neither opened nor resolved. In 0.16.1 the
// accessibility roll-up regrouped a11y findings per template, and the Summary on
// simracingcockpit.gg read "759 resolved since the last audit": 730 of them were per-page findings
// re-keyed into template findings. The pair's counts now leave the regrouped checks out (with a
// note), the verdict, the "What's broken" change column and the health chart read the same numbers,
// a run records `id@2` in check_ids, and a recorded grain never makes the check set look changed.
// Run: node scripts/probe-regrouped-deltas.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { dbPathFor } from '../dist/core/paths.js';
import { auditHistory, checkIdsWithGrain, findingsGrain, baseCheckIds } from '../dist/audit/history.js';
import { buildVerdict } from '../dist/core/summaryVerdict.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-regroup-${Date.now()}`);
const text = (v) => v.segments.map(s => s.text).join('');

const IDS = ['a11y-link-name', 'a11y-form-label', 'image-oversized'];
const CAT = { 'a11y-link-name': 'accessibility', 'a11y-form-label': 'accessibility', 'image-oversized': 'performance' };
function run(db, runId, at, findings, checkIds = JSON.stringify([...IDS].sort()), version = '0.16.0') {
  db.prepare(`INSERT INTO audit_runs (run_id,scope,started_at,finished_at,finding_count,status,check_ids,server_version,health_basis) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(runId, 'core', at, at, findings.length, 'completed', checkIds, version, 'audit');
  const ins = db.prepare(`INSERT INTO findings (run_id,check_id,category,severity,labels,certainty,url_key,evidence,traffic_at_risk,effort,priority,recommendation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [check, key, ev] of findings) ins.run(runId, check, CAT[check], 'med', '["D"]', 1, key, JSON.stringify(ev ?? {}), '{}', '{}', 1, '{}');
}
const page = (i) => `https://x.test/p${i}`;
const range = (n) => Array.from({ length: n }, (_, i) => i);

try {
  const site = 'sc-domain:regroup.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const db = adb.db;

  // Run A (0.16.0): one a11y-link-name finding per page (40 pages), 2 form-label, 5 oversized images.
  run(db, 'A', '2026-10-17 19:12:00', [
    ...range(40).map(i => ['a11y-link-name', page(i), { namelessLinks: 3 }]),
    ['a11y-form-label', page(1), {}], ['a11y-form-label', page(2), {}],
    ...range(5).map(i => ['image-oversized', page(i), {}]),
  ]);
  // Run B (0.16.1): the 40 pages' shared header links roll up into ONE template finding (keyed to the
  // top page) plus 2 pages with their own extras; form-label unchanged; 2 oversized images fixed, 1 new.
  run(db, 'B', '2026-10-17 20:55:00', [
    ['a11y-link-name', page(0), { scope: 'template', pages: 40, namelessLinks: 3 }],
    ['a11y-link-name', page(7), { scope: 'page', namelessLinks: 1 }],
    ['a11y-link-name', page(9), { scope: 'page', namelessLinks: 2 }],
    ['a11y-form-label', page(1), {}], ['a11y-form-label', page(2), {}],
    ...[2, 3, 4, 99].map(i => ['image-oversized', page(i), {}]),
  ], JSON.stringify([...IDS].sort()), '0.16.1');

  ok(findingsGrain(db, 'A', 'a11y-link-name') === 1 && findingsGrain(db, 'B', 'a11y-link-name') === 2, 'grain read from stored findings: per-page = 1, roll-up = 2');
  ok(findingsGrain(db, 'A', 'image-oversized') === 1 && findingsGrain(db, 'B', 'nonexistent-check') === null, 'a run without findings for a check has no grain (null)');

  const h = auditHistory(db);
  const ab = h.auditDeltas.find(d => d.runId === 'B');
  ok(ab && !ab.skipped, 'the pair is still compared (same scope, same check set)');
  ok(ab?.excluded?.checkIds?.join() === 'a11y-link-name' && /accessibility findings regrouped in 0\.16\.1; not counted/.test(ab.excluded.note), `the regrouped check is excluded, with the note (${JSON.stringify(ab?.excluded)})`);
  ok(ab?.resolved === 2 && ab?.opened === 1, `only real changes count: 2 resolved, 1 opened, not 40-odd (${ab?.resolved} / ${ab?.opened})`);
  ok(ab?.carried === 2 + 3, `carried: 2 form-label + 3 images (${ab?.carried})`);

  // The roll-up's own legacy branch: a 0.16.1 run on a crawl without samples stays per-page (grain 1),
  // so comparing it with a 0.16.0 run excludes nothing.
  run(db, 'C', '2026-10-17 21:30:00', [
    ...range(40).map(i => ['a11y-link-name', page(i), { scope: 'page', namelessLinks: 3, note: 'crawled before 0.16.1, which records the elements: re-crawl to group shared template elements into one finding' }]),
  ], JSON.stringify([...IDS].sort()), '0.16.1');
  ok(findingsGrain(db, 'C', 'a11y-link-name') === 1, 'a 0.16.1 finding on a page crawled before 0.16.1 is per-page grain');

  // check_ids written by this version carry the grain; a recorded grain is not a changed check set.
  const recorded = checkIdsWithGrain(db, 'B', IDS);
  ok(recorded === JSON.stringify(['a11y-form-label', 'a11y-link-name@2', 'image-oversized']), `check_ids record the roll-up grain (${recorded})`);
  ok(JSON.stringify(baseCheckIds(recorded)) === JSON.stringify([...IDS].sort()), 'grains strip back to the check set');
  adb.close();

  // ── Through the dashboard payload and the verdict: everything agrees ──
  {
    const site2 = 'sc-domain:regroup2.test';
    const a2 = new AuditDatabase(dbPathFor(dataDir, site2));
    a2.upsertProperty(site2, 'apex');
    run(a2.db, 'A', '2026-10-17 19:12:00', [
      ...range(40).map(i => ['a11y-link-name', page(i), { namelessLinks: 3 }]),
      ...range(5).map(i => ['image-oversized', page(i), {}]),
    ]);
    // Run B as 0.16.2 writes it: the grain is in check_ids.
    run(a2.db, 'B', '2026-10-17 20:55:00', [
      ['a11y-link-name', page(0), { scope: 'template', pages: 40, namelessLinks: 3 }],
      ...[2, 3, 4, 99].map(i => ['image-oversized', page(i), {}]),
    ], JSON.stringify(['a11y-form-label', 'a11y-link-name@2', 'image-oversized']), '0.16.2');
    a2.close();
    const d = getDashboardData(dataDir, site2);
    const last = d.auditDeltas.find(x => x.runId === 'B');
    ok(last && !last.skipped && last.excluded?.checkIds.join() === 'a11y-link-name', `a recorded @2 against a stored per-page run: compared, the check excluded (${JSON.stringify(last)})`);
    const rows = d.findings.byCategory;
    const acc = rows.find(r => r.category === 'accessibility'), perf = rows.find(r => r.category === 'performance');
    ok(acc && acc.opened === 0 && acc.resolved === 0 && acc.regrouped?.join() === 'a11y-link-name', `What's broken: accessibility shows no change and says regrouped (${JSON.stringify(acc)})`);
    ok(perf && perf.opened === 1 && perf.resolved === 2, `What's broken: performance +1 −2 (${JSON.stringify(perf)})`);
    const sumResolved = rows.reduce((s, r) => s + (r.resolved ?? 0), 0), sumOpened = rows.reduce((s, r) => s + (r.opened ?? 0), 0);
    ok(sumResolved === last.resolved && sumOpened === last.opened, `the change column adds up to the pair's counts (${sumOpened}/${sumResolved} vs ${last.opened}/${last.resolved})`);
    const v = text(buildVerdict({ criticalOpen: 0, resolvedSinceLastAudit: last.resolved, resolvedNote: last.excluded?.note }));
    ok(v === '0 critical issues are open, 2 resolved since the last audit (accessibility findings regrouped in 0.16.1; not counted).', `verdict: the same count, with the note (${v})`);
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
