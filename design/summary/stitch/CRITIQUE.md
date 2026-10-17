# Stitch round: site summary

**What this is:** design intent only. No copy or number from Stitch reaches the product, and every figure in these screens is a `[figure]` placeholder.

**Setup**
- Project `3979271944933978503` and design system `d173f3cd7ac9421bb32e6272a6da6ff5`. Both are the same as the PR #41 Overview round, and reuse worked, so the screen inherits that visual language.
- Light theme, 1440, DESKTOP, `GEMINI_3_8_FLASH`.
- Prompts: `summary-r1.txt` (the full brief, built from the panel list in `../SUMMARY-PAGE.md`) and `summary-r2.txt` (the corrections).
- Raw output (HTML, API JSON) stays in the ignored `out/`.

**Runner**
- `visualysed/tools/stitch/run.mjs` was copied to a temp folder and patched there; visualysed itself is untouched.
- Fix (a), the `{id, sourceScreen}`-only design-system instance, was applied but not exercised, because the run reused the existing project.
- Fix (b): the screenshot URL is an `lh3.googleusercontent.com` image. It comes back as a raw 331×512 **thumbnail** unless you append a size parameter (`=w1440`, or `=s0` for the full 2560 px). The committed PNGs use `=w1440`. Fold this into the runner when it's next fixed upstream.

| Screen | File |
|---|---|
| Round 1 | `screens/stitch-summary-r1-light-1440.png` |
| Round 2 (the reference) | `screens/stitch-summary-r2-light-1440.png` |

## Keep

- **The top-to-bottom order answers the five questions in sequence:** freshness, verdict, tiles, better/worse, broken + do-first, change / mix / winners, AI, coverage. It reads well cold. This is the main thing Stitch confirms.
- **A verdict sentence with the numbers emphasised by weight** (r2). This is the strongest single idea on the page. Keep its chips, but colour them by direction only.
- **Monthly bars with a dashed same-month-last-year ghost line** and a **hollow "partial" current month** (r2). This is the right honest treatment for an incomplete month.
- **Health step line plus opened-vs-resolved paired bars per audit,** with the "only audits with the same check set are compared" note (r2). The paired bars are exactly the `auditDeltas` payload.
- **The two-column "What is broken" / "Do this first" split.** The do-first rows carry pages, clicks at risk, a size chip, a D/N chip and an impact bar: the traceability chain, visible.
- **The AI search card in three parts,** with an explicit muted **"Answer share in chat assistants: not measured"** slot. Stitch kept the honesty slot in both rounds without arguing.
- **The data coverage footer,** with greyed "not collected" chips for field CWV and server logs.
- **The sidebar shows "System: read-only" instead of a refresh button** (r2). That's the right posture: the dashboard reads data, it doesn't start jobs.

## Reject or fix in the build

- **Bot grouping error (r2):** GPTBot is listed under "search and citation bots". It's OpenAI's *training* crawler; OAI-SearchBot and ChatGPT-User are the search ones. This is exactly why the grouping must come from one maintained constant, not from the design.
- **The severity chips in "What is broken" overflow and collide** with the since-last-audit column (`C:[figure]` / `H:[figure]` overprint) in both rounds. Use fixed-width mono count chips with numbers only and a column header legend.
- **The KPI tiles' sparklines disagree with their own data.** The "Indexation coverage" tile draws a sparkline from a single point-in-time sample; drop it there. The AI-readiness "▲ +[figure] pts" delta has no history behind it: `agent_readiness` holds one row per origin, so no delta until history exists.
- **The "Good" / "Pass" badges on the tiles** sit there unexplained. The health band is a product convention and has to sit with its definition ("share of crawled pages with no critical or high issue"). "Pass" on indexation means nothing: drop it.
- **The freshness band** still truncates (`[figure]d win…`, `Ruleset v[fig…`) at 1440. Put a single short line per source; detail goes in a tooltip.
- **Event markers** stayed as dots on the x-axis labels (r2), which is better than r1's dots on the bars. Keep them as ticks under the axis, separate from the labels.
- **Invented chrome:** "Audit log" and "Robots.txt audit: Live" badges, "Highest-impact remediation queue" captions, and "Delta across [figure] crawled URLs" sub-lines. None of these match a payload field. Cut them; card captions follow the copy rules, not Stitch.
- **Red used decoratively:** the impact bars of the top actions are red by rank, not by severity. Colour them by the finding's severity token.
- **Light-theme only.** The dark-theme variant wasn't requested this round; the PR #41 dark tokens will apply unchanged.

**Verdict:** use r2 as the layout reference for slice 3 of `SUMMARY-PAGE.md`, with the fixes above. No third round is needed: the remaining problems are data-binding and copy decisions, not layout.
