/**
 * #55 summary slice 4, group B, item 10: ecommerce.
 *   - product-gone-404              a store product that answered 200 in an earlier crawl and now answers 404/410
 *   - merchant-listing-incomplete   Product markup missing what Google's merchant listings need (judgement, low)
 *
 * Same contract as checks.ts: a pure read over stored rows, thresholds stated, missing data = no finding.
 */
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { goneSinceEarlierCrawl, equityLookup, equityWeight, EQUITY_RULE, PRODUCT_PATH, type Equity } from './checks-redirects.js';
import { parseJsonLdNodes } from './templates.js';
import { HTML_CT } from '../core/sql.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);

// ── product-gone-404 ─────────────────────────────────────────────────────────────────────────
/**
 * Store products (Shopify /products/, WooCommerce /product/, or Product/ProductGroup in the earlier
 * snapshot's JSON-LD) that went from 200 to 404/410 between crawls, with equity (the redirect checks'
 * rule: GSC clicks/impressions, a backlink or an internal link). Ranked by the clicks the URL earned
 * over the GSC history held. A discontinued product with no equity returning 404 is correct, so it is
 * not reported.
 */
function productGone404(c: CheckContext): RawFinding[] {
  const equity = equityLookup(c);
  const out: RawFinding[] = [];
  for (const g of goneSinceEarlierCrawl(c)) {
    if (!g.isProduct) continue;
    const eq = equity(g.urlKey);
    if (!eq.hasEquity) continue;
    out.push({ urlKey: g.urlKey, evidence: {
      url: g.url, status: g.status, lastSeen200: g.lastLive, detectedAsProductBy: g.productBy,
      lostClicks: eq.gsc?.clicks ?? null, lostImpressions: eq.gsc?.impressions ?? null, equity: eq, rule: EQUITY_RULE,
      note: `a product page that answered 200 in the earlier crawl now answers ${g.status}: its rankings, links and any shopping visibility went with it`,
    } });
  }
  return out.sort((a, b) => equityWeight(b.evidence.equity as Equity) - equityWeight(a.evidence.equity as Equity));
}

// ── merchant-listing-incomplete ──────────────────────────────────────────────────────────────
/** Google, "Merchant listing (Product, Offer) structured data". */
export const MERCHANT_DOCS = 'https://developers.google.com/search/docs/appearance/structured-data/merchant-listing';

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const typesOf = (n: any): string[] => asArray(n?.['@type']).map(String);

/** Product nodes on a page: top-level / @graph nodes, a WebPage's mainEntity, and a ProductGroup's variants. */
function productNodes(jsonLd: string | null): any[] {
  const out: any[] = [];
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    const t = typesOf(n);
    if (t.includes('Product')) out.push(n);
    if (t.includes('ProductGroup')) for (const v of asArray(n.hasVariant)) if (typesOf(v).includes('Product')) out.push({ ...v, image: v.image ?? n.image, name: v.name ?? n.name });
    for (const m of asArray(n.mainEntity)) if (m && typeof m === 'object') visit(m);
  };
  for (const n of parseJsonLdNodes(jsonLd)) visit(n);
  return out;
}

export interface MerchantGap { name: string | null; missingRequired: string[]; missingRecommended: string[]; offers: number }

/**
 * What one Product node lacks for a merchant listing, per Google's documentation:
 *   required    - Product.name, Product.image, Product.offers as an Offer (AggregateOffer is accepted by
 *                 product snippets, not merchant listings); Offer.price or priceSpecification.price;
 *                 Offer.priceCurrency or priceSpecification.priceCurrency.
 *   recommended - Offer.availability, Offer.itemCondition (both checked only where there is an Offer).
 * Other recommended properties (shippingDetails, hasMerchantReturnPolicy, GTIN...) are not checked here.
 */
export function merchantGaps(product: any): MerchantGap {
  const req: string[] = [], rec: string[] = [];
  if (!present(product.name)) req.push('name');
  if (!present(product.image)) req.push('image');
  const offers = asArray(product.offers).filter(o => o && typeof o === 'object');
  const plain = offers.filter(o => !typesOf(o).includes('AggregateOffer'));
  if (!offers.length) req.push('offers');
  else if (!plain.length) req.push('offers (an Offer: AggregateOffer alone is not accepted for merchant listings)');
  for (const [i, o] of plain.entries()) {
    const at = plain.length > 1 ? `offers[${i}].` : 'offers.';
    const spec = asArray(o.priceSpecification);
    if (!present(o.price) && !spec.some(s => present(s?.price))) req.push(`${at}price`);
    if (!present(o.priceCurrency) && !spec.some(s => present(s?.priceCurrency))) req.push(`${at}priceCurrency`);
    if (!present(o.availability)) rec.push(`${at}availability`);
    if (!present(o.itemCondition)) rec.push(`${at}itemCondition`);
  }
  return { name: typeof product.name === 'string' ? product.name : null, missingRequired: req, missingRecommended: rec, offers: offers.length };
}

/** How many example URLs the site-level "no offers at all" finding lists. */
export const NO_OFFERS_SAMPLE = 10;

function merchantListingIncomplete(c: CheckContext): RawFinding[] {
  const out: RawFinding[] = [];
  const noOffers: string[] = [];
  for (const r of rows(c, `SELECT url_key urlKey, url, json_ld jsonLd FROM pages
      WHERE status_code=200 AND indexable=1 AND ${HTML_CT} AND json_ld LIKE '%Product%'`)) {
    const products = productNodes(r.jsonLd);
    if (!products.length) continue;
    const storeUrl = PRODUCT_PATH.test(r.url ?? r.urlKey);
    const anyOffers = products.some(p => asArray(p.offers).length);
    if (!anyOffers) {
      // No offers anywhere: either the template drops them (a real gap, fixed once) or the product is
      // quote-only and is not a merchant listing at all. The stored data can't tell which, so these
      // roll up into one site-level finding instead of one per page. A non-store URL with no offers is
      // a review/product-snippet page: merchant listings don't apply.
      if (storeUrl) noOffers.push(r.url ?? r.urlKey);
      continue;
    }
    const gaps = products.filter(p => asArray(p.offers).length).map(merchantGaps).filter(g => g.missingRequired.length || g.missingRecommended.length);
    if (!gaps.length) continue;
    out.push({ urlKey: r.urlKey, evidence: {
      products: gaps.slice(0, 5), productNodes: products.length,
      detectedAsMerchantBy: storeUrl ? 'store product URL with an Offer' : 'Product with an Offer',
      source: MERCHANT_DOCS,
      note: 'Judgement: assumes this page sells the product online; a Merchant Center feed can also supply offer data. Required/recommended per the merchant listing documentation (source).',
    } });
  }
  // Pages missing required fields first (they can't appear as merchant listings at all).
  const req = (f: RawFinding): number => (f.evidence.products as MerchantGap[]).reduce((n, g) => n + g.missingRequired.length, 0);
  out.sort((a, b) => req(b) - req(a));
  if (noOffers.length) {
    out.unshift({ urlKey: null, evidence: {
      productPagesWithoutOffers: noOffers.length, sample: noOffers.slice(0, NO_OFFERS_SAMPLE), missingRequired: ['offers'],
      source: MERCHANT_DOCS,
      note: 'Store product pages whose Product markup has no offers at all, so none can show as a merchant listing. If these products show a price and can be bought online, the product template drops the Offer (one fix). If they are quote-only (no price on the page), they are not merchant listings and this can be ignored. The crawl does not store the on-page price, so this is judgement.',
    } });
  }
  return out;
}

export const ECOMMERCE_CHECKS: CheckDef[] = [
  {
    id: 'product-gone-404', category: 'indexation', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Product page removed (200 then 404/410)',
    fix: 'A product URL that answered 200 in an earlier crawl now answers 404/410, and it had search clicks, impressions or links. If the product is replaced, 301 it to the replacement (or the closest variant). If it is only out of stock, keep the page live at 200 and mark it OutOfStock. If it is discontinued but still earns traffic, keep it live with the alternatives, or 301 it to the parent category. Ranked by the clicks the URL earned. Needs two crawls on different dates.',
    run: productGone404,
  },
  {
    id: 'merchant-listing-incomplete', category: 'schema', severity: 'low', labels: ['N'], certainty: 0.5, effortBase: 3, fixType: 'per-page',
    title: 'Product markup incomplete for merchant listings',
    fix: 'Product structured data on this store page is missing fields Google\'s merchant listings use. Required: image, an Offer (not only an AggregateOffer) with price and priceCurrency (directly or in priceSpecification). Recommended: availability and itemCondition on each Offer. Fix it once in the product template. Judgement: if the page shows no price (quote-only), it cannot be a merchant listing and this finding can be ignored.',
    run: merchantListingIncomplete,
  },
];
