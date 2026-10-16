/**
 * Worker-thread body for SQLite integrity checks and index repair (#34). better-sqlite3 is
 * synchronous, and a full integrity_check on a multi-GB property DB takes minutes; run inline it
 * would freeze the MCP server's stdio loop for that long. Messages: { dbFile, mode, reindex }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

interface Req { dbFile: string; mode: 'quick' | 'full'; reindex?: string[] }
const { dbFile, mode, reindex } = workerData as Req;

const run = (): { messages: string[]; ms: number; reindexed: string[] } => {
  const db = new Database(dbFile);
  try {
    const reindexed: string[] = [];
    for (const idx of reindex ?? []) {
      // Index names come from integrity_check output or sqlite_master, but quote defensively.
      db.exec(`REINDEX "${idx.replace(/"/g, '""')}"`);
      reindexed.push(idx);
    }
    const t0 = Date.now();
    const rows = db.pragma(mode === 'full' ? 'integrity_check(1000)' : 'quick_check(1000)') as Record<string, string>[];
    return { messages: rows.map(r => Object.values(r)[0]), ms: Date.now() - t0, reindexed };
  } finally { db.close(); }
};

try { parentPort!.postMessage({ ok: true, ...run() }); }
catch (e) { parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
