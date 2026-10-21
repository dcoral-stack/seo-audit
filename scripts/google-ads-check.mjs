#!/usr/bin/env node
// SEOCoral fork: check the saved Google Ads credentials and (re)connect them to Claude Desktop,
// without authorising again. Use it after Basic access is approved, or any time something changed.
//
//   node scripts/google-ads-check.mjs [--creds <ruta google-ads.json>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { GoogleAdsClient, googleAdsCredentials } from '../dist/core/GoogleAdsClient.js';

const i = process.argv.indexOf('--creds');
const credsPath = i > 0 ? process.argv[i + 1] : path.join(homedir(), 'Documents/SEOCoral/credenciales/google-ads.json');
if (!existsSync(credsPath)) { console.error(`No existe ${credsPath}. Ejecuta primero scripts/google-ads-auth.mjs.`); process.exit(1); }

// 1. Wire GOOGLE_ADS_CREDENTIALS into the Claude Desktop entry (macOS), with a backup.
const cfgPath = path.join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8') || '{}');
  const entry = cfg.mcpServers?.['seocoral-audit'];
  if (!entry) console.log('Aviso: no hay una entrada "seocoral-audit" en la configuración de Claude Desktop.');
  else if (entry.env?.GOOGLE_ADS_CREDENTIALS === credsPath) console.log('Claude Desktop ya apunta a estas credenciales.');
  else {
    writeFileSync(cfgPath + '.backup', readFileSync(cfgPath));
    entry.env = { ...(entry.env ?? {}), GOOGLE_ADS_CREDENTIALS: credsPath };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log('Credenciales añadidas a Claude Desktop (copia en claude_desktop_config.json.backup). Reinícialo con Cmd + Q.');
  }
}

// 2. One real Keyword Planner call.
const c = googleAdsCredentials({ GOOGLE_ADS_CREDENTIALS: credsPath });
if (!c) { console.error('El archivo de credenciales está incompleto.'); process.exit(1); }
const ads = new GoogleAdsClient(c, path.join(tmpdir(), `gads-check-${Date.now()}.db`), 0);
try {
  const r = await ads.historicalMetrics(['agencia seo', 'agencias seo'], 2724, 'es');
  for (const k of r.items) console.log(`  ${k.keyword}: ${k.searchVolume ?? 'sin datos'} búsquedas/mes${k.groupedUnder ? ` (agrupada con "${k.groupedUnder}")` : ''}`);
  console.log('\nGoogle Ads funciona.');
} catch (e) {
  console.error('\nLa prueba falló:\n  ' + (e instanceof Error ? e.message : e));
  process.exit(1);
} finally { ads.close(); }
