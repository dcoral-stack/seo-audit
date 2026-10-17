#!/usr/bin/env node
// Brand detection (src/core/brand.ts): a query is branded when a run of its whole words spells the
// domain stem, so a concatenated domain matches its spaced spellings. Shared by the dashboard's
// branded split and the audit's branded-query exclusion.
// Run:  npm run build:server && node scripts/probe-brand.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { brandRun, brandPredicate, loadBrandQueries } from '../dist/core/brand.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-brand-${Date.now()}`);

// ── 1. The word-run rule ────────────────────────────────────────────────────────────────────────
const T = 'simracingcockpit';
for (const [q, want] of [
  ['simracingcockpit', 'simracingcockpit'],
  ['sim racing cockpit', 'sim racing cockpit'],
  ['best sim racing cockpit 2026', 'sim racing cockpit'],
  ['simracing cockpit', 'simracing cockpit'],
  ['Sim-Racing Cockpit', 'sim racing cockpit'],
  ['simracingcockpit.gg', 'simracingcockpit'],
  ['sim racing cockpits', null],
  ['sim racing cockpit', 'sim racing cockpit'],
  ['racing cockpit', null],
  ['simracingcockpitx', null],
]) ok(brandRun(q, T) === want, `brandRun("${q}") = ${JSON.stringify(want)} (${JSON.stringify(brandRun(q, T))})`);
ok(brandRun('ehi inspections', 'ehi') === 'ehi' && brandRun('vehicle inspections', 'ehi') === null, 'a short brand matches as a whole word, never inside one ("ehi" vs "vehicle")');
ok(brandRun('e hi inspections', 'ehi') === null, 'a run of two or more words needs words of 2+ characters ("e hi" is not "ehi")');
ok(brandRun('my brand shoes', 'mybrand') === 'my brand', 'a hyphenated domain (my-brand.com -> "mybrand") matches "my brand"');

// ── 2. The dashboard's branded split on a concatenated domain ───────────────────────────────────
{
  const site = 'sc-domain:simracingcockpit.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,3)`);
  const u = 'https://simracingcockpit.test/';
  adb.db.transaction(() => {
    for (let t = Date.parse('2026-08-01'); t <= Date.parse('2026-09-30'); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      ins.run(d, 'sim racing cockpit', u, u, 3, 30);
      ins.run(d, 'simracingcockpit', u, u, 1, 5);
      ins.run(d, 'simracingcockpit.gg review', u, u, 1, 5);
      ins.run(d, 'sim racing cockpits', u, u, 2, 40);   // plural: not the brand
      ins.run(d, 'fov calculator', u, u, 4, 80);
    }
  })();
  const m = loadBrandQueries(adb.db, site);
  ok(m.token === 'simracingcockpit' && m.queries === 3, `three branded queries found (${JSON.stringify(m)})`);
  ok(['sim racing cockpit', 'simracingcockpit'].every(v => m.variants.includes(v)), `variants listed: ${m.variants.join(' | ')}`);
  adb.close();
  const d = getDashboardData(dataDir, site);
  const b = d.brandedSplit;
  // 28 days x (3 + 1 + 1) branded, 28 x (2 + 4) non-branded.
  ok(b.branded.clicks === 28 * 5 && b.nonBranded.clicks === 28 * 6, `branded split: ${b.branded.clicks} branded / ${b.nonBranded.clicks} non-branded (want 140 / 168)`);
  ok(b.variants.includes('sim racing cockpit'), 'payload carries the matched spellings');
}

// ── 3. Non-ASCII case: SQLite LOWER() is ASCII-only, JS toLowerCase() is not ───────────────────
{
  const site = 'sc-domain:simracingcockpit.de';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,3)`);
  const u = 'https://simracingcockpit.de/';
  adb.db.transaction(() => {
    for (let t = Date.parse('2026-09-01'); t <= Date.parse('2026-09-30'); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      ins.run(d, 'Simracingcockpit ÜBERSICHT', u, u, 2, 20);
      ins.run(d, 'simracingcockpit übersicht', u, u, 1, 10);
      ins.run(d, 'lenkrad test', u, u, 4, 80);
    }
  })();
  const m = loadBrandQueries(adb.db, site);
  const n = (q) => adb.db.prepare(`SELECT COUNT(*) n FROM search_analytics WHERE query = ? AND ${brandPredicate()}`).get(q).n;
  ok(m.queries === 1 && n('Simracingcockpit ÜBERSICHT') === 30 && n('simracingcockpit übersicht') === 30, `"Simracingcockpit ÜBERSICHT" and its lower-case form both read as branded (${n('Simracingcockpit ÜBERSICHT')} / ${n('simracingcockpit übersicht')} rows)`);
  ok(n('lenkrad test') === 0, 'a non-brand query stays non-brand');
  adb.close();
  const b = getDashboardData(dataDir, site).brandedSplit;
  ok(b.branded.clicks === 28 * 3 && b.nonBranded.clicks === 28 * 4, `branded split counts both case forms (${b.branded.clicks} branded / ${b.nonBranded.clicks} non-branded, want 84 / 112)`);
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
