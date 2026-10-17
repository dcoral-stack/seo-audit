# Site summary page: proposal

**Questions (Richard):** (2) What top-level summary page should the dashboard have, so the user gets an overall high-level view? (3) Do we have the data schema to support it?

**Answer in brief:** add a **Summary** tab as the landing view. It replaces the current Overview's job as "the first thing you see", and the same render is page 1 of `export_report` / print. It answers five questions top to bottom: *how is the site doing · better or worse · what's broken · what to do first · how fresh is this*. Every number on it is deterministic and clicks through to the findings or rows behind it.

**Schema verdict:** about **70% is supported today** from the existing payload (`dashboardData.ts`) and tables. The gaps are three aggregations that need no new collection (findings diff between audits, a drift summary in the payload, monthly YoY clicks) and **one real schema change**: health score history needs `audit_runs` columns, because `healthScore` is computed against the *current* `pages` table and can't be recomputed honestly for past audits. Field CWV is a new collection, deferred (see GAP-ANALYSIS, top-10 #4).

---

## 1. What the existing Overview does, and where the summary sits

The Overview (PR #41: `src/ui/overview.ts`, `renderOverview`) is a good **analyst's overview**:

| Overview block | Payload source |
|---|---|
| KPI strip: clicks, impressions, CTR, avg position (28d vs prior, 28-day sparkline), site health /100 | `summary.current/prior`, `rankTrend`, `healthScore` |
| Trend small multiples (clicks / impressions / position, one x-axis) | `rankTrend` |
| Findings by priority: severity spine + top 6 issues with impact bar and size | `findings.byCheck`, `findings.top` |
| Crawl health: status mix + indexable / canonicalised / redirected / 404 rows | `crawlHealth.responseCodes`, `.indexability`, `.urlFlow` |
| Network preview (top 90 pages by iPR) | `structureGraph` |
| Top keywords / top pages tables | `topKeywords`, `pagePerformance` |
| Jobs and data freshness | `freshness.sources` |

**What it doesn't do,** and what a cold reader (an owner or MD) needs:

1. **No verdict.** It shows numbers, but never says in a sentence whether things are good or bad.
2. **"Better or worse" only covers 28 days.** There's no year-on-year, no long trend, and nothing on whether the *issues* are improving between audits.
3. **No change since last time.** `detect_changes` (drift) exists, but the dashboard never shows it.
4. **Severity, not areas.** An owner asks "is it indexing, speed or content?". The severity spine doesn't answer that.
5. **No AI-search view.** Agent readiness lives on another tab. Content recon's AIO citations aren't summarised anywhere.
6. **No statement of what's *not* measured.** Absence is invisible: no field CWV, no logs, URL inspection is a sample.

**Recommendation: replace it as the landing view, and keep the analyst blocks where they belong.**

- The new **Summary** tab becomes the default tab.
- The Overview's analyst-only blocks move to the tabs they already deep-link to: network preview → Network, keyword and page tables → Search performance, jobs strip → the sidebar freshness block (already there).
- The Overview's KPI strip, trend and findings card are **absorbed** into the Summary, so there's no duplication.
- The same Summary render is the **first page of `export_report`** with a print stylesheet. That's roadmap item 5 ("SEO report document"), and it gets the shareable view without a third surface.

Why not "sit above" the Overview? Two overview pages means a reader has to work out which one is the real one. Why not "printable only"? The cold reader is in the live dashboard too: `refresh_property` and `run_audit` hand them the link.

### What serious tools put on the summary

From product knowledge, not re-verified in this session:

- **Ahrefs Site Audit and Semrush Site Audit** both lead with a health score (% of pages without errors), counts of errors, warnings and notices with **change since the previous crawl**, a health trend across crawls, and thematic tiles (crawlability, HTTPS, international, CWV, internal links, markup).
- **Search Console's** overview is performance trend + indexing + experience.
- **AI-visibility challengers (Profound-style)** lead with visibility or share of voice across AI engines, citation share and the top cited sources, again as **trend lines, not snapshots**.

The common pattern is one headline score with a stated definition, a trend over runs, change since last time, a short ranked action list, and source coverage. We copy that pattern, not their numbers. We have **no** share-of-voice-in-chat-assistants measurement and say so on the page (panel 8).

---

## 2. Panels

Each panel's table gives its data source (exact payload field or `table.column`), whether it exists today, the gap, and the computation. Everything is deterministic: no LLM writes a number or a sentence. "Payload" means `DashboardData` in `src/core/dashboardData.ts`.

### Panel 0: Freshness band (how fresh is this)

| Element | Source | Exists? | Gap | Computation |
|---|---|---|---|---|
| Per-source state and age (Search Console, Crawl, Audit, URL inspection, Ranks) | payload `freshness.sources[]` (`kind`, `state`, `at`, `detail`), from `dataFreshness.ts` | **Yes** | none | `ago(at)`, already in `overview.ts` |
| GSC window ("to 14 Oct, 2-day lag trimmed") | payload `dateRange.maxDate`, `.trimmedDays` | **Yes** | none | as shown |
| Stale flag (amber) | the same | Partly | thresholds | **Fixed, stated thresholds**: GSC more than 7 days behind `rawMaxDate` vs today; crawl or audit older than 30 days; audit older than its crawl (the audit predates the data). Show the rule in a tooltip. These are product rules, not benchmarks |
| Audit-predates-crawl warning | `audit_runs.crawl_id` vs `property_meta.last_crawl_id` | Data **yes**, not in the payload | add `freshness.auditCrawlId` | compare ids |

### Panel 1: Verdict line

One templated sentence plus three chips. It's built **only** from panel values. No LLM.

> "Organic clicks are down 12% on the prior 28 days (non-brand down 18%); 3 critical issues are open, 14 resolved since the last audit; 27 pages changed since the last crawl."

| Clause | Source | Exists? |
|---|---|---|
| clicks Δ | `summary.current.clicks` vs `summary.prior.clicks` | Yes |
| non-brand Δ | `brandedSplit.nonBranded.clicks` vs `.priorNonBrandedClicks` | Yes. The brand token is heuristic (`brandKey`), so the tooltip names it |
| critical open | `findings.byCheck[]` where `severity='crit'` (sum of `count`) | Yes |
| resolved since last audit | **findings diff** (see panel 3) | **Gap:** new aggregation |
| pages changed | drift summary (panel 6) | **Gap:** add to the payload |

Rules:

- A clause is **omitted** when its source is missing. The page never says "0 critical issues" when no audit ran.
- The direction word ("up", "down", "flat") uses a **stated** ±5% dead band, shown in the tooltip.
- The chips mirror the three clauses, coloured by direction only.

### Panel 2: Headline tiles (how is the site doing)

| Tile | Source | Exists? | Gap | Computation |
|---|---|---|---|---|
| Organic clicks, 28d, Δ vs prior | `summary.current/prior.clicks` | Yes | none | as Overview |
| … Δ year-on-year | `search_analytics(date, clicks)` | Data yes, **not in the payload** | add `yoy: {clicks, priorYearClicks}` | the same 28-day window minus 364 days (weekday-aligned). **Only when `MIN(date)` ≤ window start − 364d**, otherwise hidden with "needs 13 months of GSC" |
| … 16-month sparkline | `search_analytics` monthly | **Gap** | add `monthly[]` (panel 3) | — |
| Non-brand share | `brandedSplit` | Yes | none | nonBranded.clicks ÷ total |
| Site health /100 | `healthScore` (`score`, `band`, `errorPages`, `totalPages`, `definition`) | Yes | none | existing: % of crawled internal pages with no crit/high finding. **The definition is printed under the value.** The bands (Weak/Fair/Good/Excellent at 31/71/91) are a product convention, not an industry benchmark: label them that way |
| … health trend sparkline | **Gap** | **schema change**: `audit_runs.health_score`, `health_error_pages`, `health_total_pages` written at the end of `runAudit` | see panel 3 |
| Indexed | `indexCoverage.indexed` / `indexCoverage.total` | Yes | none | **Printed as "N of M inspected"**, never as a % of the site: URL Inspection is a sample (quota-bound) |
| AI readiness /100 | `agentReadiness.score`, `.level`, `.checkedAt` | Yes (when `check_agent_readiness` has run) | none | existing score; the tile shows `checkedAt` age |

### Panel 3: Better or worse (trend)

| Element | Source | Exists? | Gap | Computation |
|---|---|---|---|---|
| Monthly clicks, up to 16 months, bars | `search_analytics` | Data **yes** | add `monthly: {month, clicks, impressions, days}[]` | `SUM` by `substr(date,1,7)`. **The current month is flagged `partial` (days < month length) and drawn hollow**, never compared as if complete |
| Same month last year (ghost line) | the same series shifted 12 months | Derivable | none beyond `monthly` | only where both months are complete |
| Event ticks (crawls, audits) | `crawl_metadata.finished_at` (status `completed`), `audit_runs.finished_at` | Data yes | add `events: {kind, at}[]` | — |
| Health score per audit (step line) | **`audit_runs.health_*` (new)** | **Gap: schema** | ALTER + write in `runAudit`; **backfill** past runs only where `page_snapshots` holds that run's `crawl_id` (rebuild the page set from snapshots); otherwise leave them null, never estimate | per run |
| Opened vs resolved per audit | `findings(run_id, check_id, url_key)` across consecutive `audit_runs` | Data **yes** (findings are kept per run; only `data_storage` prunes old runs) | add `auditDeltas: {runId, at, opened, resolved, carried}[]` | key = `check_id` + `url_key` (or "site" when null); opened = in run N, not N−1; resolved = in N−1, not N. **Compare only runs with the same `scope` and the same check set**: today the check set isn't stored, so a release that adds checks reads as a wave of "opened" issues. **Gap:** add `audit_runs.check_ids` (JSON) or `audit_runs.server_version`, and skip non-comparable pairs with a visible note |

### Panel 4: What's broken (by area)

| Element | Source | Exists? | Gap | Computation |
|---|---|---|---|---|
| Rows per area (indexation, crawlability, onpage, content, schema, performance, security, accessibility, merged → shown as "Search demand") | `findings.category`, `findings.severity`, `findings.url_key` (latest run) | Data **yes**; the payload has `findings.byCheck` (per check) and `recommendations` (per category, per check) | add `findings.byCategory: {category, pages, crit, high, med, low}[]` | `COUNT(DISTINCT url_key)` per category. Site-wide findings (url_key NULL) count as 1 "site" row, labelled |
| Change since last audit (+new / −resolved) | the diff from panel 3, grouped by category | **Gap** (same aggregation) | as above | as above |
| D/N share | `findings.labels` | Yes | none | the share of the area's findings that are deterministic. Judgement findings (`N`) only show when the audit ran with `includeJudgement` |

### Panel 5: Do this first

| Element | Source | Exists? | Gap | Computation |
|---|---|---|---|---|
| Top 5 actions | `findings.top[]` (`check_id`, `recommendation`, `impact` 0-100, `size` S/M/L/XL) | **Yes** | none | existing ranking (6e yield model `(T × Y × C) / E`), deduped by `check_id` as the Overview already does |
| Pages affected per action | `findings.byCheck[].count` | Yes | none | join on `check_id` |
| Clicks at risk | `findings.traffic_at_risk` JSON (`clicks`) summed per check | Data yes | add `clicksAtRisk` to `byCheck` | sum of the 28-day clicks on the affected URLs. **Labelled "current 28-day clicks on affected pages", not "clicks you'll gain"**: the impact index replaced the old clicks forecast on purpose |
| Evidence label | `findings.labels` (D/N/G) | Yes | none | chip |
| Click-through | → Issues tab filtered to the `check_id` | Yes (`data-goto`) | none | traceability: action → finding → evidence |

### Panel 6: Changed since last crawl

| Element | Source | Exists? | Gap | Computation |
|---|---|---|---|---|
| Counts: pages now erroring, noindex added, canonical changed, title changed, pages added and removed | `diffLatest()` in `src/audit/drift.ts` over `page_snapshots` | Logic **yes**, **not in the payload** | add `drift: {baselineAt, currentAt, bySeverity, byField, staleness}` (reuse `DriftResult.summary`) | as `detect_changes`. **If `staleness` is set, the panel shows the staleness banner instead of the counts**, so it never presents an old diff as current (the 0.4.7 lesson) |
| Fewer than 2 snapshots | — | — | — | "Needs two crawls to show change", not zeros |

### Panel 7: Ranking mix and winners and losers

| Element | Source | Exists? | Computation |
|---|---|---|---|
| Position bands now vs prior | `rankingDistribution[]` (b1..b4 per date) | Yes | first vs last 28-day aggregate. GSC average position per query, labelled that way (not live SERP) |
| Gaining and losing pages (top 3 each) | `pagePerformance[]` (`clicks`, `prevClicks`, `clicksChangePct`) | Yes | sort by absolute click change, with a minimum of 10 prior clicks to stop 1→3 = +200% noise (a stated rule) |
| Decay context | `contentDecay[]` | Yes | links through |

### Panel 8: AI search

| Element | Source | Exists? | Gap | Computation |
|---|---|---|---|---|
| Agent-readiness score + 4 category bars | `agentReadiness.score`, `.byCategory[]` | **Yes** | none | existing |
| AI bot access chips, grouped as **search/citation bots** vs **training bots** | `agentReadiness.checks[]` (robots AI-bot rules) | Partly: the rules are parsed, but the per-bot verdict isn't a structured field | add `agentReadiness.bots: {bot, group, verdict}[]` (verdict = allowed / blocked / not-stated) | from robots.txt groups (RFC 9309, most-specific group). The grouping is a published UA list, kept in one constant |
| AI Overview presence and citation | `recon_page.aio_present`, `recon_page.aio_cites_us` (NULL = unknown) | Data **yes** (only for pages that went through content recon) | add `aiOverview: {checked, present, cited, unknown, checkedAt}` | **Printed as "N of M checked queries"**, with M visible. `aio_cites_us` NULL counts as *unknown*, never *not cited* (the recon accuracy lesson) |
| AI Overview share of sampled SERPs | `serpFootprint.features[]` where feature = `ai_overview` | Yes (when DataForSEO is available) | none | the sample size `sampleKeywords` is shown |
| "Answer share in chat assistants" | — | **Not measured** | — | **A muted slot saying "not measured"**. We don't query ChatGPT, Perplexity or Gemini for brand mentions, and the page mustn't imply we do |

### Panel 9: Data coverage footer

| Chip | Source | Exists? |
|---|---|---|
| Search Console: months held | `MIN(date)`/`MAX(date)` in `search_analytics` (already read in `dataFreshness.ts`) | Yes |
| Crawl: pages | `crawlHealth.totalPages` | Yes |
| URL inspection: n of N indexable | `indexCoverage.total` vs indexable pages | Yes |
| Lab CWV: pages | `cwvCoverage.pages` | Yes |
| Field CWV | — | **Not collected** (CrUX: GAP-ANALYSIS top-10 #4) |
| Server logs | — | **Not collected** (out of scope) |
| Backlinks / DataForSEO | `apiKeys`, `page_backlinks` row count | Yes |

---

## 3. Honesty constraints

1. **No invented benchmarks.** Allowed thresholds are Google-published ones (CWV), our own **stated** product rules (the stale flag, the ±5% dead band, the health bands), and comparisons with the site's **own** past (prior period, prior year, prior audit). No "industry average CTR". `ctrModel.ts`'s expected-CTR curve is a model, and anything that uses it says so.
2. **Every score explains itself back to findings (D vs N).** Health score → the list of `errorPages` URLs and their crit/high findings. Area rows → the findings in that category. Actions → the finding rows and their evidence JSON. AI readiness → its checks. The verdict sentence → the panels it was built from. No composite "SEO score" that blends traffic, health and AI into one number: it couldn't be traced, so we don't build it.
3. **Samples are named as samples.** URL inspection, AIO checks and SERP footprint always show "n of M".
4. **Missing never renders as zero.** Every panel has an explicit empty state:

| Property state | What the summary shows |
|---|---|
| **No GSC** (crawl only) | Tiles: clicks, non-brand and the monthly trend are replaced by one "Connect Search Console to see traffic and trends" card. The verdict drops its traffic clauses. Health, broken, actions (crawl-only checks), drift, AI readiness and coverage all still work. The freshness band shows Search Console as "never". G-labelled checks don't run, and the area table says "search-demand checks need Search Console" |
| **No crawl** (GSC only) | Traffic tiles, monthly trend, ranking mix and winners/losers all work. Health shows "–" with "run a crawl"; broken, actions and drift show their empty states. The verdict keeps only its traffic clauses |
| **No audit yet** | Health, broken and actions say "run `run_audit`". The audit-delta chart needs ≥2 comparable audits |
| **One crawl only** | Drift: "needs two crawls" |
| **< 13 months GSC** | YoY clauses and the ghost line are hidden, with a "needs 13 months" note |

---

## 4. Implementation plan (follow-up PR, not this one)

**Slice 1: payload aggregations, no schema change** (`dashboardData.ts` + tests)

- `monthly[]` with a `partial` flag, `yoy`, `events[]`.
- `findings.byCategory[]`, `byCheck[].clicksAtRisk`.
- `drift` (call `diffLatest`, pass through `summary` + `staleness`).
- `aiOverview` from `recon_page`; `agentReadiness.bots[]`.
- `freshness.auditCrawlId`.
- Tests: fixture DBs for the four empty states above, plus partial-month, staleness-banner and `aio_cites_us IS NULL` → unknown.

**Slice 2: schema** (`AuditDatabase.ts` ensure-migration + `engine.ts`)

- `audit_runs.health_score`, `health_error_pages`, `health_total_pages`, `check_ids` (JSON), all written at the end of `runAudit` using the existing `healthScore` SQL.
- Backfill only from `page_snapshots` where that run's `crawl_id` exists; otherwise null.
- `auditDeltas[]` in the payload, skipping non-comparable pairs (different `scope` or `check_ids`), with a `skipped` reason.
- Tests: opened/resolved arithmetic across three runs, the check-set-change skip, and the backfill-only-when-snapshotted rule.

**Slice 3: UI** (`src/ui/summary.ts` + `dashboard.html` tab + `styles.css`)

- The Summary tab becomes the default.
- Move the network preview, keyword and page tables, and the jobs strip out of the Overview, and retire the Overview tab.
- Templated verdict (pure function, unit-tested over the empty states).
- Print stylesheet; `export_report` page 1 = Summary.
- Redaction mode respected (the `.redact-n` pattern).
- Stitch screens in `design/summary/stitch/screens/` are the layout reference, not the copy (see `stitch/CRITIQUE.md`).

**Slice 4: feed the summary from new checks** (from GAP-ANALYSIS)

- `site-wide-indexing-alarm` → verdict line, first clause.
- `snippet-restricted` and `ai-search-bot-blocked` → AI panel.
- `crux-field-*` → a CWV tile once collected.

Each slice: build → probe against a real DB (populated-% check) → commit, one slice at a time, per the repo's working principles.
