// Walks the whole demo console in a headless browser (test/fixtures/walk.js) and fails on any programming slip
// shown to the owner: "undefined", "NaN", "null", "[object Object]", a script error.
// Why: a count read "2 undefined" for a day because no check looked at the page with two items in it.
// Needs Chrome or Chromium. On a developer's machine without one the test is skipped; in CI it must run.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
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

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".css": "text/css" };

it("the demo console, walked end to end, shows the owner no programming slip", async (t) => {
  const browser = findBrowser();
  if (browser === null) {
    if (process.env["CI"]) assert.fail("no Chrome or Chromium on this CI machine: the console walk cannot run");
    t.skip("no Chrome or Chromium found (set CHROME_BIN to run the console walk)");
    return;
  }
  // The built demo console, served from docs/ on this machine.
  const docs = path.join(ROOT, "docs");
  const server = http.createServer((req, res) => {
    const file = path.normalize(path.join(docs, decodeURIComponent((req.url ?? "/").split("?")[0]!)));
    if (!file.startsWith(docs + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "asf-walk-"));
  const chrome = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,1500", "about:blank"], { stdio: "ignore" });
  try {
    // Chrome writes the port it chose into its profile. The loop is a guard against hanging, not a statement about speed.
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
    const onLoad = new Promise<void>((r) => { loaded = r; });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/console/index.html?still` });
    await onLoad;
    const walk = fs.readFileSync(path.join(ROOT, "test", "fixtures", "walk.js"), "utf8");
    const answer = await cdp("Runtime.evaluate", { expression: walk, awaitPromise: true, returnByValue: true });
    ws.close();
    assert.equal(answer.result?.exceptionDetails, undefined, `the walk itself failed: ${JSON.stringify(answer.result?.exceptionDetails)?.slice(0, 400)}`);
    const out = JSON.parse(answer.result.result.value) as { screens: string[]; findings: string[]; errors: string[]; threw?: string; agents?: number; sellers?: number; changes?: number; refusedValue?: string };
    assert.equal(out.threw, undefined, `the walk stopped after "${out.screens.at(-1)}": ${out.threw}`);
    assert.deepEqual(out.findings, [], "text that no owner should see");
    assert.deepEqual(out.errors, [], "script errors in the console");
    assert.ok(out.screens.length >= 25, `only ${out.screens.length} screens were looked at`);
    assert.ok((out.agents ?? 0) >= 2 && (out.sellers ?? 0) >= 4, "not every agent and seller page was opened");
    assert.ok((out.changes ?? 0) >= 5, "the owner's actions did not reach the list of changes");
    assert.equal(out.refusedValue, "Most for a single payment must be a positive amount"); // the field as the page names it, not its config name
  } finally {
    chrome.kill();
    server.close();
    for (let i = 0; i < 40; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(100); } }
  }
});
