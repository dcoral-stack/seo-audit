#!/usr/bin/env node
// Copyright (c) 2026 Richard Baxter / Houtini — Apache-2.0 (see LICENSE)
//
// Demo property generator — builds a fully populated, entirely FICTIONAL property database for
// screenshots and demos, so the docs never show a real client's data.
//
//   The company:  "Larchmere Outfitters", an invented UK outdoor-gear retailer.
//   The domain:   larchmere.example (RFC 2606 reserved TLD — it can never resolve to a real site).
//   The property: sc-domain:larchmere.example
//
// What is synthetic and what is genuine:
//   - The SITE is synthetic: ~300 HTML pages (homepage, collections, products, buying guides,
//     brands, info pages) with deliberate, realistic defects, served from an in-process HTTP server.
//   - The CRAWL is genuine: the real Crawler fetches that site (its undici connections are routed
//     to the in-process server), so pages / links / redirects / sitemap / images / the link graph
//     are the crawler's own output.
//   - The GSC history is synthetic: ~120 days of segmented (device x country) rows with seasonality,
//     a growth trend, decay, cannibalisation and striking-distance stories.
//   - Agent readiness is genuine (the real probe, run against the in-process server). Passage
//     scores are genuine when the local cross-encoder is cached (skip with --no-ml).
//   - DataForSEO / Google-only enrichments (URL inspection, backlinks, link prospects, rank
//     history, CWV, keyword intent) are synthetic but derived from the crawl so they agree with it.
//   - The AUDIT is genuine: runAudit runs every check over the result.
//
// Run:  npm run build && npm run demo:property -- [--out <dir>] [--end YYYY-MM-DD] [--no-ml]
// Then: SAC_DATA_DIR=<dir> node dist/dashboard.js   (or scripts/demo-screenshots.mjs)
// Never commit the generated .db (*.db is gitignored).
import { createRequire } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

// ── CLI ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = path.resolve(arg('--out') ?? path.join(os.tmpdir(), 'sac-demo'));
const DAY = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const END = arg('--end') ?? isoDate(Date.now() - 2 * DAY);
const NO_ML = argv.includes('--no-ml');
const DAYS = 120;
const VOL_SCALE = 0.55; // overall demand: ~40k clicks per 28 days

const SITE = 'sc-domain:larchmere.example';
const HOST = 'larchmere.example';
const ORIGIN = `https://${HOST}`;
const STORE = 'Larchmere Outfitters';

// ── Deterministic randomness ─────────────────────────────────────────────────
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(20261015);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (xs) => xs[Math.floor(rng() * xs.length)];
const gauss = () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const poisson = (lambda) => {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + gauss() * Math.sqrt(lambda)));
  const L = Math.exp(-lambda); let n = 0, p = 1;
  do { n++; p *= rng(); } while (p > L);
  return n - 1;
};
const binom = (n, p) => {
  if (n <= 0 || p <= 0) return 0;
  if (n > 40) return Math.max(0, Math.min(n, Math.round(n * p + gauss() * Math.sqrt(n * p * (1 - p)))));
  let c = 0; for (let i = 0; i < n; i++) if (rng() < p) c++; return c;
};
const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── The catalogue (all names invented) ───────────────────────────────────────
const BRANDS = [
  { slug: 'larchmere', name: 'Larchmere' }, { slug: 'fellwick', name: 'Fellwick' }, { slug: 'tarnmoor', name: 'Tarnmoor' },
  { slug: 'kestrelbank', name: 'Kestrelbank' }, { slug: 'scarrow', name: 'Scarrow' }, { slug: 'hollin-and-pike', name: 'Hollin & Pike' },
  { slug: 'ashgill-works', name: 'Ashgill Works' }, { slug: 'brindlecrag', name: 'Brindlecrag' }, { slug: 'sowerby-hart', name: 'Sowerby Hart' },
];

// season: 'summer' fades into autumn, 'winter' builds into autumn, 'flat' holds.
// queries: [query, base daily impressions, base position]
const CATS = [
  { slug: 'tents', name: 'Tents', type: 'Tent', thing: 'a tent', season: 'summer', price: [89, 649],
    models: ['Ridge 2', 'Ridge 3', 'Corrie 1', 'Corrie 2', 'Bothy 4', 'Skyline 2 UL', 'Tarn 3', 'Hollow 2', 'Wayfarer 6', 'Summit 2', 'Meadow 4', 'Gill 1', 'Ridge 2 UL', 'Moorside 5'],
    queries: [['tents', 1500, 8.5], ['2 person tent', 900, 12.5], ['backpacking tent', 520, 14.5], ['lightweight tent', 380, 11.5], ['tents uk', 260, 6.4], ['family tents', 480, 16.5]] },
  { slug: 'sleeping-bags', name: 'Sleeping Bags', type: 'Sleeping Bag', thing: 'a sleeping bag', season: 'summer', price: [45, 420],
    models: ['Ember 0', 'Ember -5', 'Drift 5', 'Down 700', 'Coldsnap -10', 'Featherlite 3', 'Hearth 2', 'Down 900', 'Drift 10', 'Nightjar 1'],
    queries: [['sleeping bags', 1100, 9.2], ['3 season sleeping bag', 420, 13.5], ['down sleeping bag', 360, 11.2], ['lightweight sleeping bag', 300, 15.5]] },
  { slug: 'backpacks', name: 'Rucksacks', type: 'Rucksack', thing: 'a rucksack', season: 'flat', price: [39, 289],
    models: ['Traverse 45', 'Traverse 65', 'Daypack 22', 'Ascent 35', 'Pathfinder 55', 'Daypack 30', 'Ascent 28', 'Expedition 80', 'Fastpack 18', 'Traverse 55'],
    queries: [['rucksacks', 800, 10.5], ['hiking backpack', 650, 13.8], ['65l rucksack', 240, 7.5], ['day pack', 330, 17.2]] },
  { slug: 'hiking-boots', name: 'Walking Boots', type: 'Walking Boots', thing: 'walking boots', season: 'flat', price: [69, 259],
    models: ['Ridgewalker GTX', 'Scree Mid', 'Fellrunner Low', 'Highland Leather', 'Scree Mid WP', 'Packhorse', 'Ridgewalker Lite', 'Drover Leather', 'Tor Mid', 'Fellrunner Mid'],
    queries: [['walking boots', 1700, 11.5], ['mens walking boots', 900, 9.4], ['womens walking boots', 820, 10.2], ['waterproof walking boots', 520, 12.8], ['leather walking boots', 260, 8.6]] },
  { slug: 'waterproof-jackets', name: 'Waterproof Jackets', type: 'Waterproof Jacket', thing: 'a waterproof jacket', season: 'winter', price: [59, 389],
    models: ['Squall 3L', 'Downpour 2.5L', 'Storm Shell', 'Cloudburst', 'Squall 3L Pro', 'Drizzle Packable', 'Gale Insulated', 'Storm Shell Womens', 'Cloudburst Womens', 'Downpour Womens', 'Tempest 3L', 'Showerproof Smock'],
    queries: [['waterproof jackets', 1600, 10.8], ['mens waterproof jacket', 1100, 12.2], ['womens waterproof jacket', 1000, 11.6], ['lightweight waterproof jacket', 450, 13.2], ['packable waterproof jacket', 260, 8.2]] },
  { slug: 'camping-stoves', name: 'Camping Stoves', type: 'Camping Stove', thing: 'a camping stove', season: 'summer', price: [24, 189],
    models: ['Kettle Burner', 'Flame Mini', 'Twin Hob', 'Jetstream 1L', 'Flame Mini Piezo', 'Meths Classic'],
    queries: [['camping stove', 620, 9.8], ['gas camping stove', 300, 12.5], ['backpacking stove', 210, 15.2]] },
  { slug: 'trekking-poles', name: 'Trekking Poles', type: 'Trekking Poles', thing: 'trekking poles', season: 'flat', price: [29, 149],
    models: ['Carbon Z', 'Alloy Trek', 'Compact 3', 'Carbon Fold', 'Alloy Trek Womens'],
    queries: [['trekking poles', 420, 8.2], ['walking poles', 520, 11.4], ['folding trekking poles', 120, 7.4]] },
  { slug: 'head-torches', name: 'Head Torches', type: 'Head Torch', thing: 'a head torch', season: 'winter', price: [15, 119],
    models: ['Beam 400', 'Beam 900 R', 'Glow 200', 'Beam 600 R', 'Glow 120 Kids'],
    queries: [['head torch', 900, 9.6], ['rechargeable head torch', 420, 12.2], ['best head torch for running', 140, 15.8]] },
  { slug: 'base-layers', name: 'Base Layers', type: 'Base Layer', thing: 'a base layer', season: 'winter', price: [19, 109],
    models: ['Merino 200 Crew', 'Merino 150 Tee', 'Thermal Zip', 'Synthetic Crew', 'Merino 260 Leggings', 'Merino 200 Crew Womens', 'Thermal Leggings', 'Merino 150 Tee Womens'],
    queries: [['base layers', 560, 11.2], ['merino base layer', 520, 13.4], ['thermal base layer', 420, 9.2], ['womens base layer', 210, 12.8]] },
  { slug: 'camp-cookware', name: 'Camp Cookware', type: 'Cook Set', thing: 'camp cookware', season: 'summer', price: [9, 99],
    models: ['Titanium Pot 750', 'Nesting Set 2P', 'Spork Ti', 'Kettle 1L', 'Nesting Set 4P', 'Mug 450'],
    queries: [['camping cookware', 260, 12.4], ['titanium pot', 140, 9.2], ['camping kettle', 210, 14.6]] },
];
const COLOURS = ['green', 'navy', 'red', 'grey', 'black'];

// Buying guides: [slug, title, category, queries, extra]
const GUIDES = [
  ['how-to-choose-a-tent', 'How to choose a tent: size, seasons and weight', 'tents', [['how to choose a tent', 260, 6.2], ['what size tent do i need', 210, 4.4], ['tent buying guide', 90, 7.1]]],
  ['best-2-person-tents', 'The best 2 person tents, tested on the fells', 'tents', [['best 2 person tent', 700, 5.5], ['best two man tent', 380, 7.4], ['2 person tent', 260, 9.8]], { decay: true }],
  ['best-family-tents', 'Best family tents for UK campsites', 'tents', [['best family tent', 520, 8.6], ['6 person tent', 280, 13.4]]],
  ['tent-footprint-do-you-need-one', 'Do you need a tent footprint?', 'tents', [['do i need a tent footprint', 160, 3.2], ['tent footprint', 240, 11.6]]],
  ['how-to-pitch-a-tent-in-wind', 'How to pitch a tent in strong wind', 'tents', [['pitching a tent in wind', 110, 4.6], ['how to pitch a tent', 300, 14.2]], { deep: true }],
  ['sleeping-bag-temperature-ratings-explained', 'Sleeping bag temperature ratings explained', 'sleeping-bags', [['sleeping bag temperature rating', 380, 3.4], ['comfort vs limit rating', 90, 2.6], ['sleeping bag season rating', 160, 5.2]]],
  ['down-vs-synthetic-sleeping-bags', 'Down vs synthetic sleeping bags', 'sleeping-bags', [['down vs synthetic sleeping bag', 240, 4.2], ['synthetic sleeping bag', 180, 12.4]]],
  ['how-to-wash-a-down-sleeping-bag', 'How to wash a down sleeping bag', 'sleeping-bags', [['how to wash a down sleeping bag', 170, 5.8]], { deep: true }],
  ['how-to-pack-a-rucksack', 'How to pack a rucksack for a multi-day walk', 'backpacks', [['how to pack a rucksack', 290, 3.6], ['how to pack a backpack for hiking', 210, 6.8]]],
  ['best-hiking-backpacks', 'The best hiking backpacks for day walks and long trails', 'backpacks', [['best hiking backpack', 420, 9.4], ['best day pack', 260, 12.6]]],
  ['how-to-choose-walking-boots', 'How to choose walking boots that fit', 'hiking-boots', [['how to choose walking boots', 220, 4.8], ['walking boots buying guide', 120, 6.2], ['walking boots', 420, 13.6]]],
  ['how-to-break-in-walking-boots', 'How to break in walking boots', 'hiking-boots', [['how to break in walking boots', 330, 2.4], ['breaking in walking boots', 140, 3.1]]],
  ['waterproof-ratings-explained', 'Waterproof ratings explained: what 10,000mm really means', 'waterproof-jackets', [['waterproof rating explained', 280, 3.8], ['hydrostatic head', 260, 6.4], ['what does 10000mm waterproof mean', 190, 2.2]]],
  ['how-to-reproof-a-waterproof-jacket', 'How to reproof a waterproof jacket', 'waterproof-jackets', [['how to reproof a waterproof jacket', 360, 3.2], ['reproof jacket', 210, 4.8]], { deep: true }],
  ['best-waterproof-jackets', 'The best waterproof jackets for UK hills', 'waterproof-jackets', [['best waterproof jacket', 1300, 5.2], ['best waterproof jacket uk', 520, 6.1], ['best lightweight waterproof jacket', 300, 8.4], ['waterproof jackets', 300, 12.2]], { lowCtr: true }],
  ['layering-for-hiking', 'Layering for hiking: base, mid and shell', 'base-layers', [['layering for hiking', 210, 5.2], ['base layer mid layer outer layer', 140, 4.1]]],
  ['merino-vs-synthetic-base-layers', 'Merino vs synthetic base layers', 'base-layers', [['merino vs synthetic base layer', 190, 3.6], ['is merino worth it', 80, 6.8]]],
  ['wild-camping-uk-guide', 'Wild camping in the UK: where it is allowed and how to do it well', 'tents', [['wild camping uk', 680, 6.4], ['where can you wild camp', 380, 8.8], ['wild camping scotland', 420, 11.6]], { deep: true, authority: true }],
  ['camping-checklist', 'The camping checklist we actually use', 'tents', [['camping checklist', 560, 4.4], ['camping essentials list', 300, 7.2]]],
  ['best-camping-stoves', 'Best camping stoves: gas, meths and multi-fuel', 'camping-stoves', [['best camping stove', 380, 7.8], ['gas vs meths stove', 90, 3.8]]],
  ['how-to-use-trekking-poles', 'How to use trekking poles properly', 'trekking-poles', [['how to use trekking poles', 260, 3.4], ['trekking pole length', 170, 5.6]]],
  ['best-head-torches', 'The best head torches for walking, running and camping', 'head-torches', [['best head torch', 520, 8.2], ['head torch lumens', 110, 4.6]]],
  ['winter-camping-tips', 'Winter camping tips for UK conditions', 'sleeping-bags', [['winter camping tips', 240, 6.6], ['camping in winter uk', 180, 9.2]], { deep: true }],
  ['three-peaks-challenge-kit-list', 'Three Peaks Challenge kit list', 'backpacks', [['three peaks challenge kit list', 210, 3.2], ['three peaks challenge', 900, 18.5]], { deep: true, authority: true }],
  ['what-to-wear-hiking-in-autumn', 'What to wear hiking in autumn', 'waterproof-jackets', [['what to wear hiking in autumn', 150, 4.2], ['autumn hiking outfit', 90, 6.4]], { fresh: true }],
  ['what-is-a-bothy', 'What is a bothy? A beginner\'s guide', 'tents', [['what is a bothy', 330, 4.8], ['bothies scotland', 210, 9.6]], { deep: true, authority: true }],
  ['hiking-for-beginners', 'Hiking for beginners: your first ten walks', 'hiking-boots', [['hiking for beginners', 300, 7.6], ['beginner walking routes', 140, 12.4]]],
  ['leave-no-trace', 'Leave No Trace: the seven principles in practice', 'tents', [['leave no trace principles', 160, 5.4]], { deep: true }],
  ['camping-food-ideas', 'Easy camping food ideas', 'camp-cookware', [['camping food ideas', 380, 9.2], ['easy camping meals', 260, 11.6]]],
  ['choosing-a-sleeping-mat', 'Choosing a sleeping mat: R-values explained', 'sleeping-bags', [['sleeping mat r value', 140, 4.4], ['best sleeping mat', 420, 21.5]], { fresh: true, orphan: true }],
  ['night-hiking-safety', 'Night hiking safety', 'head-torches', [['night hiking tips', 90, 6.2]], { fresh: true, orphan: true }],
];

// Search demand with no page that targets it: served incidentally, far down (topic-cluster gaps).
const GAP_QUERIES = [
  ['inflatable sleeping mat', 280, 27, 'guides/choosing-a-sleeping-mat'], ['self inflating sleeping mat', 160, 31, 'guides/choosing-a-sleeping-mat'],
  ['bivvy bag', 340, 24, 'guides/wild-camping-uk-guide'], ['bivvy bag uk', 120, 29, 'guides/wild-camping-uk-guide'],
  ['hammock camping', 260, 33, 'guides/wild-camping-uk-guide'], ['walking gaiters', 190, 26, 'collections/hiking-boots'],
  ['insulated jacket', 600, 23.5, 'collections/waterproof-jackets'], ['down jacket', 900, 34, 'collections/waterproof-jackets'],
  ['fleece jacket', 700, 28, 'collections/base-layers'], ['walking socks', 420, 25, 'collections/hiking-boots'],
];

const INFO = [
  ['about', 'About Larchmere Outfitters'], ['contact', 'Contact us'], ['delivery', 'Delivery information'], ['returns', 'Returns and refunds'],
  ['size-guide', 'Size guide'], ['stores', 'Our stores'], ['gift-cards', 'Gift cards'], ['privacy', 'Privacy policy'], ['terms', 'Terms and conditions'],
  ['careers', 'Careers'], ['sale', 'Outdoor gear sale'],
];
const BRANDED = [
  ['larchmere', 900, 1.1, ''], ['larchmere outfitters', 640, 1.0, ''], ['larchmere discount code', 160, 1.6, 'gift-cards'],
  ['larchmere returns', 90, 1.2, 'returns'], ['larchmere stores', 110, 1.3, 'stores'], ['larchmere delivery', 60, 1.4, 'delivery'],
  ['larchmere tents', 120, 1.4, 'collections/tents'], ['larchmere sale', 140, 1.8, 'sale'], ['larchmere jackets', 90, 1.6, 'collections/waterproof-jackets'],
];

// ── Build the site model ─────────────────────────────────────────────────────
const pages = new Map();      // path(+query) -> page
const redirects = new Map();  // path -> { status, to }
const gone = new Set();       // paths that 404
const images = new Map();     // /cdn/img/x.jpg -> bytes
const products = [];
const productsByCat = new Map();

const img = (name, kb) => { const p = `/cdn/img/${name}.jpg`; if (!images.has(p)) images.set(p, Math.round(kb * 1024)); return p; };

CATS.forEach((c, ci) => {
  const list = [];
  // Each model ships from two brands (a standard and a Lite/Pro version). Sowerby Hart has no
  // products at all (a thin brand page).
  const variants = c.models.flatMap((model, mi) => [
    [BRANDS[(mi * 2 + ci) % (BRANDS.length - 1)], model],
    [BRANDS[(mi * 2 + ci + 3) % (BRANDS.length - 1)], `${model} ${mi % 2 ? 'Pro' : 'Lite'}`],
  ]);
  variants.forEach(([brand, model], mi) => {
    const name = `${brand.name} ${model} ${c.type}`;
    const slug = slugify(`${brand.slug} ${model} ${c.type}`);
    const price = Math.round(rand(c.price[0], c.price[1])) - 0.01;
    const p = { slug, name, model, brand, cat: c, price, path: `/products/${slug}`, idx: mi };
    products.push(p); list.push(p);
  });
  productsByCat.set(c.slug, list);
});

// Discontinued products (404 now) and renamed ones (301 to the new slug) — the classic retail churn.
const DISCONTINUED = ['fellwick-summit-1-tent', 'tarnmoor-ember-plus-5-sleeping-bag', 'scarrow-squall-2l-waterproof-jacket', 'kestrelbank-beam-300-head-torch', 'brindlecrag-drover-classic-walking-boots'];
for (const s of DISCONTINUED) gone.add(`/products/${s}`);
const RENAMED = [
  ['/products/larchmere-ridge-two-tent', productsByCat.get('tents')[0].path],
  ['/products/fellwick-traverse-60-rucksack', productsByCat.get('backpacks')[1].path],
  ['/products/tarnmoor-squall-3-layer-jacket', productsByCat.get('waterproof-jackets')[0].path],
  ['/products/scarrow-merino-crew-200', productsByCat.get('base-layers')[0].path],
];
for (const [from, to] of RENAMED) redirects.set(from, { status: 301, to });
// Two-hop chains: old blog URLs -> an interim slug -> the current guide.
redirects.set('/blogs/news/best-tents-2024', { status: 301, to: '/guides/best-tents-2025' });
redirects.set('/guides/best-tents-2025', { status: 301, to: '/guides/best-2-person-tents' });
redirects.set('/blogs/news/waterproof-jacket-guide', { status: 301, to: '/guides/waterproof-jacket-guide' });
redirects.set('/guides/waterproof-jacket-guide', { status: 301, to: '/guides/best-waterproof-jackets' });
redirects.set('/blogs/news', { status: 301, to: '/guides' });
redirects.set('/sale-2025', { status: 302, to: '/sale' });
redirects.set('/collections/rucksacks', { status: 301, to: '/collections/backpacks' });
// Redirects that leave the site (a booking partner, a fit-finder tool) — recorded as redirect-outs.
redirects.set('/stores/book-a-fitting', { status: 302, to: 'https://bookings.example/larchmere/fitting', abs: true });
redirects.set('/size-guide/boot-fit-finder', { status: 301, to: 'https://fitfinder.example/larchmere', abs: true });
redirects.set('/blogs/news/partner-offers', { status: 301, to: 'https://partners.example/larchmere', abs: true });

// ── Prose (filler copy for body text; deterministic) ─────────────────────────
const SENT = [
  'When you are choosing {thing}, start with how you will actually use it: a summer weekend on a valley campsite asks for something very different from a winter night above the treeline.',
  'Weight matters most when you carry everything on your back, but comfort and durability matter more on a campsite you drive to.',
  'We tested {thing} across a full season in the Lake District, the Cairngorms and Snowdonia, in rain, wind and the occasional warm afternoon.',
  'The specification sheet only tells part of the story, so we look at how {thing} behaves after a week of real use.',
  'Check the packed size against the space you actually have, because a few centimetres decide whether it fits inside the pack or hangs off it.',
  'Fit is personal, and the best advice is to try {thing} with the layers and kit you will wear on the hill.',
  'Cheaper options are often perfectly good for occasional use; the extra money buys lower weight and longer life rather than basic performance.',
  'Look after {thing} properly and it will last for years: dry it fully before storing it, and clean it the way the maker recommends.',
  'If you are unsure, our staff in store will happily talk you through the options and the trade-offs.',
  'The most common mistake we see is buying for the best-case trip rather than the conditions you are most likely to meet.',
  'British weather is the deciding factor: wind and persistent rain test kit far harder than cold on its own.',
  'For most walkers a mid-range choice is the sweet spot between weight, price and durability.',
  'Recycled and PFC-free materials are now common, and they perform as well as the older fabrics in our tests.',
  'Think about the whole system rather than a single item, because each piece of kit works best alongside the others.',
  'Read the warranty terms before you buy; the better brands repair rather than replace, which is cheaper and kinder to the planet.',
];
const para = (thing, n = 4) => Array.from({ length: n }, () => pick(SENT).replace(/\{thing\}/g, thing)).join(' ');

// ── Pages ─────────────────────────────────────────────────────────────────────
const NAV = [['/', 'Home'], ...CATS.map(c => [`/collections/${c.slug}`, c.name]), ['/guides', 'Guides'], ['/brands', 'Brands'], ['/sale', 'Sale']];
const FOOT = [['/about', 'About us'], ['/contact', 'Contact'], ['/delivery', 'Delivery'], ['/returns', 'Returns'], ['/size-guide', 'Size guide'],
  ['/stores', 'Stores'], ['/gift-cards', 'Gift cards'], ['/gift-cards/balance', 'Check a gift card balance'], ['/privacy', 'Privacy'], ['/terms', 'Terms'],
  ['/careers', 'Careers'], ['/blogs/news', 'Journal'], ['/stores/book-a-fitting', 'Book a boot fitting'], ['/size-guide/boot-fit-finder', 'Boot fit finder'], ['/blogs/news/partner-offers', 'Partner offers']];
const a = (href, text) => `<a href="${esc(href)}">${esc(text)}</a>`;
const ld = (o) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...o })}</script>`;
const crumbs = (items) => ld({ '@type': 'BreadcrumbList', itemListElement: items.map(([href, name], i) => ({ '@type': 'ListItem', position: i + 1, name, item: ORIGIN + href })) });
const addPage = (p) => { pages.set(p.path, p); return p; };
const shortMeta = (c) => `Shop ${c.name.toLowerCase()} from ${BRANDS.slice(0, 4).map(b => b.name).join(', ')} and more. Free UK delivery over £50 and 60-day returns.`;

// Homepage — Organization + WebSite schema, two H1s (logo + hero).
addPage({
  path: '/', title: 'Larchmere Outfitters | Tents, Walking Boots & Outdoor Gear', meta: 'Outdoor gear for UK hills and campsites: tents, sleeping bags, walking boots and waterproofs, chosen and tested by walkers. Free UK delivery over £50.',
  h1: 'Kit for the hills, tested on the hills', extraH1: true, delay: 180,
  schema: [ld({ '@type': 'Organization', name: STORE, url: ORIGIN + '/', logo: ORIGIN + '/cdn/img/logo.png' }), ld({ '@type': 'WebSite', name: STORE, url: ORIGIN + '/' })],
  body: () => {
    const feat = CATS.flatMap(c => productsByCat.get(c.slug).slice(0, 1));
    const feats = feat.map(p => `<li>${a(p.path, p.name)} <span>£${p.price.toFixed(2)}</span></li>`).join('');
    const cats = CATS.map(c => `<li>${a(`/collections/${c.slug}`, `Shop ${c.name.toLowerCase()}`)}</li>`).join('');
    const gs = GUIDES.filter(g => !g[4]?.deep && !g[4]?.orphan).slice(0, 8).map(g => `<li>${a(`/guides/${g[0]}`, g[1])}</li>`).join('');
    return `<section><h2>Shop by category</h2><ul>${cats}</ul></section>
      <section><h2>New for autumn</h2><img src="${img('home-hero', 520)}" alt="Walkers on a ridge in autumn" width="1600" height="700"><ul>${feats}</ul></section>
      <section><h2>Buying guides</h2><ul>${gs}</ul><p>${a('/guides', 'All buying guides')}</p></section>
      <section><h2>About us</h2><p>${para('outdoor kit', 3)}</p><p>${a('/about', 'Our story')} · ${a('/stores', 'Visit a store')}</p></section>`;
  },
});

// Collections (+ page 2 with a canonical to page 1, + faceted filter URLs)
for (const c of CATS) {
  const list = productsByCat.get(c.slug);
  const PER = 12;
  const pagesOf = Array.from({ length: Math.ceil(list.length / PER) }, (_, n) => list.slice(n * PER, (n + 1) * PER));
  const page1 = pagesOf[0];
  const guidesFor = GUIDES.filter(g => g[2] === c.slug && !g[4]?.orphan).slice(0, 3);
  const filters = c.slug === 'tents'
    ? [['capacity', '2'], ['capacity', '4'], ['season', '3'], ['season', '4']]
    : c.slug === 'waterproof-jackets' ? [['gender', 'mens'], ['gender', 'womens']] : [];
  const listHtml = (ps) => ps.map(p => `<li><img src="${img(p.slug, rand(60, 180))}" alt="${esc(p.name)}" width="400" height="400">${a(p.path, p.name)} <span>£${p.price.toFixed(2)}</span></li>`).join('');
  const filterHtml = filters.length ? `<div class="filters"><h2>Filter</h2>${filters.map(([fk, v]) => a(`/collections/${c.slug}?${fk}=${v}&sort=price-asc`, `${fk}: ${v}`)).join(' ')}</div>` : '';
  addPage({
    path: `/collections/${c.slug}`, title: `${c.name} | ${STORE}`, meta: shortMeta(c), h1: c.name, delay: randInt(380, 760),
    schema: [crumbs([['/', 'Home'], [`/collections/${c.slug}`, c.name]])],
    body: () => `${filterHtml}<p>${para(c.thing, 2)}</p><ul class="grid">${listHtml(page1)}</ul>
      ${pagesOf.length > 1 ? `<p>${a(`/collections/${c.slug}?page=2`, 'Next page')}</p>` : ''}
      <section><h2>Help choosing</h2><ul>${guidesFor.map(g => `<li>${a(`/guides/${g[0]}`, g[1])}</li>`).join('')}</ul></section>`,
  });
  pagesOf.slice(1).forEach((items, n) => {
    const num = n + 2;
    const prev = num === 2 ? `/collections/${c.slug}` : `/collections/${c.slug}?page=${num - 1}`;
    addPage({
      path: `/collections/${c.slug}?page=${num}`, title: `${c.name} | ${STORE}`, meta: shortMeta(c), h1: c.name, delay: randInt(380, 700),
      canonical: `/collections/${c.slug}`, relPrev: prev,
      body: () => `<ul class="grid">${listHtml(items)}</ul><p>${a(prev, 'Previous page')}</p>${num < pagesOf.length ? `<p>${a(`/collections/${c.slug}?page=${num + 1}`, 'Next page')}</p>` : ''}`,
    });
  });
  for (const [fk, v] of filters) {
    const sub = list.filter((_, i) => (i + v.length) % 2 === 0);
    addPage({
      path: `/collections/${c.slug}?${fk}=${v}&sort=price-asc`, title: `${c.name} | ${STORE}`, meta: shortMeta(c), h1: c.name, delay: randInt(500, 900), canonical: false,
      body: () => `<ul class="grid">${listHtml(sub)}</ul>`,
    });
  }
}

// Products
products.forEach((p, i) => {
  const sibs = productsByCat.get(p.cat.slug).filter(x => x !== p);
  const related = [sibs[i % sibs.length], sibs[(i + 3) % sibs.length], sibs[(i + 5) % sibs.length]].filter(Boolean);
  const guide = GUIDES.find(g => g[2] === p.cat.slug && !g[4]?.orphan);
  const hasVariants = i % 11 === 3;
  const missingMeta = i % 7 === 2;
  const noAlt = i % 4 === 1;
  const brokenOffers = i % 23 === 5; // price as a formatted string - a schema value error
  const missingOffers = i % 29 === 7;
  const offers = missingOffers ? undefined : { '@type': 'Offer', price: brokenOffers ? `£${p.price.toFixed(2)}` : p.price.toFixed(2), priceCurrency: 'GBP', availability: 'https://schema.org/InStock' };
  const variants = hasVariants ? COLOURS.slice(0, 2).map(col => `${p.path}-${col}`) : [];
  const mainImg = img(p.slug, rand(60, 180));
  const detailImg = img(`${p.slug}-detail`, rand(90, 420));
  addPage({
    path: p.path,
    title: `${p.name} | ${p.cat.name} | ${STORE}`,
    meta: missingMeta ? '' : `The ${p.name}: ${p.cat.thing} built for UK hills. £${p.price.toFixed(2)} with free delivery over £50 and 60-day returns.`,
    h1: p.name, delay: randInt(140, 420) + (i % 17 === 0 ? 900 : 0), pad: i % 13 === 0 ? 520_000 : randInt(40_000, 160_000),
    schema: [crumbs([['/', 'Home'], [`/collections/${p.cat.slug}`, p.cat.name], [p.path, p.name]]),
      ld({ '@type': 'Product', name: p.name, brand: { '@type': 'Brand', name: p.brand.name }, image: ORIGIN + mainImg, sku: `LO-${1000 + i}`, ...(offers ? { offers } : {}) })],
    body: () => `<p class="crumbs">${a(`/collections/${p.cat.slug}`, p.cat.name)} / ${a(`/brands/${p.brand.slug}`, p.brand.name)}</p>
      <img src="${mainImg}" ${noAlt ? '' : `alt="${esc(p.name)}"`} width="800" height="800">
      <img src="${detailImg}" ${noAlt ? '' : `alt="${esc(p.name)} detail"`}>
      <p><strong>£${p.price.toFixed(2)}</strong></p>
      ${variants.length ? `<p>Also available in ${variants.map((v, n) => a(v, COLOURS[n])).join(' and ')}.</p>` : ''}
      <h2>Overview</h2><p>${para(p.cat.thing, i % 5 === 0 ? 3 : 7)}</p><h2>Specification</h2><p>${para(p.cat.thing, i % 5 === 0 ? 1 : 4)}</p>
      ${i % 5 === 0 ? '' : `<h2>Care and warranty</h2><p>${para(p.cat.thing, 3)}</p>`}
      <section><h2>You might also like</h2><ul>${related.map(r => `<li>${a(r.path, r.name)}</li>`).join('')}</ul></section>
      ${guide ? `<p>Not sure? Read ${a(`/guides/${guide[0]}`, guide[1])}.</p>` : ''}`,
  });
  variants.forEach((v, n) => addPage({
    path: v, title: `${p.name} - ${COLOURS[n]} | ${STORE}`, meta: `The ${p.name} in ${COLOURS[n]}.`, h1: `${p.name} (${COLOURS[n]})`, delay: randInt(150, 380),
    canonical: p.path, body: () => `<p>${para(p.cat.thing, 3)}</p><p>${a(p.path, 'Back to all colours')}</p>`,
  }));
});

// Guides
GUIDES.forEach(([slug, title, catSlug, , ex = {}], gi) => {
  const c = CATS.find(x => x.slug === catSlug);
  const ps = productsByCat.get(catSlug);
  const picks = ps.slice(0, Math.min(ps.length, 4 + (gi % 4)));
  const others = GUIDES.filter(g => g[0] !== slug && !g[4]?.orphan && (g[2] === catSlug || g[4]?.deep)).slice(gi % 3, gi % 3 + 3);
  const brokenLinks = gi % 5 === 1 ? [`/products/${DISCONTINUED[gi % DISCONTINUED.length]}`] : [];
  const redirectLinks = gi % 6 === 2 ? [RENAMED[gi % RENAMED.length][0]] : [];
  const published = isoDate(Date.parse(END) - (400 - gi * 9) * DAY);
  const modified = ex.fresh ? isoDate(Date.parse(END) - 12 * DAY) : gi % 9 === 4 ? isoDate(Date.parse(published) - 20 * DAY) : isoDate(Date.parse(END) - (60 + gi * 3) * DAY);
  const faq = gi % 4 === 0;
  const hero = img(`guide-${slug}`, gi % 3 === 0 ? rand(420, 900) : rand(140, 300));
  addPage({
    path: `/guides/${slug}`, title: `${title} | ${STORE} Guides`, meta: `${title}. Advice from the ${STORE} team, who walk, camp and test kit across the UK every month.`,
    h1: title, delay: gi % 4 === 3 ? randInt(1100, 2300) : randInt(260, 620), mixed: gi % 10 === 7,
    schema: [ld({ '@type': 'Article', headline: title, image: ORIGIN + hero, author: { '@type': 'Person', name: pick(['Ellie Marsh', 'Tom Askew', 'Priya Dale']) }, datePublished: published, dateModified: modified }),
      ...(faq ? [ld({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: `What should I look for in ${c.thing}?`, acceptedAnswer: { '@type': 'Answer', text: para(c.thing, 2) } }] })] : [])],
    body: () => `<img src="${hero}" alt="${esc(title)}">
      <p>${para(c.thing, 3)}</p>
      <h2>What to look for</h2><p>${para(c.thing, 5)}</p>
      <h2>Our picks</h2><ul>${picks.map(p => `<li>${a(p.path, p.name)}: ${para(c.thing, 1)}</li>`).join('')}${brokenLinks.map(u => `<li>${a(u, 'Our previous favourite')}</li>`).join('')}${redirectLinks.map(u => `<li>${a(u, 'A long-time staff pick')}</li>`).join('')}</ul>
      <p>Browse the full range of ${a(`/collections/${catSlug}`, c.name.toLowerCase())}.</p>
      <h2>How we tested</h2><p>${para(c.thing, 4)}</p>
      ${faq ? `<h2>Frequently asked questions</h2><h3>What should I look for in ${esc(c.thing)}?</h3><p>${para(c.thing, 2)}</p>` : ''}
      ${others.length ? `<section><h2>Read next</h2><ul>${others.map(g => `<li>${a(`/guides/${g[0]}`, g[1])}</li>`).join('')}</ul></section>` : ''}`,
  });
});
addPage({
  path: '/guides', title: `Buying guides and advice | ${STORE}`, meta: 'Independent buying guides, how-tos and kit lists from the Larchmere Outfitters team.',
  h1: 'Buying guides', delay: 320,
  body: () => `<p>${para('outdoor kit', 2)}</p><ul>${GUIDES.filter(g => !g[4]?.deep && !g[4]?.orphan).map(g => `<li>${a(`/guides/${g[0]}`, g[1])}</li>`).join('')}</ul>`,
});

// Brands
for (const b of BRANDS) {
  const bp = products.filter(p => p.brand === b);
  addPage({
    path: `/brands/${b.slug}`, title: bp.length >= 20 ? `${b.name} | ${STORE}` : `Shop by brand | ${STORE}`, meta: bp.length ? `Shop ${b.name} outdoor gear at ${STORE}.` : '',
    h1: b.name, delay: randInt(240, 480),
    body: () => bp.length ? `<p>${para('their kit', 2)}</p><ul>${bp.map(p => `<li>${a(p.path, p.name)}</li>`).join('')}</ul>` : '<p>New products from this brand are coming soon.</p>',
  });
}
addPage({ path: '/brands', title: `Brands | ${STORE}`, meta: `The outdoor brands we stock at ${STORE}.`, h1: 'Brands', delay: 260,
  body: () => `<ul>${BRANDS.map(b => `<li>${a(`/brands/${b.slug}`, b.name)}</li>`).join('')}</ul>` });

// Info pages
for (const [slug, title] of INFO) {
  addPage({
    path: `/${slug}`, title: slug === 'sale' ? `Outdoor gear sale - up to 50% off | ${STORE}` : `${title} | ${STORE}`,
    meta: slug === 'privacy' || slug === 'terms' ? '' : `${title} at ${STORE}.`,
    h1: ['privacy', 'terms', 'careers'].includes(slug) ? null : title, delay: randInt(150, 300),
    noindex: slug === 'sale' || slug === 'careers', canonical: ['privacy', 'terms', 'size-guide'].includes(slug) ? false : true,
    body: () => slug === 'sale'
      ? `<p>${para('outdoor kit', 2)}</p><ul>${products.filter((_, i) => i % 9 === 0).map(p => `<li>${a(p.path, p.name)}</li>`).join('')}</ul>`
      : `<p>${para('outdoor kit', slug === 'about' ? 6 : 2)}</p>`,
  });
}
addPage({ path: '/gift-cards/balance', status: 500, title: 'Error', h1: 'Something went wrong', body: () => '<p>Please try again later.</p>', delay: 1400 });

// ── HTML rendering ───────────────────────────────────────────────────────────
function render(p) {
  const canonicalHref = p.canonical === false ? null : typeof p.canonical === 'string' ? ORIGIN + p.canonical : ORIGIN + p.path;
  const nav = NAV.map(([h, t]) => `<li>${a(h, t)}</li>`).join('');
  const foot = FOOT.map(([h, t]) => `<li>${a(h, t)}</li>`).join('');
  const pad = p.pad ? `<script id="product-data" type="application/json">${JSON.stringify({ variants: 'x'.repeat(p.pad) })}</script>` : '';
  const mixed = p.mixed ? `<img src="http://${HOST}/cdn/img/legacy-map.jpg" alt="Route map" width="800" height="600">` : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title ?? '')}</title>
${p.meta ? `<meta name="description" content="${esc(p.meta)}">` : ''}
${canonicalHref ? `<link rel="canonical" href="${esc(canonicalHref)}">` : ''}
${p.relPrev ? `<link rel="prev" href="${esc(ORIGIN + p.relPrev)}">` : ''}
${p.noindex ? '<meta name="robots" content="noindex, follow">' : ''}
<meta property="og:title" content="${esc(p.title ?? '')}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(ORIGIN + p.path)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-DEMO0000"></script>
${(p.schema ?? []).join('\n')}
</head><body>
<header><a href="/" class="logo">${p.extraH1 ? `<h1>${STORE}</h1>` : STORE}</a><nav><ul>${nav}</ul></nav></header>
<main>${p.h1 ? `<h1>${esc(p.h1)}</h1>` : ''}${p.body()}${mixed}</main>
<footer><ul>${foot}</ul><p>&copy; ${STORE} (a fictional demo company)</p></footer>
${pad}
</body></html>`;
}

// Sitemap: products all stamped with the same lastmod (a platform default), stale entries for gone
// and renamed products, and the newest guides missing.
function sitemapXml() {
  const urls = [];
  const stamp = `${END}T03:00:00+00:00`;
  urls.push(['/', stamp]);
  for (const c of CATS) urls.push([`/collections/${c.slug}`, stamp]);
  for (const p of products) urls.push([p.path, stamp]);
  for (const s of DISCONTINUED) urls.push([`/products/${s}`, stamp]);
  for (const [from] of RENAMED.slice(0, 2)) urls.push([from, stamp]);
  for (const g of GUIDES) if (!g[4]?.fresh) urls.push([`/guides/${g[0]}`, isoDate(Date.parse(END) - 30 * DAY)]);
  for (const b of BRANDS) urls.push([`/brands/${b.slug}`, stamp]);
  for (const [slug] of INFO) if (slug !== 'careers') urls.push([`/${slug}`, stamp]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, m]) => `<url><loc>${ORIGIN}${u}</loc><lastmod>${m}</lastmod></url>`).join('\n')}\n</urlset>`;
}
const ROBOTS = `User-agent: *\nDisallow: /account/\nDisallow: /cart\nDisallow: /checkout\nDisallow: /search\n\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: CCBot\nDisallow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;
const LLMS = `# ${STORE}\n\n> A fictional UK outdoor-gear retailer used for demos.\n\n## Guides\n${GUIDES.slice(0, 8).map(g => `- [${g[1]}](${ORIGIN}/guides/${g[0]})`).join('\n')}\n`;

// ── In-process HTTP server for the virtual site ──────────────────────────────
const LAST_MOD = new Date(Date.parse(END) - 5 * DAY).toUTCString();
const SEC = { 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff' };
function handle(req, res) {
  const u = new URL(req.url, ORIGIN);
  const key = u.pathname + u.search;
  const send = (status, headers, body, delay = 0) => setTimeout(() => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const gz = /text\/html/.test(headers['content-type'] ?? '') && buf.length ? zlib.gzipSync(buf) : buf;
    res.writeHead(status, { ...headers, ...(gz !== buf ? { 'content-encoding': 'gzip' } : {}), 'content-length': gz.length });
    res.end(req.method === 'HEAD' ? undefined : gz);
  }, delay);
  if (u.pathname === '/robots.txt') return send(200, { 'content-type': 'text/plain' }, ROBOTS);
  if (u.pathname === '/sitemap.xml') return send(200, { 'content-type': 'application/xml' }, sitemapXml());
  if (u.pathname === '/llms.txt') return send(200, { 'content-type': 'text/plain' }, LLMS);
  if (u.pathname === '/favicon.ico') return send(200, { 'content-type': 'image/x-icon' }, Buffer.alloc(1150));
  if (u.pathname.startsWith('/cdn/img/')) return send(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000' }, Buffer.alloc(images.get(u.pathname) ?? 48_000), 20);
  const r = redirects.get(key) ?? redirects.get(u.pathname);
  if (r) return send(r.status, { location: r.abs ? r.to : ORIGIN + r.to, 'content-type': 'text/plain' }, '', 90);
  const p = pages.get(key);
  const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', 'last-modified': LAST_MOD, ...SEC,
    ...(p && p.path.startsWith('/guides') ? {} : { 'x-frame-options': 'SAMEORIGIN' }), ...(p && p.path.startsWith('/collections') ? { 'referrer-policy': 'strict-origin-when-cross-origin' } : {}) };
  if (!p || gone.has(u.pathname)) {
    return send(404, h, `<!doctype html><html lang="en-GB"><head><title>Page not found | ${STORE}</title></head><body><header><nav>${a('/', 'Home')}</nav></header><main><h1>Page not found</h1></main></body></html>`, 120);
  }
  send(p.status ?? 200, h, render(p), p.delay ?? 200);
}

// ── Route undici (the crawler's HTTP client) to the in-process server ────────
const require = createRequire(import.meta.url);
const undici = require('undici');
const server = http.createServer(handle);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const connect = (_opts, cb) => { const s = net.connect(PORT, '127.0.0.1'); s.once('connect', () => cb(null, s)); s.once('error', e => cb(e, null)); };
const RealAgent = undici.Agent;
// Every connection, for any origin, lands on the demo server, which routes by path. Nothing
// leaves the machine: the demo domain is a reserved .example name and external checks are off.
undici.Agent = class DemoAgent extends RealAgent { constructor(o = {}) { super({ ...o, allowH2: false, connect }); } };
undici.setGlobalDispatcher(new undici.Agent());

// Import the built modules only after the patch, so their `undici` binding is the demo agent.
const { AuditDatabase } = await import('../dist/core/AuditDatabase.js');
const { dbPathFor } = await import('../dist/core/paths.js');
const { urlKey } = await import('../dist/core/url-key.js');
const { Crawler } = await import('../dist/core/Crawler.js');
const { runAudit } = await import('../dist/audit/engine.js');
const { checkAgentReadiness } = await import('../dist/core/agentReadiness.js');

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const dbPath = dbPathFor(OUT, SITE);
const k = (u) => urlKey(u, { hostForm: 'apex' });
const nowMs = Date.now();
const sqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.error(`[demo] ${m}`);

// ── 1. Search Console history (segmented: device x country) ──────────────────
const pairs = []; // { query, path, vol, pos, drift, ctrF, season, story }
const seasonOf = (catSlug) => CATS.find(c => c.slug === catSlug)?.season ?? 'flat';
for (const c of CATS) {
  for (const [q, vol, pos] of c.queries) pairs.push({ query: q, path: `/collections/${c.slug}`, vol, pos, drift: rand(-2.5, 1.5), ctrF: q === 'tents' ? 0.35 : rand(0.8, 1.15), season: c.season });
  for (const p of productsByCat.get(c.slug)) {
    const base = `${p.brand.name} ${p.model}`.toLowerCase();
    pairs.push({ query: base, path: p.path, vol: rand(4, 45), pos: rand(1.4, 4.5), drift: rand(-1, 1), ctrF: rand(0.8, 1.2), season: c.season });
    if (rng() < 0.7) pairs.push({ query: `${base} review`, path: p.path, vol: rand(2, 18), pos: rand(4, 13), drift: rand(-2, 2), ctrF: rand(0.6, 1.1), season: c.season });
    if (rng() < 0.35) pairs.push({ query: `${p.brand.name} ${c.type}`.toLowerCase(), path: p.path, vol: rand(10, 60), pos: rand(6, 18), drift: rand(-3, 2), ctrF: 1, season: c.season });
  }
}
for (const [slug, , catSlug, qs, ex = {}] of GUIDES) {
  for (const [q, vol, pos] of qs) {
    pairs.push({ query: q, path: `/guides/${slug}`, vol, pos, drift: ex.decay ? 0 : rand(-2.2, 1.2), ctrF: ex.lowCtr && q === 'best waterproof jacket' ? 0.3 : rand(0.85, 1.2), season: seasonOf(catSlug), story: ex.decay ? 'decay' : ex.fresh ? 'fresh' : null });
  }
}
// Cannibalisation: the guide and the collection trade places week by week.
pairs.push({ query: 'best waterproof jacket', path: '/collections/waterproof-jackets', vol: 600, pos: 7.5, drift: -1, ctrF: 0.9, season: 'winter', story: 'braid' });
pairs.push({ query: '2 person tent', path: '/products/' + productsByCat.get('tents')[0].slug, vol: 180, pos: 14, drift: -3, ctrF: 1, season: 'summer' });
for (const [q, vol, pos, p] of GAP_QUERIES) pairs.push({ query: q, path: `/${p}`, vol, pos, drift: rand(-2, 2), ctrF: 0.6, season: /jacket|fleece/.test(q) ? 'winter' : 'flat' });
for (const [q, vol, pos, p] of BRANDED) pairs.push({ query: q, path: `/${p}`, vol, pos, drift: 0, ctrF: 2.4, season: 'flat' });
pairs.push({ query: 'outdoor gear sale', path: '/sale', vol: 220, pos: 6.5, drift: -1, ctrF: 1.1, season: 'flat' });
pairs.push({ query: 'camping sale', path: '/sale', vol: 160, pos: 8.2, drift: 0, ctrF: 1.1, season: 'flat' });
// Churn: discontinued products fade out; renamed/old URLs hand their demand to the new URL.
DISCONTINUED.forEach((s) => pairs.push({ query: s.replace(/-/g, ' ').replace(/ (tent|sleeping bag|waterproof jacket|head torch|walking boots)$/, ''), path: `/products/${s}`, vol: rand(20, 60), pos: rand(2, 5), drift: 6, ctrF: 1, season: 'flat', story: 'fade' }));
RENAMED.forEach(([from]) => pairs.push({ query: from.split('/').pop().replace(/-/g, ' '), path: from, vol: rand(15, 40), pos: rand(3, 6), drift: 4, ctrF: 1, season: 'flat', story: 'fade' }));
pairs.push({ query: 'best tents 2024', path: '/blogs/news/best-tents-2024', vol: 70, pos: 6, drift: 8, ctrF: 1, season: 'summer', story: 'fade' });

{ // One series per (query, page): later duplicates fold their demand into the first.
  const seen = new Map();
  for (const pr of pairs.splice(0)) { const id = `${pr.query}|${pr.path}`; const prev = seen.get(id); if (prev) prev.vol += pr.vol; else { seen.set(id, pr); pairs.push(pr); } }
}

const CTR = [0, 0.285, 0.157, 0.11, 0.08, 0.065, 0.05, 0.04, 0.032, 0.027, 0.023];
const ctrAt = (pos) => pos <= 1 ? CTR[1] : pos < 10 ? CTR[Math.floor(pos)] + (CTR[Math.ceil(pos)] - CTR[Math.floor(pos)]) * (pos % 1) : pos <= 20 ? 0.016 - (pos - 10) * 0.0011 : 0.0025;
const DEVICES = [['MOBILE', 0.63, 0.5], ['DESKTOP', 0.32, -0.4], ['TABLET', 0.05, 0.3]];
const COUNTRIES = [['gbr', 0.8, 0], ['irl', 0.05, 1.5], ['usa', 0.04, 6], ['aus', 0.025, 5], ['can', 0.02, 5], ['nld', 0.015, 4], ['deu', 0.015, 5], ['fra', 0.01, 6], ['esp', 0.01, 6], ['nzl', 0.01, 5], ['ind', 0.01, 8]];
const endMs = Date.parse(END);
const startMs = endMs - (DAYS - 1) * DAY;
{
  const adb = new AuditDatabase(dbPath);
  adb.upsertProperty(SITE, 'apex');
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let rows = 0, totC = 0, totI = 0;
  adb.db.transaction(() => {
    for (const pr of pairs) {
      const url = ORIGIN + pr.path;
      const key = k(url);
      const phase = rand(0, 7);
      for (let d = 0; d < DAYS; d++) {
        const t = d / (DAYS - 1);
        const ms = startMs + d * DAY;
        const dow = new Date(ms).getUTCDay();
        const season = pr.season === 'summer' ? 1.3 - 0.75 * t : pr.season === 'winter' ? 0.7 + 0.75 * t : 1 - 0.05 * Math.sin(t * 3);
        const week = dow === 0 || dow === 6 ? 1.12 : dow === 5 ? 0.9 : 1;
        let vol = VOL_SCALE * pr.vol * season * week * (1 + 0.1 * t) * Math.exp(gauss() * 0.16) * (1 + 0.06 * Math.sin(d / 3.5 + phase));
        let pos = pr.pos + pr.drift * t + gauss() * 0.5;
        if (pr.story === 'decay' && d > DAYS - 40) { vol *= 0.62; pos += 3.2; }
        if (pr.story === 'fade') vol *= Math.max(0, 1 - t * 1.25);
        if (pr.story === 'fresh' && d < DAYS - 45) continue;
        if (pr.story === 'braid') pos += (Math.floor(d / 7) % 2 === 0 ? -2.4 : 2.6);
        const impr = poisson(vol);
        if (!impr) continue;
        const date = isoDate(ms);
        for (const [dev, dp, doff] of DEVICES) {
          for (const [cty, cp, coff] of COUNTRIES) {
            const ci = poisson(impr * dp * cp);
            if (!ci) continue;
            const cpos = Math.max(1, pos + (doff + coff) * Math.min(1, pr.pos / 6) + gauss() * 0.4); // brand terms rank #1 everywhere
            const clicks = binom(ci, Math.min(0.62, ctrAt(cpos) * pr.ctrF));
            ins.run(date, pr.query, url, key, dev, cty, clicks, ci, clicks / ci, Math.round(cpos * 10) / 10);
            rows++; totC += clicks; totI += ci;
          }
        }
      }
    }
  })();
  adb.db.prepare('UPDATE property_meta SET last_synced_at=? WHERE site_url=?').run(sqlTs(nowMs - 26 * 3600_000), SITE);
  adb.close();
  log(`GSC: ${pairs.length} query/page pairs, ${rows.toLocaleString()} rows, ${totC.toLocaleString()} clicks / ${totI.toLocaleString()} impressions over ${DAYS} days to ${END}`);
}

// ── 2. The crawl (the real crawler, against the demo server) ─────────────────
{
  const res = await new Crawler(OUT).run(SITE, { maxConcurrency: 8, delayMs: 0, checkExternal: false, chromeFallback: false }, () => {}, new AbortController().signal);
  log(`crawl: ${res.crawled} crawled, ${res.failed} failed, ${res.skipped} skipped; sitemaps ${JSON.stringify(res.sitemaps ?? {})}`);
}

// ── 3. Agent readiness (the real probe, against the demo server) ─────────────
{
  const r = await checkAgentReadiness(SITE);
  const adb = new AuditDatabase(dbPath);
  adb.db.prepare(`INSERT INTO agent_readiness (origin,score,level,checks,by_category,checked_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(origin) DO UPDATE SET score=excluded.score, level=excluded.level, checks=excluded.checks, by_category=excluded.by_category, checked_at=excluded.checked_at`)
    .run(r.origin, r.score, r.level, JSON.stringify(r.checks), JSON.stringify(r.byCategory), sqlTs(nowMs - 23 * 3600_000));
  adb.close();
  log(`agent readiness: ${r.score}/100 (${r.level})`);
}
server.close();

// ── 4. Enrichments that normally need Google / DataForSEO / Majestic ─────────
{
  const adb = new AuditDatabase(dbPath);
  const db = adb.db;
  const crawl = db.prepare(`SELECT crawl_id FROM crawl_metadata ORDER BY started_at DESC LIMIT 1`).get();
  // Backdate the crawl to "yesterday", after the sync, so the freshness panel reads naturally.
  const crawlStart = nowMs - 25 * 3600_000;
  db.prepare(`UPDATE crawl_metadata SET started_at=?, finished_at=? WHERE crawl_id=?`).run(new Date(crawlStart).toISOString(), new Date(crawlStart + 4 * 60_000).toISOString(), crawl.crawl_id);
  db.prepare(`UPDATE sitemap_urls SET fetched_at=?`).run(sqlTs(crawlStart));

  const pagesRows = db.prepare(`SELECT url, url_key, status_code, indexable, indexable_reason, noindex, canonical_key, click_depth FROM pages WHERE is_internal=1`).all();
  const impr = new Map(db.prepare(`SELECT page_key, SUM(impressions) i FROM search_analytics WHERE date > date(?, '-90 days') GROUP BY page_key`).all(END).map(r => [r.page_key, r.i]));
  const inSitemap = new Set(db.prepare(`SELECT url_key FROM sitemap_urls`).all().map(r => r.url_key));

  // URL Inspection — coverage states consistent with the crawl.
  const insI = db.prepare(`INSERT OR REPLACE INTO url_inspection (url_key,url,verdict,coverage_state,indexing_state,robots_txt_state,page_fetch_state,last_crawl_time,google_canonical,user_canonical,crawled_as,inspected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const inspectAt = sqlTs(nowMs - 24 * 3600_000);
  let inspected = 0, dupCanon = 0;
  for (const p of pagesRows.sort((x, y) => (impr.get(y.url_key) ?? 0) - (impr.get(x.url_key) ?? 0)).slice(0, 260)) {
    const i = impr.get(p.url_key) ?? 0;
    let state, verdict = 'PASS', fetch = 'SUCCESSFUL', gCanon = p.url, uCanon = p.canonical_key ?? p.url;
    if (p.status_code === 404) { state = 'Not found (404)'; verdict = 'FAIL'; fetch = 'NOT_FOUND'; gCanon = null; uCanon = null; }
    else if (p.status_code >= 500) { state = 'Server error (5xx)'; verdict = 'FAIL'; fetch = 'SERVER_ERROR'; gCanon = null; uCanon = null; }
    else if (p.status_code >= 300) { state = 'Page with redirect'; verdict = 'NEUTRAL'; gCanon = null; uCanon = null; }
    else if (p.noindex) { state = "Excluded by 'noindex' tag"; verdict = 'NEUTRAL'; }
    else if (p.indexable_reason === 'canonicalised') {
      if (dupCanon < 2 && /-(green|navy)$/.test(p.url)) { state = 'Duplicate, Google chose different canonical than user'; gCanon = p.url; dupCanon++; }
      else { state = 'Alternate page with proper canonical tag'; gCanon = p.canonical_key; }
      verdict = 'NEUTRAL';
    }
    else if (/\/brands\/sowerby-hart$/.test(p.url)) { state = 'Soft 404'; verdict = 'FAIL'; fetch = 'SOFT_404'; }
    else if (i > 0) state = inSitemap.has(p.url_key) ? 'Submitted and indexed' : 'Indexed, not submitted in sitemap';
    else { state = rng() < 0.7 ? 'Crawled - currently not indexed' : 'Discovered - currently not indexed'; verdict = 'NEUTRAL'; }
    insI.run(p.url_key, p.url, verdict, state, state.includes('noindex') ? 'BLOCKED_BY_META_TAG' : 'INDEXING_ALLOWED', 'ALLOWED', fetch,
      new Date(nowMs - randInt(2, 40) * DAY).toISOString(), gCanon, uCanon, 'MOBILE', inspectAt);
    inspected++;
  }

  // Backlinks (DataForSEO page-level counts + Majestic per-URL Trust Flow).
  const TOPICS = ['Recreation/Camping', 'Sports/Hiking', 'Recreation/Outdoors', 'Shopping/Sports', 'Travel/Europe', 'News/Weather'];
  const insB = db.prepare(`INSERT OR REPLACE INTO page_backlinks (url_key,url,backlinks,referring_domains,dofollow,status_code,trust_flow,citation_flow,topical_trust_flow,majestic_at,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const blAt = sqlTs(nowMs - 6 * DAY);
  const blTargets = [
    ['/', 1840, 212], ['/guides/wild-camping-uk-guide', 410, 64], ['/guides/what-is-a-bothy', 260, 41], ['/guides/three-peaks-challenge-kit-list', 190, 33],
    ['/guides/how-to-reproof-a-waterproof-jacket', 88, 19], ['/guides/sleeping-bag-temperature-ratings-explained', 120, 22], ['/guides/waterproof-ratings-explained', 140, 27],
    ['/guides/leave-no-trace', 70, 14], ['/guides/winter-camping-tips', 64, 12], ['/guides/how-to-pitch-a-tent-in-wind', 40, 9], ['/guides/camping-checklist', 96, 18],
    ['/collections/tents', 75, 16], ['/collections/waterproof-jackets', 52, 11], ['/about', 44, 13], ['/stores', 38, 15],
    [`/products/${DISCONTINUED[0]}`, 58, 12], [`/products/${DISCONTINUED[2]}`, 21, 6], ['/blogs/news/best-tents-2024', 33, 9],
  ];
  for (const [p, bl, rd] of blTargets) {
    const row = pagesRows.find(x => x.url_key === k(ORIGIN + p));
    const tf = Math.min(48, Math.round(8 + Math.log2(rd + 1) * 4 + rand(-3, 3)));
    insB.run(k(ORIGIN + p), ORIGIN + p, bl, rd, Math.round(bl * rand(0.55, 0.85)), row?.status_code ?? 301, tf, tf + randInt(4, 14),
      JSON.stringify([{ topic: pick(TOPICS.slice(0, 3)), value: tf - randInt(0, 4) }, { topic: pick(TOPICS.slice(3)), value: Math.max(1, tf - randInt(6, 14)) }]), blAt, blAt);
  }
  const blProducts = products.filter((_, i) => i % 6 === 0);
  for (const p of blProducts) {
    const rd = randInt(1, 5);
    insB.run(k(ORIGIN + p.path), ORIGIN + p.path, rd * randInt(1, 4), rd, rd, 200, randInt(4, 14), randInt(10, 22), JSON.stringify([{ topic: 'Shopping/Sports', value: randInt(3, 10) }]), blAt, blAt);
  }
  db.prepare(`UPDATE property_meta SET total_backlinks=?, referring_domains=?, backlinks_spam_score=?, backlinks_fetched_at=?, backlinks_rank=?, broken_backlinks=?, broken_pages=?, backlinks_nofollow_pct=? WHERE site_url=?`)
    .run(4120, 386, 4, blAt, 212, 91, 3, 0.31, SITE);

  // Link intersect prospects — fictional referring domains linking to fictional competitors.
  const COMPETITORS = ['peakandpine.example', 'basecamp-supply.example', 'moorland-gear.example'];
  const PROSPECTS = ['trailnotes.example', 'the-bothy-blog.example', 'fellwalkers-forum.example', 'outdoor-weekly.example', 'wildcamp-diaries.example', 'ridge-and-river.example',
    'campsite-reviews.example', 'hillwalking-club.example', 'gearlab-uk.example', 'scottish-trails.example', 'peak-district-walks.example', 'the-long-way-round.example',
    'family-camping-mag.example', 'kit-list-central.example', 'snowdonia-guides.example', 'lakeland-hikers.example', 'mountain-safety-hub.example', 'ultralight-uk.example',
    'coastal-paths.example', 'dogs-on-the-hill.example', 'outdoor-deals-daily.example', 'best-gear-directory.example', 'weekend-wanderers.example', 'trail-running-life.example',
    'bushcraft-basics.example', 'scouting-resources.example', 'the-camping-podcast.example', 'adventure-parents.example', 'uk-hiking-routes.example', 'link-directory-247.example'];
  const insP = db.prepare(`INSERT OR REPLACE INTO link_prospects (domain,intersections,linked_targets,domain_trust,spam_score,dofollow,backlinks,referring_domains,first_seen,trust_flow,citation_flow,topical_trust_flow,competitors_set,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  PROSPECTS.forEach((d, i) => {
    const spammy = /directory|deals/.test(d);
    const n = spammy ? 3 : randInt(1, 3);
    const tf = spammy ? randInt(0, 3) : randInt(9, 41);
    insP.run(d, n, JSON.stringify(COMPETITORS.slice(0, n)), spammy ? randInt(180, 260) : randInt(90, 340), spammy ? randInt(40, 70) : randInt(0, 18), spammy ? 0 : (i % 5 === 3 ? 0 : 1),
      randInt(2, 40), 1, isoDate(nowMs - randInt(60, 900) * DAY), tf, tf + randInt(3, 20),
      JSON.stringify([{ topic: spammy ? 'Business/Directories' : pick(TOPICS.slice(0, 4)), value: Math.max(0, tf - randInt(0, 5)) }]), JSON.stringify(COMPETITORS), sqlTs(nowMs - 6 * DAY));
  });

  // DataForSEO rank history — 13 months, organic keywords growing into autumn.
  const insR = db.prepare(`INSERT OR REPLACE INTO rank_history (period,pos_1_3,pos_4_10,pos_11_20,pos_21_100,etv,keyword_count,source,fetched_at,is_new,is_up,is_down,is_lost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let m = 12; m >= 0; m--) {
    const dt = new Date(endMs); dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() - m);
    const g = 1 + (12 - m) * 0.035;
    const p13 = Math.round(310 * g + rand(-15, 15)), p410 = Math.round(820 * g + rand(-30, 30)), p1120 = Math.round(1240 * g + rand(-40, 40)), p21 = Math.round(4100 * g + rand(-90, 90));
    insR.run(dt.toISOString().slice(0, 7), p13, p410, p1120, p21, Math.round(21000 * g * rand(0.95, 1.05)), p13 + p410 + p1120 + p21, 'dataforseo', sqlTs(nowMs - 3 * DAY), randInt(140, 260), randInt(300, 520), randInt(220, 420), randInt(90, 200));
  }

  // Lab Core Web Vitals (page_lighthouse) for the busiest templates.
  const insC = db.prepare(`INSERT OR REPLACE INTO page_cwv (url_key,url,for_mobile,performance,lcp_ms,cls,tbt_ms,fetched_at) VALUES (?,?,?,?,?,?,?,?)`);
  const cwvPages = ['/', ...CATS.slice(0, 6).map(c => `/collections/${c.slug}`), ...products.filter((_, i) => i % 9 === 0).map(p => p.path), ...GUIDES.slice(0, 8).map(g => `/guides/${g[0]}`)];
  for (const p of cwvPages) {
    const heavy = p.startsWith('/collections') || /best-/.test(p);
    insC.run(k(ORIGIN + p), ORIGIN + p, 1, heavy ? rand(0.32, 0.58) : rand(0.55, 0.92), heavy ? rand(3100, 5400) : rand(1500, 2900), heavy ? rand(0.06, 0.24) : rand(0, 0.08), heavy ? rand(320, 900) : rand(60, 260), sqlTs(nowMs - 6 * DAY));
  }

  // Keyword intent (DataForSEO Labs) for the busiest queries.
  const insK = db.prepare(`INSERT OR REPLACE INTO keyword_intent (keyword,intent,probability,fetched_at) VALUES (?,?,?,?)`);
  for (const { query } of db.prepare(`SELECT query, SUM(impressions) i FROM search_analytics WHERE date > date(?, '-28 days') GROUP BY query ORDER BY i DESC LIMIT 160`).all(END)) {
    const intent = /^larchmere/.test(query) ? 'navigational' : /^(how|what|where|do i|is |when)|explained|vs|tips|checklist|ideas|principles|guide|meaning|rating/.test(query) ? 'informational'
      : /^best|review|lightweight|packable/.test(query) ? 'commercial' : 'transactional';
    insK.run(query, intent, Math.round(rand(0.62, 0.98) * 100) / 100, sqlTs(nowMs - 6 * DAY));
  }
  adb.close();
  log(`enrichments: ${inspected} URLs inspected, ${blTargets.length + blProducts.length} backlinked pages, ${PROSPECTS.length} link prospects, 13 months of rank history, ${cwvPages.length} CWV pages`);
}

// ── 5. Passage scores (the local cross-encoder, when cached) ─────────────────
if (!NO_ML) {
  try {
    const { scoreSitePassages } = await import('../dist/core/passageScore.js');
    const r = await scoreSitePassages(OUT, SITE, { limit: 40, minImpressions: 50 });
    log(`passage scores: ${r.scored} pages scored, ${r.flagged} weak`);
  } catch (e) { log(`passage scoring skipped: ${e.message}`); }
}

// ── 6. The audit (every check, genuine output) ───────────────────────────────
{
  const res = runAudit(OUT, SITE, { scope: 'full', includeJudgement: true });
  log(`audit: ${res.total} findings across ${res.byCheck.length} checks`);
}
console.log(OUT);
process.exit(0);
