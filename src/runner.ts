#!/usr/bin/env node
// Copyright (c) 2026 Richard Baxter / Houtini — Apache-2.0 (see LICENSE)
import { runFromEnv } from './core/jobRunner.js';

/**
 * `seo-audit-runner`: the job runner sidecar (#56). It runs the crawls, syncs and other async jobs
 * that an MCP server started with SAC_JOB_RUNNER=external has queued in the shared data dir, so
 * the MCP process (a Docker MCP gateway worker) can be replaced mid-job without killing the work.
 *
 * Run it next to the gateway, on the same data volume and with the same credentials:
 *   docker run -d --init --name seo-audit-runner --restart unless-stopped \
 *     -v mcp-sac-data:/data -v mcp-sac-creds:/creds:ro \
 *     -e SAC_DATA_DIR=/data -e GOOGLE_APPLICATION_CREDENTIALS=/creds/gsc.json \
 *     node:22-slim npx -y -p @houtini/seo-audit-console seo-audit-runner
 * Env: SAC_RUNNER_CONCURRENCY (default 1; one job per property at a time whatever it is set to),
 * plus the optional DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD / MAJESTIC_API_KEY the MCP server has.
 * Logs go to stderr (docker logs seo-audit-runner). SIGTERM stops it cleanly.
 */
try {
  runFromEnv();
} catch (e) {
  console.error('[runner] failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
}
