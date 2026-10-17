# Majestic functions

DataForSEO's own link data sorts on **domain rank**, a link-*volume* metric — so directories, aggregators and syndicated-press domains float straight to the top. Technically authoritative, worthless to pitch. [Majestic](https://majestic.com) fixes that: it re-sorts link prospects by **editorial authority** instead of link count.

Majestic is **optional** and **separate** from DataForSEO. It enriches two tools — [`link_intersect`](dataforseo.md#link_intersect), where it re-sorts the prospect list, and [`pull_backlinks`](dataforseo.md#pull_backlinks), where it scores your own backlinked pages — and everything else works without it. Set `MAJESTIC_API_KEY` to switch it on.

## What it adds

### Trust Flow (0–100)
Editorial authority, propagated from a seed set of trusted sites. It measures who *vouches* for a domain rather than how many links it has managed to accumulate — the directory killer. In testing, a domain DataForSEO ranked **#227** came back **Trust Flow 0**; a volume metric simply can't see that.

### Topical Trust Flow
The same authority, broken down by topic — so you can see whether a domain's authority is in *your* niche or somewhere else entirely. The tool shows each prospect's leading topic beside its Trust Flow; it doesn't sort on it, so that relevance call stays yours.

## How it's used

`link_intersect` builds the prospect list from DataForSEO's `domain_intersection` (your competitors' links, minus yours). Then, **if `MAJESTIC_API_KEY` is set**, it calls Majestic's `GetIndexItemInfo` on the strongest prospects - the top `enrichLimit` by DataForSEO domain trust (default 100, max 500, batched 100 per call at roughly a unit each) - and **re-sorts by Trust Flow**, still followed links first. Nothing is filtered out on Majestic's numbers; the directories just sink, and if more prospects qualified than were enriched the response says so.

`pull_backlinks` uses the same call on your own site: with the key set, your most-backlinked pages (up to 500 per pull) get Trust Flow, Citation Flow and Topical Trust Flow. That's what the dashboard's **Trapped authority** report sorts on - pages the web trusts that sit buried in your architecture.

Without the key, `link_intersect` still runs and still sorts followed-first by DataForSEO domain trust — Majestic just sharpens the priority order so you email the right prospect first.

- Endpoint: `https://api.majestic.com/api/json` (`cmd=GetIndexItemInfo`)
- Host override: `MAJESTIC_API_HOST` (defaults to the live API host, `api.majestic.com`)
- Cache: every response is kept in `majestic-cache.db` for `MAJESTIC_CACHE_DAYS` (default 30), and a cache hit costs no units
- **Privacy:** Majestic receives the prospect **domain names** from `link_intersect` and your backlinked page URLs from `pull_backlinks` — nothing else about your site.

## Setup

Grab a key from Majestic's [plans and pricing](https://majestic.com/plans-pricing) (the tier that exposes Trust Flow), then add `MAJESTIC_API_KEY` to your env — see [getting-started](getting-started.md#environment-variables). The full link-intersect workflow is in [competitive.md](competitive.md#link-intersect-link_intersect).

---
*Trust Flow and Topical Trust Flow are trademarks of Majestic (Majestic-12 Ltd).*
