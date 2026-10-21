#!/usr/bin/env node
// SEOCoral fork: one-time Google Ads API authorisation for keyword_volume / keyword_ideas.
//
//   node scripts/google-ads-auth.mjs ~/Downloads/client_secret_XXXX.json
//
// 1. Reads the OAuth client (type "Desktop app") downloaded from Google Cloud.
// 2. Asks for the MCC developer token and MCC id (and optionally a client account id).
// 3. Opens the browser to authorise with the Google user that has access to the MCC.
// 4. Writes ~/Documents/SEOCoral/credenciales/google-ads.json (or --out <path>), mode 600.
// 5. Runs one real Keyword Planner call to prove it works.
//
// Then point GOOGLE_ADS_CREDENTIALS at that file in the Claude Desktop config.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : path.join(homedir(), 'Documents/SEOCoral/credenciales/google-ads.json');
const secretPath = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1));
if (!secretPath || !existsSync(secretPath)) {
  console.error('Uso: node scripts/google-ads-auth.mjs <client_secret.json> [--out <ruta>]');
  console.error('El client_secret.json se descarga en Google Cloud > APIs y servicios > Credenciales (cliente OAuth tipo "App de escritorio").');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(secretPath, 'utf8'));
const client = raw.installed ?? raw.web ?? raw;
if (!client.client_id || !client.client_secret) { console.error('El JSON no contiene client_id / client_secret.'); process.exit(1); }

const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
// Line queue instead of rl.question: works the same typed interactively or piped.
const rl = readline.createInterface({ input: process.stdin });
const lines = [], waiting = [];
rl.on('line', l => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on('close', () => { while (waiting.length) waiting.shift()(''); });
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise(r => waiting.push(r)));
const ask = async (q, def) => { process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `); return (await nextLine()).trim() || def || ''; };
const developerToken = await ask('Developer token del MCC (Herramientas > Centro de API)', prev.developer_token);
const loginCustomerId = (await ask('ID del MCC (10 dígitos)', prev.login_customer_id)).replace(/\D/g, '');
const customerId = (await ask('ID de una cuenta cliente con gasto, para volúmenes exactos (Enter = usar el MCC)', prev.customer_id || loginCustomerId)).replace(/\D/g, '');
rl.close();
if (!developerToken || loginCustomerId.length !== 10) { console.error('Faltan el developer token o un ID de MCC de 10 dígitos.'); process.exit(1); }

// Loopback OAuth flow (Desktop app clients accept http://127.0.0.1:<any port>).
const state = randomBytes(16).toString('hex');
const code = await new Promise((resolve, reject) => {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/') { res.writeHead(404).end(); return; }
    const err = u.searchParams.get('error');
    const c = u.searchParams.get('code');
    const ok = !err && c && u.searchParams.get('state') === state;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(ok ? '<h2>Autorizado. Ya puedes cerrar esta pestaña y volver a la Terminal.</h2>' : `<h2>Error: ${err ?? 'respuesta no válida'}</h2>`);
    srv.close();
    ok ? resolve({ code: c, redirect: `http://127.0.0.1:${port}` }) : reject(new Error(err ?? 'state mismatch'));
  });
  let port;
  srv.listen(0, '127.0.0.1', () => {
    port = srv.address().port;
    const redirect = `http://127.0.0.1:${port}`;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords', access_type: 'offline', prompt: 'consent', state,
    }).toString();
    console.log('\nAbriendo el navegador para autorizar. Entra con la cuenta de Google que gestiona el MCC.');
    console.log('Si no se abre, copia esta URL en el navegador:\n' + auth.toString() + '\n');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try { const ch = spawn(opener, [auth.toString()], { stdio: 'ignore', detached: true }); ch.on('error', () => {}); ch.unref(); } catch { /* URL printed above */ }
  });
  setTimeout(() => { srv.close(); reject(new Error('tiempo agotado (5 min) esperando la autorización')); }, 300_000).unref();
});

let tokRes;
try {
  tokRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code: code.code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: code.redirect, grant_type: 'authorization_code' }).toString(),
  });
} catch (e) {
  console.error('No se pudo contactar con Google para obtener el token (¿sin conexión?):', e.cause?.code ?? e.message);
  process.exit(1);
}
const tok = await tokRes.json();
if (!tokRes.ok || !tok.refresh_token) {
  console.error('No se obtuvo refresh token:', tok.error ?? tokRes.status, tok.error_description ?? '');
  process.exit(1);
}

const creds = {
  developer_token: developerToken, client_id: client.client_id, client_secret: client.client_secret,
  refresh_token: tok.refresh_token, login_customer_id: loginCustomerId, customer_id: customerId,
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(creds, null, 2));
chmodSync(out, 0o600);
console.log(`Credenciales guardadas en ${out}`);
// Point the Claude Desktop entry at the credentials (macOS path), keeping a backup.
const cfgPath = path.join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
let wired = false;
if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8') || '{}');
  const entry = cfg.mcpServers?.['seocoral-audit'];
  if (entry) {
    writeFileSync(cfgPath + '.backup', readFileSync(cfgPath));
    entry.env = { ...(entry.env ?? {}), GOOGLE_ADS_CREDENTIALS: out };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    wired = true;
  }
}

// Prove it with one real call.
const { GoogleAdsClient, googleAdsCredentials } = await import('../dist/core/GoogleAdsClient.js');
const c = googleAdsCredentials({ GOOGLE_ADS_CREDENTIALS: out });
const ads = new GoogleAdsClient(c, path.join(tmpdir(), `gads-check-${Date.now()}.db`), 0);
try {
  const r = await ads.historicalMetrics(['agencia seo', 'agencias seo'], 2724, 'es');
  for (const k of r.items) console.log(`  ${k.keyword}: ${k.searchVolume ?? 'sin datos'} búsquedas/mes${k.groupedUnder ? ` (agrupada con "${k.groupedUnder}")` : ''}`);
  console.log(wired
    ? '\nGoogle Ads funciona y está conectado a Claude Desktop (copia en claude_desktop_config.json.backup). Cierra Claude con Cmd + Q y vuelve a abrirlo.'
    : `\nGoogle Ads funciona. Añade GOOGLE_ADS_CREDENTIALS=${out} al servidor seocoral-audit en la configuración de Claude Desktop y reinícialo.`);
} catch (e) {
  console.error('\nLas credenciales se guardaron' + (wired ? ' y están conectadas a Claude Desktop' : '') + ', pero la prueba falló:\n  ' + (e instanceof Error ? e.message : e));
  console.error('Cuando esté resuelto, comprueba con: node scripts/google-ads-check.mjs (no hace falta volver a autorizar).');
  process.exit(1);
} finally { ads.close(); }
