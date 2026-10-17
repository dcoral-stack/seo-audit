# Design System: SEO Audit Console - Crawl & Network Intelligence

## 1. Visual Theme & Atmosphere
A crawl and network intelligence console for technical SEO: it crawls a website, maps the
site as a link graph, and joins it to Google Search Console analytics. The feel is a modern
analytics product in the category of current SEO suites and AI-visibility challengers:
dense but calm, data-first, quiet chrome, crisp thin-line charts, every number in a
monospaced tabular face. A signature visual is the crawl network: pages as nodes, internal
links as hairline edges, node size by internal PageRank, node colour by health. Nothing
decorative: no gradients, no glow, no illustrations, no emoji, no stock imagery. Dark theme
is the hero (graphite, not pure black); a light theme on cool paper (#F6F7F9 canvas, white panels, #E3E7EC hairlines, #10141A ink, #0F8F66 accent) is equally finished.
Desktop web app at 1440 wide, left sidebar navigation, a slim top bar.

## 2. Color Palette & Roles
- Graphite Canvas (#0F1115) - app background.
- Panel (#161A20) - cards and the sidebar; Panel Raised (#1C2129) for hover and inset tracks.
- Hairline (#262C35) - card borders, table rules, gridlines (#1F242C for whisper gridlines).
- Ink (#E8ECF1) - headings and key numbers; Ink Two (#A7B0BC) - body; Muted (#6E7885) - labels, axis ticks.
- Signal Green (#2BD39B) - the ONE accent: active nav, the primary series, healthy nodes,
  positive deltas. Used sparingly.
- Link Blue (#5AA9F5) - the secondary series (impressions, outbound edges, links).
- Amber (#E9B44C) - warnings, non-indexable, striking distance.
- Signal Red (#F0616D) - reserved for genuine problems: 4xx/5xx, critical findings, broken nodes.
- Context Grey (#3A424D) - every bar, dot or edge that is not the point.


## 3. Typography Rules
- UI and headings: a grotesque sans (Schibsted Grotesk, or Inter), 13-14px body, 600 weight
  for card titles at 13px, page title 20px 700. Sentence case everywhere.
- Every number, URL, axis tick, label and code: JetBrains Mono, tabular figures.
- KPI value: JetBrains Mono 28-32px, weight 500, tight letter-spacing.
- Micro-labels: mono 10.5px uppercase, letter-spaced 0.06em, Muted.
- Table text: 12.5-13px; URLs in mono 12px, middle-truncated so the slug end survives.

## 4. Component Stylings
- Sidebar: 232px, Panel surface, product wordmark top, property switcher (mono domain), a
  vertical nav list with small line icons (Overview, Issues, Crawl health, Network,
  Search performance, Opportunities, Links, Research), active item = 2px green bar on the
  left + Ink text, a data-freshness block pinned at the bottom (last sync, last crawl, last
  audit, each with a small status dot).
- Top bar: page title, date-range chip in mono ("28d vs prior 28d"), theme toggle, an
  export button (outlined, 7px radius).
- KPI tile: flat Panel, 1px Hairline, 10px radius, mono micro-label, mono value, delta chip
  (green up / red down, small triangle), a 28-day sparkline in the tile's lower right.
- Card: flat Panel, 1px Hairline border, 10px radius, 16-20px padding, title 13px 600 +
  a one-line Muted description; a small mono source line ("GSC - 90d", "Crawl - 14 Oct").
- Charts: thin 1.5px lines, area fills at 8-12% opacity, hairline dashed gridlines, no chart
  borders, recessive axes, direct labels where 4 series or fewer, legend above otherwise.
  Horizontal stat bars: 8px tall, rounded, on a Panel Raised track, count + percent at the
  bar end in mono. Stacked 100% bars for status mixes.
- Network graph: force layout on the Graphite canvas, hairline edges at 30% opacity, nodes
  sized by PageRank, coloured healthy / non-indexable / broken, labels only on hubs.
- Severity: small pill chips with a coloured dot and mono count (Critical red, High amber,
  Medium blue, Low grey); used as filters. Severity spine bar: one 6px segmented bar.
- Tables: sticky mono uppercase headers, 36px rows, hairline row rules, right-aligned mono
  numerics, hover row = Panel Raised, impact shown as a thin inline bar.
- Job status row: type tag (SYNC, CRAWL, AUDIT, INSPECT) in mono, a status dot, a progress
  line or a completed timestamp, the window covered.
- Motion: tab content fades in over 180ms; nothing bounces; reduced motion = no motion.

## 5. Layout Principles
- Desktop-first at 1440: sidebar 232px + content area with 24px gutters, max content width
  ~1180px. Responsive to 375 by collapsing the sidebar into a top bar and stacking cards.
- 12-column grid; KPI strip of 4-6 tiles; charts in 8+4 or 6+6 splits; one full-width
  network or table per screen.
- Dense but breathable: 16px gaps between cards, 12px inside tiles.
- Every number shows its window; every chart a source line. Empty states are one line of
  Muted text naming the action that fills them.
