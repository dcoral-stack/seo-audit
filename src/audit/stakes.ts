/**
 * The share of a page's clicks a page-experience finding (one asset or element of the page) can
 * plausibly move. Lives in its own module so the check files and engine.ts can both import it without
 * a cycle; the reasoning is in engine.ts (stakeShareOf) and manual/checks.md ("How priority works").
 */
export const PAGE_EXPERIENCE_STAKE_SHARE = 0.1;
