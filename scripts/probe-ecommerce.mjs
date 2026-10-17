// #55 group B, item 10: ecommerce checks (product-gone-404, merchant-listing-incomplete). Fixture DB,
// each check firing and not firing. No network.
// Run: node scripts/probe-ecommerce.mjs (after npm run build:server)
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';
import { merchantGaps } from '../dist/audit/checks-ecommerce.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const SITE = 'sc-domain:shop.test';
const W = 'https://www.shop.test';
const keyOpts = { hostForm: hostFormForProperty(SITE) };
const K = (p) => urlKey(`${W}${p}`, keyOpts);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
const runCheck = (db, id) => CHECKS.find(c => c.id === id).run({ db, gscMaxDate: gscFreshness(db).effectiveMax, brand: null });
const strip = (k) => (k ?? '').replace(/^https?:\/\/[^/]+/, '');

const offer = (o = {}) => ({ '@type': 'Offer', price: '19.99', priceCurrency: 'AUD', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition', ...o });
const product = (o = {}) => ({ '@context': 'https://schema.org', '@type': 'Product', name: 'Widget', image: 'https://www.shop.test/w.jpg', ...o });
const ld = (...nodes) => JSON.stringify(nodes.map(n => JSON.stringify(n)));

try {
  // ── 1. merchantGaps (pure) ──────────────────────────────────────────────────────────────────
  {
    const g = (p) => merchantGaps(p);
    check('merchantGaps: a complete Product + Offer has no gaps', JSON.stringify(g(product({ offers: offer() }))) === JSON.stringify({ name: 'Widget', missingRequired: [], missingRecommended: [], offers: 1 }));
    const noCond = g(product({ offers: offer({ itemCondition: undefined, availability: undefined }) }));
    check('merchantGaps: availability and itemCondition are RECOMMENDED, not required', noCond.missingRequired.length === 0 && JSON.stringify(noCond.missingRecommended) === JSON.stringify(['offers.availability', 'offers.itemCondition']), JSON.stringify(noCond));
    const spec = g(product({ offers: offer({ price: undefined, priceCurrency: undefined, priceSpecification: { '@type': 'UnitPriceSpecification', price: 10, priceCurrency: 'AUD' } }) }));
    check('merchantGaps: price/priceCurrency inside priceSpecification satisfy the requirement', spec.missingRequired.length === 0, JSON.stringify(spec));
    const agg = g(product({ offers: { '@type': 'AggregateOffer', lowPrice: 5, highPrice: 9, priceCurrency: 'AUD' } }));
    check('merchantGaps: AggregateOffer alone is a required gap for merchant listings', agg.missingRequired.length === 1 && /AggregateOffer/.test(agg.missingRequired[0]), JSON.stringify(agg));
    const two = g(product({ image: undefined, offers: [offer(), offer({ priceCurrency: '' })] }));
    check('merchantGaps: missing image and a per-offer currency, indexed when there are several offers', JSON.stringify(two.missingRequired) === JSON.stringify(['image', 'offers[1].priceCurrency']), JSON.stringify(two));
  }

  // ── 2. Fixture DB ────────────────────────────────────────────────────────────────────────────
  const dir = tmp('sac-ecom-');
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const day = (k) => new Date(Date.parse(D) - k * 86400000).toISOString().slice(0, 10);
  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    adb.upsertProperty(SITE, 'apex');
    const db = adb.db;
    for (const [id, at] of [['c1', '2026-08-01T00:00:00Z'], ['c2', '2026-09-01T00:00:00Z']])
      db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES (?, ?, 'shop.test', 'completed', ?, ?)`).run(id, `${W}/`, at, at);
    const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,indexable_reason,json_ld,fetch_state) VALUES ('c2',?,?,?,'text/html',1,?,?,?,?)`);
    const page = (p, status, jsonLd = null, { indexable = status === 200 ? 1 : 0, fetchState = null } = {}) =>
      pg.run(`${W}${p}`, K(p), status, indexable, status === 200 ? (indexable ? null : 'noindex-meta') : (status == null ? 'rate-limited' : `http-${status}`), jsonLd, fetchState);

    // product-gone-404 fixtures
    page('/products/gone-clicks', 404); page('/product/woo-gone', 410); page('/item/schema-gone', 404);
    page('/products/quiet', 404); page('/products/rl', null, null, { indexable: null, fetchState: 'rate_limited' });
    page('/products/new404', 404); page('/products/still', 200); page('/blog/article-gone', 404);
    const sn = db.prepare(`INSERT INTO page_snapshots (crawl_id,url_key,captured_at,status_code,indexable,schema_types) VALUES ('c1',?,'2026-08-01 01:00:00',?,1,?)`);
    for (const [p, types] of [['/products/gone-clicks', 'BreadcrumbList,Product'], ['/product/woo-gone', ''], ['/item/schema-gone', 'BreadcrumbList,Product'], ['/products/quiet', 'Product'], ['/products/rl', 'Product'], ['/products/still', 'Product'], ['/blog/article-gone', 'Article']])
      sn.run(K(p), 200, types);
    const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,5)`);
    for (let k = 0; k < 10; k++) sa.run(day(k), 'filler', `${W}/products/still`, K('/products/still'), 1, 10);
    sa.run(day(20), 'widget', `${W}/products/gone-clicks`, K('/products/gone-clicks'), 7, 70);
    sa.run(day(20), 'schema item', `${W}/item/schema-gone`, K('/item/schema-gone'), 0, 20);
    sa.run(day(20), 'quiet', `${W}/products/quiet`, K('/products/quiet'), 0, 3);
    sa.run(day(20), 'article', `${W}/blog/article-gone`, K('/blog/article-gone'), 2, 30);
    db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains) VALUES (?,?,3,2)`).run(K('/product/woo-gone'), `${W}/product/woo-gone`);

    // merchant-listing-incomplete fixtures
    page('/products/full', 200, ld(product({ offers: offer() })));
    page('/products/no-cond', 200, ld(product({ offers: offer({ itemCondition: undefined }) })));
    page('/products/spec', 200, ld(product({ offers: offer({ price: undefined, priceCurrency: undefined, priceSpecification: { price: 3, priceCurrency: 'AUD' } }) })));
    page('/products/agg', 200, ld(product({ offers: { '@type': 'AggregateOffer', lowPrice: 1, highPrice: 2, priceCurrency: 'AUD' } })));
    page('/products/no-img', 200, ld(product({ image: undefined, offers: offer({ priceCurrency: undefined }) })));
    page('/products/quote1', 200, ld(product()));
    page('/products/quote2', 200, ld({ '@context': 'https://schema.org', '@type': ['Product', 'Thing'], name: 'Quote only', image: 'x.jpg' }));
    page('/reviews/wheel', 200, ld(product({ review: { '@type': 'Review', author: 'R' } })));
    page('/reviews/with-offer', 200, ld(product({ offers: offer({ availability: undefined }) })));
    page('/products/graph', 200, ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'ProductGroup', name: 'Group', image: 'g.jpg', hasVariant: [product({ offers: offer() }), { '@type': 'Product', name: 'Var B', offers: offer({ price: undefined }) }] }] }));
    page('/products/noindex', 200, ld(product({ offers: offer({ itemCondition: undefined }) })), { indexable: 0 });
    page('/products/main-entity', 200, ld({ '@context': 'https://schema.org', '@type': 'ItemPage', mainEntity: product({ offers: offer({ availability: undefined }) }) }));
    adb.close();
  }

  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    const db = adb.db;
    const gone = runCheck(db, 'product-gone-404');
    check('product-gone-404: Shopify URL with clicks, WooCommerce URL with backlinks, schema-only product with impressions, ranked clicks first',
      JSON.stringify(gone.map(f => strip(f.urlKey))) === JSON.stringify(['/products/gone-clicks', '/product/woo-gone', '/item/schema-gone']), JSON.stringify(gone.map(f => strip(f.urlKey))));
    check('product-gone-404: evidence carries lost clicks, the last 200 crawl and how it was detected as a product',
      gone[0]?.evidence.lostClicks === 7 && gone[0].evidence.lastSeen200.crawlId === 'c1' && JSON.stringify(gone[0].evidence.detectedAsProductBy) === JSON.stringify(['url', 'schema']) && JSON.stringify(gone[2]?.evidence.detectedAsProductBy) === JSON.stringify(['schema']), JSON.stringify(gone[0]?.evidence));
    check('product-gone-404: no equity, rate-limited, new 404, still 200 and a non-product do not fire', !['/products/quiet', '/products/rl', '/products/new404', '/products/still', '/blog/article-gone'].some(p => gone.some(f => strip(f.urlKey) === p)));
    const ret = runCheck(db, 'redirect-retired');
    check('redirect-retired takes the non-product (/blog/article-gone) and leaves products to product-gone-404', JSON.stringify(ret.map(f => strip(f.urlKey))) === JSON.stringify(['/blog/article-gone']), JSON.stringify(ret.map(f => strip(f.urlKey))));

    const ml = runCheck(db, 'merchant-listing-incomplete');
    const site = ml.find(f => f.urlKey === null);
    check('merchant-listing-incomplete: store product pages with no offers at all roll up into ONE site-level finding (2)', site?.evidence.productPagesWithoutOffers === 2 && site.evidence.sample.length === 2 && ml.filter(f => f.urlKey === null).length === 1, JSON.stringify(site?.evidence));
    const pages = ml.filter(f => f.urlKey).map(f => strip(f.urlKey));
    check('merchant-listing-incomplete: page findings for AggregateOffer, missing image/currency, a variant missing price, missing itemCondition/availability',
      JSON.stringify([...pages].sort()) === JSON.stringify(['/products/agg', '/products/graph', '/products/main-entity', '/products/no-cond', '/products/no-img', '/reviews/with-offer']), JSON.stringify(pages));
    check('merchant-listing-incomplete: required gaps sort before recommended-only ones (site-level roll-up first)', ml[0].urlKey === null && strip(ml[1].urlKey) === '/products/no-img' && ['/products/no-cond', '/reviews/with-offer', '/products/main-entity'].includes(pages[pages.length - 1]), JSON.stringify(pages));
    const graph = ml.find(f => strip(f.urlKey) === '/products/graph');
    check('merchant-listing-incomplete: ProductGroup variant B missing price; variant inherits the group image', graph?.evidence.products.length === 1 && graph.evidence.products[0].name === 'Var B' && JSON.stringify(graph.evidence.products[0].missingRequired) === JSON.stringify(['offers.price']), JSON.stringify(graph?.evidence));
    check('merchant-listing-incomplete: complete, priceSpecification, review-only (non-store) and noindex pages do not fire', !['/products/full', '/products/spec', '/reviews/wheel', '/products/noindex'].some(p => pages.includes(p)));
    check('merchant-listing-incomplete: cites Google\'s merchant listing docs', ml.every(f => f.evidence.source === 'https://developers.google.com/search/docs/appearance/structured-data/merchant-listing'));
    adb.close();

    const core = runAudit(dir, SITE, {});
    const judged = runAudit(dir, SITE, { includeJudgement: true });
    const ids = (a) => a.byCheck.map(b => b.checkId);
    check('run_audit: product-gone-404 stored; merchant-listing-incomplete (N) only with includeJudgement', ids(core).includes('product-gone-404') && !ids(core).includes('merchant-listing-incomplete') && ids(judged).includes('merchant-listing-incomplete'), JSON.stringify([ids(core), ids(judged)]));
  }

  // ── 3. Missing data and the registry ─────────────────────────────────────────────────────────
  {
    const adb = new AuditDatabase(dbPathFor(tmp('sac-ecom-empty-'), SITE));
    check('empty property: neither check returns anything', runCheck(adb.db, 'product-gone-404').length === 0 && runCheck(adb.db, 'merchant-listing-incomplete').length === 0);
    adb.close();
    const pg = CHECKS.find(c => c.id === 'product-gone-404'), ml = CHECKS.find(c => c.id === 'merchant-listing-incomplete');
    check('registry: product-gone-404 deterministic (D+G, high); merchant-listing-incomplete N, low, certainty < 1',
      pg?.certainty === 1 && pg.labels.includes('D') && pg.severity === 'high' && ml?.labels.includes('N') && ml.severity === 'low' && ml.certainty < 1
      && CHECKS.filter(c => c.id === 'product-gone-404' || c.id === 'merchant-listing-incomplete').length === 2);
  }
} catch (e) {
  fail++;
  console.log(`FAIL  probe threw :: ${e?.stack ?? e}`);
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { console.log(`  (cleanup: ${e.code} on ${d})`); } }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
