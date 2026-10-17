# Technical-SEO audit: gap analysis

**Question (Richard):** Gemini Argon must have a very complete technical-SEO audit checklist. What don't we check?

**Short answer:** most of what a 2026 checklist asks for that we can't do yet sits in three places. First, **asset and redirect data we already collect but never check** (`page_resources`, `resource_assets`, `image_assets`, `redirect_sources`, `probes`, `render_audit`, `links.rel`, `pages.hreflang` codes, `pages.vary`). Second, **AI-search controls** (snippet directives and AI-bot rules), which we measure in `check_agent_readiness` but never feed into the audit. Third, **field Core Web Vitals**: we have no INP at all, because `page_cwv` is lab-only. Log-file analysis, manual actions and crawl stats are out of scope. They need data that isn't in any API we call.

## Method

| Side | Source | Notes |
|---|---|---|
| Ours | `src/audit/checks.ts` on `origin/master` (a78fb43): **111 checks**, cross-checked against `list_checks` on the installed build | Grouped below by the registry's own `category` field |
| Ours (context) | `research/01-modern-technical-seo-checklist.md`, `plan/checklist-coverage.md` (76-item industry checklist, mapped 2026-07-20), `CHANGELOG.md` | Not in the public repo; they're local working files |
| Gemini | `gemini-4-argon`, grounding on, thinking high, no `max_tokens`. One full-list call timed out at 240s, so the list was split into **two calls** (areas 1-10, areas 11-19). | **~190 candidate rows** came back. Gemini is a source of candidate checks, not truth: every row was judged against what Google documents and what our data can prove. See "Discarded" |

### Our inventory (111 checks)

| Category | n | Checks |
|---|---|---|
| merged (GSC × crawl) | 23 | orphan-with-impressions, striking-distance, keyword-cannibalisation, ctr-below-expected, traffic-decay, lost-queries, position-slipping, rising-pages, traffic-to-dead-url, impressions-rising-clicks-flat, h1/title/body-missing-top-query, rag-answer-gap, anchor-text-incoherent, weak-passage-answer, answer-not-front-loaded, stale-content, high-ipr-no-traffic, ghost-pages, underlinked-high-demand, underlinked-editorial, intent-vs-pagetype-mismatch |
| onpage | 22 | titles, metas, H1s, image-alt, image dimensions, heading-hierarchy, social/OG tags, viewport, lang, excessive-links, favicon, analytics, external-broken, external-redirected, discover-max-image-preview, discover-missing-og |
| indexation | 16 | canonical (relative / multiple / ignored / conflict / broken target), noindex-with-traffic, indexed-junk-url, coverage-not-indexed, index-bloat, soft-404-shell, hreflang (broken target / no return tag), sitemap reconciliation (3), image-preview-restricted |
| crawlability | 15 | broken-internal-links, redirect-chain, internal-links-to-redirects, deep-pages, orphans (2), ipr-bleed-by-status, faceted-spider-trap, pagination-canonical-to-page-1, content-only-in-rendered-dom, meta-nofollow, robots-blocked-with-traffic, backlinks-to-404, entity-internal-link-gap, discover-crawl-waste |
| schema | 13 | invalid / missing-required / value-errors / forbidden / missing, homepage org, breadcrumb consistency, rich-result-issues (URL Inspection), article dates / author / duplicates, discover type + image |
| accessibility | 7 | axe-style link-name, button-name, form-label, zoom-disabled, duplicate-id, positive-tabindex, empty-alt content images |
| content | 6 | thin, near-duplicate (semantic), poor-chunkability, low-extractability, content-bloat, ai-slop-signals |
| performance | 6 | high-yield-cwv-fail (lab), slow-response (TTFB proxy), large-html, uncompressed-html, no-304-revalidation, discover-slow-response |
| security | 3 | mixed-content, missing-hsts, non-https |

### Data we collect that no check reads

| Table / column | Written by | Read by a check? |
|---|---|---|
| `page_resources` (every CSS/JS/font/img a page loads: head/body, async/defer/preload, first/third party) | crawler | **No.** Not in the dashboard either |
| `resource_assets` (status, content_length, cache_control per asset) | crawler | **No** |
| `image_assets` (bytes, status, content_type) | crawler (HEAD) | **No.** Shown in `crawlHealth.largeImages`, never a finding |
| `probes` (URL variants: status, redirect chain, canonical, robots, cache headers) | `probeUrls.ts` | **No** |
| `redirect_sources.status` / `.chain` / `.hops` | crawler | Partly: only `backlinks-to-404` joins it |
| `render_audit.title_changed` / `.canonical_changed` / word counts | render tier | Partly: `content-only-in-rendered-dom` uses links and words only |
| `pages.security_headers` (csp, xFrame, xContentType, referrer, permissions) | crawler | Partly: HSTS only |
| `pages.vary`, `pages.rel_amphtml`, `pages.charset` | crawler | **No** |
| `links.rel` (nofollow/ugc/sponsored on internal links) | crawler | **No** |
| `pages.hreflang` codes | crawler | Partly: target health and return tags only, not code validity, self-reference or x-default |
| `agent_readiness` (AI-bot rules, llms.txt, …) | `check_agent_readiness` | **No.** Dashboard-only; CLAUDE.md roadmap item 3 still says "wiring into the audit/score" is TODO |
| `url_inspection.page_fetch_state` / `.robots_txt_state` | `inspect_urls` | Partly: soft-404 only |
| `url_inspection.mobile_usability` | `inspect_urls` | No. Google retired the Mobile Usability report (Dec 2023), so expect it empty. Drop the column rather than build on it |
| `search_analytics.search_appearance` | GSC sync | No |
| `page_snapshots` history (status, indexable, schema_types per crawl) | crawler | Only `detect_changes` reads it. No check uses cross-crawl history |

## The diff

Each row is a check that Gemini proposed (or that the diff exposed) and that we don't have. Gemini's ID is given where it differs. "Collected?" points at the exact table and column, or says what is missing. Effort is S (under half a day, data exists), M (a day or two, or one new field), or L (a new collection tier). Value is H, M or L for a typical site the console audits. Ecommerce and international rows matter much more on those sites.

### (a) Addable from data we already have

| Area | Missing check | Why it matters | Data needed | Collected? | Effort | Value |
|---|---|---|---|---|---|---|
| AI search | `snippet-restricted` (Gemini: restrictive-nosnippet-or-max-snippet) | `nosnippet` / low `max-snippet` also removes the page from AI Overviews and AI Mode (Google, "AI features and your website") | meta robots + X-Robots-Tag | Yes: `pages.robots`, `pages.x_robots_tag` | S | H |
| AI search | `ai-search-bot-blocked` (ai-search-crawlers-blocked-in-robots) | Blocking retrieval bots (OAI-SearchBot, PerplexityBot, Claude-SearchBot) removes citations. Blocking training bots (GPTBot, Google-Extended) doesn't. The audit should tell the two apart | robots.txt groups per bot | Yes: `agent_readiness.checks` (robots AI-bot rules); not wired into findings | S | H |
| AI search | `org-entity-incomplete` (incomplete-entity-organization-sameas) | Organization without `@id`/`sameAs` weakens entity disambiguation for Knowledge Graph and LLMs. Extends `homepage-missing-org-schema` | homepage JSON-LD | Yes: `pages.json_ld` | S | M |
| Indexing | `site-wide-indexing-alarm` (staging-blocks-retained-on-launch + sudden-indexed-url-or-impression-drop) | One critical finding when >N% of crawled pages go noindex or robots-blocked, or when distinct pages with impressions drop >20% week on week. Today each page fires separately and the site-level event is lost | page indexability; weekly distinct `page_key` with impressions | Yes: `pages.indexable_reason`, `search_analytics(date, page_key)` | S | H |
| Indexing | `canonical-cross-host` (canonical-or-sitemap-references-http / old host) | A canonical pointing at another host (an old domain, staging, a CDN hostname) hands indexing to that host | canonical host vs property host | Yes: `pages.canonical_url`, `property_meta.host_form` | S | H |
| Redirects | `redirect-loop` | A loop is a dead end for users and crawlers | redirect chain | Yes: `redirect_sources.chain` | S | M |
| Redirects | `temporary-redirect-with-equity` (temporary-redirect-permanent-intent) | A 302/307 on a URL with GSC history or backlinks; a 301/308 says the move is permanent | first-hop status; GSC; backlinks | Yes: `redirect_sources.status`, `search_analytics`, `page_backlinks` | S | M |
| Redirects / migrations | `redirect-to-non-indexable` (migration-redirect-to-non-indexable) | A redirect whose final URL is noindex, canonicalised away or robots-blocked throws the equity away | final_key → indexability | Yes: `redirect_sources.final_key` ⋈ `pages.indexable` | S | H |
| Redirects / migrations | `redirect-to-homepage` (irrelevant-redirect-to-homepage) | Google treats a deep URL redirected to `/` as a soft 404 | final_key = home | Yes: `redirect_sources` | S | H |
| Migrations | `redirect-retired` (legacy-redirects-retired-prematurely) | A URL that was a 3xx in an earlier crawl and is now a 4xx: someone removed the redirects | status per crawl | Yes: `page_snapshots.status_code` across `crawl_id` | S | H |
| International | `hreflang-invalid-code` | Google ignores invalid ISO 639-1 / 3166-1 codes (`en-uk`) | hreflang values | Yes: `pages.hreflang` | S | M (H intl) |
| International | `hreflang-missing-self` | Each version must list itself (Google, "Localized versions") | hreflang + url_key | Yes: `pages.hreflang` | S | M (H intl) |
| International | `hreflang-missing-x-default` | No fallback for unmatched locales | hreflang | Yes: `pages.hreflang` | S | L |
| International | `hreflang-duplicate-locale` | Two URLs claim the same locale in one cluster | hreflang | Yes: `pages.hreflang` | S | M |
| International | `hreflang-canonical-conflict` (cross-locale-canonical-conflict) | A locale page canonicalised to another locale drops out of the index | hreflang + canonical | Yes: `pages.hreflang`, `pages.canonical_key` | S | H (intl) |
| JS rendering | `canonical-changed-by-js` / `title-changed-by-js` | Google may use either value, and a JS-rewritten canonical is a known trap (Search Central JS SEO basics) | raw vs rendered | Yes: `render_audit.canonical_changed`, `.title_changed` (render tier only) | S | H / M |
| JS rendering | `hydration-content-loss` (hydration-wipes-ssr-content) | Rendered word count well below raw: JS wipes server-rendered copy | raw vs rendered words | Yes: `render_audit.raw_word_count`, `.rendered_word_count` | S | M |
| Performance | `render-blocking-head-resources` | Synchronous scripts and stylesheets in `<head>` delay LCP | resource position + async/defer | Yes: `page_resources.position`, `.is_async`, `.is_defer`, `.type` | S | M |
| Performance | `broken-subresource` | A 4xx on a CSS/JS file breaks rendering, for Googlebot too | asset status | Yes: `resource_assets.status` | S | H |
| Performance | `static-asset-uncached` (missing-immutable-cache-headers) | Static assets with no long `max-age` slow repeat visits | Cache-Control per asset | Yes: `resource_assets.cache_control` | S | M |
| Performance | `js-payload-heavy` (excessive-dom-nodes-and-js-payload, payload half) | Large JS weight correlates with poor INP. Report it in bytes, without inventing a threshold for "bad" | sum JS bytes per page | Yes: `page_resources` ⋈ `resource_assets.content_length` | S | M |
| Images | `image-oversized` / `image-legacy-format` (unoptimized-image-format-and-bytes) | Heavy JPEG/PNG where WebP/AVIF would do | bytes + content-type | Yes: `image_assets.bytes`, `.content_type` (HEAD only, so no pixel dimensions) | S | M |
| Images | `broken-image` (broken-image-resource) | A 4xx image in content | image status | Yes: `image_assets.status` | S | M |
| Internal linking | `internal-nofollow` (nofollow-on-internal-links) | `rel=nofollow` on internal links to indexable pages wastes equity. We only flag the page-level meta nofollow | link rel | Yes: `links.rel`, `links.is_internal` | S | M |
| Internal linking | `links-to-robots-blocked` (robots-blocked-internal-urls) | Internal links pointing into disallowed URLs | link target indexable_reason | Yes: `links` ⋈ `pages.indexable_reason='robots-disallowed'` | S | M |
| Internal linking | `hub-dead-end` (internal-pagerank-hoarding-dead-ends) | High-iPR or high-backlink pages with almost no outgoing body links trap authority | iPR, body out-links | Yes: `pages.ipr`, `links.placement='body'`, `page_backlinks` | S | M |
| Internal linking | `generic-anchor-share` (generic-or-empty-anchor-text) | Share of a page's inbound internal anchors that are generic ("read more"). Complements `anchor-text-incoherent` | anchors | Yes: `links.anchor_text` (stoplist already exists) | S | L |
| Crawlability | `path-repetition-trap` (infinite-crawl-trap-path) | Repeating path segments (`/a/b/a/b/`) mark a relative-link trap | URLs | Yes: `pages.url` | S | M |
| Crawlability | `sort-param-indexable` (indexable-sort-or-view-parameters) | Single sort/view parameters left indexable. `faceted-spider-trap` only catches multi-parameter URLs | URL params + indexable | Yes: `pages.url`, `pages.indexable` | S | M |
| Ecommerce | `product-gone-404` (out-of-stock-product-returns-4xx) | A URL that carried Product schema in an earlier crawl and now returns 404/410, so a discontinued or out-of-stock product took its rankings and links with it | schema history + status | Yes: `page_snapshots.schema_types`, `.status_code` | M | H (ecom) |
| Ecommerce | `merchant-listing-incomplete` (merchant-listing-schema-incomplete) | Product/Offer without `shippingDetails` / `hasMerchantReturnPolicy` / GTIN misses merchant-listing enhancements. **These are recommended properties, not required ones, so the check is N-labelled and low severity, in line with the validator's required-only principle** | JSON-LD | Yes: `pages.json_ld` | S | M (ecom) |
| Ecommerce | `duplicate-product-entities` (conflicting-duplicate-schema-entities) | Generalise `duplicate-article-entities` to Product. Two Product nodes with conflicting price | JSON-LD | Yes: `pages.json_ld` | S | M |
| Ecommerce | `zero-result-listing` (indexable-zero-result-category-or-facet) | Indexable 200 pages showing "0 results" are soft-404 candidates. Heuristic, so N | body text | Yes: `pages.body_chunks` (bounded to 40×1500 chars) | S | M |
| Search Console | `nonbrand-decline-masked` (non-brand-vs-brand-traffic-divergence) | Non-brand clicks fall while brand holds steady: a ranking loss hidden inside a flat total | brand split per period | Yes: `brandedSplit` aggregation in `dashboardData.ts` (brand token is heuristic: state it) | S | H |
| Security | `security-headers-baseline` (missing-baseline-security-headers) | No `X-Content-Type-Options` / frame controls. Trust hygiene, not a ranking signal: keep it low | headers | Yes: `pages.security_headers` | S | L |
| Mobile | `dynamic-serving-without-vary` | Dynamic serving (different HTML per UA) needs `Vary: User-Agent`. We capture `Vary` but never read it. This is the cheap precursor to a full mobile-parity check | Vary header | Yes: `pages.vary` | S | L |
| A11y overlap | `lang-invalid` (missing-or-invalid-html-lang) | Malformed BCP 47 in `<html lang>`. We only flag a missing value | lang | Yes: `pages.lang` | S | L |

### (b) Needs new collection

| Area | Missing check | Why it matters | Data needed | Collected? | Effort | Value |
|---|---|---|---|---|---|---|
| CWV | `crux-field-lcp` / `crux-field-inp` / `crux-field-cls` (crux-*-exceeds-threshold, poor-crux-core-web-vitals) | **We have no INP anywhere.** It's a field-only metric, and `page_cwv` is Lighthouse lab (LCP/CLS/TBT). Google's thresholds are published (LCP 2.5s/4s, INP 200/500ms, CLS 0.1/0.25), so they are not invented benchmarks | CrUX API (free, key) per URL and origin, p75, form factor | No. New `page_crux` table | M | H |
| AI search | `data-nosnippet-on-main` (misconfigured-data-nosnippet) | `data-nosnippet` around main content hides it from snippets and AI features | element attribute | No. Extractor field (count + share of body text) | S | M |
| Indexing | `soft-404-handling` (spa-soft-404-on-invalid-route) | Request one random non-existent path. A 200 means every typo URL is indexable | one probe per crawl | No, but `probes` can hold it | S | H |
| Redirects | `host-variant-split` (host-protocol-canonical-redirect-split, http-to-https-redirect-missing) | http/https × www/apex should each 301 in one hop to the canonical host | 4 probes per crawl | Partly: `probes.variant_type` exists, but nothing runs it per crawl | S | H |
| Redirects | `meta-refresh-redirect` (meta-refresh-or-js-redirect) | A client-side redirect on a 200 page | `<meta http-equiv=refresh>` | No. Extractor field | S | M |
| Indexing | `canonical-in-body` (canonical-outside-head) | Google ignores a canonical in `<body>`, or one pushed there by invalid head markup | canonical location | No. Extractor flag | S | M |
| JS rendering | `noindex-changed-by-js` (raw-vs-rendered-noindex-conflict) | Raw noindex removed by JS is still honoured, so Google never renders the page | rendered robots | No. Add `robots_changed` to `render_audit` | S | H (JS sites) |
| JS rendering | `schema-only-rendered` (schema-injected-client-side-only) | JSON-LD that only appears after JS | rendered JSON-LD | No. Add to `render_audit` | S | M |
| JS rendering | `non-crawlable-links` (non-crawlable-js-link-elements) | `href="#"`, `javascript:`, `onclick` navigation | anchor without href | No. Extractor count | S | M |
| Performance | `lcp-image-lazy` (lcp-image-lazy-loaded-or-unprioritized) | `loading="lazy"` on the first content image or the hero | `loading`/`fetchpriority` on images in document order | No. `page_resources` stores images but not these attributes | S | M |
| Performance | `asset-compression` / `http-version` (legacy-http-protocol) | Uncompressed JS/CSS; HTTP/1.1 only | `content-encoding` per asset; ALPN / `alt-svc` | No. Add columns to `resource_assets`; ALPN needs the fetch layer | S / M | L |
| Security | `tls-expiring` (tls-certificate-expiring-or-invalid) | An expired certificate takes the whole site down for users and crawlers | TLS peer cert | No. One `tls.connect` per host per crawl | S | M |
| Crawlability | `robots-txt-health` (robots-txt-fetch-status, -size-limit, -invalid-directives) | A 5xx on robots.txt halts crawling. Content beyond 500 KiB is ignored. A `Noindex:` line does nothing | robots fetch status, size, unsupported lines | Partly: `robots.ts` fetches it but nothing is persisted | S | H (5xx) / L |
| Sitemaps | `sitemap-invalid` / `sitemap-limits` / `sitemap-index-nesting` / `sitemap-not-in-robots` | A malformed sitemap or an over-limit file is ignored entirely (50k URLs / 50 MB) | parse errors, counts, index structure | Partly: `sitemap.ts` parses, but only `sitemap_urls` rows survive | S | M |
| Sitemaps | `news-sitemap-invalid` / `video-sitemap-invalid` | News/video-specific required tags | sitemap extensions | No | M | L (M publishers) |
| Images / video | `image-alt-filename` (non-descriptive-image-alt-filenames) | Alt text like `IMG_1234.jpg` | alt values | No. Only counts are stored | S | L |
| A11y overlap | `no-main-landmark` (missing-semantic-main-landmark) | No `<main>`, so boilerplate separation is ambiguous | landmark presence | No. Extractor flag | S | L |
| International | `content-language-mismatch` | An untranslated body on `/de/` | language detection on body | No. Needs a language-ID dependency over `body_chunks` | M | M (intl) |
| International | `locale-redirect` (geo-ip-or-accept-language-redirect) | Redirecting by IP or `Accept-Language` hides locales from US-based Googlebot (documented) | fetch with varied `Accept-Language` | No | M | M (intl) |
| Security | `cloaking-diff` (hacked-content-cloaking-or-spam-injection) | Googlebot-UA fetch differs from the browser-UA fetch. This is the classic hacked-site tell | second fetch as Googlebot (recon's `crawlAs` already does this) | No, not for the owned-site crawl | M | M (rare, severe) |
| Mobile | `mobile-parity` (mobile-desktop-content / link / schema mismatch) | Mobile-first indexing uses the mobile DOM | a second render with a mobile UA and viewport | No. Render tier, mobile pass | L | M |
| Migrations | `migration-baseline` (post-migration-template-traffic-drop) | Template-level traffic before and after a **declared** migration date | user-supplied migration date + `search_analytics` | Partly: data exists, the migration date doesn't | M | H (when it applies) |
| Ecommerce | `product-variant-schema` (product-variants-missing-productgroup-schema) | Variant URLs without `ProductGroup`. Needs variant clustering across URLs | JSON-LD + URL clusters | Partly: `pages.json_ld` exists, clustering doesn't | M | M (ecom) |
| Ecommerce | `schema-visible-price-mismatch` (schema-vs-dom-price-availability-mismatch) | JSON-LD price differs from the visible price. The `body_chunks` bound (40×1500) is too lossy to prove absence, so it needs a targeted extractor field | visible price text | No | M | M (ecom) |
| Bing / IndexNow | `indexnow-missing` | No IndexNow key file. Bing documents IndexNow. **Gemini's claim that it affects ChatGPT search grounding is unverified, so leave that claim out of the finding** | `/{key}.txt` probe | No. Add to `agentReadiness` | S | L |

### (c) Out of scope

| Area | Check | Why out |
|---|---|---|
| Log files | spoofed-googlebot-requests, wasted-googlebot-crawl-share, log-only-orphan-urls, uncrawled-priority-sitemap-pages, googlebot-5xx-or-429-rate-spike, googlebot-high-server-latency, hashed-js-css-404-for-googlebot, cdn-waf-blocking-ai-user-agents | Needs a server-log pipeline. CLAUDE.md already lists log analysis as out of scope. These are the most valuable checks we can't do. A log-upload ingest (CSV/combined-log into a `bot_hits` table) would bring them in scope later, at size L |
| GSC (not in the API) | active-manual-action-or-security-issue, crawl-stats-host-availability-errors, video-not-on-watch-page, unrendered-resources-in-url-inspection | Search Console exposes none of these through the public API (Search Analytics, URL Inspection, Sitemaps only). Surface them as "check in Search Console" links, never as measured findings |
| Mobile UX | intrusive-interstitial-or-dialog, crowded-mobile-tap-targets, illegible-mobile-font-or-horizontal-overflow, interaction-dependent-lazy-loaded-content | Needs layout-aware rendering with geometry. Lighthouse covers tap targets and font size: if `page_lighthouse` ever stores those audits, revisit |
| Security | open-redirect-vulnerability, csp-blocking-rendering-resources | Active vulnerability probing is a security-scanner job, not an SEO audit. CSP breakage needs the render tier plus console capture |
| Ecommerce | pagination-missing-crawlable-anchor-links (infinite scroll) | Proving "no other path to the product" needs scroll emulation; the orphan checks cover the outcome |

### Discarded from Gemini's list (and why)

- **Self-flagged by Gemini as myths or unverifiable:** crawl-budget-exhaustion-small-site, low-word-count-penalty, text-to-html-ratio-threshold, first-link-priority-override, direct-eeat-score-threshold, wcag-score-direct-ranking-factor. Agreed: none get built.
- **`insufficient-text-color-contrast`**: Gemini says a contrast below 1.2:1 "triggers hidden-text spam detection". That threshold isn't in any Google document. The WCAG 4.5:1 half is accessibility, not SEO, and needs computed styles. Discarded.
- **`excessive-boilerplate-ratio`**: the 20% threshold is unsourced and the metric isn't a documented signal. `thin-content` and `near-duplicate-content` cover the defensible part.
- **`crawl-frequency-vs-value-inversion`**: needs logs, and the "5×" threshold is arbitrary.
- **`rich-result-missing-recommended-field`**: rejected on principle. `schema-validate.ts` is deliberately required-only, because recommended-field warnings are the false-positive noise Google itself ignores. The merchant-listing row above is the one narrow, N-labelled exception.
- **Gemini's severity numbers** (">2% 5xx triggers throttling", ">30% boilerplate", "1,500 DOM nodes") are treated as illustrative, not adopted. Where we build a check, severity follows our yield model, `(T × Y × C) / E`, and Google-published thresholds only.
- **Already covered** (Gemini proposed them; we have them, sometimes better): broken/redirected internal links, redirect chains, orphans, click depth, canonical conflict / target / multiple / relative, Google-chosen canonical, crawled/discovered-not-indexed (`coverage-not-indexed` matches both), soft 404, index bloat, duplicate titles and metas, cannibalisation, stale decay, thin, near-duplicate, pagination canonical, faceted traps, sitemap non-indexable / missing / lastmod, hreflang return tags and broken targets, mixed content, HSTS, HTTPS, viewport and zoom, H1s, heading skips, lang missing, empty links, image alt and dimensions, JSON-LD validity and required fields, restricted FAQ/HowTo, rich-result issues, CTR outliers, impressions-without-clicks, AI-answer extractability (rag-answer-gap, weak-passage-answer, answer-not-front-loaded, low-extractability), content only in the rendered DOM, backlinks to 404, AI Overview citation gap (per page, in content recon).

## Top 10 to build next

Ranked by value ÷ effort, with a bias towards checks that feed the proposed summary page (`SUMMARY-PAGE.md`):

1. **`site-wide-indexing-alarm`** (a, S, H): the one critical finding an owner must never miss (site-wide noindex or Disallow, or a >20% week-on-week drop in pages earning impressions). It feeds the summary verdict directly.
2. **`snippet-restricted` + `ai-search-bot-blocked`** (a, S, H): wire the AI-search controls we already measure into the audit. Retrieval bots and training bots are scored separately.
3. **Redirect hygiene from `redirect_sources`**: `redirect-to-non-indexable`, `redirect-to-homepage`, `redirect-loop`, `temporary-redirect-with-equity`, and `redirect-retired` from `page_snapshots` (a, S, H). It's migration safety from data we already hold.
4. **`crux-field-*` (LCP/INP/CLS)** (b, M, H): closes the only Core Web Vital we have no data for. Google's own thresholds make it an honest benchmark.
5. **`nonbrand-decline-masked`** (a, S, H): the "is it actually getting worse?" check, built on `brandedSplit`.
6. **`canonical-cross-host` + the hreflang validation set** (invalid code, missing self, duplicate locale, canonical conflict) (a, S, H for international).
7. **Asset-layer checks**: `broken-subresource`, `render-blocking-head-resources`, `static-asset-uncached`, `image-oversized`/`legacy-format`, `broken-image` (a, S, M). They make three silent tables earn their keep.
8. **`soft-404-handling` + `host-variant-split`** (b, S, H): five probes per crawl. `probes` already has the schema.
9. **JS-render divergence**: `canonical-changed-by-js`, `title-changed-by-js`, `hydration-content-loss` (a), plus `noindex-changed-by-js` (b, extend `render_audit`). S, H on JS-heavy sites.
10. **Ecommerce pair**: `product-gone-404` from snapshot history and `merchant-listing-incomplete` (N, low) (a, S/M, H on stores).

Next tier: `internal-nofollow`, `robots-txt-health`, `tls-expiring`, `data-nosnippet-on-main`, `sitemap-invalid`/limits, `org-entity-incomplete`.

**Confidence:** ~85% that the (a) list is complete for the tables audited here. The inventory is exact: it's parsed from `checks.ts`. "Collected?" was verified against the `CREATE TABLE` statements in `AuditDatabase.ts` and a grep of `checks.ts` for each table name. It was **not** verified against populated percentages on a real DB, so a column can exist and still be sparsely written. Run the per-column populated-% diagnostic (CLAUDE.md, "Diagnostics learned this build") before building on `page_resources` and `resource_assets`.
