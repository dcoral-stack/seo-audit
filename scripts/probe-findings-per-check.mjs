#!/usr/bin/env node
// SEOCoral fork: the dashboard lists up to FINDINGS_PER_CHECK findings of EACH check (was the 50
// highest overall), so filtering by area/severity always finds the rows its counter promises.
// Run:  npm run build:server && node scripts/probe-findings-per-check.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { getDashboardData, FINDINGS_PER_CHECK } from '../dist/core/dashboardData.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const dir = path.join(tmpdir(), `sac-fpc-${Date.now()}`); const site = 'https://x.test/';
const adb = new AuditDatabase(dbPathFor(dir, site)); adb.upsertProperty(site, 'prefix');
const db = adb.db;
db.prepare(`INSERT INTO audit_runs (run_id, started_at, finished_at, status, finding_count) VALUES ('r1', datetime('now'), datetime('now'), 'completed', 0)`).run();
const ins = db.prepare(`INSERT INTO findings (run_id, check_id, category, severity, url_key, evidence, traffic_at_risk, effort, priority, recommendation) VALUES ('r1',?,?,?,?,'{}','{}','{}',?,'{}')`);
db.transaction(() => {
  for (let i = 0; i < 120; i++) ins.run('broken-internal-links', 'crawlability', 'crit', `https://x.test/p${i}`, 1.1);
  for (let i = 0; i < 16; i++) ins.run('missing-structured-data', 'schema', 'low', `https://x.test/s${i}`, 0);
  ins.run('homepage-missing-org-schema', 'schema', 'med', 'https://x.test/', 0);
  ins.run('missing-hsts', 'security', 'low', 'https://x.test/', 0);
})();
adb.close();
const top = getDashboardData(dir, site).findings?.top ?? [];
const n = (c) => top.filter(f => f.check_id === c).length;
ok(FINDINGS_PER_CHECK === 50, 'cap is 50 per check');
ok(n('broken-internal-links') === 50, `a check repeated 120 times is capped at 50 (${n('broken-internal-links')})`);
ok(n('missing-structured-data') === 16 && n('homepage-missing-org-schema') === 1, 'low-priority schema findings are all listed (were cut by the old top-50)');
ok(top.some(f => f.category === 'security'), 'security area has its row');
ok(top.filter(f => f.category === 'schema' && f.severity === 'med').length === 1, 'schema + Medium filter finds the homepage Organization finding');
ok(top[0].check_id === 'broken-internal-links' && top.at(-1).priority === 0, 'still ordered by priority');
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
