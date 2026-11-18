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
let reply: { code: number; json: unknown } = { code: 200, json: {} };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asf-mcp-"));
  tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, TOKEN + "\n", { mode: 0o600 });
  fw = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization));
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

  it("tools/list has exactly one tool with a url input", async () => {
    const { replies } = await run([req(1, "tools/list")]);
    const tools = replies[0].result.tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "fetch_paid_resource");
    assert.deepEqual(tools[0].inputSchema.required, ["url"]);
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
