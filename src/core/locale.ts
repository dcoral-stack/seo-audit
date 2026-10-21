/**
 * SEOCoral fork: market defaults. Upstream defaulted every DataForSEO call to the United States
 * (location 2840) in English, Google News to en-US and Wikidata labels to English. This fork
 * defaults to Spain / Spanish; any tool call can still pass its own location and languageCode.
 *
 *   SAC_DEFAULT_LOCATION  DataForSEO location code or name (default 2724 = Spain; e.g. 2484 Mexico)
 *   SAC_DEFAULT_LANGUAGE  ISO language code (default "es"; "ca" for Catalan, "en" for English)
 *   SAC_DEFAULT_COUNTRY   ISO country for Google News (default "ES")
 */
const env = (k: string): string => (process.env[k] ?? '').trim();

const locRaw = env('SAC_DEFAULT_LOCATION');
export const DEFAULT_LOCATION: number | string = !locRaw ? 2724 : /^\d+$/.test(locRaw) ? Number(locRaw) : locRaw;
export const DEFAULT_LANGUAGE: string = env('SAC_DEFAULT_LANGUAGE') || 'es';
export const DEFAULT_COUNTRY: string = (env('SAC_DEFAULT_COUNTRY') || 'ES').toUpperCase();

/** Human-readable default market, for tool descriptions. */
export const DEFAULT_MARKET_LABEL: string = locRaw ? `${locRaw} (${DEFAULT_LANGUAGE})` : `Spain (2724), Spanish`;
