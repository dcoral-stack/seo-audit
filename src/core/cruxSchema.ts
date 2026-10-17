/**
 * CrUX tables (#55 item 4), the ensure-migration pattern: idempotent, run when AuditDatabase opens.
 * Kept apart from CruxSync so AuditDatabase can import it without a cycle.
 */
import type Database from 'better-sqlite3';

export function ensureCruxSchema(db: Database.Database): void {
  db.exec(`
    -- One row per target x form factor x metric x 28-day window. Idempotent upsert on the PK,
    -- so each weekly pull adds only the new window and history accrues for free.
    CREATE TABLE IF NOT EXISTS crux_metrics (
      scope        TEXT NOT NULL,      -- 'origin' | 'url'
      target       TEXT NOT NULL,      -- origin (https://host) or url_key (joins pages/GSC)
      form_factor  TEXT NOT NULL,      -- 'PHONE' | 'DESKTOP' | 'TABLET' | 'ALL'
      metric       TEXT NOT NULL,      -- API metric name, e.g. 'largest_contentful_paint'
      period_first TEXT NOT NULL,      -- YYYY-MM-DD
      period_last  TEXT NOT NULL,      -- YYYY-MM-DD (window end; the trend's x-axis)
      p75          REAL,               -- NULL when the API had no value ("NaN"/null)
      good         REAL,               -- bin densities 0..1; NULL when absent
      ni           REAL,
      poor         REAL,
      good_max     REAL,               -- bin edges as returned (e.g. 2500 / 4000, 0.10 / 0.25),
      ni_max       REAL,               --   so a threshold change by Google stays traceable
      source       TEXT NOT NULL,      -- 'record' | 'history'
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope, target, form_factor, metric, period_last)
    );
    CREATE INDEX IF NOT EXISTS idx_crux_target ON crux_metrics(target, form_factor, period_last);

    -- Fraction metrics (navigation types, LCP resource type, URL-level form-factor split).
    CREATE TABLE IF NOT EXISTS crux_fractions (
      scope TEXT NOT NULL, target TEXT NOT NULL, form_factor TEXT NOT NULL,
      metric TEXT NOT NULL, period_last TEXT NOT NULL, bucket TEXT NOT NULL, fraction REAL,
      PRIMARY KEY (scope, target, form_factor, metric, period_last, bucket)
    );

    -- Which targets have CrUX data at all. A 404 NOT_FOUND is "insufficient traffic", not an error.
    CREATE TABLE IF NOT EXISTS crux_targets (
      scope TEXT NOT NULL, target TEXT NOT NULL, form_factor TEXT NOT NULL,
      status TEXT NOT NULL,              -- 'ok' | 'insufficient_data' | 'error'
      last_checked TEXT NOT NULL, error TEXT,
      query_url TEXT,                    -- the exact origin/URL sent to the API (the target is its url_key)
      PRIMARY KEY (scope, target, form_factor)
    );
  `);
  if (!(db.prepare(`PRAGMA table_info(crux_targets)`).all() as { name: string }[]).some(c => c.name === 'query_url')) {
    db.exec('ALTER TABLE crux_targets ADD COLUMN query_url TEXT');
  }
}

