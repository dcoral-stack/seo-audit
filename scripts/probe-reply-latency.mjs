// Probe (0.16.2): a job tool replies with its job id before the job's database work starts.
// In 0.16.1 the job body ran in the microtask queue ahead of the tool's reply, so sync_gsc on a
// 5.5 GB property answered after 33.8 s (the sync's synchronous prologue ran first). Here another
// connection holds the property database's write lock: a job body that ran first would block on
// its first write for the 10 s busy timeout, so a reply in under 2 s proves the reply never waits
// on the job's DB work. sync_gsc's planned range is still read (read-only, index-backed) and right.
// Run: node scripts/probe-reply-latency.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JobManager } from '../dist/core/JobManager.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { storedSearchTypes } from '../dist/core/GscSync.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'sac-reply-latency-'));
const REPLY_MAX_MS = 2000;

try {
  // ── JobManager: the body starts after the current turn, so the caller's reply goes first ──
  {
    const jm = new JobManager();
    const order = [];
    const id = jm.start('sync', async () => { order.push('body'); const end = Date.now() + 300; while (Date.now() < end) { /* synchronous DB work */ } });
    // What the MCP SDK does after a handler returns: a few promise hops, then the write.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    order.push('reply');
    await sleep(400);
    check('the job body starts after the reply is written', order.join(',') === 'reply,body', order.join(','));
    check('the job still ran to completion', jm.get(id)?.state === 'completed', JSON.stringify(jm.get(id)));
  }

  // ── storedSearchTypes: constant-time end rows, both tables ──
  {
    const file = path.join(root, 'types.db');
    const adb = new AuditDatabase(file);
    const ins = adb.db.prepare(`INSERT INTO search_analytics (date, query, page, page_key, device, country, clicks, impressions, ctr, position, search_type) VALUES (?, 'q', 'p', 'p', '', '', 1, 1, 1, 1, ?)`);
    check('no rows: no stored type', storedSearchTypes(adb.db).length === 0, JSON.stringify(storedSearchTypes(adb.db)));
    ins.run('2026-10-01', 'web'); ins.run('2026-10-02', 'web');
    check('one type stored: read from the end rows', JSON.stringify(storedSearchTypes(adb.db)) === '["web"]', JSON.stringify(storedSearchTypes(adb.db)));
    adb.db.prepare(`INSERT INTO search_analytics_segments (date, query, page, page_key, device, country, clicks, impressions, ctr, position, search_type) VALUES ('2026-10-03', 'q', 'p', 'p', '', 'gbr', 1, 1, 1, 1, 'discover')`).run();
    check('a different type in the segment table is seen', storedSearchTypes(adb.db).sort().join(',') === 'discover,web', JSON.stringify(storedSearchTypes(adb.db)));
    adb.close();
  }

  // ── Through the real server, with the property's write lock held by another connection ──
  {
    const dir = path.join(root, 'e2e');
    // A one-page local site, so the crawl finishes quickly and nothing leaves the machine.
    const server = http.createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>t</title></head><body><h1>t</h1></body></html>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${server.address().port}/`;
    const file = dbPathFor(dir, site);
    {
      const adb = new AuditDatabase(file);
      adb.upsertProperty(site, 'asis');
      const ins = adb.db.prepare(`INSERT INTO search_analytics (date, query, page, page_key, device, country, clicks, impressions, ctr, position) VALUES (?, 'q', ?, ?, '', '', 3, 30, 0.1, 4)`);
      for (const d of ['2026-10-01', '2026-10-10']) ins.run(d, `${site}a`, `${site}a`);
      adb.close();
    }
    const creds = path.join(root, 'creds.json'); // parses as a key file; signing fails before any request
    writeFileSync(creds, JSON.stringify({ type: 'service_account', client_email: 'x@x.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n', token_uri: 'http://127.0.0.1:9/token' }));
    const env = { ...process.env, SAC_DATA_DIR: dir, SAC_AUTOSERVE: '0', GOOGLE_APPLICATION_CREDENTIALS: creds };
    for (const k of ['SAC_JOB_RUNNER', 'DATAFORSEO_USERNAME', 'DATAFORSEO_PASSWORD', 'MAJESTIC_API_KEY', 'CRUX_API_KEY']) delete env[k];
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(here, '../dist/index.js')], env, stderr: 'ignore' });
    const client = new Client({ name: 'probe-reply-latency', version: '0' });
    await client.connect(transport);
    const text = (r) => (r.content ?? []).map(c => c.text ?? '').join('\n');
    const settle = async (jobId) => {
      const end = Date.now() + 60_000;
      while (Date.now() < end) {
        const st = await client.callTool({ name: 'check_sync_status', arguments: { jobId } });
        const line = text(st).split('\n')[0];
        if (!/: (running|queued)/.test(line)) return text(st);
        await sleep(200);
      }
      return 'still running';
    };
    const calls = [
      ['sync_gsc', { siteUrl: site }],
      ['start_crawl', { siteUrl: site, maxPages: 1, checkExternal: false, siteProbes: false }],
      ['refresh_property', { siteUrl: site, crawl: false, inspect: false, ranks: false, crux: false }],
      ['data_storage', { siteUrl: site, check: 'quick' }],
    ];
    try {
      for (const [tool, args] of calls) {
        const lock = new Database(file);
        lock.exec('BEGIN IMMEDIATE');
        lock.prepare(`UPDATE property_meta SET last_crawl_id = last_crawl_id`).run(); // hold the write lock
        const t0 = performance.now();
        const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60_000 });
        const ms = Math.round(performance.now() - t0);
        const jobId = r.structuredContent?.jobId;
        check(`${tool} replies with a job id in under ${REPLY_MAX_MS} ms while its database is write-locked (${ms} ms)`, typeof jobId === 'string' && ms < REPLY_MAX_MS, `${ms} ms: ${text(r)}`);
        if (tool === 'sync_gsc') {
          check('sync_gsc still states the planned range from the stored data (last stored day minus the lag days)', r.structuredContent?.startDate === '2026-10-06' && r.structuredContent?.incremental === true, JSON.stringify(r.structuredContent));
        }
        // Release the lock a second later from this process; the job (blocked on its first write
        // meanwhile) then proceeds and settles on its own: a failed GSC auth, a one-page crawl.
        await sleep(1000);
        lock.exec('ROLLBACK');
        lock.close();
        const fin = await settle(jobId);
        check(`${tool}: the job ran once the lock was released`, fin !== 'still running' && !/database is locked/.test(fin), fin);
      }
    } finally {
      await client.close();
      server.close();
    }
  }
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
