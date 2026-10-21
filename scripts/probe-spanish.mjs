#!/usr/bin/env node
// SEOCoral fork: Spanish-language handling (src/core/text.ts and its call sites).
// Accent folding, Spanish stop words, the light plural stemmer, accented brand queries,
// the cluster-cannibalisation SQL fold, and the Spain/Spanish market defaults.
// Run:  npm run build:server && node scripts/probe-spanish.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fold, words, compact, terms, tokens, stem, acceptLanguage } from '../dist/core/text.js';
import { tokenize, jaccard } from '../dist/audit/lexical.js';
import { queryCore, clusterCannibalisation } from '../dist/audit/recon.js';
import { brandRun, loadBrandQueries } from '../dist/core/brand.js';
import { DEFAULT_LANGUAGE, DEFAULT_LOCATION, DEFAULT_COUNTRY } from '../dist/core/locale.js';
import { CHROME_HEADERS, BOT_UA } from '../dist/core/userAgents.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dataDir = path.join(tmpdir(), `sac-spanish-${Date.now()}`);

// ── 1. Folding keeps Spanish words whole ────────────────────────────────────────────────────────
ok(fold('Diseño de COCINAS pequeñas') === 'diseno de cocinas pequenas', 'fold: ñ and case');
ok(eq(words('gestoría para autónomos en Madrid'), ['gestoria', 'para', 'autonomos', 'en', 'madrid']), `words keep accented words whole (${words('gestoría para autónomos en Madrid')})`);
ok(eq(words('Pingüino · Çava · Straße'), ['pinguino', 'cava', 'strasse']), 'fold: ü, ç, ß');
ok(compact('Peluquería López') === 'peluquerialopez', 'compact: accented brand to its domain spelling');

// ── 2. Stop words: Spanish function words drop, topics stay ─────────────────────────────────────
ok(eq(terms('gestoría para autónomos en Madrid'), ['gestoria', 'autonomos', 'madrid']), `terms drop "para"/"en" (${terms('gestoría para autónomos en Madrid')})`);
ok(eq(terms('¿Cuál es el mejor seguro de coche?'), ['seguro', 'coche']), `terms drop interrogatives and "mejor" (${terms('¿Cuál es el mejor seguro de coche?')})`);
ok(eq(terms('best cms for the agency'), ['cms', 'agency']), 'English stop words still drop');

// ── 3. Light stemmer: singular and plural meet; gender stays apart ──────────────────────────────
for (const [a, b] of [
  ['gestorias', 'gestoria'], ['autonomos', 'autonomo'], ['gestores', 'gestor'], ['calles', 'calle'],
  ['habitaciones', 'habitacion'], ['luces', 'luz'], ['veces', 'vez'], ['clases', 'clase'],
  ['pages', 'page'], ['stores', 'store'], ['boxes', 'box'], ['precios', 'precio'],
]) ok(stem(a) === stem(b), `stem("${a}") = stem("${b}") (${stem(a)} / ${stem(b)})`);
ok(stem('abogado') !== stem('abogada'), 'gender is not merged (abogado / abogada)');
ok(stem('analysis') === 'analysis' && stem('campus') === 'campus' && stem('crisis') === 'crisis', '-is / -us endings left alone');
ok(stem('seo') === 'seo' && stem('2026') === '2026', 'short words and numbers untouched');

// ── 4. Clustering tokenizer: accented and unaccented spellings cluster together ────────────────
const a = new Set(tokenize('Diseño de cocinas pequeñas')), b = new Set(tokenize('diseno cocina pequena'));
ok(jaccard(a, b) === 1, `"Diseño de cocinas pequeñas" ≡ "diseno cocina pequena" (jaccard ${jaccard(a, b)})`);
ok(eq(tokens('Gestorías en Madrid'), tokens('gestoria madrid')), 'tokens: plural + accent + stop word');

// ── 5. Cluster cannibalisation core + SQL fold ──────────────────────────────────────────────────
ok(eq(queryCore('mejores precios de diseño de cocinas en Madrid'), ['diseno', 'cocinas', 'madrid']), `queryCore drops Spanish modifiers (${queryCore('mejores precios de diseño de cocinas en Madrid')})`);
{
  const site = 'sc-domain:cocinas.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,?)`);
  const u1 = 'https://cocinas.test/diseno-cocinas/', u2 = 'https://cocinas.test/blog/ideas-cocinas-pequenas/';
  adb.db.transaction(() => {
    for (let t = Date.parse('2026-09-01'); t <= Date.parse('2026-09-28'); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      ins.run(d, 'diseño cocinas', u1, u1, 3, 40, 4);
      ins.run(d, 'diseño cocinas', u2, u2, 1, 30, 7);   // same accented query, second URL
      ins.run(d, 'diseno cocinas', u2, u2, 1, 30, 6);   // unaccented spelling
    }
  })();
  const r = clusterCannibalisation(adb.db, 'diseño cocinas', '2026-09-28');
  ok(r.clusterQueries === 2, `both spellings land in one cluster (${r.clusterQueries} queries)`);
  ok(r.urls.length === 2 && r.cannibalising, `two competing URLs flagged (${r.urls.length}, cannibalising=${r.cannibalising})`);
  adb.close();
}

// ── 6. Accented brand queries ──────────────────────────────────────────────────────────────────
ok(brandRun('peluquería lópez opiniones', 'peluquerialopez') === 'peluqueria lopez', 'brandRun: accented spaced spelling');
ok(brandRun('peluqueria lopez', 'peluquerialopez') === 'peluqueria lopez', 'brandRun: unaccented spaced spelling');
{
  const site = 'sc-domain:peluquerialopez.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,2)`);
  const u = 'https://peluquerialopez.test/';
  adb.db.transaction(() => {
    for (let t = Date.parse('2026-09-01'); t <= Date.parse('2026-09-28'); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      ins.run(d, 'peluquería lópez', u, u, 5, 20);
      ins.run(d, 'peluquerialopez', u, u, 2, 5);
      ins.run(d, 'peluquería en madrid', u, u, 1, 50);
    }
  })();
  const m = loadBrandQueries(adb.db, site);
  ok(m && m.queries === 2, `accented brand query detected in SQL prefilter (${JSON.stringify(m)})`);
  adb.close();
}

// ── 7. Market defaults ──────────────────────────────────────────────────────────────────────────
ok(DEFAULT_LOCATION === 2724 && DEFAULT_LANGUAGE === 'es' && DEFAULT_COUNTRY === 'ES', `defaults: Spain/es (${DEFAULT_LOCATION}, ${DEFAULT_LANGUAGE}, ${DEFAULT_COUNTRY})`);
ok(acceptLanguage().startsWith('es-ES') && CHROME_HEADERS['accept-language'].startsWith('es-ES'), 'Accept-Language es-ES on the browser fallback');
ok(BOT_UA.includes('seocoral-audit'), 'crawler identifies the fork');

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
