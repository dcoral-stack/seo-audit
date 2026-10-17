// Title and meta-description length limits: ONE place, read by the audit checks (title-too-long,
// meta-description-length) and the dashboard's Crawl overview bars, so the two never count
// different pages (they did: Crawl health counted meta descriptions over 155 characters, the audit
// over 160). Character counts are a proxy for Google's pixel-width truncation, not a rule Google
// publishes; the UI says which limit it applies.
export const TITLE_MAX_CHARS = 60;
export const TITLE_MIN_CHARS = 30;
export const META_DESC_MAX_CHARS = 160;
export const META_DESC_MIN_CHARS = 70;
