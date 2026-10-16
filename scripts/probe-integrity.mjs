// Regression test for data_storage integrity check + index repair (#34). Damages an index the way
// the field report saw ("row N missing from index …") by rewriting its definition via
// writable_schema, so stored entries no longer match. Run: node scripts/probe-integrity.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { checkIntegrity, repairIndexes } from '../dist/core/integrity.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dir = mkdtempSync(path.join(tmpdir(), 'sac-integrity-'));
const site = 'https://example.com/';
const file = dbPathFor(dir, site);

new AuditDatabase(file).close(); // a real property DB
{
  const db = new Database(file);
  db.exec(`CREATE TABLE zz(a INTEGER, b INTEGER); CREATE INDEX idx_zz ON zz(a);`);
  const ins = db.prepare('INSERT INTO zz VALUES (?, ?)');
  db.transaction(() => { for (let i = 0; i < 200; i++) ins.run(i, 1000 - i); })();
  db.close();
}

const clean = await checkIntegrity(dir, site, 'full');
check('healthy DB reports ok', clean.ok && clean.problems.length === 0, JSON.stringify(clean));

{
  const db = new Database(file);
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  db.prepare(`UPDATE sqlite_master SET sql = 'CREATE INDEX idx_zz ON zz(b)' WHERE name = 'idx_zz'`).run();
  db.pragma('writable_schema = OFF');
  db.close();
}

const quick = await checkIntegrity(dir, site, 'quick');
const full = await checkIntegrity(dir, site, 'full');
check('full check finds the damaged index by name', !full.ok && full.damagedIndexes.includes('idx_zz') && !full.tableDamage, JSON.stringify({ ...full, problems: full.problems.slice(0, 2) }));
console.log(`  (quick_check ok=${quick.ok}; field report saw quick_check pass on this class of damage)`);

const rep = await repairIndexes(dir, site);
check('repair backs up before touching the DB', !!rep.backup && readdirSync(dir).some(f => f.includes('.bak-')), JSON.stringify(rep.backup));
check('repair REINDEXes only the damaged index', JSON.stringify(rep.reindexed) === '["idx_zz"]', JSON.stringify(rep.reindexed));
check('integrity is clean after repair', rep.after?.ok === true, JSON.stringify(rep.after?.problems.slice(0, 2)));

const again = await repairIndexes(dir, site);
check('repair on a clean DB is a no-op without a backup', again.backup === null && again.reindexed.length === 0, JSON.stringify(again));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
