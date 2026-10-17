// Probe (0.16.1): data_storage lists backups and each property's GSC storage state. Backups
// (`<db>.bak-*`) are listed per property with size and date and counted in the totals; the
// migration's backup is marked; stray empty -wal/-shm beside a backup are removed; a migration
// refused for disk reads "deferred" with the reason; and a new migration backup leaves no sidecars.
// Run: node scripts/probe-data-storage.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { storageSummary, removeEmptySidecars, COUNTS_CACHE_FILE } from '../dist/core/dataStorage.js';
import { migrateGscStorage } from '../dist/core/gscMigrate.js';
import { setGscStorageState } from '../dist/core/gscRows.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dir = mkdtempSync(path.join(tmpdir(), 'sac-storage-'));

/** A property in the #64 layout (segment rows in search_analytics): the migration has work to do. */
function legacyProperty(name) {
  const site = `sc-domain:${name}.test`;
  const file = dbPathFor(dir, site);
  const adb = new AuditDatabase(file);
  adb.upsertProperty(site, 'apex');
  adb.db.exec(`DROP TRIGGER IF EXISTS sa_totals_only; DROP TRIGGER IF EXISTS sa_totals_only_upd; DELETE FROM gsc_storage_state;`);
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,0,4)`);
  for (const d of ['2026-06-01', '2026-06-02']) { ins.run(d, 'q', 'https://x.test/a', 'x.test/a', '', '', 5, 50); ins.run(d, 'q', 'https://x.test/a', 'x.test/a', '', 'gbr', 5, 50); }
  adb.close();
  new AuditDatabase(file).close(); // first open by this version: pending
  return { site, file };
}

try {
  // ── 1. A migrated property with two backups (one the migration's, with 0.16.0's stray sidecars) ──
  const site = 'sc-domain:main.test';
  const file = dbPathFor(dir, site);
  { const adb = new AuditDatabase(file); adb.upsertProperty(site, 'apex'); adb.close(); }
  const migBak = `${file}.bak-20261017-190415`;
  const oldBak = `${file}.bak-2026-10-16`;
  copyFileSync(file, migBak);
  copyFileSync(file, oldBak);
  writeFileSync(`${migBak}-wal`, '');               // what 0.16.0 left: an empty WAL ...
  writeFileSync(`${migBak}-shm`, Buffer.alloc(32768)); // ... and its shared-memory file
  { const adb = new AuditDatabase(file); setGscStorageState(adb.db, 'done', { backup: migBak, detail: { finishedAt: '2026-10-17T19:10:00Z' } }); adb.close(); }

  const s = storageSummary(dir);
  const p = s.properties.find(x => x.siteUrl === site);
  check('both backups listed for the property', p?.backups.length === 2 && p.backups.every(b => b.of === path.basename(file)), JSON.stringify(p?.backups));
  const mb = p?.backups.find(b => b.file === path.basename(migBak));
  check('the migration backup is marked, with size and date', mb?.kind === 'gsc-migration' && mb.bytes > 0 && /^\d{4}-\d\d-\d\dT/.test(mb.modified), JSON.stringify(mb));
  check('the other backup is "other"', p?.backups.find(b => b.file === path.basename(oldBak))?.kind === 'other');
  check('backups counted in the totals', s.backupBytes === p.backups.reduce((a, b) => a + b.bytes, 0) && s.totalBytes >= s.backupBytes + p.bytes, JSON.stringify({ backupBytes: s.backupBytes, totalBytes: s.totalBytes }));
  check('stray empty sidecars beside the backup removed', s.straySidecarsRemoved.length === 2 && !existsSync(`${migBak}-wal`) && !existsSync(`${migBak}-shm`), JSON.stringify(s.straySidecarsRemoved));
  check('a backup is not mistaken for a property or "other" db', !s.other.some(o => o.file.includes('.bak-')) && s.properties.length === 1);
  check('GSC storage: migrated', p?.gscStorage.state === 'migrated' && /delete/.test(p.gscStorage.note), JSON.stringify(p?.gscStorage));
  writeFileSync(`${oldBak}-wal`, 'not empty');
  check('a non-empty WAL beside a backup is left alone', removeEmptySidecars(oldBak).length === 0 && existsSync(`${oldBak}-wal`));
  rmSync(`${oldBak}-wal`);

  // ── 2. Pending, then deferred for lack of disk (with the reason) ──
  const pend = legacyProperty('pending');
  check('GSC storage: pending before any migration attempt', storageSummary(dir, pend.site).properties[0]?.gscStorage.state === 'pending');
  { const adb = new AuditDatabase(pend.file); const r = await migrateGscStorage(adb.db, pend.file, { freeBytes: () => 1024 }); adb.close(); check('migration refused on low disk', !!r.refused); }
  const def = storageSummary(dir, pend.site).properties[0]?.gscStorage;
  check('GSC storage: deferred, and why', def?.state === 'deferred' && /not enough free disk/.test(def.note), JSON.stringify(def));
  check('narrowed to one property: only its backups', storageSummary(dir, pend.site).backups.length === 0);

  // ── 3. A real migration's backup leaves no sidecars ──
  const mig = legacyProperty('migrates');
  const r = await (async () => { const adb = new AuditDatabase(mig.file); try { return await migrateGscStorage(adb.db, mig.file, { freeBytes: () => 1e15 }); } finally { adb.close(); } })();
  check('migration ran and made a backup', r.ran && !!r.backup && existsSync(r.backup), JSON.stringify(r));
  const beside = readdirSync(dir).filter(f => f.startsWith(path.basename(r.backup)) && f !== path.basename(r.backup));
  check('no -wal/-shm beside the new backup', beside.length === 0, JSON.stringify(beside));
  const after = storageSummary(dir, mig.site).properties[0];
  check('GSC storage: migrated, its backup marked', after?.gscStorage.state === 'migrated' && after.backups[0]?.kind === 'gsc-migration', JSON.stringify(after?.backups));

  // ── 4. Row counts are cached beside the databases until a database or its WAL changes (0.16.2) ──
  {
    const cacheFile = path.join(dir, COUNTS_CACHE_FILE);
    const first = storageSummary(dir, site).properties[0];
    check('the counts cache is written', existsSync(cacheFile));
    // Doctor the cached count: a listing that reuses the cache shows it, one that recounts doesn't.
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    cache[path.basename(file)].counts.findings = 4242;
    writeFileSync(cacheFile, JSON.stringify(cache));
    check('an unchanged database reuses the cached counts', storageSummary(dir, site).properties[0]?.findings === 4242, String(storageSummary(dir, site).properties[0]?.findings));
    { const adb = new AuditDatabase(file); adb.db.prepare(`INSERT INTO audit_runs (run_id, started_at) VALUES ('r-cache', datetime('now'))`).run(); adb.close(); }
    const recount = storageSummary(dir, site).properties[0];
    check('a write to the database invalidates them', recount?.findings === first.findings && recount.findings !== 4242, String(recount?.findings));
    writeFileSync(cacheFile, '{not json');
    check('an unreadable cache just means counting', storageSummary(dir, site).properties[0]?.findings === first.findings);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
