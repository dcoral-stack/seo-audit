/**
 * robots.txt as fetched by the latest crawl, one row per origin (#55). The crawler already reads
 * robots.txt for its own politeness gate; storing the bytes lets the audit answer "what does
 * robots.txt say to Googlebot / to OAI-SearchBot?" from a stored row, so site-wide-indexing-alarm
 * and ai-search-bot-blocked cite what was fetched rather than a live request.
 */
import type Database from 'better-sqlite3';
import type { RobotsTxtFetch } from './robots.js';

export function ensureRobotsTxtSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS robots_txt (
      origin TEXT PRIMARY KEY,         -- scheme://host the file was requested from
      status INTEGER NOT NULL,         -- HTTP status (0 = no response)
      body TEXT,                       -- the file (NULL unless 2xx)
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function storeRobotsTxt(db: Database.Database, origin: string, r: RobotsTxtFetch): void {
  ensureRobotsTxtSchema(db);
  db.prepare(`INSERT INTO robots_txt (origin, status, body, fetched_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(origin) DO UPDATE SET status=excluded.status, body=excluded.body, fetched_at=excluded.fetched_at`)
    .run(origin, r.status, r.body);
}

/** The most recently fetched robots.txt, or null when no crawl has stored one. */
export function latestRobotsTxt(db: Database.Database): { origin: string; status: number; body: string | null; fetchedAt: string } | null {
  ensureRobotsTxtSchema(db);
  const r = db.prepare(`SELECT origin, status, body, fetched_at fetchedAt FROM robots_txt ORDER BY fetched_at DESC LIMIT 1`).get() as
    { origin: string; status: number; body: string | null; fetchedAt: string } | undefined;
  return r ?? null;
}
