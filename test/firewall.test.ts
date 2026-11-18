// M6 tests: local fake seller (node:http) returning real x402 v2 402 responses. No network, no funds.
// Solana is tested only up to refusals (the library needs a live RPC for a blockhash; it has no injection hook
// besides an RPC URL, and building a fake JSON-RPC server was out of scope).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { recoverTypedDataAddress } from "viem";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { loadConfig, parseConfig, startFirewall } from "../src/firewall.ts";
import type { FirewallConfig, FetchResult, RunningFirewall } from "../src/firewall.ts";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/evm.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const PAYEE = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const TOKEN = "tok-agent-1-very-secret";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asf-fw-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ---- fake seller
interface Seen { path: string; paid: PaymentPayload | null }
interface Seller { port: number; host: string; seen: Seen[]; mode: Map<string, (n: number) => PaymentRequirements[] | "ok500" | "redirect" | "garbage" | "free">; close(): Promise<void> }

function req(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return { scheme: "exact", network: NET, asset: USDC, amount: "10000", payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...over };
}

async function startSeller(): Promise<Seller> {
  const seen: Seen[] = [];
  const mode: Seller["mode"] = new Map();
  let counter = 0;
  const server = http.createServer((rq, rs) => {
    const p = (rq.url ?? "/").split("?")[0]!;
    const sig = rq.headers["payment-signature"];
    const paid = typeof sig === "string" ? (decodePaymentSignatureHeader(sig) as unknown as PaymentPayload) : null;
    seen.push({ path: p, paid });
    const m = mode.get(p);
    const v = m ? m(++counter) : [req()];
    if (v === "redirect") { rs.writeHead(302, { location: "http://127.0.0.1:1/x" }); return void rs.end(); }
    if (v === "free") { rs.writeHead(200); return void rs.end("free content"); }
    if (v === "garbage") { rs.writeHead(402, { "payment-required": "!!!" }); return void rs.end("nope"); }
    if (paid) {
      if (v === "ok500") { rs.writeHead(500); return void rs.end("boom"); }
      rs.writeHead(200, { "payment-response": encodePaymentResponseHeader({ success: true, transaction: "0xabc123", network: paid.accepted.network, payer: "x" } as never) });
      return void rs.end("paid content");
    }
    const accepts = v === "ok500" ? [req()] : v;
    const pr: PaymentRequired = { x402Version: 2, error: "payment required", resource: { url: "http://x/" }, accepts };
    rs.writeHead(402, { "payment-required": encodePaymentRequiredHeader(pr) });
    rs.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, host: `127.0.0.1:${port}`, seen, mode, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

// ---- firewall under test
interface Rig { fw: RunningFirewall; seller: Seller; cfg: FirewallConfig; base: string; keyDir: string; logPath: string; call(url: string, token?: string): Promise<{ status: number; json: FetchResult }> }

async function rig(over: { policy?: Record<string, unknown>; payees?: Record<string, unknown> | null; allowPrivateHosts?: string[] } = {}): Promise<Rig> {
  const seller = await startSeller();
  const dir = fs.mkdtempSync(path.join(tmpRoot, "r-"));
  const keyDir = path.join(dir, "keys");
  const logPath = path.join(dir, "decisions.jsonl");
  const payees = over.payees === undefined ? { [seller.host]: { evm: [PAYEE] } } : (over.payees ?? {});
  const raw = {
    listen: { host: "127.0.0.1", port: 0 }, keyDir, storePath: path.join(dir, "state.db"), logPath,
    svmRpcUrl: "http://127.0.0.1:1",
    // local fake sellers live on loopback; the SSRF guard blocks loopback unless allowlisted
    allowPrivateHosts: over.allowPrivateHosts ?? [seller.host],
    agents: { [sha(TOKEN)]: "agent-1" },
    assets: [{ network: NET, asset: USDC, decimals: 6, usd_per_unit: "1", evm_domain: { name: "USDC", version: "2" } }],
    policy: {
      networks: [NET], cap_usd: "1", budget_usd: "10", window_s: 3600, max_validity_s: 300, min_amount_usd: "0.000001",
      max_signatures_per_window: 100, known_hosts_only: false, payees, block_after_undelivered: 0, undelivered_window_s: 3600,
      agents: { "agent-1": { budget_usd: "5" } }, ...over.policy,
    },
  };
  const cfg = parseConfig(raw);
  const fw = await startFirewall(cfg);
  const base = `http://127.0.0.1:${fw.port}`;
  const call = async (url: string, token: string = TOKEN) => {
    const r = await fetch(`${base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url }) });
    return { status: r.status, json: (await r.json()) as FetchResult };
  };
  return { fw, seller, cfg, base, keyDir, logPath, call };
}
async function done(r: Rig) { await r.fw.close(); await r.seller.close(); }
const readLog = (r: Rig) => fs.readFileSync(r.logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const paidHeaders = (r: Rig) => r.seller.seen.filter((s) => s.paid);

describe("M6 firewall", () => {
  it("unknown, missing and malformed tokens -> 401; no seller contact", async () => {
    const r = await rig();
    try {
      assert.equal((await r.call(`http://${r.seller.host}/a`, "wrong")).status, 401);
      const none = await fetch(`${r.base}/fetch`, { method: "POST", body: JSON.stringify({ url: "http://x/" }) });
      assert.equal(none.status, 401);
      const basic = await fetch(`${r.base}/fetch`, { method: "POST", headers: { authorization: `Basic ${TOKEN}` }, body: "{}" });
      assert.equal(basic.status, 401);
      assert.equal(r.seller.seen.length, 0);
    } finally { await done(r); }
  });

  it("oversized body -> 413; bad url -> 400; bad json -> 400", async () => {
    const r = await rig();
    try {
      const big = await fetch(`${r.base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ url: "http://a/" + "x".repeat(9000) }) });
      assert.equal(big.status, 413);
      assert.equal((await r.call("ftp://x/")).status, 400);
      const bad = await fetch(`${r.base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{{" });
      assert.equal(bad.status, 400);
    } finally { await done(r); }
  });

  it("non-loopback listen host refused at startup", async () => {
    const r = await rig();
    try {
      for (const host of ["0.0.0.0", "192.168.1.5", "::", "example.com"]) {
        await assert.rejects(startFirewall({ ...r.cfg, listen: { host, port: 0 }, storePath: path.join(tmpRoot, "x.db") }), /loopback/);
      }
    } finally { await done(r); }
  });

  it("serves from loopback only: foreign Host header -> 403", async () => {
    const r = await rig();
    try {
      const res = await new Promise<number>((resolve, reject) => {
        const q = http.request({ host: "127.0.0.1", port: r.fw.port, path: "/api/log", headers: { host: "evil.example" } }, (s) => { s.resume(); resolve(s.statusCode ?? 0); });
        q.on("error", reject); q.end();
      });
      assert.equal(res, 403);
    } finally { await done(r); }
  });

  it("redirect is refused (HOST/redirect) and not followed", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/r", () => "redirect");
      const { json } = await r.call(`http://${r.seller.host}/r`);
      assert.equal(json.status, 502);
      assert.deepEqual(json.refused, { code: "HOST", reason: "redirect" });
      assert.equal(json.paid, null);
      assert.equal(r.seller.seen.length, 1);
    } finally { await done(r); }
  });

  it("SSRF (#8): a loopback seller that is not allowlisted is refused before any contact", async () => {
    const r = await rig({ allowPrivateHosts: [] });
    try {
      r.seller.mode.set("/f", () => "free");
      for (const u of [`http://${r.seller.host}/f`, `http://localhost:${r.seller.host.split(":")[1]}/f`]) {
        const { json } = await r.call(u);
        assert.deepEqual(json.refused, { code: "HOST", reason: "private or internal address" });
      }
      assert.equal(r.seller.seen.length, 0);
    } finally { await done(r); }
  });

  it("non-402 passes through unpaid", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/f", () => "free");
      const { json } = await r.call(`http://${r.seller.host}/f`);
      assert.deepEqual({ status: json.status, paid: json.paid, refused: json.refused, body: json.body }, { status: 200, paid: null, refused: null, body: "free content" });
    } finally { await done(r); }
  });

  it("unparseable 402 -> FORMAT, nothing signed", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/g", () => "garbage");
      const { json } = await r.call(`http://${r.seller.host}/g`);
      assert.equal(json.refused?.code, "FORMAT");
      assert.equal(paidHeaders(r).length, 0);
    } finally { await done(r); }
  });

  it("requirement on an unsupported network refused before any signing (NETWORK), also Solana", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/n1", () => [req({ network: "eip155:1" })]);
      r.seller.mode.set("/n2", () => [req({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", payTo: "11111111111111111111111111111112" })]);
      for (const p of ["/n1", "/n2"]) {
        const { json } = await r.call(`http://${r.seller.host}${p}`);
        assert.equal(json.refused?.code, "NETWORK");
        assert.equal(json.paid, null);
      }
      assert.equal(paidHeaders(r).length, 0);
      assert.equal(readLog(r).every((l) => l.allow === false && l.code === "NETWORK"), true);
    } finally { await done(r); }
  });

  it("unaccepted asset -> ASSET; malformed amount -> FORMAT", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/a", () => [req({ asset: "0x4444444444444444444444444444444444444444" })]);
      r.seller.mode.set("/m", () => [req({ amount: "1.5" })]);
      assert.equal((await r.call(`http://${r.seller.host}/a`)).json.refused?.code, "ASSET");
      assert.equal((await r.call(`http://${r.seller.host}/m`)).json.refused?.code, "FORMAT");
      assert.equal(paidHeaders(r).length, 0);
    } finally { await done(r); }
  });

  it("falls through to the first acceptable requirement", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/x", () => [req({ network: "eip155:1" }), req()]);
      const { json } = await r.call(`http://${r.seller.host}/x`);
      assert.equal(json.status, 200);
      assert.equal(json.paid?.network, NET);
    } finally { await done(r); }
  });

  it("CAP refused: logged, nothing signed", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/c", () => [req({ amount: "2000000" })]);
      const { json } = await r.call(`http://${r.seller.host}/c`);
      assert.equal(json.refused?.code, "CAP");
      assert.equal(json.paid, null);
      assert.equal(paidHeaders(r).length, 0);
      const log = readLog(r);
      assert.equal(log.length, 1);
      assert.equal(log[0].allow, false);
      assert.equal(log[0].code, "CAP");
      assert.equal(log[0].usd6, "2000000");
    } finally { await done(r); }
  });

  it("PAYEE refused (not in allowlist): logged, nothing signed", async () => {
    const r = await rig();
    try {
      r.seller.mode.set("/p", () => [req({ payTo: OTHER })]);
      const { json } = await r.call(`http://${r.seller.host}/p`);
      assert.equal(json.refused?.code, "PAYEE");
      assert.equal(paidHeaders(r).length, 0);
      assert.equal(readLog(r)[0].code, "PAYEE");
    } finally { await done(r); }
  });

  it("BUDGET refused after the budget is used up", async () => {
    const r = await rig({ policy: { budget_usd: "0.015" } });
    try {
      const u = `http://${r.seller.host}/b`;
      assert.equal((await r.call(u)).json.status, 200);
      const second = (await r.call(u)).json;
      assert.equal(second.refused?.code, "BUDGET");
      assert.equal(paidHeaders(r).length, 1);
      const log = readLog(r);
      assert.deepEqual(log.map((l) => [l.allow, l.code]), [[true, undefined], [false, "BUDGET"]]);
    } finally { await done(r); }
  });

  it("allowed payment: header decodes at the seller and signed values match the requirement", async () => {
    const r = await rig();
    try {
      const { json } = await r.call(`http://${r.seller.host}/ok?x=1`);
      assert.equal(json.status, 200);
      assert.equal(json.body, "paid content");
      assert.deepEqual(json.paid, { usd6: "10000", network: NET, payee: PAYEE, tx: "0xabc123" });
      assert.equal(json.refused, null);

      const p = paidHeaders(r);
      assert.equal(p.length, 1);
      const pay = p[0]!.paid!;
      assert.equal(pay.x402Version, 2);
      assert.deepEqual(pay.accepted, req());
      const auth = pay.payload.authorization as Record<string, string>;
      const sig = pay.payload.signature as `0x${string}`;
      assert.equal(auth.to.toLowerCase(), PAYEE);
      assert.equal(auth.value, "10000");
      assert.equal(auth.from.toLowerCase(), r.fw.firewall.addresses.evm.toLowerCase());
      const signer = await recoverTypedDataAddress({
        domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization",
        message: { from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` },
        signature: sig,
      });
      assert.equal(signer.toLowerCase(), r.fw.firewall.addresses.evm.toLowerCase());
      const log = readLog(r);
      assert.equal(log.length, 1);
      assert.equal(log[0].allow, true);
      assert.equal(log[0].delivered, true);
      assert.equal(log[0].tx, "0xabc123");
    } finally { await done(r); }
  });

  it("seller 500 after payment -> undelivered; host blocked (UNDELIVERED) at the threshold", async () => {
    const r = await rig({ policy: { block_after_undelivered: 2, undelivered_window_s: 3600 } });
    try {
      r.seller.mode.set("/u", () => "ok500");
      const u = `http://${r.seller.host}/u`;
      for (let i = 0; i < 2; i++) {
        const { json } = await r.call(u);
        assert.equal(json.status, 500);
        assert.ok(json.paid, "payment was made");
      }
      const third = (await r.call(u)).json;
      assert.equal(third.refused?.code, "UNDELIVERED");
      assert.equal(third.paid, null);
      assert.equal(paidHeaders(r).length, 2);
      const log = readLog(r);
      assert.deepEqual(log.map((l) => [l.allow, l.delivered, l.code]), [[true, false, undefined], [true, false, undefined], [false, undefined, "UNDELIVERED"]]);
    } finally { await done(r); }
  });

  it("log lines hold no token, key material, URL path or query", async () => {
    const r = await rig();
    try {
      const u = `http://${r.seller.host}/very-secret-path-123?apikey=hunter2`;
      await r.call(u);
      r.seller.mode.set("/cap-secret-path", () => [req({ amount: "9000000" })]);
      await r.call(`http://${r.seller.host}/cap-secret-path?q=zzz`);
      const text = fs.readFileSync(r.logPath, "utf8");
      const evmKey = fs.readFileSync(path.join(r.keyDir, "evm.key"), "utf8").trim();
      for (const bad of [TOKEN, sha(TOKEN), evmKey, evmKey.slice(2), "very-secret-path", "hunter2", "cap-secret-path", "zzz"]) {
        assert.equal(text.includes(bad), false, `log must not contain ${bad.slice(0, 6)}...`);
      }
      assert.ok(text.includes(r.seller.host));
      const viaApi = await (await fetch(`${r.base}/api/log?limit=1`)).json() as Array<{ code?: string }>;
      assert.equal(viaApi.length, 1);
      assert.equal(viaApi[0]!.code, "CAP"); // newest first
    } finally { await done(r); }
  });

  it("GET / serves dashboard.html from disk, 404 when missing", async () => {
    const r = await rig();
    try {
      const exists = fs.existsSync(path.join(import.meta.dirname, "../src/dashboard.html"));
      const res = await fetch(`${r.base}/`);
      assert.equal(res.status, exists ? 200 : 404);
      await res.arrayBuffer();
    } finally { await done(r); }
  });
});

describe("loadConfig", () => {
  const good = (dir: string) => ({
    listen: { host: "127.0.0.1", port: 8402 }, keyDir: "~/k", storePath: "~/s.db", logPath: path.join(dir, "l.jsonl"),
    agents: { [sha("t")]: "a" }, assets: [],
    policy: { networks: [NET], cap_usd: "1", budget_usd: "10", window_s: 60, max_validity_s: 300, min_amount_usd: "0.01", max_signatures_per_window: 5, known_hosts_only: false, payees: {}, block_after_undelivered: 0, undelivered_window_s: 0, agents: { a: { budget_usd: "1" } } },
  });
  it("parses, expands ~ and fills policy.assets from the top level", () => {
    const f = path.join(tmpRoot, "c.json");
    fs.writeFileSync(f, JSON.stringify(good(tmpRoot)));
    const c = loadConfig(f);
    assert.equal(c.keyDir, path.join(os.homedir(), "k"));
    assert.equal(c.storePath, path.join(os.homedir(), "s.db"));
    assert.equal(c.policy.assets, c.assets);
  });
  it("rejects bad input", () => {
    const g = good(tmpRoot) as Record<string, any>;
    const mut = (f: (c: Record<string, any>) => void) => { const c = structuredClone(g); f(c); return c; };
    assert.throws(() => loadConfig(path.join(tmpRoot, "missing.json")), /cannot read/);
    fs.writeFileSync(path.join(tmpRoot, "bad.json"), "{");
    assert.throws(() => loadConfig(path.join(tmpRoot, "bad.json")), /not valid JSON/);
    assert.throws(() => parseConfig(mut((c) => { c.agents = { plain: "a" }; })), /sha256/);
    assert.throws(() => parseConfig(mut((c) => { c.policy.cap_usd = "1e3"; })), /cap_usd/);
    assert.throws(() => parseConfig(mut((c) => { c.policy.cap_usd = 1; })), /cap_usd/);
    assert.throws(() => parseConfig(mut((c) => { c.policy.window_s = 0; })), /window_s/);
    assert.throws(() => parseConfig(mut((c) => { c.policy.networks = ["solana:abc"]; c.policy.max_validity_s = 300; })), /svmRpcUrl/);
    assert.throws(() => parseConfig(mut((c) => { c.policy.assets = []; })), /policy.assets/);
    assert.throws(() => parseConfig(mut((c) => { delete c.logPath; })), /logPath/);
  });
});
