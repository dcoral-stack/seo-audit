/** Worker-thread body for the one-time FTS backfill on large property DBs (#35 review): better-sqlite3
 *  is synchronous, so a multi-million-row backfill on the main thread would freeze the MCP server. */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { ensureFtsSchema, ensureFtsBackfilled, type FtsIndex } from './fts.js';

const { dbFile, indexes } = workerData as { dbFile: string; indexes: FtsIndex[] };
try {
  const db = new Database(dbFile, { fileMustExist: true });
  db.pragma('busy_timeout = 60000'); // wait out a running sync/crawl's write lock instead of failing
  try { ensureFtsSchema(db); for (const i of indexes) ensureFtsBackfilled(db, i); } finally { db.close(); }
  parentPort!.postMessage({ ok: true, indexes });
} catch (e) { parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
