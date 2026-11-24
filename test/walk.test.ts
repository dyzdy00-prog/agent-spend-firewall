// Walks the whole console in a headless browser (test/fixtures/walk.js) and fails on any programming slip
// shown to the owner: "undefined", "NaN", "null", "[object Object]", a script error.
// Why: a count read "2 undefined" for a day because no check looked at the page with two items in it.
// Twice: the demo console built into docs/, and the real console of a practice firewall started for the test.
// Needs Chrome or Chromium. On a developer's machine without one the tests are skipped; in CI they must run.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findBrowser(): string | null {
  const named = process.env["CHROME_BIN"];
  if (named && fs.existsSync(named)) return named;
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) if (fs.existsSync(p)) return p;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { const p = execFileSync("which", [name], { encoding: "utf8" }).trim(); if (p) return p; } catch { /* not installed */ }
  }
  return null;
}

/** The browser to use, or null after skipping (a developer's machine) or failing (CI) the test. */
function browserOr(t: TestContext): string | null {
  const browser = findBrowser();
  if (browser !== null) return browser;
  if (process.env["CI"]) assert.fail("no Chrome or Chromium on this CI machine: the console walk cannot run");
  t.skip("no Chrome or Chromium found (set CHROME_BIN to run the console walk)");
  return null;
}

interface Walk { sums?: Record<string, number>; width?: number; demo: boolean; screens: string[]; findings: string[]; errors: string[]; threw?: string; agents?: number; sellers?: number; changes?: number; refusedValue?: string }

/** The same money must read the same on every page that shows it. Compared in cents; counts as they are. */
function sameSums(out: Walk): void {
  const s = out.sums;
  assert.ok(s, "the walk did not read the sums");
  const cents = (k: string) => Math.round((s[k] ?? NaN) * 100);
  assert.ok(cents("hourOverview") > 0 && cents("weekReport") > 0, `nothing was paid, so nothing was compared: ${JSON.stringify(s)}`);
  for (const k of ["hourAgents", "hourSellers"]) assert.equal(cents(k), cents("hourOverview"), `paid this hour: ${k} says ${s[k]}, the Overview says ${s["hourOverview"]}`);
  for (const k of ["hourStoppedAgents", "hourStoppedSellers"]) assert.equal(s[k], s["hourStoppedOverview"], `stopped this hour: ${k} says ${s[k]}, the Overview says ${s["hourStoppedOverview"]}`);
  for (const k of ["weekReportAgents", "weekReportSellers", "weekAgents", "weekSellers"]) assert.equal(cents(k), cents("weekReport"), `paid in 7 days: ${k} says ${s[k]}, the Report says ${s["weekReport"]}`);
  for (const k of ["weekStoppedWhy", "weekStoppedAgents"]) assert.equal(s[k], s["weekStoppedReport"], `stopped in 7 days: ${k} says ${s[k]}, the Report says ${s["weekStoppedReport"]}`);
}

/** Opens `url` in a fresh headless browser, runs the walk in the page and returns what it saw. */
async function walk(browser: string, url: string, phone = false, fixture = "walk.js"): Promise<Walk> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "asf-walk-"));
  const chrome = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,1500", "about:blank"], { stdio: "ignore" });
  try {
    // Chrome writes the port it chose into its profile. The loops are guards against hanging, not statements about speed.
    let debugPort = 0;
    for (let i = 0; i < 1200 && debugPort === 0; i++) {
      await sleep(50);
      try { debugPort = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { /* not written yet */ }
    }
    assert.ok(debugPort > 0, "the browser did not start");
    let wsUrl = "";
    for (let i = 0; i < 400 && wsUrl === ""; i++) {
      try {
        const tabs = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        wsUrl = tabs.find((x) => x.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch { /* not listening yet */ }
      if (wsUrl === "") await sleep(50);
    }
    assert.ok(wsUrl !== "", "the browser has no page");
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error("cannot reach the browser")); });
    let n = 0;
    const waiting = new Map<number, (v: any) => void>();
    let loaded: (() => void) | null = null;
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.method === "Page.loadEventFired" && loaded) { loaded(); loaded = null; }
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)!(msg); waiting.delete(msg.id); }
    };
    const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    await cdp("Page.enable");
    // A phone: 375 wide, touch, the narrow layout. The walk then also measures every screen against that width.
    if (phone) await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    const onLoad = new Promise<void>((r) => { loaded = r; });
    await cdp("Page.navigate", { url });
    await onLoad;
    const script = fs.readFileSync(path.join(ROOT, "test", "fixtures", fixture), "utf8");
    const answer = await cdp("Runtime.evaluate", { expression: (phone ? "window.__PHONE = true;\n" : "") + script, awaitPromise: true, returnByValue: true });
    ws.close();
    assert.equal(answer.result?.exceptionDetails, undefined, `the walk itself failed: ${JSON.stringify(answer.result?.exceptionDetails)?.slice(0, 400)}`);
    return JSON.parse(answer.result.result.value) as Walk;
  } finally {
    chrome.kill();
    for (let i = 0; i < 40; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(100); } }
  }
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".css": "text/css" };

/** The built demo console, served from docs/ on this machine. */
function serveDocs(): http.Server {
  const docs = path.join(ROOT, "docs");
  return http.createServer((req, res) => {
    const file = path.normalize(path.join(docs, decodeURIComponent((req.url ?? "/").split("?")[0]!)));
    if (!file.startsWith(docs + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
}

it("the demo console, walked end to end, shows the owner no programming slip", async (t) => {
  const browser = browserOr(t);
  if (browser === null) return;
  const server = serveDocs();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await walk(browser, `http://127.0.0.1:${(server.address() as AddressInfo).port}/console/index.html?still`);
    t.diagnostic(`demo console: ${out.screens.length} screens, ${out.agents} agent pages, ${out.sellers} seller pages, ${out.changes} changes listed`);
    assert.equal(out.demo, true);
    assert.equal(out.threw, undefined, `the walk stopped after "${out.screens.at(-1)}": ${out.threw}`);
    assert.deepEqual(out.findings, [], "text that no owner should see");
    assert.deepEqual(out.errors, [], "script errors in the console");
    assert.ok(out.screens.length >= 25, `only ${out.screens.length} screens were looked at`);
    assert.ok((out.agents ?? 0) >= 2 && (out.sellers ?? 0) >= 4, "not every agent and seller page was opened");
    assert.ok((out.changes ?? 0) >= 5, "the owner's actions did not reach the list of changes");
    assert.equal(out.refusedValue, "Most for a single payment must be a positive amount"); // the field as the page names it, not its config name
    sameSums(out);
  } finally { server.close(); }
});

it("the demo console on a phone-sized screen: the same walk, and nothing reaches past the edge", async (t) => {
  const browser = browserOr(t);
  if (browser === null) return;
  const server = serveDocs();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await walk(browser, `http://127.0.0.1:${(server.address() as AddressInfo).port}/console/index.html?still`, true);
    t.diagnostic(`demo console at 375 wide: ${out.screens.length} screens`);
    assert.equal(out.threw, undefined, `the walk stopped after "${out.screens.at(-1)}": ${out.threw}`);
    assert.equal(out.width, 375, "the browser did not take the phone's width");
    assert.deepEqual(out.findings, [], "on a phone-sized screen");
    assert.deepEqual(out.errors, [], "script errors in the console");
    assert.ok(out.screens.length >= 25, `only ${out.screens.length} screens were looked at`);
  } finally { server.close(); }
});

// The landing page, as a visitor meets it: every link, picture and button (test/fixtures/landing.js).
interface Landing { findings: string[]; errors: string[]; repoPaths: string[]; pressed: number; pictures: number; links: number; parts?: number; width?: number; threw?: string }
for (const phone of [false, true]) {
  it(`the landing page${phone ? " on a phone-sized screen" : ""}: links lead somewhere, pictures load, buttons work, nothing is broken`, async (t) => {
    const browser = browserOr(t);
    if (browser === null) return;
    const server = serveDocs();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const out = (await walk(browser, `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html`, phone, "landing.js")) as unknown as Landing;
      t.diagnostic(`landing page${phone ? " at 375 wide" : ""}: ${out.links} links, ${out.pictures} pictures, ${out.pressed} buttons pressed, ${out.parts} parts`);
      assert.equal(out.threw, undefined, `the walk stopped: ${out.threw}`);
      if (phone) assert.equal(out.width, 375, "the browser did not take the phone's width");
      assert.deepEqual(out.findings, [], "broken on the landing page");
      assert.deepEqual(out.errors, [], "script or loading errors on the landing page");
      // A link into the repository must name something that is in it.
      for (const rel of out.repoPaths) assert.ok(fs.existsSync(path.join(ROOT, decodeURIComponent(rel))), `the page links to ${rel}, which is not in the repository`);
      assert.ok(out.links >= 15 && out.pressed >= 14 && out.pictures >= 2 && (out.parts ?? 0) >= 10, "the walk did not reach the whole page");
    } finally { server.close(); }
  });
}

/** A port nothing listens on, and `count` free ports in a row after `from`. */
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const isFree = (port: number) => new Promise<boolean>((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.listen(port, "127.0.0.1", () => s.close(() => r(true))); });
async function freeRun(count: number): Promise<number> {
  for (let base = 21000 + (process.pid % 4000) * 8; base < 60000; base += 16) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await isFree(base + i);
    if (ok) return base;
  }
  throw new Error("no run of free ports");
}

it("the real console of a practice firewall, walked the same way, shows the owner no programming slip", async (t) => {
  const browser = browserOr(t);
  if (browser === null) return;
  // `npm start -- --practice` with its settings, keys and ports all its own: nothing of the developer's is read or changed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asf-walk-fw-"));
  const port = await freePort(), practice = await freeRun(8);
  const fw = spawn(process.execPath, ["src/start.ts", "--practice", "--no-open"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ASF_DIR: dir, ASF_KEY_DIR: path.join(dir, "keys"), ASF_PORT: String(port), ASF_PRACTICE_PORT: String(practice) },
  });
  let said = "";
  fw.stdout.on("data", (c) => { said += String(c); });
  fw.stderr.on("data", (c) => { said += String(c); });
  let gone = false;
  fw.on("exit", () => { gone = true; });
  try {
    // The first run ends by letting a demo agent buy a few things, so the console is not empty. A guard, not a time limit.
    for (let i = 0; i < 2400 && !gone && !/Demo agent finished\.|Practice seller did not start|Practice run skipped/.test(said); i++) await sleep(50);
    assert.match(said, /Demo agent finished\./, `the practice firewall did not come up:\n${said.slice(-1500)}`);
    const token = fs.readFileSync(path.join(dir, "admin.token"), "utf8").trim();
    const out = await walk(browser, `http://127.0.0.1:${port}/app#k=${token}`);
    t.diagnostic(`real console: ${out.screens.length} screens, ${out.agents} agent pages, ${out.sellers} seller pages, ${out.changes} changes listed; a refused value read "${out.refusedValue}"`);
    assert.equal(out.demo, false);
    assert.equal(out.threw, undefined, `the walk stopped after "${out.screens.at(-1)}": ${out.threw}`);
    assert.deepEqual(out.findings, [], "text that no owner should see");
    assert.deepEqual(out.errors, [], "script errors in the console");
    assert.ok(out.screens.length >= 22, `only ${out.screens.length} screens were looked at`);
    assert.ok((out.agents ?? 0) >= 1 && (out.sellers ?? 0) >= 3, "not every agent and seller page was opened");
    assert.ok((out.changes ?? 0) >= 5, "the owner's actions did not reach the list of changes");
    assert.ok(out.refusedValue && !/_usd|\bnull\b/.test(out.refusedValue), `a refused value was told in the firewall's inside words: ${out.refusedValue}`);
    t.diagnostic(`real console sums: ${JSON.stringify(out.sums)}`);
    sameSums(out);
  } finally {
    fw.kill("SIGINT");
    for (let i = 0; i < 200 && !gone; i++) await sleep(50);
    if (!gone) fw.kill("SIGKILL");
    for (let i = 0; i < 40; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(100); } }
  }
});
