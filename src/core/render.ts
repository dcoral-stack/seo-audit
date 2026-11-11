// Opt-in headless-Chromium renderer (Playwright) for the "Response vs Render" tier. Playwright is an
// OPTIONAL dependency: the default install and the HTTP crawler never touch it, and nothing here runs
// unless the user calls render_pages AND has installed the browser. stdio-safe: Playwright talks to
// the browser over a pipe (not stdout), and this module never console.log (the MCP owns stdout for
// JSON-RPC) — any diagnostics go to stderr.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let browserP: Promise<any> | null = null;

// Import through a variable specifier so TypeScript doesn't statically resolve the OPTIONAL dependency
// at build time (it isn't installed in the default build), while runtime import still works when present.
const PLAYWRIGHT = 'playwright';

/** Rendering can't work at all on this install (no `playwright` package, or no browser binary).
 * Distinct from a per-URL failure (timeout, unreachable page), which a batch skips and carries on from. */
export class RendererUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'RendererUnavailableError'; }
}

/** True if the optional `playwright` package is importable. Cheap check for graceful degradation.
 * NOT proof that rendering works: npm installs the optional package without its browser, so the
 * launch can still fail, and renderHtml then throws RendererUnavailableError. */
export async function rendererAvailable(): Promise<boolean> {
  try { await import(PLAYWRIGHT); return true; } catch { return false; }
}

/** Folders where Playwright keeps its downloaded browsers (any Playwright version shares them). */
function browserCacheDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const home = homedir();
  dirs.push(join(home, 'Library', 'Caches', 'ms-playwright'), join(home, '.cache', 'ms-playwright'));
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'ms-playwright'));
  return dirs.filter(d => { try { return statSync(d).isDirectory(); } catch { return false; } });
}

/** Find an executable by name below `root` (bounded depth: browser bundles are a few levels deep). */
function findBinary(root: string, names: string[], depth = 6): string | null {
  if (depth < 0) return null;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  for (const e of entries) {
    const full = join(root, e);
    if (names.includes(e)) { try { if (statSync(full).isFile()) return full; } catch { /* skip */ } }
  }
  for (const e of entries) {
    const full = join(root, e);
    try { if (statSync(full).isDirectory()) { const f = findBinary(full, names, depth - 1); if (f) return f; } } catch { /* skip */ }
  }
  return null;
}

/** Chromium builds already on this machine, newest first: the one Playwright wants may be missing
 * (a different Playwright version asks for a different build number) while another build is fine. */
function installedChromiums(): string[] {
  const found: string[] = [];
  const env = process.env.SEO_AUDIT_CHROMIUM_PATH;
  if (env && existsSync(env)) found.push(env);
  const names = ['chrome-headless-shell', 'headless_shell', 'Chromium', 'Google Chrome for Testing', 'chrome', 'chrome.exe', 'headless_shell.exe', 'chrome-headless-shell.exe'];
  for (const dir of browserCacheDirs()) {
    let builds: string[] = [];
    try { builds = readdirSync(dir).filter(d => /^chromium(_headless_shell)?-\d+/.test(d)); } catch { continue; }
    // headless shell first (lighter), then by build number descending
    builds.sort((a, b) => (Number(/headless_shell/.test(b)) - Number(/headless_shell/.test(a))) || (Number(b.replace(/\D/g, '')) - Number(a.replace(/\D/g, ''))));
    for (const b of builds) { const bin = findBinary(join(dir, b), names); if (bin) found.push(bin); }
  }
  return found;
}

async function getBrowser(): Promise<any> {
  if (!browserP) {
    browserP = (async () => {
      let pw: any;
      try {
        pw = await import(PLAYWRIGHT);
      } catch {
        throw new RendererUnavailableError('Rendering needs the optional "playwright" package: run `npm i playwright && npx playwright install chromium`. The rest of the audit works without it (the crawler is HTTP-only by design).');
      }
      const args = ['--no-sandbox', '--disable-dev-shm-usage'];
      let firstErr: unknown;
      // An explicit SEO_AUDIT_CHROMIUM_PATH wins; otherwise try Playwright's own build first.
      const custom = process.env.SEO_AUDIT_CHROMIUM_PATH;
      if (custom && existsSync(custom)) {
        try { return await pw.chromium.launch({ headless: true, args, executablePath: custom }); } catch (e) { firstErr = e; }
      } else {
        try { return await pw.chromium.launch({ headless: true, args }); } catch (e) { firstErr = e; }
      }
      // Fallback: any Chromium already downloaded by another Playwright version, then installed Google Chrome.
      for (const exe of installedChromiums()) {
        try { return await pw.chromium.launch({ headless: true, args, executablePath: exe }); } catch { /* try the next one */ }
      }
      try { return await pw.chromium.launch({ headless: true, args, channel: 'chrome' }); } catch { /* none left */ }
      throw new RendererUnavailableError(`Playwright is installed but no Chromium would launch — run \`npx playwright install chromium\` in the project, or set SEO_AUDIT_CHROMIUM_PATH to a Chromium/Chrome binary. (${firstErr instanceof Error ? firstErr.message.slice(0, 140) : String(firstErr)})`);
    })();
    // Don't cache a failed launch for the life of the process: once the user installs the browser,
    // the next render_pages call should try again rather than replay the old failure.
    browserP.catch(() => { browserP = null; });
  }
  return browserP;
}

/** Render one URL and return the serialised post-JavaScript DOM as HTML. Reuses one browser process
 * across calls (close it with closeRenderer at the end of a batch). Bounded by `timeoutMs`. */
export async function renderHtml(url: string, ua: string, timeoutMs = 20000): Promise<string> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: ua });
  const page = await ctx.newPage();
  try {
    // networkidle waits for XHR/fetch-driven content to settle — that's the whole point of rendering.
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return await page.content();
  } finally {
    await ctx.close().catch(() => { /* already gone */ });
  }
}

/** Close the shared browser process. Safe to call when none was started. */
export async function closeRenderer(): Promise<void> {
  if (browserP) {
    try { (await browserP).close(); } catch { /* already closed / never launched */ }
    browserP = null;
  }
}
