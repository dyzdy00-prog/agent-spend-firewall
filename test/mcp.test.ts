// Tests for M7 (contracts/M7-mcp.md). Written by the builder, with the code in view.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const TOKEN = "t0ken-for-tests-" + "x".repeat(20);
let dir = "";
let tokenFile = "";
let fw: http.Server;
let fwUrl = "";
let seenAuth: string[] = [];
let seenUrls: string[] = [];
let reply: { code: number; json: unknown } = { code: 200, json: {} };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asf-mcp-"));
  tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, TOKEN + "\n", { mode: 0o600 });
  fw = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization));
    seenUrls.push(String(req.url));
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.code, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((r) => fw.listen(0, "127.0.0.1", r));
  fwUrl = `http://127.0.0.1:${(fw.address() as AddressInfo).port}`;
});
after(() => {
  fw.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the MCP server, send lines, collect parsed replies (and exit code, stdout, stderr). */
function run(lines: string[], env: Record<string, string> = {}, waitMs = 1500) {
  return new Promise<{ replies: any[]; stdout: string; stderr: string; code: number | null }>((resolve) => {
    const p = spawn(process.execPath, ["src/mcp.ts"], {
      env: { ...process.env, ASF_FIREWALL_URL: fwUrl, ASF_AGENT_TOKEN_FILE: tokenFile, ...env },
    });
    let out = "", errOut = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (errOut += d));
    for (const l of lines) p.stdin.write(l + "\n");
    const t = setTimeout(() => p.kill(), waitMs);
    p.on("exit", (code) => {
      clearTimeout(t);
      const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      resolve({ replies, stdout: out, stderr: errOut, code });
    });
  });
}
const req = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const call = (id: number, url: string) => req(id, "tools/call", { name: "fetch_paid_resource", arguments: { url } });

describe("M7 MCP interface", () => {
  it("initialize negotiates the protocol version", async () => {
    const { replies } = await run([
      req(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
      req(2, "initialize", { protocolVersion: "1999-01-01" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      req(3, "ping"),
    ]);
    assert.equal(replies.length, 3, "notification gets no reply");
    assert.equal(replies[0].result.protocolVersion, "2025-03-26");
    assert.equal(replies[1].result.protocolVersion, "2025-06-18");
    assert.deepEqual(replies[0].result.capabilities, { tools: {} });
    assert.deepEqual(replies[2].result, {});
  });

  it("tools/list has three tools: find_paid_resources (query), fetch_paid_resource (url), spend_report (no arguments)", async () => {
    const { replies } = await run([req(1, "tools/list")]);
    const tools = replies[0].result.tools;
    assert.equal(tools.length, 3);
    assert.equal(tools[0].name, "find_paid_resources");
    assert.deepEqual(tools[0].inputSchema.required, ["query"]);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ["query", "max_usd"]);
    assert.match(tools[0].description, /before guessing URLs/);
    assert.equal(tools[1].name, "fetch_paid_resource");
    assert.deepEqual(tools[1].inputSchema.required, ["url"]);
    assert.equal(tools[2].name, "spend_report");
    assert.deepEqual(tools[2].inputSchema.properties, {});
    assert.match(tools[1].description, /spend_report/);
    assert.match(tools[2].description, /largest single payment/);
  });

  it("find_paid_resources calls /search with the bearer and renders readable lines", async () => {
    seenAuth = []; seenUrls = [];
    reply = { code: 200, json: {
      fetchedAt: Date.now() - 3 * 3_600_000, total: 12,
      results: [
        { url: "https://a.example/weather", description: "Forecast by city", source: "cdp", payable: true,
          offers: [{ network: "eip155:8453", asset: "0x8335", usd: "0.001", payTo: "0xab" }] },
        { url: "https://b.example/sol", description: "", source: "payai", payable: false,
          offers: [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjF", usd: null, payTo: "9x" }] },
      ],
    } };
    const a = await run([req(1, "tools/call", { name: "find_paid_resources", arguments: { query: "weather forecast", max_usd: 0.05 } })]);
    const text = a.replies[0].result.content[0].text as string;
    assert.equal(a.replies[0].result.isError, undefined);
    assert.match(text, /^2 of 12 matches \(catalog 3 h old/);
    assert.match(text, /^\$0\.001  base  https:\/\/a\.example\/weather  \[payable\]  — Forecast by city$/m);
    assert.match(text, /^\$\?  solana  https:\/\/b\.example\/sol  \[not payable\]$/m);
    assert.match(text, /third-party and unverified/);
    assert.match(text, /re-checked/);
    assert.deepEqual(seenAuth, [`Bearer ${TOKEN}`]);
    assert.equal(seenUrls[0], "/search?q=weather+forecast&max_usd=0.05");
    assert.ok(!a.stdout.includes(TOKEN));
    // without max_usd, and an empty result
    seenUrls = [];
    reply = { code: 200, json: { fetchedAt: Date.now(), total: 0, results: [] } };
    const b = await run([req(1, "tools/call", { name: "find_paid_resources", arguments: { query: "x" } })]);
    assert.match(b.replies[0].result.content[0].text, /^No matches \(catalog 1 min old\)\./);
    assert.equal(seenUrls[0], "/search?q=x");
  });

  it("find_paid_resources: bad arguments are protocol errors; 503, 401 and a dead firewall are isError", async () => {
    const bad = await run([
      req(1, "tools/call", { name: "find_paid_resources", arguments: {} }),
      req(2, "tools/call", { name: "find_paid_resources", arguments: { query: "  " } }),
      req(3, "tools/call", { name: "find_paid_resources", arguments: { query: "a", max_usd: "5" } }),
      req(4, "tools/call", { name: "find_paid_resources", arguments: { query: "a", max_usd: -1 } }),
    ]);
    for (const r of bad.replies) assert.equal(r.error.code, -32602);
    reply = { code: 503, json: { error: "no catalog" } };
    const a = await run([req(1, "tools/call", { name: "find_paid_resources", arguments: { query: "a" } })]);
    assert.equal(a.replies[0].result.isError, true);
    assert.match(a.replies[0].result.content[0].text, /no service catalog loaded/);
    reply = { code: 401, json: { error: "x" } };
    const b = await run([req(1, "tools/call", { name: "find_paid_resources", arguments: { query: "a" } })]);
    assert.equal(b.replies[0].result.isError, true);
    assert.match(b.replies[0].result.content[0].text, /HTTP 401/);
    const c = await run([req(1, "tools/call", { name: "find_paid_resources", arguments: { query: "a" } })], { ASF_FIREWALL_URL: "http://127.0.0.1:1" });
    assert.equal(c.replies[0].result.isError, true);
    assert.match(c.replies[0].result.content[0].text, /not reachable/);
  });

  it("a cache hit reads CACHED with $0 spent", async () => {
    reply = { code: 200, json: { status: 200, paid: null, refused: null, body: "again", cached: { usd6: "10000", ageS: 42 } } };
    const { replies } = await run([call(1, "http://x.test/c")]);
    assert.match(replies[0].result.content[0].text, /^CACHED \(first paid \$0\.010000, 42 s ago\) — \$0 spent\nupstream status 200\n\nagain$/);
  });

  it("spend_report calls /report with the bearer and returns readable text", async () => {
    seenAuth = [];
    reply = { code: 200, json: {
      windowS: 3600, budgetUsd6: "5000000", spentUsd6: "20000", remainingUsd6: "4980000",
      paid: { count: 2, usd6: "20000" }, delivered: { count: 1, usd6: "10000" }, undelivered: { count: 1, usd6: "10000" },
      refused: { count: 1, byCode: { CAP: 1 } }, cached: { count: 1, savedUsd6: "10000" },
      bySeller: [{ host: "x.test", paidUsd6: "20000", delivered: 1, undelivered: 1, refused: 1, cachedSavedUsd6: "10000" }],
    } };
    const a = await run([req(1, "tools/call", { name: "spend_report", arguments: {} })]);
    const text = a.replies[0].result.content[0].text as string;
    assert.match(text, /Budget \$5\.000000, spent \$0\.020000, remaining \$4\.980000/);
    assert.match(text, /Refused: 1 \(CAP 1\)/);
    assert.match(text, /Saved by cache: \$0\.010000 in 1 repeat fetches/);
    assert.match(text, /- x\.test: paid \$0\.020000/);
    assert.deepEqual(seenAuth, [`Bearer ${TOKEN}`]);
    assert.ok(!a.stdout.includes(TOKEN));
    assert.match(text, /^Spend report, last 1 h/); // a firewall without `limits` still gives the old report
    const base = reply.json as Record<string, unknown>;
    const withLimits = async (limits: Record<string, unknown>) => {
      reply = { code: 200, json: { ...base, limits } };
      return (await run([req(1, "tools/call", { name: "spend_report", arguments: {} })])).replies[0].result.content[0].text as string;
    };
    const L = { paused: false, capUsd6: "50000", askAboveUsd6: null, windowLeftUsd6: "230000", dayLeftUsd6: null, canPayUsd6: "50000" };
    const plain = await withLimits(L);
    assert.equal(plain.split("\n")[0], "Right now one payment can be at most $0.050000 (per-payment limit $0.050000; left in this budget window $0.230000).");
    assert.equal(plain.split("\n")[1], "Spend report, last 1 h");
    const day = await withLimits({ ...L, dayLeftUsd6: "20000", canPayUsd6: "20000", askAboveUsd6: "10000" });
    assert.match(day.split("\n")[0]!, /at most \$0\.020000 \(.*left in the last-24-hours limit \$0\.020000\)\.$/);
    assert.equal(day.split("\n")[1], "A payment above $0.010000 waits for the owner's approval and is refused if they do not answer.");
    const none = await withLimits({ ...L, windowLeftUsd6: "0", canPayUsd6: "0", askAboveUsd6: "10000" });
    assert.equal(none.split("\n")[1], "Nothing can be paid at the moment: wait for the budget to free up or tell your owner.");
    assert.equal(none.includes("waits for the owner"), false);
    const paused = await withLimits({ ...L, paused: true, canPayUsd6: "0" });
    assert.match(paused.split("\n")[0]!, /^PAUSED: the owner has paused all payments\./);
    assert.equal(paused.includes("Right now"), false);
    reply = { code: 401, json: { error: "x" } };
    const b = await run([req(1, "tools/call", { name: "spend_report" })]);
    assert.equal(b.replies[0].result.isError, true);
  });

  it("paid, refused and passthrough results become status lines; token sent as bearer, never echoed", async () => {
    seenAuth = [];
    reply = { code: 200, json: { status: 200, paid: { usd6: "10000", network: "eip155:84532", payee: "0xab", tx: "0xdead" }, refused: null, body: "hello" } };
    const a = await run([call(1, "http://x.test/a")]);
    reply = { code: 200, json: { status: 402, paid: null, refused: { code: "CAP", reason: "payment exceeds per-payment cap" }, body: "" } };
    const b = await run([call(1, "http://x.test/b")]);
    reply = { code: 200, json: { status: 200, paid: null, refused: null, body: "free" } };
    const c = await run([call(1, "http://x.test/c")]);
    assert.match(a.replies[0].result.content[0].text, /^PAID \$0\.010000 on eip155:84532 \(tx 0xdead\)\nupstream status 200\n\nhello$/);
    assert.match(b.replies[0].result.content[0].text, /^REFUSED CAP: payment exceeds per-payment cap/);
    assert.equal(b.replies[0].result.isError, undefined, "a refusal is a normal result");
    assert.match(c.replies[0].result.content[0].text, /^NO PAYMENT NEEDED/);
    assert.deepEqual(seenAuth, Array(3).fill(`Bearer ${TOKEN}`));
    for (const r of [a, b, c]) assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  });

  it("long bodies are cut", async () => {
    reply = { code: 200, json: { status: 200, paid: null, refused: null, body: "y".repeat(20_000) } };
    const { replies } = await run([call(1, "http://x.test/long")]);
    assert.ok(replies[0].result.content[0].text.endsWith("[truncated]"));
  });

  it("firewall non-200 or down → isError", async () => {
    reply = { code: 401, json: { error: "x" } };
    const a = await run([call(1, "http://x.test/a")]);
    assert.equal(a.replies[0].result.isError, true);
    const b = await run([call(1, "http://x.test/a")], { ASF_FIREWALL_URL: "http://127.0.0.1:1" });
    assert.equal(b.replies[0].result.isError, true);
  });

  it("protocol errors: unknown method, malformed JSON, bad params", async () => {
    const { replies } = await run([
      req(1, "resources/list"),
      "{not json",
      req(2, "tools/call", { name: "other", arguments: { url: "http://x" } }),
      req(3, "tools/call", { name: "fetch_paid_resource", arguments: {} }),
    ]);
    assert.equal(replies[0].error.code, -32601);
    assert.equal(replies[1].error.code, -32700);
    assert.equal(replies[2].error.code, -32602);
    assert.equal(replies[3].error.code, -32602);
  });

  it("refuses to start with a loose token file or a non-loopback firewall", async () => {
    const loose = path.join(dir, "loose");
    fs.writeFileSync(loose, TOKEN, { mode: 0o644 });
    fs.chmodSync(loose, 0o644);
    const a = await run([], { ASF_AGENT_TOKEN_FILE: loose });
    assert.equal(a.code, 1);
    const b = await run([], { ASF_FIREWALL_URL: "http://example.com:8402" });
    assert.equal(b.code, 1);
    const c = await run([], { ASF_FIREWALL_URL: "https://127.0.0.1:8402" });
    assert.equal(c.code, 1);
  });
});
