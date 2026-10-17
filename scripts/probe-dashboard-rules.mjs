#!/usr/bin/env node
// Dashboard display rules (src/core/displayRules.ts) and the real-data fixes from the
// directdrivewheels.com rehearsal (#68 follow-up): rank changes in positions, the small-base rule,
// one share-rounding rule, the health cap, one freshness rule, run labels on same-day runs, the
// empty-state reasons, and the brand rule on exact-match domains.
// Run:  npm run build:server && node scripts/probe-dashboard-rules.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import {
  countChange, shareText, sharePct, capHealth, rankChange, SMALL_BASE_MIN,
  assessField, fieldValue, fieldWindowLagDays,
} from '../dist/core/displayRules.js';
import { cwvFieldPayload } from '../dist/core/CruxSync.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { computeHealth } from '../dist/audit/history.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-rules-${Date.now()}`);

// ── 1. Rank change: positions, never a % of a rank ───────────────────────────────────────────
console.log('rank change');
{
  const worse = rankChange(29.3, 17.0);
  ok(worse.positions === 12.3 && !worse.better && !worse.flat, `17.0 -> 29.3 is 12.3 positions worse (${JSON.stringify(worse)})`);
  const better = rankChange(5.1, 8.5);
  ok(better.positions === 3.4 && better.better, `8.5 -> 5.1 is 3.4 positions better (${JSON.stringify(better)})`);
  ok(rankChange(4.02, 4.0).flat, 'a 0.02 move is flat');
}

// ── 2. Small-base rule ─────────────────────────────────────────────────────────────────────────
console.log('small-base change');
{
  const zeroToOne = countChange(1, 0);
  ok(zeroToOne.mode === 'abs' && zeroToOne.value === 1, `0 -> 1 is "+1", not +100% (${JSON.stringify(zeroToOne)})`);
  ok(countChange(6, 2).mode === 'abs', '2 -> 6 is a count change, not +200%');
  ok(countChange(3, SMALL_BASE_MIN - 1).mode === 'abs', `a prior of ${SMALL_BASE_MIN - 1} is still a small base`);
  const big = countChange(28, 84);
  ok(big.mode === 'pct' && Math.round(big.value) === -67, `84 -> 28 is -67% (${big.value.toFixed(1)})`);
  ok(countChange(5, SMALL_BASE_MIN).mode === 'pct', `a prior of exactly ${SMALL_BASE_MIN} takes a percentage`);
}

// ── 3. One share-rounding rule ─────────────────────────────────────────────────────────────────
console.log('share rounding');
{
  ok(shareText(2, 495) === '<1', `2 of 495 reads "<1" (got ${shareText(2, 495)})`);
  ok(shareText(0, 495) === '0', '0 of 495 reads "0"');
  ok(shareText(493, 495) === '>99', `493 of 495 reads ">99", never 100 (got ${shareText(493, 495)})`);
  ok(shareText(495, 495) === '100', 'all of them reads "100"');
  ok(sharePct(63, 495) === '13%', `63 of 495 reads 13% (got ${sharePct(63, 495)})`);
  ok(shareText(5, 0) === '0', 'an empty base reads "0", not NaN');
}

// ── 4. Health never reads 100 with a critical or high page ─────────────────────────────────────
console.log('health cap');
{
  ok(capHealth(100, 1) === 99, '100 with one error page is capped at 99');
  ok(capHealth(100, 0) === 100, '100 with no error page stays 100');
  ok(capHealth(87, 12) === 87, 'scores under 100 are untouched');
  const site = 'sc-domain:health.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at) VALUES ('c1','https://health.test','health.test','completed',495,datetime('now'),datetime('now'))`).run();
  const ins = adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable) VALUES ('c1',?,?,200,'text/html',1,1)`);
  for (let i = 0; i < 495; i++) ins.run(`https://health.test/p${i}`, `https://health.test/p${i}`);
  adb.db.prepare(`INSERT INTO audit_runs (run_id,crawl_id,scope,started_at,finished_at,finding_count,status) VALUES ('r1','c1','full',datetime('now'),datetime('now'),1,'completed')`).run();
  adb.db.prepare(`INSERT INTO findings (run_id,check_id,category,severity,url_key,labels,evidence,recommendation) VALUES ('r1','x','onpage','high','https://health.test/p3','[]','{}','{}')`).run();
  const h = computeHealth(adb.db, 'r1');
  ok(h.score === 99 && h.errorPages === 1, `1 high page of 495: stored health is 99, not 100 (${JSON.stringify(h)})`);
  adb.close();
}

// ── 5. Field CWV: thin CrUX data is shown honestly ────────────────────────────────────────────
console.log('field CWV (CrUX)');
{
  const good = (p75) => ({ p75, band: 'good' });
  const thin = assessField({ lcp: good(722), inp: null, cls: good(0) });
  ok(thin.status === 'pass' && thin.missing.join() === 'INP', `LCP + CLS good, no INP: pass on what was measured, INP listed as missing (${JSON.stringify(thin)})`);
  ok(fieldValue('inp', null) === null && fieldValue('inp', undefined) === null, 'a missing INP renders as no value (the UI says "not enough Chrome traffic"), never 0');
  ok(fieldValue('cls', 0) === '0.00' && fieldValue('lcp', 722) === '0.72 s' && fieldValue('inp', 180) === '180 ms', 'a measured zero stays a value: CLS 0.00; LCP in s, INP in ms');
  ok(assessField({ lcp: { p75: 3100, band: 'needs-improvement' }, inp: null, cls: good(0.02) }).status === 'fail', 'a needs-improvement LCP fails the assessment');
  ok(assessField({ lcp: null, inp: null, cls: good(0.02) }).status === 'unknown', 'no LCP: not assessable, never a pass');
  ok(fieldWindowLagDays('2026-08-01', '2026-10-17 16:20:57') === 78, 'a window ending 1 Aug checked 17 Oct is 78 days old');

  // The directdrivewheels.com shape: two weekly history windows, no current record, no INP.
  const site = 'sc-domain:crux.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const ins = adb.db.prepare(`INSERT INTO crux_metrics (scope,target,form_factor,metric,period_first,period_last,p75,good,ni,poor,source) VALUES ('origin','https://crux.test',?,?,?,?,?,?,?,?,'history')`);
  for (const ff of ['PHONE', 'DESKTOP']) {
    ins.run(ff, 'cumulative_layout_shift', '2026-06-28', '2026-07-25', 0, 0.95, 0.04, 0.01);
    ins.run(ff, 'cumulative_layout_shift', '2026-07-05', '2026-08-01', 0, 0.95, 0.04, 0.01);
    ins.run(ff, 'largest_contentful_paint', '2026-07-05', '2026-08-01', 722, 0.98, 0.02, 0);
  }
  adb.db.prepare(`INSERT INTO crux_targets (scope,target,form_factor,status,last_checked) VALUES ('origin','https://crux.test','PHONE','ok','2026-10-17 16:20:57')`).run();
  const cf = cwvFieldPayload(adb.db);
  const ph = cf?.formFactors?.PHONE;
  ok(ph?.source === 'history' && ph?.windows === 2, `history-only origin: source "history", 2 windows held (${ph?.source}, ${ph?.windows})`);
  ok(ph?.metrics?.inp === null && ph?.history?.inp?.length === 0, 'no INP rows: inp is null and its history empty (not zeros)');
  ok(cf?.lastChecked === '2026-10-17 16:20:57', 'the last check date ships, so the UI can say how old the window is');
  adb.close();
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
