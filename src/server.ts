import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { getDashboardData } from './core/dashboardData.js';
import { startDashboardServer, stopDashboardServer, dashboardServerUrl, dashboardReachable, containerDashboardNote, type WebServerOptions } from './core/webServer.js';
import { buildWebCallHandlers } from './core/webHandlers.js';

/** The dashboard fields for a structured result: an openable URL, or (in a container the host
 * can't reach) a null URL plus the in-container address and what to do instead. */
function dashboardFields(siteUrl?: string): Record<string, unknown> {
  const base = dashboardServerUrl();
  if (!base) return { dashboardUrl: null };
  const page = `${base}/dashboard${siteUrl ? `?siteUrl=${encodeURIComponent(siteUrl)}` : ''}`;
  if (dashboardReachable()) return { dashboardUrl: base, dashboard: page };
  return { dashboardUrl: null, dashboard: null, dashboardContainerUrl: page, dashboardNote: containerDashboardNote(siteUrl, page) };
}

/** A clickable browser-dashboard link appended to tool outputs — the user should always
 * know the full interactive report is one click away (or one serve_dashboard call away). */
function browserLink(siteUrl?: string): string {
  const base = dashboardServerUrl();
  // Inside a container with a random, unpublished port the URL is only reachable from inside it:
  // say so and hand over the sidecar command instead of a dead link (bare metal is unchanged).
  if (base && !dashboardReachable()) return `\n\n📊 ${containerDashboardNote(siteUrl, `${base}/dashboard${siteUrl ? `?siteUrl=${encodeURIComponent(siteUrl)}` : ''}`)}`;
  if (base) return `\n\n📊 Browser dashboard: ${base}/dashboard${siteUrl ? `?siteUrl=${encodeURIComponent(siteUrl)}` : ''}`;
  // No live server: point at the dashboard surfaces that always work. get_dashboard renders the
  // interactive dashboard in chat (works through the Docker gateway where a served port would not);
  // serve_dashboard opens a browser tab locally; export_report writes a shareable HTML file.
  return `\n\n📊 See it in the dashboard — run get_dashboard${siteUrl ? ` for ${siteUrl}` : ''} (interactive, in chat), serve_dashboard (browser tab), or export_report (shareable HTML).`;
}
import { runAudit, runSingleCheck, listChecks } from './audit/engine.js';
import { buildAuditMarkdown } from './audit/report.js';
import { diffLatest, buildDriftMarkdown } from './audit/drift.js';
import { checkAgentReadiness, buildAgentReadinessMarkdown } from './core/agentReadiness.js';
import { detectTemplates } from './audit/templates.js';
import { suggestPages } from './audit/opportunities.js';
import { AuditDatabase } from './core/AuditDatabase.js';
import { dbPathFor, sanitizeProperty, jobScopeFor, CONFIG_PATH, DEFAULT_DATA_DIR, resolveDataDir } from './core/paths.js';
import { fmtDuration, crawlNotes } from './core/crawlProgress.js';
import Database from 'better-sqlite3';
import { runQueryData, QUERYABLE_TABLES, FILTER_OPS, METRIC_FNS, truncateCell } from './core/queryData.js';
import { ftsIndexFor, pendingBackfills, INLINE_BACKFILL_MAX_ROWS, type FtsIndex } from './core/fts.js';
import { storageSummary, pruneProperty, fmtBytes } from './core/dataStorage.js';
import { scoreSitePassages } from './core/passageScore.js';
import { buildDraftBrief } from './core/draftBrief.js';
import { generateJsonLd, suggestRedirect, suggestInternalLinks, collapseChainRules } from './generators/index.js';

import { urlKey, hostFormForProperty } from './core/url-key.js';
import { GscClient } from './core/GscClient.js';
import { GscSync, FULL_DIMENSIONS } from './core/GscSync.js';
import { UrlInspector } from './core/UrlInspector.js';
import { Crawler } from './core/Crawler.js';
import { Refresh } from './core/Refresh.js';
import type { DataForSeoClient } from './core/DataForSeoClient.js';
import { GoogleAdsClient, googleAdsCredentials } from './core/GoogleAdsClient.js';
import { keywordVolumes, compactMonthly } from './core/volume.js';
import { saveKeywords, deleteKeywords, keywordDemandPayload } from './core/keywordDemand.js';
import type { RankTracker } from './core/RankTracker.js';
import type { Backlinks } from './core/Backlinks.js';
import { fetchGoogleNews } from './core/googleNews.js';
import { WikidataClient } from './core/WikidataClient.js';
import { Entities } from './core/Entities.js';
import { JobManager, corruptionHint, jobsDbPath, jobRunnerModeFromEnv, type Job } from './core/JobManager.js';
import { submitJob, type JobKindName, type JobArgsByKind, type JobDeps } from './core/jobKinds.js';
import { propertyDbFile } from './core/integrity.js';
import { probeUrls, urlVariants, judgeVariants, type ProbeResult } from './core/probeUrls.js';
import { triage404s, verifyLive } from './core/triage404.js';
import { gscFreshness } from './core/gscFreshness.js';
import { clusterKeywordList } from './audit/keywordList.js';
import type { FetchOptions } from './core/types.js';
import { DEFAULT_MARKET_LABEL } from './core/locale.js';
import { cruxApiKey } from './core/secrets.js';
import { CruxSync, CRUX_DEFAULT_URL_LIMIT } from './core/CruxSync.js';

const SERVER_NAME = 'seo-audit-console';
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

// Where per-property crawl/audit DBs live. Resolution order (computed once per run):
//   SAC_DATA_DIR env  >  persisted choice (~/.seo-audit-console.json)  >  Documents default.
// The user can set the persisted choice through the `data_location` tool (no JSON editing).
// CONFIG_PATH / DEFAULT_DATA_DIR / resolveDataDir live in core/paths.ts so the dashboard sidecar
// resolves the same directory (it used to read SAC_DATA_DIR only and ignore data_location, #50).
let RESOLVED_DATA_DIR: string | null = null;
export function dataDir(): string {
  if (!RESOLVED_DATA_DIR) RESOLVED_DATA_DIR = resolveDataDir();
  return RESOLVED_DATA_DIR;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Version the widget URIs: hosts may cache ui:// resources by URI indefinitely, so an
// unversioned URI can pin users to a stale (or broken) cached bundle across releases.
const DASHBOARD_URI = `ui://dashboard/main-${SERVER_VERSION}.html`;
const SYNC_PROGRESS_URI = `ui://sync-progress/main-${SERVER_VERSION}.html`;

// Must match the categories actually used by CHECKS (src/audit/checks.ts) so category
// filters never silently return empty. (Was listing performance/agentic/integrity/war-stories
// which no check uses, and omitting content/security which checks do use.)
const CHECK_CATEGORIES = [
  'crawlability', 'indexation', 'onpage', 'content', 'schema', 'security', 'performance', 'accessibility', 'merged',
] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}


// Server-level instructions (MCP `initialize` result): teach the assistant how the data
// sources JOIN so it can COMPOSE bespoke multi-source analyses, not just run presets.
const SERVER_INSTRUCTIONS = `SEOCoral Audit (fork of SEO Audit Console for Spanish-language sites) fuses free sources into one SQLite database per property: Google Search Console history, a first-party site crawl, GSC URL Inspection, and Google Ads Keyword Planner volumes. Its power is COMPOSITION — joining sources to answer questions no single tool answers. Text matching is accent-, stop-word- and plural-aware (Spanish and English).

JOIN KEYS:
- url_key — one normalised URL form. Joins the crawl (pages, links) ↔ GSC (search_analytics.page_key) ↔ url_inspection ↔ page_cwv ↔ page_entity. normalize_url shows the key for any URL.
- query / keyword — GSC search_analytics.query ↔ keyword_planner.keyword (Keyword Planner rows saved per property).

GRAIN:
- search_analytics: date × query × page (all-country totals; device/country rows live in search_analytics_segments). Position must be impression-weighted when aggregated.
- pages / links: the LATEST crawl, one row per url_key (history in page_snapshots, diffed by detect_changes).
- url_inspection: one row per inspected URL — Google's own view.
- keyword_planner: one row per keyword saved to the property (volume, competition, CPC, trend).

ARCHETYPE CHAINS:
1. Demand → reality: Keyword Planner volume or a GSC query with impressions but weak rank → the ranking page's title/H1/body → does the page say what the query asks? → fix on-page or draft content.
2. Authority → waste: iPR flowing into non-200, redirected or orphaned URLs → 301s or internal links (fix_finding generates them).
3. Demand → gap: keyword_ideas for a client's services (siteUrl to save) → keyword_demand status gap/striking → pages to create or push.

COST: every tool is free. Keyword Planner calls are cached 30 days and count against the Google Ads API daily quota, so batch keywords (up to thousands per keyword_volume call) instead of looping. Keep replies lean: keyword tools omit the 12-month series unless includeMonthly is set.

WORKFLOW per client: refresh_property → run_audit → keyword_ideas / keyword_volume with siteUrl → keyword_demand → fix_finding per top finding → export_report (includes the Keywords tab).

Before planning a complex multi-source question, call composition_cookbook.`;

const COOKBOOK_TEXT = `# Composition cookbook — the data surface and how to join it

This server's value is composition: joining Search Console, the crawl, URL Inspection and Google Keyword Planner to answer questions no preset check covers. This page is static (no API calls) — use it to PLAN, then run the tools.

## The data surface

| Source (table) | Grain | Key dimensions | Join keys | Freshness | Cost |
|---|---|---|---|---|---|
| search_analytics (GSC) | date × query × page (+device/country with segments) | clicks, impressions, ctr, position | page_key (url_key), query, date | sync_gsc / refresh_property — incremental, GSC lags ~2–3 days | free |
| pages + links (crawl) | one row per url_key, LATEST crawl | status, title, H1, meta (meta_description_length NULL = tag absent, 0 = empty), canonical_key, robots, json_ld, hreflang, redirects, body_chunks, word_count, ipr, click_depth, inlink_count, conditional_304, images_without_alt / images_empty_alt / images_empty_alt_content; links.href_form (absolute / protocol-relative / root-relative / relative, as written) | url_key | start_crawl / refresh_property (on demand) | free |
| page_snapshots (drift) | url_key × crawl | field-level SEO snapshot per crawl | url_key, captured_at | every crawl, automatically | free |
| url_inspection | one row per inspected URL (top pages by clicks, quota-limited) | coverage_state, page_fetch_state, google_canonical, user_canonical, last_crawl_time, crawled_as, rich_results | url_key | inspect_urls | free (GSC quota) |
| sitemap_urls | one row per sitemap URL | lastmod | url_key | captured at crawl time | free |
| page_entity + entity_edge | one row per page / edge per relation | QID, label, subclass-of / part-of | url_key, qid | resolve_entities (free Wikidata) | free |
| findings (audit_runs) | finding per check × URL | priority, evidence JSON | url_key, check_id | run_audit | free |
| redirect_sources | one row per crawled URL that redirected | status, final_url, hops, chain (every hop) | url_key → final_key | every crawl | free |
| external_link_status | one row per distinct outbound link target | verdict (ok / redirected / broken / unverifiable), status, final_url, error, fetched_as | url_key = links.target_key | after every crawl, cached 7 days | free |
| page_resources / resource_assets | one row per subresource a page loads / per distinct css-js-font asset | type, first/third party, head/body, async/defer/preload; status, size, cache-control | page_key; resource_url | every crawl (assets with headResources:true) | free |
| image_assets | one row per sampled image | bytes, status, content_type, used_on | url | every crawl (top 500 by use) | free |
| probes | one row per probe_urls fetch (persist:true), plus the crawl's site probes (source='site-probe': soft-404 + host variants) | status, redirect chain, canonical, verdict | url | on demand; site probes every crawl (latest only) | free |

Raw access: query_data reads any of these tables (aggregate by default; filters eq/ne/gt/gte/lt/lte/like/in, and "match" for full-text search over GSC queries, page titles/H1s/body text and anchor text); query_audit runs any single check with full evidence; every table lives in one SQLite file per property (path via data_location) if you need direct SQL.

## Worked recipes

2. **Striking distance without body coverage.** query_audit check:striking-distance (GSC rank 11–20) → for each page, check pages.body_chunks for the query's terms. The automated versions: body-missing-top-query, rag-answer-gap, and score_passages for the dense-answer test. Pages ranking 11–20 that never answer the query in one passage are the highest-yield rewrites.
3. **Not indexed + no equity.** url_inspection.coverage_state ~ 'not indexed' joined to pages.ipr + inlink_count. Low-iPR unindexed pages need internal links, not resubmission; high-iPR unindexed pages are the real anomalies. (Checks: coverage-not-indexed, underlinked-high-demand.)
4. **Cannibalisation with semantic overlap.** run_audit → keyword-cannibalisation evidence lists the competing URLs per query → compare those pages' body_chunks: heavy chunk overlap = consolidate (301 the loser); light overlap = differentiate the titles/H1s and interlink with distinct anchors.
5. **Stable rank, falling CTR → SERP feature shift.** In search_analytics find queries where weekly position is flat but ctr declines → check the live results page for that query by hand: a new AI Overview, video carousel or ads block usually explains it.
6. **Schema vs rich-result reality.** pages.json_ld (declared @types) joined to url_inspection.rich_results (what Google actually detected + issues). The rich-result-issues check automates the per-URL diff; the composition question is per-TEMPLATE (list_templates): which template's schema never earns its rich result?
7. **Migration signal transfer.** pages.redirects (recorded chains) → url_inspection.google_canonical of the target (has Google accepted the move?) → search_analytics clicks by page_key before/after the migration date. Equity that didn't follow the 301 shows up as a target with no canonical adoption and no click recovery.

## Novel combinations (nothing else surfaces these)

- **Crawl budget vs equity:** url_inspection.last_crawl_time × pages.ipr — your highest-iPR pages should be recrawled often; a high-iPR page Google rarely revisits is a freshness/priority problem (and vice versa: junk crawled daily = wasted budget).
- **Crawl-to-first-impression latency:** url_inspection.last_crawl_time vs the first date a page appears in search_analytics — how fast does Google turn a crawl into impressions, per template? Slow templates have an indexing-pipeline problem.
- **Crawled-as vs response times:** url_inspection.crawled_as (mobile/desktop agent) × pages.response_time_ms — slow responses specifically on the agent Google uses against you.

## Agency engagement recipes (the deliverable arc)

- **Week-one baseline:** refresh_property → run_audit → serve_dashboard. Share the dashboard URL; the ranked findings ARE the technical workstream.
- **Fix-and-prove cycle:** fix_finding on the top finding → ship → start_crawl → detect_changes shows the fix landed → re-run run_audit and watch the finding drop off. That screenshot is the client update.

Plan the join first (url_key / query / domain), state the grain of each side, then run the fewest paid calls that answer it.

## Keyword Planner recipes
- **Demand map for a client:** keyword_ideas {keywords: their services + city, url or site: their domain, siteUrl} → keyword_demand → gap rows are pages to create, striking rows are pages to push, each with the page Google shows or a suggested on-site page.
- **Size a list:** keyword_volume {keywords:[...], siteUrl} (thousands per call) → keyword_demand status:["gap"] for the content plan.
`;

// The check catalogue rendered as markdown — single source of truth is listChecks();
// shared by the seo-audit://checks-reference resource (and buildable for any category subset).
function buildChecksMarkdown(checks: ReturnType<typeof listChecks>): string {
  const byCategory = new Map<string, typeof checks>();
  for (const c of checks) {
    const cat = String(c.category);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(c);
  }
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const sections = [...byCategory.entries()].map(([cat, list]) =>
    `## ${cat} (${list.length})\n\n| Check | Severity | Labels | Certainty | Fix type | What it catches | Fix |\n|---|---|---|---|---|---|---|\n` +
    list.map(c => `| \`${c.id}\` | ${c.severity} | ${c.labels.join(',')} | ${c.certainty} | ${c.fixType} | ${esc(c.title)} | ${esc(c.fix)} |`).join('\n'),
  );
  return `# Check registry — ${checks.length} checks\n\nLabels: D = deterministic (cites bytes), G = evidence from Google's own data (Search Console / URL Inspection), N = judgement (heuristic, gated behind includeJudgement). Certainty < 1 discounts a finding's priority.\n\n${sections.join('\n\n')}\n`;
}

const HELP_TEXT = `# SEO Audit Console — what it can do
A technical-SEO audit that fuses **Search Console + a site crawl + Google Keyword Planner**, joined on a normalised URL, with evidence on every finding. Typical flow: **refresh → audit → fix → report**.

## 1. Sync the data
- **refresh_property** — sync everything (GSC → crawl → URL inspection → rank history). _"Refresh sc-domain:example.com"_ · add \`segments:true\` for device/country, \`maxPages\`, \`startDate\`.
- **sync_gsc / start_crawl / inspect_urls** — run just one part. _"Crawl example.com, 500 pages"_
- **sync_crux** — field Core Web Vitals (LCP / INP / CLS at p75) from the Chrome UX Report for the origin and your top pages, with ~25 weeks of history. Free; needs \`CRUX_API_KEY\`. _"Pull CrUX data for example.com"_
- **check_sync_status / check_crawl_status** — poll a job. _"Check sync status"_
- **list_properties** — _"List my Search Console properties"_

## 2. Audit
- **run_audit** — score all checks; returns a prioritised markdown report. _"Run an SEO audit on sc-domain:example.com"_ · \`scope:full\`, \`categories\`, \`includeJudgement:true\`.
- **query_audit** — one named check with evidence (\`columns\`/\`offset\` for big sets). _"Show striking-distance for example.com"_
- **query_data** — read-only queries over the raw tables; aggregates in the database (counts/percentages/sums), answers not rows. _"How do status codes break down on example.com?"_
- **probe_urls** — fetch any URLs on the site live (status, redirect chain, canonical, cache headers); \`variantsOf\` tests case/slash/param/host variants. _"Does example.com serve the same page at /Page/ and /page/?"_
- **triage_404s** — crawled 404s bucketed redirect / review / ignore, with the closest live URL and a 301 map. _"Triage the 404s on example.com"_
- **open_dashboard** — the property's browser dashboard link (finished syncs/crawls offer it automatically). _"Open the dashboard for example.com"_
- **list_checks** — _"What does the audit check for?"_
- **find_duplicates** — semantic near-duplicate pages from a local embedding model (no API cost); feeds \`near-duplicate-content\`. _"Find near-duplicate pages on example.com"_
- **render_pages** — Response vs Render: a sampled set of pages in headless Chromium, showing content and links that only exist after JavaScript (needs the optional Playwright). _"Render the top pages on example.com"_

## 3. Fix (the moat)
- **fix_finding** — paste-ready remediation from your own data: JSON-LD for missing/invalid schema, a 301 rule for broken links, iPR-ranked internal-link suggestions. _"Generate the fix for finding 12"_ or _"fix_finding check:missing-required-fields url:https://example.com/x"_
- **detect_changes** — what changed since the last crawl (status, canonical, noindex, title, schema), severity-ranked — the regression monitor. _"Detect changes on example.com"_
- **check_agent_readiness** — is your site ready for AI agents? Scores llms.txt / agents.md / AI-bot rules / Content Signals / MCP server card / Agent Skills / API Catalog / OAuth signals (0–100 + level) with copy-paste fixes. _"Check agent readiness for example.com"_

## 4. Keywords (Google Ads Keyword Planner, free, cached 30 days)
- **keyword_volume** — monthly volume, CPC, competition and trend for a list of keywords (pass siteUrl to save them to the client). _"Volumen de: gestoría Madrid, asesoría fiscal autónomos"_
- **keyword_ideas** — keyword ideas from seed keywords, a URL or a whole domain, sorted by volume. _"Ideas de keywords para ardurilgestoria.com"_
- **keyword_demand** — the saved keywords joined to Search Console: page, position, clicks, status (top3 / page1 / striking / weak / gap) and a suggested page for gaps. Also the dashboard Keywords tab and export_report.
- **news_discovery** — recent Google News coverage for a topic (free RSS).
## 5. Templates & opportunities
- **list_templates** — cluster pages into templates (one fix → N pages) with a representative exemplar. _"List page templates for example.com"_
- **suggest_pages** — new-page ideas grounded in real GSC demand, minus what you already cover. _"Suggest new pages for example.com"_
- **content_opportunities** — the content marketer's report from stored data: write next, refresh now, rewrite snippets, strengthen. _"Content opportunities for example.com"_
- **keyword_list** — cluster a keyword list (or your top GSC queries) by the page Google ranks for it: own / weak / absent, no paid calls. _"Cluster these keywords for example.com: [...]"_
- **resolve_entities** — map pages to Wikidata entities → unlocks entity-internal-link-gap (judgement). _"Resolve entities for example.com"_

## 6. Reports & dashboard
- **get_dashboard** — interactive dashboard (renders in chat). _"Show the dashboard for example.com"_
- **serve_dashboard / open_dashboard** — the same dashboard in a local browser tab (live data, CSV downloads). _"Open the dashboard for example.com"_
- **export_report** — self-contained shareable HTML to send a client. _"Export the report for example.com"_

## 7. Utilities
- **data_location** — where DBs are stored (set with a path). · **normalize_url** — the join key for a URL. · **composition_cookbook** — the data-surface map and multi-source recipes. · **seo_audit_help** — this page.
- **data_storage** — per-property disk usage + row counts; prune (vacuum / clear-crawl-history / delete-property / repair, destructive ones and repair need \`confirm:true\`); \`check:true\` runs an integrity check. _"How much disk is my audit data using?"_

_Tip: first time on a property → \`refresh_property\` then \`run_audit\`._
_Composing your own analysis? Call \`composition_cookbook\` first — the data-surface map (grain + join keys per source) and worked multi-source recipes._`;

export function createServer(): { server: McpServer; run: () => Promise<void> } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  // Durable registry in the data dir (#9): a later process can still report a finished job, or an
  // interrupted one whose process died. Falls back to memory-only if the file can't be opened.
  // SAC_JOB_RUNNER=external (#56): jobs are only queued here and a seo-audit-runner process runs them.
  const jobs = new JobManager({ dbPath: jobsDbPath(dataDir()), runner: jobRunnerModeFromEnv() });

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const gsc = credPath ? new GscClient(credPath) : null;
  const sync = gsc ? new GscSync(gsc, dataDir()) : null;
  const inspector = gsc ? new UrlInspector(gsc, dataDir()) : null;
  const crawler = new Crawler(dataDir()); // no GSC credentials required

  // SEOCoral fork: DataForSEO and Majestic are removed (paid tiers the agency doesn't use). The
  // internal modules stay typed but are never constructed, so no code path can reach those APIs.
  const dfs: DataForSeoClient | null = null;
  const rankTracker: RankTracker | null = null;
  const backlinks: Backlinks | null = null;
  // SEOCoral fork: Google Ads Keyword Planner (free with the agency's MCC) for search volume + ideas.
  const adsCreds = googleAdsCredentials();
  const ads = adsCreds
    ? new GoogleAdsClient(adsCreds, path.join(dataDir(), 'google-ads-cache.db'), Number(process.env.GOOGLE_ADS_CACHE_DAYS) || 30)
    : null;
  const entities = new Entities(new WikidataClient(path.join(dataDir(), 'wikidata-cache.db')), dataDir());
  // CrUX (#55): field Core Web Vitals. Free Google API key (CRUX_API_KEY), read placeholder-safe.
  const cruxKey = cruxApiKey();
  const cruxSync = cruxKey ? new CruxSync(cruxKey, dataDir()) : null;
  const refresh = new Refresh(sync, crawler, inspector, rankTracker, cruxSync);
  // Every job works on one property; record which (its DB file name, stable across the different
  // mounts a gateway container and a Desktop process see of the same data dir) so per-property
  // questions - "is a crawl live for THIS site?", "is this DB's FTS build already running?" - can
  // be answered from the registry, from the job's very first write.
  const jobScope = (siteUrl: string): string => jobScopeFor(dataDir(), siteUrl);
  // Jobs are named kinds run from their arguments (src/core/jobKinds.ts), so the same job can run
  // here or, queued, in the job runner (#56). withDashboard is resolved at call time (defined below).
  const jobDeps: JobDeps = { dataDir, sync, inspector, crawler, refresh, rankTracker, backlinks, entities, dfs, cruxSync, withDashboard: (siteUrl, fn) => withDashboard(siteUrl, fn) };
  const startFor = <K extends JobKindName>(siteUrl: string, kind: K, args: JobArgsByKind[K]): string =>
    submitJob(jobs, kind, args, jobDeps, jobScope(siteUrl));
  const requireGsc = <T>(v: T | null): T => {
    if (!v) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set — required for Search Console access.');
    return v;
  };
  // Which optional integrations have a key set — drives the dashboard's key-gated tabs
  // (Links, Content research) and their affiliate-linked upsell states. The data layer has
  // no env access, so it's injected here onto every dashboard payload surface.
  const apiKeysStatus = (): { dataforseo: boolean; majestic: boolean } =>
    ({ dataforseo: false, majestic: false });

  // The dashboard webserver's options — one definition shared by serve_dashboard AND the
  // auto-start at the end of refresh_property / run_audit, so a populated property always has
  // a live browser link (browserLink() surfaces dashboardServerUrl() once this is running).
  const buildWebOpts = (port?: number): WebServerOptions => ({
    dataDir,
    uiHtml: () => readFileSync(path.join(__dirname, 'src', 'ui', 'dashboard.html'), 'utf8'),
    call: buildWebCallHandlers({ dataDir, dfs, ads, apiKeys: apiKeysStatus }),
    ...(port != null ? { port } : {}),
  });
  // Idempotent auto-start used by refresh_property / run_audit. Best-effort: a served port that
  // can't bind (e.g. Docker without a published port) must never fail the populate/audit — the
  // in-chat get_dashboard and export_report still work, and browserLink() falls back to those.
  // Opt-out with SAC_AUTOSERVE=0 for headless/CI/sandboxed runs where binding a localhost port
  // is unwanted (default: on, since the whole point is to hand the user a link).
  const autoServeDashboard = async (): Promise<void> => {
    if (/^(0|false|no|off)$/i.test(process.env.SAC_AUTOSERVE ?? '')) return;
    try { await startDashboardServer(buildWebOpts()); } catch { /* dashboard is a convenience, not a dependency */ }
  };

  // ── Introspection (no data / creds required) ────────────────────────────
  server.registerTool(
    'seo_audit_help',
    {
      title: 'Help — what this audit can do',
      description: 'Overview of every tool/feature with an example prompt for each. Start here.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: HELP_TEXT }] }), // text-only: a structuredContent stub eclipses the text in hosts that prefer structured output
  );

  server.registerTool(
    'composition_cookbook',
    {
      title: 'Composition cookbook (data-surface map + recipes)',
      description: 'The full data-surface map (every source: grain, dimensions, join keys, freshness, cost) plus worked multi-source recipes and novel combinations, in this server\'s actual tool and table names. Static — no API calls, no cost. Call this BEFORE planning any complex question that spans more than one data source.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: COOKBOOK_TEXT }] }), // text-only (see seo_audit_help note)
  );

  server.registerTool(
    'list_checks',
    {
      title: 'List audit checks',
      description: 'List the technical-SEO check categories this server can evaluate.',
      inputSchema: { category: z.enum(CHECK_CATEGORIES).optional() },
    },
    async ({ category }) => {
      const all = listChecks();
      const checks = category ? all.filter(c => (c.category as string) === category) : all;
      return { content: [{ type: 'text', text: `${checks.length} checks${category ? ` in ${category}` : ''}` }], structuredContent: { checks } };
    },
  );

  server.registerTool(
    'list_templates',
    {
      title: 'Detect page templates',
      description: 'Cluster the crawled pages into templates (by URL morphology + JSON-LD @type) and return each template with its page count and a representative exemplar URL. A single template-level fix corrects every page in the cluster — this is the map for per-template analysis. Needs a crawl (run refresh_property / start_crawl first).',
      inputSchema: { siteUrl: z.string(), minMembers: z.number().int().min(2).max(100).optional() },
    },
    async ({ siteUrl, minMembers }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const clusters = detectTemplates(db.db, minMembers != null ? { minMembers } : {});
        const summary = clusters.slice(0, 20).map(c => `• ${c.morphology} [${c.schemaType}] — ${c.count} pages (e.g. ${c.exemplarUrl})`).join('\n');
        return {
          content: [{ type: 'text', text: clusters.length ? `${clusters.length} templates detected:\n${summary}` : 'No templates with ≥ the minimum members — crawl first, or lower minMembers.' }],
          structuredContent: { templates: clusters.map(({ memberKeys: _m, ...c }) => c), count: clusters.length },
        };
      } finally { db.close(); }
    },
  );

  server.registerTool(
    'data_location',
    {
      title: 'Get or set where audit data is stored',
      description: 'No args: report the folder where per-property crawl/audit databases are saved. With `path`: set it (persisted to ~/.seo-audit-console.json) — restart Claude Desktop to apply. Default is your Documents folder; the SAC_DATA_DIR env var overrides everything.',
      inputSchema: { path: z.string().optional() },
    },
    async ({ path: newPath }) => {
      if (newPath) {
        // Persist an ABSOLUTE path — a relative one resolves against the host process's
        // cwd, which differs across Claude Desktop launches, so DBs would "disappear".
        newPath = path.resolve(newPath);
        mkdirSync(newPath, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ dataDir: newPath }, null, 2));
        return {
          content: [{ type: 'text', text: `Data location set to ${newPath}. Restart Claude Desktop to apply (this session still uses ${dataDir()}). Move existing .db files there to keep your synced data.` }],
          structuredContent: { requested: newPath, active: dataDir(), restartRequired: true, configFile: CONFIG_PATH },
        };
      }
      return {
        content: [{ type: 'text', text: `Audit data is stored in: ${dataDir()}` }],
        structuredContent: { active: dataDir(), default: DEFAULT_DATA_DIR, env: process.env.SAC_DATA_DIR ?? null, configFile: CONFIG_PATH },
      };
    },
  );

  server.registerTool(
    'data_storage',
    {
      title: 'Data storage summary + pruning',
      description: 'Data hygiene. No args: list every per-property database in the data dir — size (incl. WAL), key row counts (search_analytics, pages, links, page_snapshots, findings), last sync and last crawl, and any link_intersect prospect set with its capture date (flagged when it is going stale) — plus the DataForSEO/Majestic caches and reports folder sizes. Optional siteUrl narrows to one property. Pruning via `prune:{siteUrl, action}`: "vacuum" (compact the DB, reports bytes reclaimed), "clear-crawl-history" (delete page_snapshots + audit runs/findings older than the 5 most recent, then vacuum), "delete-property" (remove the DB files entirely). Destructive actions (clear-crawl-history, delete-property) REQUIRE confirm:true and refuse loudly without it, naming what would be deleted. Refuses to prune while any job is running. Integrity: `check:true` (with siteUrl) starts an async job running SQLite\'s full integrity_check (minutes on a multi-GB DB; check:"quick" is faster but misses missing-index-row damage) and reports damaged indexes. `prune:{siteUrl, action:"repair"}` with confirm:true backs up the DB file, REINDEXes the damaged indexes and re-checks (async job) — the fix for a sync failing with "database disk image is malformed".',
      inputSchema: {
        siteUrl: z.string().optional(),
        prune: z.object({
          siteUrl: z.string(),
          action: z.enum(['vacuum', 'clear-crawl-history', 'delete-property', 'repair']),
        }).optional(),
        confirm: z.boolean().optional(),
        check: z.union([z.boolean(), z.enum(['quick', 'full'])]).optional().describe('Run an integrity check on siteUrl\'s DB (async job). true = full integrity_check.'),
      },
    },
    async ({ siteUrl, prune, confirm, check }) => {
      if (check) {
        if (!siteUrl) throw new Error('check needs a siteUrl.');
        const mode = check === 'quick' ? 'quick' : 'full';
        propertyDbFile(dataDir(), siteUrl); // fail fast on an unknown property
        const jobId = startFor(siteUrl, 'integrity', { siteUrl, mode });
        return jobStarted({ jobId, status: 'running', siteUrl, mode },
          `Integrity check (${mode === 'full' ? 'full integrity_check — can take minutes on a large DB' : 'quick_check — misses missing-index-row damage'}) started for ${siteUrl}. Poll check_sync_status; the result lists damaged indexes. If any are reported, run data_storage prune:{siteUrl, action:"repair"} confirm:true.`);
      }
      if (prune?.action === 'repair') {
        const running = jobs.possiblyRunning(); // conservative: a busy owner can look stale for a while
        if (running.length) {
          return { content: [{ type: 'text', text: `Refusing to repair while ${running.length} job(s) are running (${running.map(j => `${j.type}#${j.id}`).join(', ')}). Wait for them to finish and retry.` }], structuredContent: { ok: false, refused: 'jobs_running' } };
        }
        const dbFile = propertyDbFile(dataDir(), prune.siteUrl);
        if (!confirm) {
          const bytes = storageSummary(dataDir(), prune.siteUrl).properties[0]?.bytes ?? 0;
          return { content: [{ type: 'text', text: `REFUSED: repair needs confirm:true. It will run a full integrity_check, copy ${dbFile} to a timestamped .bak file alongside it (${fmtBytes(bytes)} of extra disk), REINDEX only the damaged indexes, then re-check. Table data is never modified; damage that isn't in an index is reported, not "fixed".` }], structuredContent: { ok: false, refused: 'confirm_required', dbFile, bytes } };
        }
        const jobId = startFor(prune.siteUrl, 'repair', { siteUrl: prune.siteUrl });
        return jobStarted({ jobId, status: 'running', siteUrl: prune.siteUrl }, `Repair started for ${prune.siteUrl}: integrity check, backup, REINDEX of damaged indexes, re-check. Poll check_sync_status.`);
      }
      if (prune) {
        const running = jobs.possiblyRunning().map(j => ({ id: j.id, type: j.type })); // conservative: a busy owner can look stale for a while
        const r = pruneProperty(dataDir(), prune.siteUrl, prune.action as 'vacuum' | 'clear-crawl-history' | 'delete-property', confirm === true, running);
        if (!r.ok) {
          return { content: [{ type: 'text', text: r.refused ?? `Could not ${prune.action}.` }], structuredContent: r as unknown as Record<string, unknown> };
        }
        const d = r.detail;
        const line = prune.action === 'delete-property'
          ? `Deleted ${prune.siteUrl}'s database (${fmtBytes(Number(d.bytesFreed) || 0)} freed).`
          : prune.action === 'vacuum'
            ? `Vacuumed ${prune.siteUrl}: ${fmtBytes(Number(d.bytesBefore) || 0)} → ${fmtBytes(Number(d.bytesAfter) || 0)} (${fmtBytes(Number(d.bytesReclaimed) || 0)} reclaimed).`
            : `Cleared crawl/audit history for ${prune.siteUrl} beyond the 5 most recent runs: ${fmtBytes(Number(d.bytesBefore) || 0)} → ${fmtBytes(Number(d.bytesAfter) || 0)} (${fmtBytes(Number(d.bytesReclaimed) || 0)} reclaimed).`;
        return { content: [{ type: 'text', text: line }], structuredContent: r as unknown as Record<string, unknown> };
      }
      const s = storageSummary(dataDir(), siteUrl);
      if (!s.properties.length && !s.caches.length) {
        return { content: [{ type: 'text', text: `No databases in ${s.dataDir}${siteUrl ? ` matching ${siteUrl}` : ''} — run refresh_property first.` }], structuredContent: s as unknown as Record<string, unknown> };
      }
      const rows = s.properties.map(p =>
        `| ${p.siteUrl ?? p.file} | ${fmtBytes(p.bytes)} | ${p.searchAnalytics.toLocaleString('en-US')}${p.searchAnalyticsSegments ? ` (+${p.searchAnalyticsSegments.toLocaleString('en-US')} segment)` : ''} | ${p.pages.toLocaleString('en-US')} | ${p.links.toLocaleString('en-US')} | ${p.pageSnapshots.toLocaleString('en-US')} | ${p.findings.toLocaleString('en-US')} | ${p.lastSynced?.slice(0, 10) ?? '—'} | ${p.lastCrawl?.slice(0, 10) ?? '—'} | ${p.gscStorage.state} |`,
      ).join('\n');
      // GSC storage (#65): spell out anything that isn't simply migrated, with the reason.
      const gscLines = s.properties.filter(p => p.gscStorage.state !== 'migrated').map(p => `- ${p.siteUrl ?? p.file}: ${p.gscStorage.note}`).join('\n');
      // Backups beside the databases: the migration's (and repairs') copies are full-size files.
      const bkLines = s.backups.map(b => `- ${b.file}: ${fmtBytes(b.bytes)}, ${b.modified ? b.modified.slice(0, 16).replace('T', ' ') : 'date unknown'}${b.kind === 'gsc-migration' ? ' (the GSC storage migration\'s backup)' : ''}`).join('\n');
      const bkBlock = bkLines
        ? `Backups (${fmtBytes(s.backupBytes)}, included in the total):\n${bkLines}\nEach can be deleted once you've confirmed the migration or repair it was taken for went through (the dashboard and an audit look right); nothing reads them.\n\n`
        : '';
      const strayBlock = s.straySidecarsRemoved.length
        ? `Removed ${s.straySidecarsRemoved.length} stray empty sidecar file(s) an earlier version left beside its backups: ${s.straySidecarsRemoved.join(', ')}.\n\n`
        : '';
      const cacheLines = s.caches.map(c => `- ${c.file}: ${fmtBytes(c.bytes)}`).join('\n');
      // Link-intersect freshness: prospect data ages as competitors keep earning links, so
      // flag properties that HAVE link_prospects and roughly how stale it is — a re-run of
      // link_intersect updates it. (The DataForSEO call is 20-day cached; older than that a
      // re-run genuinely refetches.)
      const nowMs = Date.now();
      const liProps = s.properties.filter(p => (p.linkProspects ?? 0) > 0);
      const liLines = liProps.map(p => {
        const fetched = p.linkProspectsFetched;
        const ageDays = fetched ? Math.floor((nowMs - Date.parse(fetched)) / 86400000) : null;
        const stale = ageDays != null && ageDays > 20;
        return `- ${p.siteUrl ?? p.file}: ${p.linkProspects} prospects, captured ${fetched?.slice(0, 10) ?? '—'}${ageDays != null ? ` (${ageDays}d ago${stale ? ' — likely stale, re-run link_intersect to update' : ''})` : ''}`;
      }).join('\n');
      // A crawl that never completed doesn't count as the last crawl (#20); list it so it's visible.
      const runLines = s.properties.filter(p => p.latestCrawlRun).map(p =>
        `- ${p.siteUrl ?? p.file}: latest crawl run ${p.latestCrawlRun!.status} (started ${p.latestCrawlRun!.startedAt.slice(0, 16).replace('T', ' ')})${p.latestCrawlRun!.error ? `: ${p.latestCrawlRun!.error}` : ''}${p.latestCrawlRun!.status === 'running' ? ' (if no job is running, it died with its server process)' : ''}`).join('\n');
      const md = `**Data dir:** ${s.dataDir} — total ${fmtBytes(s.totalBytes)}\n\n` +
        `| Property | Size | GSC rows | Pages | Links | Snapshots | Findings | Last sync | Last completed crawl | GSC storage |\n|---|---|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
        `${gscLines ? `GSC storage not yet migrated:\n${gscLines}\n\n` : ''}` + bkBlock + strayBlock +
        `${runLines ? `Crawl runs that did not complete:\n${runLines}\n\n` : ''}` +
        `${liLines ? `Link-intersect prospects (may be stale — competitors keep earning links):\n${liLines}\n\n` : ''}` +
        `${cacheLines ? `Caches:\n${cacheLines}\n` : ''}Reports folder: ${fmtBytes(s.reportsBytes)}` +
        `${s.other.length ? `\nOther .db files: ${s.other.map(o => `${o.file} (${fmtBytes(o.bytes)})`).join(', ')}` : ''}\n\n` +
        `Prune with data_storage prune:{siteUrl, action:"vacuum" | "clear-crawl-history" | "delete-property" | "repair"} (destructive actions and repair need confirm:true). Check integrity with data_storage {siteUrl, check:true}.`;
      return { content: [{ type: 'text', text: md }], structuredContent: s as unknown as Record<string, unknown> };
    },
  );

  // ── Audit engine ────────────────────────────────────────────────────────
  server.registerTool(
    'run_audit',
    {
      title: 'Run SEO audit',
      description: 'Run the technical-SEO checks against synced data and return scored findings, ranked by expected clicks per dev-hour — Priority = (T × Y × C) / E (T = clicks at stake from real GSC data, Y = expected yield, C = certainty, E = effort hours). Crawl + GSC + URL-inspection checks. Set includeJudgement=true to include heuristic (N) checks. Returns the counts (byCheck, bySeverity, byCategory, notCollected) and the top findings (topLimit, default 10, max 50) with trimmed evidence; each check\'s title and fix appear once in `checks`. query_audit is the drill-down: every finding of one check, full evidence.',
      inputSchema: {
        siteUrl: z.string(),
        scope: z.enum(['core', 'full']).optional(),
        categories: z.array(z.enum(CHECK_CATEGORIES)).optional(),
        includeJudgement: z.boolean().optional(),
        topLimit: z.number().int().min(1).max(50).optional().describe('Top findings to return (default 10, max 50)'),
      },
    },
    async ({ siteUrl, scope, categories, includeJudgement, topLimit }) => {
      const result = runAudit(dataDir(), siteUrl, { scope, categories, includeJudgement, topLimit });
      await autoServeDashboard(); // spin up the browser dashboard so browserLink() hands over a live URL
      return {
        content: [{ type: 'text', text: buildAuditMarkdown(result, siteUrl) + browserLink(siteUrl) }],
        structuredContent: { ...result, ...dashboardFields(siteUrl) } as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'query_audit',
    {
      title: 'Run one audit check',
      description: 'Run a single named check (see list_checks) and return its affected URLs + evidence. Token discipline: `columns` narrows evidence to the named keys, string evidence values are truncated at 120 chars (trailing …), `offset` + `limit` page through large result sets (the footer states showing X–Y of TOTAL). Grain: finding per URL with evidence JSON. Joins: url_key across all sources.',
      inputSchema: {
        siteUrl: z.string(),
        check: z.string(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
        columns: z.array(z.string()).max(20).optional().describe('Evidence keys to keep (default: all)'),
      },
    },
    async ({ siteUrl, check, limit, offset, columns }) => {
      const r = runSingleCheck(dataDir(), siteUrl, check, limit, offset ?? 0);
      // Token discipline (mirrors query_data): optional evidence-column selection + loud
      // 120-char cell truncation, and an explicit offset/total footer.
      const shape = (f: any): any => {
        const src = (f.evidence ?? {}) as Record<string, unknown>;
        const keys = columns?.length ? columns.filter(k => k in src) : Object.keys(src);
        const evidence: Record<string, unknown> = {};
        for (const k of keys) evidence[k] = truncateCell(src[k]);
        return { ...f, evidence };
      };
      let sc: Record<string, unknown> = { ...r, findingsTotal: r.total };
      let findings = r.findings.map(shape);
      // Hosts cap the model-facing result (~60k chars). On evidence-heavy checks a large
      // `limit` can blow that ceiling and error the whole call — trim findings (keeping the
      // true total) instead of failing. Same guard pattern as detect_changes.
      while (findings.length > 25 && JSON.stringify({ ...sc, findings }).length > 45000) {
        findings = findings.slice(0, Math.floor(findings.length / 2));
      }
      const start = (offset ?? 0) + (findings.length ? 1 : 0);
      const end = (offset ?? 0) + findings.length;
      const nextOffset = end < r.total ? end : null;
      sc = { ...sc, findings, findingsReturned: findings.length, offset: offset ?? 0, nextOffset };
      return {
        content: [{ type: 'text', text: `${check}: showing ${start}–${end} of ${r.total} findings${nextOffset != null ? `; next offset ${nextOffset}` : ''}${findings.length < r.findings.length ? ` (trimmed to fit the token cap — use a smaller limit)` : ''}` }],
        structuredContent: sc,
      };
    },
  );

  server.registerTool(
    'query_data',
    {
      title: 'Query the raw data (aggregate first)',
      description: 'Direct read-only access to the property database — the composition layer\'s escape hatch. AGGREGATE IN THE DATABASE and return answers, not rows: default mode groups by the columns you name and returns counts, percentages and sum/avg/min/max metrics (classic crawler-style distributions in one call — "status codes by folder", "clicks by page_key"). mode:rows returns raw rows with strict token discipline (curated default columns, 120-char cells, loud paging footer). Filters are exact/range/like/in/match and always parameterised; op:"match" is full-text search via FTS5 (words, "phrases", prefix*, AND/OR/NOT, NEAR(a b, 5)) on search_analytics.query, pages.title / h1 / body_chunks and links.anchor_text — use it instead of like for text on big tables; column names are validated against the live table schema. Grain: per table — search_analytics = date × query × page; pages/links = latest crawl per url_key; url_inspection / sitemap_urls / page_backlinks = one row per URL; findings = check × URL per audit run. Joins: url_key across pages/links/search_analytics.page_key/url_inspection/sitemap_urls/page_backlinks; query → keyword tools; run_id → audit runs.',
      inputSchema: {
        siteUrl: z.string(),
        table: z.enum(QUERYABLE_TABLES),
        mode: z.enum(['aggregate', 'rows']).optional().describe('Default aggregate — return grouped answers, not rows'),
        groupBy: z.array(z.string()).max(4).optional().describe('Columns to group by (aggregate mode)'),
        metrics: z.array(z.object({ fn: z.enum(METRIC_FNS), column: z.string() })).max(6).optional().describe('count is always included; add sum/avg/min/max over numeric columns'),
        filters: z.array(z.object({
          column: z.string(),
          op: z.enum(FILTER_OPS),
          value: z.union([z.string(), z.number(), z.null(), z.array(z.union([z.string(), z.number()])).max(100)]),
        })).max(8).optional(),
        orderBy: z.string().optional().describe('Aggregate: a groupBy column, "count", or a metric alias like sum_clicks. Rows: any column'),
        orderDir: z.enum(['asc', 'desc']).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 25 (aggregate) / 50 (rows)'),
        offset: z.number().int().min(0).optional().describe('Rows mode paging'),
        columns: z.array(z.string()).max(20).optional().describe('Rows mode: columns to return (default: a curated per-table set)'),
      },
    },
    async ({ siteUrl, table, mode, groupBy, metrics, filters, orderBy, orderDir, limit, offset, columns }) => {
      // A match filter on a large DB whose FTS index isn't built yet: build it in a worker job rather
      // than stalling this call (and the whole stdio loop) on a multi-million-row backfill.
      const wanted = (filters ?? []).filter(f => f.op === 'match').map(f => ftsIndexFor(table, f.column)).filter((x): x is FtsIndex => !!x);
      if (wanted.length) {
        const dbFile = dbPathFor(dataDir(), siteUrl);
        let pending: { index: FtsIndex; rows: number }[] = [];
        try { const ro = new Database(dbFile, { readonly: true, fileMustExist: true }); try { pending = pendingBackfills(ro, wanted); } finally { ro.close(); } } catch { /* no DB: runQueryData reports it */ }
        const big = pending.filter(p => p.rows > INLINE_BACKFILL_MAX_ROWS);
        if (big.length) {
          // One build per database: a running fts-index job for ANOTHER property must not be handed back.
          const running = jobs.list().find(j => j.type === 'fts-index' && (j.state === 'running' || j.state === 'queued') && j.scope === jobScope(siteUrl)); // scope is in the registry from the job's first write; progress.dbFile wasn't until the first heartbeat
          const jobId = running?.id ?? startFor(siteUrl, 'fts-index', { siteUrl, dbName: path.basename(dbFile), indexes: pending.map(p => p.index) });
          return jobStarted({ jobId, status: 'running', siteUrl, building: pending.map(p => p.index) },
            `Building the full-text index for ${pending.map(p => p.index).join(', ')} (one-time, ~${big.reduce((a, p) => a + p.rows, 0).toLocaleString('en-US')} rows, in the background). Poll check_sync_status, then re-run this query. Meanwhile op "like" works, just slower.`);
        }
      }
      const r = runQueryData(dbPathFor(dataDir(), siteUrl), {
        table, mode, groupBy, metrics, filters, orderBy, orderDir, limit, offset, columns,
      } as Parameters<typeof runQueryData>[1]);
      return { content: [{ type: 'text', text: r.markdown }], structuredContent: r.structured };
    },
  );

  server.registerTool(
    'score_passages',
    {
      title: 'Score passage relevance (AI-search readiness)',
      description: 'Run a local cross-encoder reranker (ms-marco-MiniLM-L-6-v2, downloaded once to a cache, no Python) over each ranking page\'s heading chunks against its top Search Console query, and persist the single best-passage relevance score. It SCORES relevance (a classifier — it cannot hallucinate). Powers the `weak-passage-answer` check — the "RAG snippetability" test: does any passage confidently answer the query, the way AI/passage search re-ranks? Returns the score for EVERY page it scored (not just the failures) with the flag threshold, the band convention and the run\'s own distribution, so a passing page\'s score is readable without a second query_data hop. On-demand + ML-heavy (~0.6s/page), bounded to pages that already rank. `limit` caps pages (highest-impression first); `minImpressions` sets the floor (default 50). First run downloads ~25MB. Re-run after a re-crawl.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(2000).optional(), minImpressions: z.number().int().min(0).optional(), urls: z.array(z.string()).optional().describe('Only report these pages (they are still scored site-wide; this filters the returned list)') },
    },
    async ({ siteUrl, limit, minImpressions, urls }) => {
      const r = await scoreSitePassages(dataDir(), siteUrl, { limit, minImpressions });
      const keys = urls?.length ? new Set(urls.map(u => urlKey(u, { hostForm: hostFormForProperty(siteUrl) ?? 'asis' }))) : null;
      const shown = keys ? r.pages.filter(p => keys.has(p.url)) : r.pages;
      const rows = shown.slice(0, 25).map(p => `  ${String(p.score).padStart(7)}  ${p.band.padEnd(8)} ${p.url.replace(/^https?:\/\/[^/]+/, '')} · "${p.query}" (${p.impressions} impr)`).join('\n');
      const d = r.distribution;
      const text = `Scored ${r.scored} ranking pages; ${r.flagged} below the weak threshold of ${r.threshold} — run_audit surfaces those as weak-passage-answer.\n\n` +
        `Scale: ${r.scale}\n` +
        (d ? `This run: min ${d.min} · p25 ${d.p25} · median ${d.median} · p75 ${d.p75} · max ${d.max}\n` : '') +
        (rows ? `\nScores (${shown.length === r.pagesTotal ? `all ${r.pagesTotal}` : `${shown.length} of ${r.pagesTotal}`}, showing up to 25):\n${rows}` : '');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...r, ...(keys ? { pages: shown, pagesReturned: shown.length } : {}) } as unknown as Record<string, unknown>,
      };
    },
  );

  // sync_gsc's start reply: the range the job will actually fetch (#33), or that there's nothing to.
  const syncReply = (siteUrl: string, jobId: string, planned: { startDate: string; endDate: string; incremental: boolean; noop?: boolean; segmentsKept?: boolean }, requestedStart: string, full: boolean): string => {
    if (planned.noop) return `Sync started for ${siteUrl} (job ${jobId}): nothing to fetch, the stored data already covers ${requestedStart} → ${planned.endDate}. Poll check_sync_status.`;
    const how = planned.incremental ? ` (incremental: the last stored days are re-pulled and replaced; requested window started ${requestedStart})` : full ? ' (full re-pull)' : '';
    const segs = planned.segmentsKept ? ', with device and country segments (this property\'s breakdowns are kept current)' : '';
    return `Sync started for ${siteUrl} (job ${jobId}): fetching ${planned.startDate} → ${planned.endDate}${how}${segs}. Poll check_sync_status.`;
  };
  // ── Async-job helpers ─────────────────────────────────────────────────────
  // A job-starting tool returns the same JSON in the text reply as in structuredContent, so a
  // client that reads only text content can still take the jobId without regexing prose (#27).
  // #56: with SAC_JOB_RUNNER=external the job is only queued here - say so, and whether a runner is there to take it.
  const jobStarted = (sc: Record<string, unknown>, hint: string) => {
    if (typeof sc.jobId === 'string' && jobs.get(sc.jobId)?.state === 'queued') { sc = { ...sc, status: 'queued' }; hint = `${hint} ${jobs.queuedHint()}`; }
    return { content: [{ type: 'text' as const, text: `${JSON.stringify(sc)}\n${hint}` }], structuredContent: sc };
  };
  // One status handler, registered as both check_sync_status and check_crawl_status (#19). The
  // text carries the failure reason and latest progress, not just the state (#33): many clients
  // and models read only the text content.
  // #38: a job that wrote property data starts the dashboard server when it finishes and carries
  // the link in its result, so the completion reply can offer it (refresh_property already did).
  const DATA_JOBS = new Set(['sync', 'crawl', 'inspect', 'refresh', 'crux']);
  const withDashboard = (siteUrl: string, fn: (update: (p: Record<string, unknown>) => void, signal: AbortSignal) => Promise<unknown>) =>
    async (update: (p: Record<string, unknown>) => void, signal: AbortSignal): Promise<unknown> => {
      const r = await fn(update, signal);
      if (signal.aborted) return r;
      await autoServeDashboard();
      return dashboardServerUrl() && r && typeof r === 'object' ? { ...(r as Record<string, unknown>), ...dashboardFields(siteUrl) } : r;
    };
  // #52: a crawl's progress as one readable line (stage, counts, rate, ETA) instead of raw JSON.
  const crawlProgressLine = (p: Record<string, unknown>): string | null => {
    if (typeof p.stage !== 'string' || typeof p.crawled !== 'number') return null;
    const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '?');
    const secs = (v: unknown) => fmtDuration(typeof v === 'number' ? v : null);
    if (p.stage === 'fetching') {
      const rate = typeof p.pagesPerSec === 'number' ? `${p.pagesPerSec} pages/s` : 'rate pending';
      const eta = typeof p.etaSeconds === 'number' ? `ETA ${fmtDuration(p.etaSeconds)}` : 'ETA pending';
      return `fetching: ${n(p.crawled)}/${n(p.maxPages)} pages, ${n(p.pagesRemaining)} queued, ${n(p.failed)} failed (${rate}, ${eta}, ${secs(p.elapsedSeconds)} elapsed)${crawlNotes(p)}`;
    }
    if (p.stage === 'external-links' && typeof p.checked === 'number') return `external-links: ${n(p.checked)}/${n(p.total)} outbound targets checked, after ${n(p.crawled)} pages fetched${crawlNotes(p)}`;
    return `${p.stage}: post-crawl stage after ${n(p.crawled)} pages fetched${typeof p.linksSeen === 'number' ? ` and ${n(p.linksSeen)} links` : ''} (${secs(p.elapsedSeconds)} elapsed)${crawlNotes(p)}`;
  };
  const oneLineJob = (job: Job, detail = false): string => {
    const head = `Job ${job.id} (${job.type}): ${job.state}`;
    if (job.state === 'queued') return `${head}${job.noRunner ? ' (no runner)' : ''}: ${job.note ?? 'waiting for the job runner'}`; // #56
    if (job.state === 'failed') return `${head}: ${job.error ?? 'unknown error'}${corruptionHint(job.error)}`;
    if (job.state === 'interrupted') return `${head}: ${job.error ?? 'the process running it exited before it finished.'}`;
    const prog = Object.keys(job.progress).length ? ` ${crawlProgressLine(job.progress) ?? JSON.stringify(job.progress).slice(0, 300)}` : '';
    // render_pages: say plainly when nothing could be rendered (no browser on this install) or some
    // pages were skipped, rather than leave a bare "completed" over an empty result.
    if (job.type === 'render' && job.state === 'completed') {
      const r = job.result as { available?: boolean; note?: string; audited?: number; dependsOnJs?: number } | undefined;
      if (r?.available === false) return `${head}, but nothing was rendered: ${r.note ?? 'the renderer is unavailable.'}`;
      const summary = r ? ` - ${r.audited ?? 0} page(s) rendered, ${r.dependsOnJs ?? 0} depend on JavaScript.` : '';
      return head + summary + (r?.note ? ` ${r.note}` : '') + (r?.audited ? ' Run run_audit to see the render checks.' : '');
    }
    if (!detail || job.state !== 'completed' || !DATA_JOBS.has(job.type)) return head + prog;
    const link = (job.result as { dashboard?: string } | undefined)?.dashboard;
    const containerNote = (job.result as { dashboardNote?: string } | undefined)?.dashboardNote;
    const siteUrl = (job.result as { siteUrl?: string } | undefined)?.siteUrl;
    const res = job.result as { blocking?: { blockedAsBot: number; okAsChrome: number; switchedToChrome: boolean }; crawl?: { blocking?: { blockedAsBot: number; okAsChrome: number; switchedToChrome: boolean } } } | undefined;
    const blk = res?.blocking ?? res?.crawl?.blocking; // refresh nests the crawl result
    // #54: the finished crawl explains a slow run (rate limiting, Shopify start) from its RESULT.
    type CrawlNotesSrc = { rateLimited?: { unfetched?: number }; platform?: unknown };
    const rlSrc = ((res as CrawlNotesSrc | undefined)?.rateLimited ? res : (res as { crawl?: CrawlNotesSrc } | undefined)?.crawl) as CrawlNotesSrc | undefined;
    const rlNotes = crawlNotes(rlSrc);
    const unfetchedN = rlSrc?.rateLimited?.unfetched ?? 0;
    const rlLine = (rlNotes && !prog.includes(rlNotes) ? `\n\n⏱ Crawl${rlNotes.replace(/^; /, ': ')}.` : '')
      + (unfetchedN > 0 ? `\n\n⏱ ${unfetchedN} URL(s) were still rate limited after every retry. They are stored with fetch_state "rate_limited" and no status: the audit treats them as unknown, not broken. Re-crawl with maxConcurrency 2-3 to fill them in.` : '');
    const blockLine = blk ? `\n\n🛡 ${blk.blockedAsBot} request(s) were bot-blocked for the crawler's user agent; ${blk.okAsChrome} got through as Chrome${blk.switchedToChrome ? ' and the rest of the crawl ran as Chrome' : ''}. The site's bot protection is challenging non-browser clients: check it isn't also blocking crawlers you want (pages.fetched_as shows which pages).` : '';
    // #65: the storage migration was deferred for lack of disk; the sync still ran (old layout).
    const migDeferred = (res as { storageMigrationDeferred?: string; gsc?: { storageMigrationDeferred?: string } } | undefined);
    const deferredMsg = migDeferred?.storageMigrationDeferred ?? migDeferred?.gsc?.storageMigrationDeferred;
    const deferredLine = deferredMsg ? `\n\n⚠ GSC ${deferredMsg}` : '';
    return head + prog + blockLine + rlLine + deferredLine + (link
      ? `\n\n📊 The dashboard is updated with this data: ${link} (open it in your browser).`
      : containerNote ? `\n\n📊 The dashboard is updated with this data. ${containerNote}`
      : `\n\n📊 The data is in. See it with get_dashboard${siteUrl ? ` for ${siteUrl}` : ''} (in chat), open_dashboard (browser tab) or export_report.`);
  };
  const jobStatus = async ({ jobId }: { jobId?: string }) => {
    if (jobId) {
      const job = jobs.get(jobId);
      if (!job) return { content: [{ type: 'text' as const, text: `No job ${jobId}. It is not in this process or in the job registry (${jobs.durable ? 'the id may be wrong, or it was pruned' : "the registry could not be opened, so only this process's jobs are known"}). If this server runs under a per-call container setup (the Docker MCP gateway without longLived: true, or a data directory that is not a persistent volume), jobs can't be tracked between calls; see README, Docker.` }], structuredContent: { error: 'not_found', jobId } };
      return { content: [{ type: 'text' as const, text: oneLineJob(job, true) }], structuredContent: job as unknown as Record<string, unknown> };
    }
    const all = jobs.list();
    const lines = all.slice(0, 20).map(j => oneLineJob(j));
    return { content: [{ type: 'text' as const, text: `${all.length} jobs${lines.length ? '\n' + lines.join('\n') : ''}` }], structuredContent: { jobs: all } };
  };

  server.registerTool(
    'render_pages',
    {
      title: 'Response vs Render (JavaScript rendering tier)',
      description: '[Opt-in: needs the optional `playwright` package + `npx playwright install chromium`] Render a BOUNDED, sampled set of indexable pages in headless Chromium and diff the rendered DOM against the raw HTML the crawler fetched — the "Response vs Render" check the classic desktop crawlers are known for. Surfaces content and internal links that exist ONLY after JavaScript runs (what a first-pass crawl, and Google before it renders, can miss). Persists to render_audit (raw vs rendered canonical, title, robots meta, X-Robots-Tag, noindex and main-content words); run_audit then reports `content-only-in-rendered-dom`, `canonical-changed-by-js`, `title-changed-by-js`, `noindex-changed-by-js` and `hydration-content-loss`. Slow (a real browser), so it is a separate async job and never part of the normal crawl — poll check_crawl_status. `limit` caps pages (default 10, lowest raw word-count first — the likeliest JS-dependent pages); pass `urls` to render specific pages. Degrades with a clear message if the browser isn’t installed; the HTTP audit is unaffected either way.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(200).optional(), urls: z.array(z.string()).optional() },
    },
    async ({ siteUrl, limit, urls }) => {
      const jobId = startFor(siteUrl, 'render', { siteUrl, limit, urls });
      return jobStarted({ jobId, status: 'running', siteUrl }, `Render pass started for ${siteUrl} (job ${jobId}). Headless Chromium renders each sampled page (a few seconds each), so poll check_crawl_status with jobId "${jobId}"; the finished job reports which pages depend on JavaScript. If Playwright/Chromium isn’t installed the job returns a one-line install hint and the HTTP audit is unaffected.`);
    },
  );

  server.registerTool(
    'find_duplicates',
    {
      title: 'Find near-duplicate content (semantic embeddings)',
      description: 'Embed each indexable HTML page\'s title+body with a local sentence model (all-MiniLM-L6-v2, downloaded once to a cache, no Python, no API cost) and flag pairs whose cosine similarity clears a threshold — the semantic near-duplicate / cannibalisation signal. Persists pairs to near_duplicates; run_audit then reports them as `near-duplicate-content` (judgement — needs includeJudgement:true). On-demand + ML-ish; `limit` caps pages compared (default 500, highest word-count first), `threshold` the cosine bar (default 0.9). The model reads ~the first 200 words, so it catches templated/boilerplate duplicates and thin variants — verify a pair before consolidating. First run downloads ~25MB. Re-run after a re-crawl.',
      inputSchema: { siteUrl: z.string(), threshold: z.number().min(0.5).max(1).optional(), limit: z.number().int().min(2).max(2000).optional() },
    },
    async ({ siteUrl, threshold, limit }) => {
      // Async job: the first run downloads the model and embedding up to `limit` pages (CPU, cold
      // cache, large sites) can exceed the ~60s tool ceiling — return a jobId and poll.
      const jobId = startFor(siteUrl, 'duplicates', { siteUrl, threshold, limit });
      return jobStarted({ jobId, status: 'running', siteUrl }, `Near-duplicate scan started for ${siteUrl} (job ${jobId}). Embedding runs locally (first run downloads ~25MB); poll check_crawl_status with jobId "${jobId}". The finished job lists the near-duplicate pairs; run_audit includeJudgement:true then surfaces them as near-duplicate-content.`);
    },
  );

  server.registerTool(
    'draft_content',
    {
      title: 'Draft a grounded fix in the author\'s own voice',
      description: 'Assemble a GROUNDED writing brief for a page so YOU (the assistant) can draft the fix — no bundled LLM. Returns the ranking-query gap, the page\'s OWN passages as voice exemplars (match tone/pace/lexicon), and the most query-relevant existing passages (selected by the reranker) as facts to ground in. Use it on a weak-passage-answer / not-front-loaded page to write a self-contained answer passage in the site\'s voice, inventing nothing. Omit urlKey to target the weakest-scoring page. Needs body_chunks (+ score_passages for the gap).',
      inputSchema: { siteUrl: z.string(), urlKey: z.string().optional() },
    },
    async ({ siteUrl, urlKey }) => {
      const r = await buildDraftBrief(dataDir(), siteUrl, urlKey);
      if ('error' in r) return { content: [{ type: 'text', text: r.error }], structuredContent: r };
      const voice = r.voice.map((v, i) => `  [V${i + 1}${v.heading ? ` · ${v.heading}` : ''}] ${v.text}`).join('\n');
      const facts = r.facts.map((f, i) => `  [F${i + 1} · rel ${f.relevance}${f.heading ? ` · ${f.heading}` : ''}] ${f.text}`).join('\n');
      const text = `WRITING BRIEF — ${r.url}\nTarget query: “${r.topQuery ?? '(unknown)'}”\nGap: ${r.gap}\n\nTASK\n${r.brief}\n\nVOICE (match this — the page's own writing):\n${voice || '  (no substantial passages)'}\n\nFACTS (ground in these — the page's most query-relevant content; invent nothing beyond them):\n${facts || '  (none)'}`;
      return { content: [{ type: 'text', text }], structuredContent: r as unknown as Record<string, unknown> };
    },
  );

  // detect_changes — change-detection / drift: what changed on the site since the last crawl.
  server.registerTool(
    'detect_changes',
    {
      title: 'Detect changes since the last crawl',
      description: 'Compare the two most recent crawls and report what changed per URL — status code, indexability, canonical, robots/noindex, title, meta, H1, schema, large content swings — each classified by severity (critical → info). This is the monitor: run refresh_property on different days to build history, then this surfaces regressions (a page that went noindex, a canonical that flipped, a 200 that became a 404). Needs at least two crawls.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(500).optional() },
    },
    async ({ siteUrl, limit }) => {
      const adb = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const d = diffLatest(adb.db);
        // Cap the changes array in structuredContent to `limit` — the full diff can be tens of
        // thousands of rows (e.g. a crawl-methodology change) and blow the MCP token ceiling. The
        // summary keeps the TRUE totals; markdown is already limited.
        const lim = limit ?? 50;
        const sc = { ...d, changes: d.changes.slice(0, lim), changesReturned: Math.min(lim, d.changes.length), changesTotal: d.changes.length };
        return {
          content: [{ type: 'text', text: buildDriftMarkdown(d, siteUrl, lim) }],
          structuredContent: sc as unknown as Record<string, unknown>,
        };
      } finally { adb.close(); }
    },
  );

  // check_agent_readiness — is the site ready for AI agents? (the agentic-SEO / GEO frontier)
  server.registerTool(
    'check_agent_readiness',
    {
      title: 'Check agent readiness (AI-agent / GEO signals)',
      description: 'Probe a site for AI-agent readiness — the signals agents use to discover and use it: robots.txt AI-bot rules + Content Signals, sitemap, Link headers, llms.txt, agents.md, Markdown content negotiation, Web Bot Auth, MCP server card, Agent Skills, API Catalog, OAuth discovery. Returns a 0–100 score, a level (Basic web presence → Agent-native), and a per-check checklist with copy-paste fixes. Live HTTP probes of the property origin (no crawl/GSC needed). Modelled on Cloudflare\'s isitagentready.com.',
      inputSchema: { siteUrl: z.string() },
    },
    async ({ siteUrl }) => {
      const r = await checkAgentReadiness(siteUrl);
      // Persist so the dashboard/export can show it (live probe, not crawl-derived).
      try {
        const adb = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
        try {
          adb.db.prepare(`INSERT INTO agent_readiness (origin,score,level,checks,by_category,bots,checked_at) VALUES (?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(origin) DO UPDATE SET score=excluded.score, level=excluded.level, checks=excluded.checks, by_category=excluded.by_category, bots=excluded.bots, checked_at=excluded.checked_at`)
            .run(r.origin, r.score, r.level, JSON.stringify(r.checks), JSON.stringify(r.byCategory), r.bots ? JSON.stringify(r.bots) : null);
        } finally { adb.close(); }
      } catch { /* persistence is best-effort */ }
      return {
        content: [{ type: 'text', text: buildAgentReadinessMarkdown(r) }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    },
  );

  // fix_finding — the moat: turn a finding into a concrete, paste-ready remediation.
  server.registerTool(
    'fix_finding',
    {
      title: 'Generate a fix for a finding',
      description: 'Turn an audit finding into a concrete, paste-ready remediation: JSON-LD for missing structured data, a 301 rule for broken / redirecting internal links, or internal-link suggestions for orphan / striking-distance pages. Other checks return their deterministic fix guidance. Dry-run — returns artifacts, never writes to your site. Identify the finding by findingId (from run_audit) or by check + url.',
      inputSchema: {
        siteUrl: z.string(),
        findingId: z.number().int().optional(),
        check: z.string().optional(),
        url: z.string().optional(),
        redirectFormat: z.enum(['htaccess', 'nginx', 'nextjs']).optional(),
      },
    },
    async ({ siteUrl, findingId, check, url, redirectFormat }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        // Resolve the finding → checkId, affected url_key, evidence.
        let checkId: string | undefined = check;
        let affectedKey: string | null = null;
        let evidence: Record<string, unknown> = {};
        if (findingId != null) {
          const row = db.db.prepare('SELECT check_id, url_key, evidence FROM findings WHERE id = ?').get(findingId) as
            | { check_id: string; url_key: string | null; evidence: string | null }
            | undefined;
          if (!row) {
            return { content: [{ type: 'text', text: `No finding #${findingId} for ${siteUrl}. Run run_audit first.` }], structuredContent: { error: 'not_found', findingId } };
          }
          checkId = row.check_id;
          affectedKey = row.url_key;
          evidence = row.evidence ? JSON.parse(row.evidence) : {};
        } else if (check && url) {
          const hostForm = hostFormForProperty(siteUrl) ?? 'asis';
          affectedKey = urlKey(url, { hostForm });
          const row = db.db.prepare('SELECT evidence FROM findings WHERE check_id = ? AND url_key = ? ORDER BY id DESC LIMIT 1').get(check, affectedKey) as
            | { evidence: string | null }
            | undefined;
          evidence = row?.evidence ? JSON.parse(row.evidence) : {};
        } else {
          throw new Error('Provide either findingId, or check + url.');
        }

        let kind: string;
        let fix: unknown;
        switch (checkId) {
          case 'missing-structured-data':
          case 'invalid-schema':
          case 'missing-required-fields': {
            const page = db.db
              .prepare('SELECT url, url_key, title, h1, meta_description, og_tags FROM pages WHERE url_key = ?')
              .get(affectedKey) as Record<string, unknown> | undefined;
            if (!page) {
              return { content: [{ type: 'text', text: `No crawled page for ${affectedKey} — crawl the property first.` }], structuredContent: { error: 'no_page', urlKey: affectedKey } };
            }
            kind = 'json-ld';
            fix = generateJsonLd(page);
            break;
          }
          case 'redirect-chain': {
            // The finding's url_key IS the chain's final page — its row holds the recorded
            // hops. Collapse each hop straight to the final URL; never fuzzy-match here.
            const page = db.db.prepare('SELECT url, redirects FROM pages WHERE url_key = ?').get(affectedKey) as
              | { url: string; redirects: string | null } | undefined;
            let hops: { from: string; to: string }[] = [];
            try { hops = page?.redirects ? JSON.parse(page.redirects) : []; } catch { /* malformed chain */ }
            kind = 'redirect';
            fix = page && hops.length
              ? { ...collapseChainRules(page.url, hops, redirectFormat ?? 'htaccess'), chain: hops }
              : { explanation: 'Redirect chain no longer present in the latest crawl — re-crawl and re-audit.' };
            break;
          }
          case 'internal-links-to-redirects': {
            // The flagged key is a redirect SOURCE; the crawler recorded where it actually
            // goes — find the chain containing it and use that real destination.
            const hostForm = hostFormForProperty(siteUrl) ?? 'asis';
            let knownTarget: string | null = null;
            for (const row of db.db.prepare(`SELECT url, redirects FROM pages WHERE redirects IS NOT NULL AND redirects <> ''`).iterate() as IterableIterator<{ url: string; redirects: string }>) {
              try {
                const hops = JSON.parse(row.redirects) as { from?: string }[];
                if (hops.some(h => h.from && urlKey(String(h.from), { hostForm }) === affectedKey)) { knownTarget = row.url; break; }
              } catch { /* skip malformed */ }
            }
            kind = 'redirect';
            fix = suggestRedirect(affectedKey ?? '', [], redirectFormat ?? 'htaccess', knownTarget);
            break;
          }
          case 'broken-internal-links': {
            // Genuinely dead target (4xx/5xx) — no recorded destination exists, so fall back
            // to token-overlap fuzzy matching against live pages.
            const livePages = db.db
              .prepare('SELECT url FROM pages WHERE status_code = 200 AND indexable = 1')
              .all() as { url: string }[];
            kind = 'redirect';
            fix = suggestRedirect(affectedKey ?? '', livePages, redirectFormat ?? 'htaccess');
            break;
          }
          case 'orphan-with-impressions':
          case 'striking-distance': {
            const page = db.db.prepare('SELECT h1, title FROM pages WHERE url_key = ?').get(affectedKey) as
              | { h1: string | null; title: string | null }
              | undefined;
            // Prefer the GSC query as anchor, but fall back to H1/title when it's a
            // boolean/over-long search string (common on job boards) — not usable anchor text.
            const q = evidence.query as string | undefined;
            const cleanQuery = q && q.length <= 60 && !/["()]|\bor\b|\bnot\b|\s-\w/i.test(q) ? q : undefined;
            // Never fall back to the raw q — it was just rejected as unusable anchor text.
            const anchor = cleanQuery ?? page?.h1 ?? page?.title ?? '';
            kind = 'internal-links';
            fix = suggestInternalLinks(db.db, affectedKey ?? '', anchor);
            break;
          }
          default: {
            const def = listChecks().find(c => c.id === checkId);
            kind = 'explanation';
            fix = { explanation: def?.fix ?? 'No automated generator for this check — apply the recommendation manually.', fixType: def?.fixType, title: def?.title };
          }
        }

        return {
          content: [{ type: 'text', text: `Fix for ${checkId} (${kind})${affectedKey ? ` on ${affectedKey}` : ''}` }],
          structuredContent: { checkId, urlKey: affectedKey, kind, fix } as Record<string, unknown>,
        };
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'normalize_url',
    {
      title: 'Normalise a URL to its join key',
      description: 'Return the canonical url_key used to join GSC data to crawl data.',
      inputSchema: { url: z.string(), siteUrl: z.string().optional() },
    },
    async ({ url, siteUrl }) => {
      const hostForm = siteUrl ? hostFormForProperty(siteUrl) : 'asis';
      const key = urlKey(url, { hostForm });
      return { content: [{ type: 'text', text: key }], structuredContent: { url, key, hostForm } };
    },
  );

  // ── GSC ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_properties',
    {
      title: 'List GSC properties',
      description: 'List Google Search Console properties accessible to the service account.',
      inputSchema: {},
    },
    async () => {
      const properties = await requireGsc(gsc).listProperties();
      return {
        content: [{ type: 'text', text: `${properties.length} properties: ${properties.map(p => p.siteUrl).join(', ')}` }],
        structuredContent: { properties },
      };
    },
  );

  // refresh_property — the "sync everything" verb (GSC + crawl + inspection in one job).
  // Skip flags let the same tool do "just update X".
  registerAppTool(
    server,
    'refresh_property',
    {
      title: 'Refresh a property (sync + crawl + inspect)',
      description: 'Full refresh for a property in one async job: GSC sync → site crawl → URL inspection → CrUX field data (when CRUX_API_KEY is set; each target at most once per 7 days). Opens a live progress widget (phases + counts). Set gsc/crawl/inspect/ranks/crux=false to run just part. GSC sync is "lite" (date×query×page) by default — set segments=true to also pull device/country breakdowns (much heavier on large sites). GSC sync is INCREMENTAL: the first sync pulls the window (default last 90 days; pass startDate to go deeper), later syncs only fetch new days — set full=true to force a full re-pull. Use this for "sync everything"; use the single-purpose tools to update just one thing.',
      inputSchema: {
        siteUrl: z.string(),
        gsc: z.boolean().optional(),
        crawl: z.boolean().optional(),
        inspect: z.boolean().optional(),
        ranks: z.boolean().optional(),
        crux: z.boolean().optional(),
        segments: z.boolean().optional(),
        full: z.boolean().optional(),
        location: z.union([z.string(), z.number()]).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        maxPages: z.number().int().min(1).max(50000).optional(),
        inspectLimit: z.number().int().min(1).max(500).optional(),
      },
      _meta: { ui: { resourceUri: SYNC_PROGRESS_URI } },
    },
    async ({ siteUrl, gsc: doGsc, crawl, inspect, ranks, crux, segments, full, location, startDate, endDate, maxPages, inspectLimit }) => {
      // Property is now populated: the shared helper starts the browser dashboard and puts its link
      // on the finished job (polled via check_sync_status), and skips that if the job was cancelled.
      const jobId = startFor(siteUrl, 'refresh', { siteUrl, gsc: doGsc, crawl, inspect, ranks, crux, segments, full, location, startDate, endDate, maxPages, inspectLimit });
      return jobStarted({ jobId, status: 'running', siteUrl }, `Refresh started for ${siteUrl} (job ${jobId}). Poll check_sync_status.`);
    },
  );

  server.registerTool(
    'sync_gsc',
    {
      title: 'Sync Search Console data (just GSC)',
      description: 'Update just the GSC search-analytics history (async job — poll with check_sync_status). Incremental: the first sync pulls the range (default last 90 days; pass startDate to go deeper), later syncs only fetch new days — set full=true to force a full re-pull. Lite by default (date×query×page); set segments=true (or pass dimensions) to also pull device/country. For a full refresh use refresh_property. Grain: date × query × page. Joins: page_key (url_key) → crawl/inspection/backlinks; query → DataForSEO keyword tools.',
      inputSchema: {
        siteUrl: z.string(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        dimensions: z.array(z.string()).optional(),
        segments: z.boolean().optional(),
        full: z.boolean().optional(),
        searchType: z.enum(['web', 'discover', 'googleNews', 'image', 'video']).optional(),
      },
    },
    async ({ siteUrl, startDate, endDate, dimensions, segments, full, searchType }) => {
      const syncer = requireGsc(sync);
      const options: FetchOptions = {
        startDate: startDate ?? isoDaysAgo(90),
        endDate: endDate ?? isoDaysAgo(0),
        dimensions: dimensions ?? (segments ? FULL_DIMENSIONS : undefined),
        fullResync: full,
        searchType,
      };
      const planned = syncer.plannedRange(siteUrl, options); // before the job can write
      const jobId = startFor(siteUrl, 'sync', { siteUrl, options });
      // Show the range this sync will actually fetch, not the requested default (#33). planned is
      // computed by the same rule as the job; a shape change can still widen it, and the finished
      // job reports the range used.
      return jobStarted({ jobId, status: 'running', siteUrl, startDate: planned.startDate, endDate: planned.endDate, incremental: planned.incremental, requestedStartDate: options.startDate, ...(options.dimensions ? { dimensions: options.dimensions } : {}), ...(searchType ? { searchType } : {}) },
        syncReply(siteUrl, jobId, planned, options.startDate, !!full));
    },
  );

  server.registerTool(
    'check_sync_status',
    {
      title: 'Check sync status',
      description: 'Poll any async job (sync, crawl, refresh, inspect, render, recon, backlinks, …) by id, or omit jobId to list recent jobs. check_sync_status and check_crawl_status are the same tool under two names. A running crawl reports its stage (fetching, writing-links, image-weights, resource-headers, link-graph, revalidation-probe, snapshot, site-probes, external-links), pages crawled vs the cap, pages/sec and an ETA for the fetch stage, so a long crawl is never mistaken for a stalled one; poll every 60-120 s. A failed job\'s reason is in the text reply as well as in structuredContent.error. A job whose server process exited before it finished reads as "interrupted" (see README, Docker).',
      inputSchema: { jobId: z.string().optional() },
    },
    jobStatus,
  );

  server.registerTool(
    'inspect_urls',
    {
      title: 'Inspect URLs (just URL inspection)',
      description: 'Update just the GSC URL Inspection data (coverage, indexing, Google-vs-declared canonical, last crawl) for top URLs into url_inspection. Quota-limited — samples top pages by clicks. Async job. For a full refresh use refresh_property. Grain: one row per inspected URL. Joins: url_key → pages/GSC.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(500).optional() },
    },
    async ({ siteUrl, limit }) => {
      requireGsc(inspector); // fail fast, before queueing
      const jobId = startFor(siteUrl, 'inspect', { siteUrl, limit });
      return jobStarted({ jobId, status: 'running', siteUrl }, `Inspection started for ${siteUrl} (job ${jobId}). Poll check_sync_status.`);
    },
  );

  // ── Crawl ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'start_crawl',
    {
      title: 'Crawl a site (just the crawl)',
      description: 'Update just the crawl: fetch the site into the local database (async job — poll with check_crawl_status every 60-120 s; it reports the stage, pages crawled vs maxPages, pages/sec and an ETA). Large sites: maxPages up to 50000 (default 4000); a 10k-page crawl is typically 20-40 minutes and streams pages/links to SQLite as it goes, then runs the post-crawl stages (link graph, snapshot, outbound-link check). Rate limits are adapted to (#54): a 429 (or 503 with Retry-After) halves the effective concurrency and honours Retry-After, 20 clean responses add one back up to maxConcurrency, and rate-limited URLs are re-queued at the end (2 more attempts); a URL still limited is stored with fetch_state "rate_limited" and no status, never as a 429 error. Shopify hosts are detected from their headers and start at concurrency 3 unless maxConcurrency is set. HTTP crawl; respects robots.txt; asset file-types are fetched with GET and the body is aborted unread (no download; HEAD can lie about status); internal-search / cart / wp-json / builder junk URLs are skipped by default. For a full refresh use refresh_property. excludePatterns adds extra URL regexes to skip (e.g. ["/author/","/tag/","/page/"]) to keep big crawls light. Every crawl also records each page\'s subresources (CSS, JS, fonts, images: type, first/third party, head/body, async/defer/preload) into page_resources without downloading them; headResources:true adds a header-only pass over the CSS/JS/font ones. After the crawl, every distinct outbound link target is checked (HEAD, ranged-GET fallback, host-throttled, cached 7 days in external_link_status; bot walls are "unverifiable", not broken) and run_audit reports external-broken / external-redirected — checkExternal:false skips it. Grain: one row per url_key, latest crawl. Joins: url_key → GSC/inspection/backlinks.',
      inputSchema: {
        siteUrl: z.string(),
        maxPages: z.number().int().min(1).max(50000).optional(),
        maxDepth: z.number().int().min(1).max(20).optional(),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
        delayMs: z.number().int().min(0).max(10000).optional(),
        userAgent: z.string().optional(),
        excludePatterns: z.array(z.string()).optional(),
        headResources: z.boolean().optional().describe('Also run a header-only pass over the CSS/JS/font subresources pages load (status, size, cache-control) into resource_assets. Off by default; bodies are never downloaded.'),
        checkExternal: z.boolean().optional().describe('Check every distinct outbound link target after the crawl (default true). false skips it.'),
        externalCacheDays: z.number().int().min(0).max(90).optional().describe('Reuse outbound-link results younger than this many days (default 7; 0 re-checks everything).'),
        chromeFallback: z.boolean().optional().describe('When a request is bot-blocked (403, 999, a WAF challenge) under the crawler\'s own user agent, retry it once as desktop Chrome; once at least 3 pages have needed it, and they are at least half the pages tried under the bot user agent, the rest of the crawl goes out as Chrome. Default true; always off when userAgent is set.'),
        siteProbes: z.boolean().optional().describe('End the crawl with at most 5 site probes (two URLs that cannot exist, and the http/https and www/apex twins of the homepage and of the most-linked deep page), read by soft-404-handling and host-variant-split. Default true; false skips them.'),
      },
    },
    async ({ siteUrl, maxPages, maxDepth, maxConcurrency, delayMs, userAgent, excludePatterns, headResources, checkExternal, externalCacheDays, chromeFallback, siteProbes }) => {
      const jobId = startFor(siteUrl, 'crawl', { siteUrl, maxPages, maxDepth, maxConcurrency, delayMs, userAgent, excludePatterns, headResources, checkExternal, externalCacheDays, chromeFallback, siteProbes });
      return jobStarted({ jobId, status: 'running', siteUrl }, `Crawl started for ${siteUrl} (job ${jobId}). Poll check_crawl_status.`);
    },
  );

  server.registerTool(
    'probe_urls',
    {
      title: 'Probe URLs (test a URL hypothesis live)',
      description: 'Fetch arbitrary URLs on the property\'s own host (apex or www) — including ones you generate to test a hypothesis — and report per URL: status, the full redirect chain and final URL, canonical, meta robots and X-Robots-Tag, title, a content fingerprint (equal contentHash = same page), and cache headers (cf-cache-status, x-cache, age, cache-control). The crawler only fetches what it discovers; use this to test case, trailing-slash, parameter, scheme, host or typo variants, redirect rules, or whether a 404 in the data still 404s. `variantsOf` (up to 6 URLs) is a preset: it generates uppercase, title-case, slash, index.php, unknown-param, http and www/apex variants of each URL and says per variant whether the site normalises it (one 301 to the baseline), contains it (200 with canonical to the baseline: indexing is safe but each variant is crawled and usually bypasses the page cache), or serves a duplicate. Max 50 URLs per call, 4 at a time, 45-second budget (unfinished URLs are marked, not dropped). persist:true stores results in the probes table for query_data. Free (your own server).',
      inputSchema: {
        siteUrl: z.string(),
        urls: z.array(z.string()).max(50).optional(),
        variantsOf: z.array(z.string()).max(6).optional().describe('Generate and judge URL variants of each of these URLs'),
        followRedirects: z.boolean().optional().describe('Default true; false reports only the first response'),
        persist: z.boolean().optional(),
        chromeFallback: z.boolean().optional().describe('Retry a bot-blocked URL once as desktop Chrome (default true)'),
      },
    },
    async ({ siteUrl, urls, variantsOf, followRedirects, persist, chromeFallback }) => {
      const seed = siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
      const baseHost = new URL(seed).hostname;
      const variantSets = (variantsOf ?? []).map(u => ({ of: u, list: urlVariants(u) }));
      const targets: { url: string; variantType?: string; variantOf?: string }[] = [
        ...(urls ?? []).map(url => ({ url })),
        ...variantSets.flatMap(v => v.list.map(x => ({ ...x, variantOf: v.of }))),
      ];
      if (!targets.length) throw new Error('Pass urls and/or variantsOf.');
      if (targets.length > 50) throw new Error(`That is ${targets.length} URLs (each variantsOf URL expands to ~8); the limit is 50 per call.`);
      const results = await probeUrls(targets, baseHost, { followRedirects, chromeFallback });
      const verdicts = variantSets.map(v => {
        const set = results.filter((_r, i) => targets[i].variantOf === v.of);
        const judged = judgeVariants(set);
        return { url: v.of, normalisesAll: judged.every(j => j.verdict === 'redirects'), variants: judged };
      });
      if (persist) {
        const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
        try {
          const ins = db.db.prepare(`INSERT INTO probes (url, variant_of, variant_type, status, redirect_chain, final_url, final_status, canonical, meta_robots, x_robots_tag, title, content_hash, cache, verdict, error)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          const verdictOf = new Map(verdicts.flatMap(v => v.variants.map(j => [j.url, j.verdict] as const)));
          db.db.transaction(() => results.forEach((r: ProbeResult, i) => ins.run(r.url, targets[i].variantOf ?? null, r.variantType ?? null, r.status, JSON.stringify(r.redirectChain), r.finalUrl, r.finalStatus, r.canonical, r.metaRobots, r.xRobotsTag, r.title, r.contentHash, JSON.stringify(r.cache), verdictOf.get(r.url) ?? null, r.error ?? null)))();
        } finally { db.close(); }
      }
      const cell = (s: string | null | undefined, n = 60): string => (s ?? '—').replace(/\|/g, '\\|').slice(0, n);
      const rowsMd = results.map(r => `| ${cell(r.url, 80)}${r.variantType ? ` (${r.variantType})` : ''} | ${r.status ?? '—'} | ${r.redirectChain.length ? r.redirectChain.map(h => h.status).join('→') + ' → ' + cell(r.finalUrl, 60) : '—'} | ${r.finalStatus ?? '—'} | ${cell(r.canonical)} | ${r.contentHash ?? '—'} | ${r.cache.cfCacheStatus ?? r.cache.xCache ?? '—'} | ${r.error ? cell(r.error, 50) : ''}${r.blockedAsBot ? ' blocked for the crawler UA; result fetched as Chrome' : ''} |`);
      const verdictMd = verdicts.map(v => `\n**${v.url}**: ${v.normalisesAll ? 'normalises every variant with a single redirect' : 'does NOT normalise every variant'}\n${v.variants.map(j => `- ${j.variantType}: ${j.verdict} (${j.detail})`).join('\n')}`).join('\n');
      const text = `Probed ${results.length} URL(s)${persist ? ' (saved to probes)' : ''}.\n\n| URL | Status | Redirects | Final | Canonical | Content hash | Cache | Error |\n|---|---|---|---|---|---|---|---|\n${rowsMd.join('\n')}${verdictMd ? '\n' + verdictMd : ''}`;
      return { content: [{ type: 'text', text: text.slice(0, 38000) }], structuredContent: { results, ...(verdicts.length ? { variants: verdicts } : {}) } };
    },
  );

  server.registerTool(
    'triage_404s',
    {
      title: 'Triage 404s into a redirect map',
      description: 'Turn the crawl\'s 404/410 list into a short redirect map. A GSC-seeded crawl reports every URL Google has seen, so real lost pages (traffic, backlinks) sit among many mangled variants of real slugs from scraped or AI-rewritten links. Each 404 gets its discovery sources (internal link / sitemap / GSC / backlink), clicks, impressions and last-seen date from search_analytics, backlinks and referring domains, and the closest live indexable URL by slug similarity (token overlap or edit distance, 0-1). Buckets: redirect (has clicks, ≥minImpressions impressions or referring domains, AND a match ≥minScore), ignore (no clicks, <10 impressions, no internal links, not in sitemap, no backlinks), review (everything else, e.g. internal links pointing at it: fix those at source). Before bucketing, the redirect and review candidates are probed live (verify:true, default; up to 50 URLs, 30s): a URL that already 3xx\'s to a live page is reported as already-redirected with its live destination (so a suggestion never replaces a correct redirect), and one that answers 200 now as live-now. Slug scores weight rare tokens (a brand or model) over ones shared across the site (buyers-guide, review), and archive targets (/tag/, /category/, /author/, /page/N) are discounted and flagged. Needs a crawl; GSC and pull_backlinks data sharpen it. Free: local data plus requests to your own host.',
      inputSchema: {
        siteUrl: z.string(),
        minImpressions: z.number().int().min(1).optional().describe('Impressions that count as real value (default 50)'),
        minScore: z.number().min(0).max(1).optional().describe('Slug similarity needed for a confident redirect target (default 0.6)'),
        limit: z.number().int().min(1).max(5000).optional().describe('Max 404s to triage (default 500)'),
        verify: z.boolean().optional().describe('Probe redirect/review candidates live before bucketing (default true)'),
      },
    },
    async ({ siteUrl, minImpressions, minScore, limit, verify }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      let rows: ReturnType<typeof triage404s>;
      try {
        rows = triage404s(db.db, { minImpressions, minScore, limit });
      } finally { db.close(); }
      {
        if (!rows.length) return { content: [{ type: 'text', text: `No crawled 404/410 URLs for ${siteUrl}. Run start_crawl (it seeds GSC-known URLs) first.` }], structuredContent: { rows: [] } };
        // Live verification is reported explicitly either way (#40 review): a map that was NOT
        // checked must never read as one that was.
        let probed = 0, candidates = 0;
        let verification: { ran: boolean; probed: number; candidates: number; error?: string } = { ran: false, probed: 0, candidates: 0 };
        if (verify !== false) {
          const seed = siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
          try {
            ({ rows, probed, candidates } = await verifyLive(rows, new URL(seed).hostname));
            verification = { ran: true, probed, candidates };
            if (candidates && !probed) verification.error = 'no candidate answered within the time budget';
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[triage_404s] live verification failed:', msg);
            verification = { ran: false, probed: 0, candidates: 0, error: msg };
          }
        }
        const by = (b: string) => rows.filter(r => r.bucket === b);
        const redirect = by('redirect'), review = by('review'), ignore = by('ignore'), already = by('already-redirected'), liveNow = by('live-now');
        const cell = (u: string | null) => (u ?? '—').replace(/\|/g, '\\|');
        const redirectMd = redirect.length ? `\n\n**Redirect (${redirect.length})**\n| From | To | Score | Why |\n|---|---|---|---|\n${redirect.slice(0, 60).map(r => `| ${cell(r.url)} | ${cell(r.bestMatch)} | ${r.score} | ${r.reason}${r.live?.catchAll ? ' ⚠ currently caught by a blanket redirect to the homepage' : ''} |`).join('\n')}\n\n301 map (from to):\n\`\`\`\n${redirect.map(r => `${r.url} ${r.bestMatch}`).join('\n')}\n\`\`\`` : '';
        const reviewMd = review.length ? `\n\n**Review (${review.length})**\n${review.slice(0, 40).map(r => `- ${r.url}: ${r.reason}${r.bestMatch ? ` (closest: ${r.bestMatch}, ${r.score})` : ''}`).join('\n')}` : '';
        const ignoreMd = ignore.length ? `\n\n**Ignore (${ignore.length})**: mangled or stray URLs with no value. Examples:\n${ignore.slice(0, 10).map(r => `- ${r.url}${r.bestMatch && r.score >= (minScore ?? 0.6) ? ` (variant of ${r.bestMatch})` : ''}`).join('\n')}` : '';
        const alreadyMd = already.length ? `\n\n**Already redirected live (${already.length})**: the crawl predates these redirects; nothing to do unless the destination is wrong.\n${already.slice(0, 40).map(r => `- ${r.url} → ${r.live?.finalUrl} (${r.live?.chain.join('→')})`).join('\n')}` : '';
        const liveMd = liveNow.length ? `\n\n**Live now (${liveNow.length})**: answer 200 today; re-crawl to clear them.\n${liveNow.slice(0, 20).map(r => `- ${r.url}`).join('\n')}` : '';
        const stale = already.length + liveNow.length;
        const verifyNote = verify === false
          ? ' ⚠ Not verified live (verify:false): confirm each target with probe_urls before shipping.'
          : verification.error
            ? ` ⚠ NOT VERIFIED LIVE: ${verification.error}. The buckets below are from the stored crawl only; re-run (verify defaults to on) or check targets with probe_urls before shipping any 301.`
            : probed < candidates
              ? ` ${probed} of ${candidates} candidate(s) verified live (the rest hit the time budget; re-run to cover them).`
              : ` ${probed} candidate(s) verified live.`;
        const recrawlNote = stale ? ` ${stale} URL(s) are no longer 404s live, so the stored crawl is stale: re-crawl (start_crawl) before acting on the rest.` : '';
        const text = `${rows.length} crawled 404/410 URL(s) for ${siteUrl}: ${redirect.length} to redirect, ${review.length} to review, ${ignore.length} to ignore${already.length ? `, ${already.length} already redirected` : ''}${liveNow.length ? `, ${liveNow.length} live now` : ''}.${verifyNote}${recrawlNote}${redirectMd}${reviewMd}${alreadyMd}${liveMd}${ignoreMd}`;
        return { content: [{ type: 'text', text: text.slice(0, 38000) }], structuredContent: { counts: { redirect: redirect.length, review: review.length, ignore: ignore.length, alreadyRedirected: already.length, liveNow: liveNow.length }, verification, recrawlRecommended: stale > 0, rows } };
      }
    },
  );

  server.registerTool(
    'check_crawl_status',
    {
      title: 'Check crawl status',
      description: 'Poll any async job (sync, crawl, refresh, inspect, render, recon, backlinks, …) by id, or omit jobId to list recent jobs. check_sync_status and check_crawl_status are the same tool under two names. A running crawl reports its stage (fetching, writing-links, image-weights, resource-headers, link-graph, revalidation-probe, snapshot, site-probes, external-links), pages crawled vs the cap, pages/sec and an ETA for the fetch stage, so a long crawl is never mistaken for a stalled one; poll every 60-120 s. A failed job\'s reason is in the text reply as well as in structuredContent.error. A job whose server process exited before it finished reads as "interrupted" (see README, Docker).',
      inputSchema: { jobId: z.string().optional() },
    },
    jobStatus,
  );

  // ── Google Ads Keyword Planner (free, cached 30 days) ─────────────────────
  server.registerTool(
    'keyword_volume',
    {
      title: 'Keyword search volume (Google Ads Keyword Planner)',
      description: '[FREE, Google Ads Keyword Planner, cached 30d | Use for: demand sizing] Monthly search volume + CPC + competition for keywords. With Google Ads it also returns the 12-month series, and a keyword Google groups under a close variant (plural, accent) carries groupedUnder. Location is a numeric geo id (2724 Spain, 2484 Mexico, 1005424 Madrid). Default location: ' + DEFAULT_MARKET_LABEL + '.',
      inputSchema: {
        keywords: z.array(z.string()).min(1).max(5000),
        location: z.union([z.string(), z.number()]).optional(),
        languageCode: z.string().optional(),
        includeMonthly: z.boolean().optional().describe('Include the 12-month series per keyword (default false: it multiplies the reply size). A trend label is always included.'),
        siteUrl: z.string().optional().describe('A GSC property: save these keywords to it, so keyword_demand, the dashboard and export_report show them joined to its rankings'),
      },
    },
    async ({ keywords, location, languageCode, includeMonthly, siteUrl }) => {
      const r0 = await keywordVolumes(ads, dfs, keywords, location, languageCode);
      if (siteUrl && r0.provider === 'google-ads') {
        const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
        try { saveKeywords(db.db, r0.keywords.map(k => ({ ...k, competitionLevel: k.competitionLevel ?? null, lowTopOfPageBid: null, highTopOfPageBid: null, monthly: k.monthly ?? [] })), { source: 'volume', location, language: languageCode }); } finally { db.close(); }
      }
      const r = { ...r0, keywords: r0.keywords.map(k => compactMonthly(k, includeMonthly)), ...(siteUrl ? { savedTo: siteUrl } : {}) };
      const src = 'Google Ads';
      return {
        content: [{ type: 'text', text: `${r.keywords.length} keywords via ${src}${r.cached ? ' (cached)' : r.cost ? ` (live, $${r.cost.toFixed(4)})` : ' (live)'}` }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'keyword_ideas',
    {
      title: 'Keyword ideas (Google Ads Keyword Planner)',
      description: '[FREE with Google Ads credentials, cached 30d | Use for: keyword research, new content ideas, sizing a topic] Keyword ideas with search volume, competition and CPC from Google Ads Keyword Planner, seeded by up to 20 keywords and/or a URL, or a whole site (site = domain, ideas from all its pages). Sorted by volume. Location is a numeric geo id (2724 Spain). Default location: ' + DEFAULT_MARKET_LABEL + '.',
      inputSchema: {
        keywords: z.array(z.string()).max(20).optional(),
        url: z.string().optional(),
        site: z.string().optional().describe('A domain (e.g. example.com): ideas drawn from the whole site'),
        location: z.union([z.string(), z.number()]).optional(),
        languageCode: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        includeMonthly: z.boolean().optional().describe('Include the 12-month series per idea (default false: it multiplies the reply size). A trend label is always included.'),
        siteUrl: z.string().optional().describe('A GSC property: save the ideas to it (see keyword_volume). Ideas with no volume are not saved.'),
      },
    },
    async ({ keywords, url, site, location, languageCode, limit, includeMonthly, siteUrl }) => {
      if (!ads) throw new Error('Google Ads not configured: set GOOGLE_ADS_CREDENTIALS (run scripts/google-ads-auth.mjs).');
      const r = await ads.keywordIdeas({ keywords, url, site, location, language: languageCode, limit });
      if (siteUrl) {
        const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
        const seed = [...(keywords ?? []), url, site].filter(Boolean).join(' | ');
        try { saveKeywords(db.db, r.items.filter(k => (k.searchVolume ?? 0) > 0), { source: 'ideas', seed, location, language: languageCode }); } finally { db.close(); }
      }
      return {
        content: [{ type: 'text', text: `${r.items.length} keyword ideas via Google Ads${r.cached ? ' (cached)' : ' (live)'}` }],
        structuredContent: { ideas: r.items.map(k => compactMonthly(k, includeMonthly)), cached: r.cached } as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'keyword_demand',
    {
      title: 'Keyword demand for a property (Keyword Planner × Search Console)',
      description: '[FREE, stored data | Use for: which searched keywords a client wins, almost wins or misses] The Keyword Planner keywords saved to a property (keyword_volume / keyword_ideas with siteUrl), each joined to Search Console (last 90 days; plurals and accents matched) with the page Google shows, its position, impressions and clicks, or a suggested on-site page when it does not rank. Status: top3 / page1 / striking (11-20) / weak (>20) / gap (no impressions). Same data as the dashboard Keywords tab and export_report. remove deletes keywords from the property.',
      inputSchema: {
        siteUrl: z.string(),
        status: z.array(z.enum(['top3', 'page1', 'striking', 'weak', 'gap'])).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Rows returned (default 50, by volume)'),
        remove: z.array(z.string()).optional().describe('Keywords to delete from this property; ["*"] deletes all'),
      },
    },
    async ({ siteUrl, status, limit, remove }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        let removed = 0;
        if (remove?.length) removed = deleteKeywords(db.db, remove.includes('*') ? undefined : remove);
        const p = keywordDemandPayload(db.db);
        if (!p) return { content: [{ type: 'text', text: (removed ? `Removed ${removed}. ` : '') + 'No keywords saved for this property yet: run keyword_volume or keyword_ideas with siteUrl.' }] };
        const want = status?.length ? new Set(status) : null;
        const rows = p.rows.filter(r => !want || want.has(r.status)).slice(0, limit ?? 50)
          .map(r => ({ keyword: r.keyword, volume: r.searchVolume, cpc: r.cpc, competition: r.competitionLevel, trend: r.trend, status: r.status, page: r.page, position: r.position, clicks: r.clicks, impressions: r.impressions, suggestedPage: r.suggestedPage }));
        const t = p.totals;
        return {
          content: [{ type: 'text', text: `${removed ? `Removed ${removed}. ` : ''}${t.keywords} keywords, ${t.volume.toLocaleString('es-ES')} searches/mo; page 1 captures ${t.capturedVolume.toLocaleString('es-ES')}. top3 ${t.byStatus.top3} · page1 ${t.byStatus.page1} · striking ${t.byStatus.striking} · weak ${t.byStatus.weak} · gap ${t.byStatus.gap}.` }],
          structuredContent: { totals: t, updatedAt: p.updatedAt, rows } as unknown as Record<string, unknown>,
        };
      } finally { db.close(); }
    },
  );

  server.registerTool(
    'news_discovery',
    {
      title: 'News discovery (Google News RSS)',
      description: '[FREE, no key | Use for: what has been PUBLISHED on a topic — freshness, "what changed since {date}", competitor coverage] Recent news for a keyword from the Google News RSS search feed (Spain / Spanish by default). Returns title, source, publish time, URL and the top publishers.',
      inputSchema: {
        keyword: z.string(),
        location: z.union([z.string(), z.number()]).optional(),
        languageCode: z.string().optional(),
        depth: z.number().int().min(1).max(200).optional().describe('How many news results (default 20)'),
      },
    },
    async ({ keyword, depth }) => {
      const src = 'google';
      const n = depth ?? 20;
      const seen = new Set<string>();
      const articles: any[] = [];
      const add = (a: any): void => { const k = String(a.url || a.title || '').toLowerCase(); if (k && !seen.has(k)) { seen.add(k); articles.push(a); } };
      let cost = 0, cached = false, googleCount = 0, dfsCount = 0, googleError: string | null = null;
      // Free Google News RSS.
      if (src === 'google' || src === 'both') {
        try {
          const g = await fetchGoogleNews(keyword, { limit: n });
          googleCount = g.articles.length;
          for (const a of g.articles) add({ title: a.title, source: a.source, timestamp: a.timestamp, url: a.url, via: 'google-news' });
        } catch (e) { googleError = e instanceof Error ? e.message : 'failed'; }
      }
      // Top sources: which publishers are covering this topic, ranked by article count — the
      // "who is talking about X" read. Powers "trending news + sources for X" in one call.
      const sourceCount = new Map<string, number>();
      for (const a of articles) { const s = String(a.source ?? '').trim(); if (s) sourceCount.set(s, (sourceCount.get(s) ?? 0) + 1); }
      const topSources = [...sourceCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([source, count]) => ({ source, count }));

      const top = articles.slice(0, 15).map(a =>
        `• ${a.title ?? '(untitled)'}${a.source ? ` — ${a.source}` : ''}${a.timestamp ? `, ${a.timestamp}` : ''}\n  ${a.url ?? ''}`).join('\n');
      const srcNote = [googleCount ? `${googleCount} Google News` : '', ].filter(Boolean).join(' + ') || 'no results';
      const sourcesLine = topSources.length ? `\n\nTop sources: ${topSources.map(s => `${s.source} (${s.count})`).join(', ')}` : '';
      return {
        content: [{ type: 'text', text: `${articles.length} news results for "${keyword}" (${srcNote}${cost ? `, $${cost.toFixed(4)}` : ', free'})${googleError ? ` [Google News error: ${googleError}]` : ''}${sourcesLine}${articles.length ? `\n\n${top}` : ''}\n\nCompose with topic_trend for direction (rising/falling); schedule this call daily/hourly for a topic radar.` }],
        structuredContent: { keyword, articles, topSources, cached, cost, sources: { googleNews: googleCount, dataforseo: dfsCount }, googleError },
      };
    },
  );

  server.registerTool(
    'suggest_pages',
    {
      title: 'Suggest new pages from real demand (gaps)',
      description: 'Propose NEW pages grounded in real Search Console demand: queries you already get impressions for but rank 11+ (no winning page), after subtracting demand you already satisfy (you rank ≤10, or a page already covers the query, or one URL owns it). Survivors are clustered into one proposed page per intent and scored by impressions × intent. Returns evidence + the nearest existing page to link the new page from. Computable from synced GSC + crawl — no paid calls (run search_intent siteUrl:<property> first to weight by intent).',
      inputSchema: { siteUrl: z.string(), minImpressions: z.number().int().min(1).optional(), maxProposals: z.number().int().min(1).max(200).optional() },
    },
    async ({ siteUrl, minImpressions, maxProposals }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const r = suggestPages(db.db, { ...(minImpressions != null ? { minImpressions } : {}), ...(maxProposals != null ? { maxProposals } : {}) });
        const top = r.proposals.slice(0, 15).map(p => `• "${p.headTerm}" — ${p.totalImpressions} impr, currently pos ${p.bestPosition}${p.intent ? `, ${p.intent}` : ''} (${p.queries.length} queries)`).join('\n');
        const intentTip = r.proposals.length && r.proposals.every(p => !p.intent) ? `\n\nTip: run \`search_intent\` for this property first to rank these by search intent (currently unweighted).` : '';
        return {
          content: [{ type: 'text', text: r.proposals.length ? `${r.proposals.length} new-page opportunities (from ${r.consideredQueries} queries, ${r.afterDedup} after dedup):\n${top}${intentTip}` : `No new-page gaps found (${r.consideredQueries} queries considered). Needs synced GSC data.` }],
          structuredContent: r as unknown as Record<string, unknown>,
        };
      } finally { db.close(); }
    },
  );

  // content_opportunities — the content marketer's report: everything the stored data
  // says about what to WRITE, REFRESH and REWRITE, in one free composition.
  server.registerTool(
    'content_opportunities',
    {
      title: 'Content opportunity report (write / refresh / rewrite)',
      description: 'The content marketer\'s report, composed entirely from stored data - NO paid calls. Four sections: WRITE NEXT (new pages proposed from queries you already earn impressions for but have no winning page - suggest_pages), REFRESH NOW (pages that lost 20%+ of their clicks vs the prior period - content decay), REWRITE SNIPPETS (page-1 rankings earning far below expected CTR - title/meta rewrites, the fastest wins), and STRENGTHEN (keyword clusters where you rank 4-20 - one push from the money positions). Every line traces to real Search Console data. Chain into draft_content for a brief, or keyword_volume to size a cluster against the market.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(3).max(30).optional().describe('Rows per section (default 10)') },
    },
    async ({ siteUrl, limit }) => {
      const n = limit ?? 10;
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      let proposals: ReturnType<typeof suggestPages>['proposals'];
      let weak: ReturnType<typeof clusterKeywordList>['clusters'];
      try {
        proposals = suggestPages(db.db, { maxProposals: n }).proposals;
        const fresh = gscFreshness(db.db);
        weak = clusterKeywordList(db.db, undefined, { maxDate: fresh.effectiveMax }).clusters
          .filter(c => c.verdict === 'weak' && c.bestPosition != null && c.bestPosition >= 4).slice(0, n);
      } finally { db.close(); }
      const dash = getDashboardData(dataDir(), siteUrl);
      const decay = (dash.contentDecay ?? []).slice(0, n);
      const snippets = (dash.quickWins ?? []).filter(q => q.type === 'snippet').sort((a, b) => b.potential - a.potential).slice(0, n);
      const sect: string[] = [];
      sect.push(`## 1. Write next - demand you already have, no winning page\n` + (proposals.length
        ? `| Proposed page (head term) | Impressions/mo | Best pos today | Queries |\n|---|---|---|---|\n` +
          proposals.map(p => `| ${p.headTerm.replace(/\|/g, '\\|')} | ${fmtNum(p.totalImpressions)} | ${p.bestPosition} | ${p.queries.length} |`).join('\n')
        : '_No unserved-demand gaps found._'));
      sect.push(`## 2. Refresh now - pages losing clicks\n` + (decay.length
        ? `| Page | Clicks were | Now | Drop | Clicks lost |\n|---|---|---|---|---|\n` +
          decay.map(d => `| ${d.urlKey.replace(/\|/g, '\\|')} | ${fmtNum(d.prevClicks)} | ${fmtNum(d.clicks)} | ${d.dropPct}% | ${fmtNum(d.lost)} |`).join('\n')
        : '_No significant decay - nothing lost 20%+ of its clicks._'));
      sect.push(`## 3. Rewrite snippets - ranking well, under-clicked\n` + (snippets.length
        ? `| Query | Position | CTR | Expected | Clicks recoverable/mo |\n|---|---|---|---|---|\n` +
          snippets.map(q => `| ${q.query.replace(/\|/g, '\\|')} | ${q.position} | ${(q.ctr * 100).toFixed(1)}% | ${(q.expectedCtr * 100).toFixed(1)}% | ${fmtNum(Math.round(q.potential))} |`).join('\n')
        : '_No page-1 CTR gaps found._'));
      sect.push(`## 4. Strengthen - clusters one push from the money positions\n` + (weak.length
        ? `| Cluster | Best pos | Impressions 90d | Keywords | Ranking URL |\n|---|---|---|---|---|\n` +
          weak.map(c => `| ${c.head.replace(/\|/g, '\\|')} | ${c.bestPosition} | ${fmtNum(c.impressions)} | ${c.keywords.length} | ${c.url ?? '-'} |`).join('\n')
        : '_No weak clusters - your rankings are polarised own/absent._'));
      const md = `# Content opportunity report - ${siteUrl}\n\nEverything below is from your own Search Console + crawl data (no paid calls, no invented keywords).\n\n` +
        sect.join('\n\n') +
        `\n\nNext moves: draft_content for a brief on any row · keyword_volume to size a cluster against the market · keyword_ideas (with siteUrl) to find the demand you don't cover yet.` +
        browserLink(siteUrl);
      return {
        content: [{ type: 'text', text: md }],
        structuredContent: {
          siteUrl,
          writeNext: proposals, refreshNow: decay, rewriteSnippets: snippets,
          strengthen: weak.map(c => ({ head: c.head, bestPosition: c.bestPosition, impressions: c.impressions, url: c.url, keywords: c.keywords.length })),
        } as unknown as Record<string, unknown>,
      };
    },
  );

  // keyword_list — demand-first clustering ("list mode"): a keyword list becomes topics
  // with own/weak/absent verdicts, clustered by the URL Google already answers them with.
  server.registerTool(
    'keyword_list',
    {
      title: 'Cluster a keyword list into topics with own/weak/absent verdicts',
      description: 'Demand-first keyword clustering from stored data - NO paid calls. Give it a keyword list (or omit keywords to use your top 500 GSC queries) and it clusters them by the page Google ALREADY answers them with (two keywords that rank via the same URL belong together - the strongest clustering signal, free from your own GSC data), then groups non-ranking keywords lexically. Each cluster gets a deterministic verdict: OWN (best position <=3), WEAK (4-20), ABSENT (no ranking page), plus the ranking URL, summed 90-day impressions and clicks. The keyword-research workhorse: paste a client keyword list, get the topic map and where you stand. Chain with keyword_volume for market volumes on the interesting clusters, or draft_content for the absent ones.',
      inputSchema: {
        siteUrl: z.string(),
        keywords: z.array(z.string()).max(2000).optional().describe('The keyword list. Omit to derive from your top 500 GSC queries by impressions'),
        limit: z.number().int().min(1).max(200).optional().describe('Clusters to show in the table (default 40)'),
      },
    },
    async ({ siteUrl, keywords, limit }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const fresh = gscFreshness(db.db);
        const r = clusterKeywordList(db.db, keywords, { maxDate: fresh.effectiveMax });
        const show = r.clusters.slice(0, limit ?? 40);
        const counts = { own: 0, weak: 0, absent: 0 } as Record<string, number>;
        for (const c of r.clusters) counts[c.verdict]++;
        const rowsMd = show.map(c =>
          `| ${c.head.replace(/\|/g, '\\|')} | ${c.verdict.toUpperCase()} | ${c.bestPosition ?? '-'} | ${fmtNum(c.impressions)} | ${c.keywords.length} | ${c.url ? c.url.replace(/\|/g, '\\|') : '-'} |`);
        const md = `**Keyword list clustered for ${siteUrl}** - ${r.totalKeywords} keywords (${r.derived ? 'derived from your GSC demand' : 'your list'}, ${r.inGsc} with GSC data) → ${r.clusters.length} clusters: ${counts.own} own · ${counts.weak} weak · ${counts.absent} absent\n\n` +
          `| Cluster (head term) | Verdict | Best pos | Impressions 90d | Keywords | Ranking URL |\n|---|---|---|---|---|---|\n` +
          rowsMd.join('\n') +
          `\n\nVerdicts are deterministic from your GSC positions. ABSENT clusters are content opportunities - chain into keyword_volume (market volume) or draft_content (a brief).`;
        return {
          content: [{ type: 'text', text: md }],
          structuredContent: { ...r, clusters: r.clusters.slice(0, 200) } as unknown as Record<string, unknown>,
        };
      } finally { db.close(); }
    },
  );

  const fmtNum = (v: unknown): string => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—';
  };

  // ── Dashboard (MCP App UI — houtini design + ECharts) ───────────────────
  registerAppTool(
    server,
    'get_dashboard',
    {
      title: 'SEO dashboard',
      description: 'Interactive dashboard for a property: summary metrics, rank & clicks over time, and top-keyword performance (click a keyword for related terms). Needs synced GSC data — run refresh_property first.',
      inputSchema: { siteUrl: z.string() },
      _meta: { ui: { resourceUri: DASHBOARD_URI } },
    },
    async ({ siteUrl }) => {
      // Return only a TINY model-facing result + the siteUrl; the widget fetches the full
      // (large) dataset itself via the app-only get_dashboard_data tool, which keeps the
      // big payload OUT of the model's context/token limit (per the MCP Apps large-data pattern).
      const data = getDashboardData(dataDir(), siteUrl);
      if (data.empty) {
        return { content: [{ type: 'text', text: `No synced data for ${siteUrl} yet — run refresh_property.` }], structuredContent: { siteUrl, empty: true } };
      }
      const c = data.summary?.current;
      const summary = `Dashboard opened for ${siteUrl} — ${c?.clicks ?? 0} clicks / ${c?.impressions ?? 0} impressions (last 28d)` +
        `${data.findings ? `, ${data.findings.total} audit findings` : ''}. Interactive charts + findings render in the widget.` + browserLink(siteUrl);
      return { content: [{ type: 'text', text: summary }], structuredContent: { siteUrl } };
    },
  );

  // App-only data tool: the dashboard widget calls this via app.callServerTool to fetch its
  // full dataset. visibility:['app'] hides it from the model; results route to the iframe,
  // bypassing the model token cap that a large model-facing result would hit.
  registerAppTool(
    server,
    'get_dashboard_data',
    {
      title: 'Dashboard data (internal)',
      description: 'Full dashboard dataset for the UI widget. App-only — not for direct use.',
      inputSchema: { siteUrl: z.string() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ siteUrl }) => {
      const data = { ...getDashboardData(dataDir(), siteUrl), apiKeys: apiKeysStatus() };
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: data as unknown as Record<string, unknown> };
    },
  );

  // export_report — the dependable deliverable: a self-contained interactive dashboard
  // HTML (data inlined) the user opens in any browser / emails to a client. Works
  // regardless of whether the host renders MCP-App widgets inline.
  server.registerTool(
    'export_report',
    {
      title: 'Export a shareable dashboard report (HTML)',
      description: 'Write a self-contained, interactive dashboard HTML for a property (all data + charts inlined) to the reports folder, and return the file path. Open it in any browser or send it to a client — no server, no MCP-App host support needed. Run refresh_property (+ run_audit for findings) first.',
      inputSchema: { siteUrl: z.string(), theme: z.enum(['light', 'dark']).optional() },
    },
    async ({ siteUrl, theme }) => {
      const data = { ...getDashboardData(dataDir(), siteUrl), apiKeys: apiKeysStatus() };
      if (data.empty) {
        return { content: [{ type: 'text', text: `No synced data for ${siteUrl} — run refresh_property first.` }], structuredContent: { error: 'empty', siteUrl } };
      }
      const tpl = readFileSync(path.join(__dirname, 'src', 'ui', 'dashboard.html'), 'utf8');
      const json = JSON.stringify(data).replace(/</g, '\\u003c'); // prevent </script> breakout
      const inject = `<script>window.__DASH_FIXTURE__=${json};window.__DASH_THEME__=${JSON.stringify(theme ?? 'light')};</script>`;
      // Replacement FUNCTION, not string — crawl data containing $& / $' would otherwise
      // be interpreted as String.replace substitution patterns and corrupt the report.
      const html = tpl.replace(/<head([^>]*)>/i, (_m, attrs: string) => `<head${attrs}>${inject}`);
      const dir = path.join(dataDir(), 'reports');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sanitizeProperty(siteUrl)}-dashboard.html`);
      writeFileSync(file, html);
      return {
        content: [{ type: 'text', text: `Report saved: ${file}\nOpen it in any browser for the full interactive dashboard (${data.findings?.total ?? 0} findings). Shareable — send it to a client as-is.` + browserLink(siteUrl) }],
        structuredContent: { path: file, siteUrl, findings: data.findings?.total ?? 0, bytes: html.length },
      };
    },
  );

  // serve_dashboard — the local webserver delivery surface: the full dashboard in a real
  // browser tab (live data, property switcher, native downloads), no MCP-App host needed.
  server.registerTool(
    'serve_dashboard',
    {
      title: 'Serve the dashboard on a local webserver',
      description: 'Start a localhost-only webserver and return a URL that opens the full interactive dashboard in your browser — live data straight from the local database (always current, unlike export_report snapshots), a property switcher, working CSV downloads, and no host widget limits. The server stays up while the MCP server runs; call again with stop=true to shut it down. Localhost only — nothing is exposed to the network.',
      inputSchema: { siteUrl: z.string().optional(), port: z.number().int().min(1024).max(65535).optional(), stop: z.boolean().optional() },
    },
    async ({ siteUrl, port, stop }) => {
      if (stop) {
        const was = dashboardServerUrl();
        const stopped = await stopDashboardServer();
        return {
          content: [{ type: 'text', text: stopped ? `Dashboard server stopped (was ${was}).` : 'No dashboard server running.' }],
          structuredContent: { stopped },
        };
      }
      const { url } = await startDashboardServer(buildWebOpts(port));
      const open = siteUrl ? `${url}/dashboard?siteUrl=${encodeURIComponent(siteUrl)}` : `${url}/`;
      if (!dashboardReachable()) {
        const note = containerDashboardNote(siteUrl, open);
        return { content: [{ type: 'text', text: note }], structuredContent: { url: null, base: null, containerUrl: open, note } };
      }
      const portNote = port != null && !url.endsWith(`:${port}`)
        ? ` (already running on its original port — requested port ${port} ignored; stop=true first to move it)`
        : '';
      return {
        content: [{ type: 'text', text: `Dashboard server running — open ${open} in your browser${portNote}. Live data, all charts, CSV downloads, property switcher. Stays up while this MCP server runs; serve_dashboard stop=true to stop it.` }],
        structuredContent: { url: open, base: url },
      };
    },
  );

  // #38: one obvious verb for "show me the dashboard": starts the local server if needed and hands
  // back the property's link. An explicit request, like serve_dashboard, so SAC_AUTOSERVE=0 (which
  // only stops AUTOMATIC starts) doesn't apply; where a port can't be bound (e.g. the Docker gateway)
  // it points at the in-chat get_dashboard instead.
  server.registerTool(
    'open_dashboard',
    {
      title: 'Open the dashboard for a property',
      description: 'Return a link that opens the property\'s interactive dashboard in the browser, starting the localhost dashboard server if it isn\'t running. Offer this after a sync, crawl, refresh or audit finishes. Where no local port can be served (e.g. the Docker MCP gateway), it says to use get_dashboard, which renders the dashboard in chat.',
      inputSchema: { siteUrl: z.string() },
    },
    async ({ siteUrl }) => {
      let base = dashboardServerUrl();
      if (!base) { try { base = (await startDashboardServer(buildWebOpts())).url; } catch { base = null; } }
      if (!base) return { content: [{ type: 'text', text: `Couldn't start the local dashboard server here. Run get_dashboard for ${siteUrl} to see the dashboard in chat, or export_report for a shareable HTML file.` }], structuredContent: { url: null } };
      const url = `${base}/dashboard?siteUrl=${encodeURIComponent(siteUrl)}`;
      if (!dashboardReachable()) {
        const note = containerDashboardNote(siteUrl, url);
        return { content: [{ type: 'text', text: `📊 ${note}` }], structuredContent: { url: null, base: null, containerUrl: url, note } };
      }
      return { content: [{ type: 'text', text: `📊 Dashboard for ${siteUrl}: ${url}\nLive from the local database: summary, rank and clicks over time, top keywords, findings by priority, crawl health.` }], structuredContent: { url, base } };
    },
  );

  server.registerTool(
    'resolve_entities',
    {
      title: 'Resolve page entities (Wikidata)',
      description: 'Heuristically resolve each top page’s primary entity (by H1, fallback title) to a Wikidata QID, and store subclass-of / part-of relationships between them. Unlocks the entity-internal-link-gap finding (suggests internal links a topical mesh implies). Heuristic — those findings are judgement (N), shown only with includeJudgement. Free (public Wikidata API), cached ~45 days, on-demand. Async job — poll check_sync_status.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(500).optional(), language: z.string().optional() },
    },
    async ({ siteUrl, limit, language }) => {
      const jobId = startFor(siteUrl, 'entities', { siteUrl, limit, language });
      return jobStarted({ jobId, status: 'running', siteUrl }, `Entity resolution started for ${siteUrl} (job ${jobId}). Poll check_sync_status, then run_audit includeJudgement:true for entity-internal-link-gap.`);
    },
  );

  // ── Static reference resources (same content the tools return — one source of truth) ──
  server.registerResource(
    'checks-reference',
    'seo-audit://checks-reference',
    {
      title: 'Check registry reference',
      description: 'The full audit check catalogue (the list_checks data) rendered as markdown: every check with category, severity, labels, certainty, fix type and its one-line fix.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{ uri: 'seo-audit://checks-reference', mimeType: 'text/markdown', text: buildChecksMarkdown(listChecks()) }],
    }),
  );

  server.registerResource(
    'cookbook',
    'seo-audit://cookbook',
    {
      title: 'Composition cookbook',
      description: 'The data-surface map (grain, join keys, freshness, cost per source) and worked multi-source recipes — identical to the composition_cookbook tool output.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{ uri: 'seo-audit://cookbook', mimeType: 'text/markdown', text: COOKBOOK_TEXT }],
    }),
  );

  registerAppResource(
    server,
    'SEO Dashboard',
    DASHBOARD_URI,
    {},
    async () => ({
      contents: [{ uri: DASHBOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(path.join(__dirname, 'src', 'ui', 'dashboard.html'), 'utf-8') }],
    }),
  );

  registerAppResource(
    server,
    'Sync Progress',
    SYNC_PROGRESS_URI,
    {},
    async () => ({
      contents: [{ uri: SYNC_PROGRESS_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(path.join(__dirname, 'src', 'ui', 'sync-progress.html'), 'utf-8') }],
    }),
  );

  // sync_crux — field Core Web Vitals from the Chrome UX Report API (#55 item 4). Free (Google API
  // key), quota 150 queries/min, throttled under it. Async job like the other collectors.
  server.registerTool(
    'sync_crux',
    {
      title: 'Sync CrUX field data (Core Web Vitals)',
      description: `[Free: Google API key in CRUX_API_KEY | Use for: real-user Core Web Vitals, incl. INP, which lab tools cannot measure] Pull Chrome UX Report field data (p75 + good/needs-improvement/poor shares for LCP, INP, CLS, plus FCP, TTFB, RTT, the LCP sub-parts, LCP resource type and navigation types) for the property's origin and its top URLs by GSC clicks (default ${CRUX_DEFAULT_URL_LIMIT}), each on PHONE and DESKTOP, into crux_metrics / crux_fractions / crux_targets. A target's first pull backfills ~25 weekly 28-day windows of history; later pulls add the newest window, at most once per 7 days per target (force:true overrides). A URL without enough Chrome traffic is recorded as insufficient_data (not an error) and re-asked after 28 days. Throttled under the API's 150 queries/min. Async job - poll check_sync_status, then run_audit for crux-field-lcp / -inp / -cls and crux-regression. refresh_property runs this too when the key is set. Grain: target x form factor x metric x 28-day window (windows overlap - a trend, never a sum). Joins: target = url_key -> pages/GSC.`,
      inputSchema: {
        siteUrl: z.string(),
        urls: z.array(z.string()).max(500).optional().describe('Collect these URLs instead of the top pages by GSC clicks'),
        limit: z.number().int().min(0).max(500).optional().describe(`Top URLs by GSC clicks (28 days) to collect besides the origin (default ${CRUX_DEFAULT_URL_LIMIT}; 0 = origin only)`),
        force: z.boolean().optional().describe('Re-ask targets checked within the last 7 days (28 for insufficient_data)'),
      },
    },
    async ({ siteUrl, urls, limit, force }) => {
      if (!cruxSync) throw new Error('CRUX_API_KEY is not set (or still a placeholder) - required for CrUX. It is a free Google Cloud API key with the Chrome UX Report API enabled: see manual/getting-started.md, "CrUX key (optional)".');
      const jobId = startFor(siteUrl, 'crux', { siteUrl, urls, limit, force });
      return jobStarted({ jobId, status: 'running', siteUrl }, `CrUX sync started for ${siteUrl} (job ${jobId}). Poll check_sync_status, then run_audit.`);
    },
  );

  const run = async (): Promise<void> => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (data: ${dataDir()}${credPath ? '' : ', GSC disabled — no credentials'})`);
  };

  return { server, run };
}
