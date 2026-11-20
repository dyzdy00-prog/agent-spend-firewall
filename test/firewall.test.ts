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
const TOKEN2 = "tok-agent-2-very-secret";
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

// ---- catalog fixture: the file format `load` in src/catalog.ts expects
const CATALOG_FETCHED_AT = 1_700_000_000_000;
function catEntry(url: string, atoms: string, over: Record<string, unknown> = {}, payTo = PAYEE) {
  return {
    url, host: new URL(url).host, description: "weather data", source: "cdp",
    offers: [{ scheme: "exact", network: NET, asset: USDC, amountAtoms: atoms, payTo, usd: undefined, ...over }],
  };
}
function writeCatalog(dir: string, entries: unknown[]) {
  const withUsd = (entries as { offers: { amountAtoms: string; usd?: string }[] }[]).map((e) => ({
    ...e, offers: e.offers.map((o) => ({ ...o, usd: o.usd ?? (Number(o.amountAtoms) / 1e6).toString() })),
  }));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ version: 1, fetchedAt: CATALOG_FETCHED_AT, sources: {}, entries: withUsd }));
}

// ---- firewall under test
interface Rig { fw: RunningFirewall; seller: Seller; cfg: FirewallConfig; base: string; keyDir: string; logPath: string; call(url: string, token?: string): Promise<{ status: number; json: FetchResult }>; report(window?: number, token?: string): Promise<{ status: number; json: any }> }

async function rig(over: { policy?: Record<string, unknown>; payees?: Record<string, unknown> | null; allowPrivateHosts?: string[]; cache_ttl_s?: number; max_price_vs_catalog?: number; catalog?: unknown[]; catalogCheckMs?: number } = {}): Promise<Rig> {
  const seller = await startSeller();
  const dir = fs.mkdtempSync(path.join(tmpRoot, "r-"));
  const keyDir = path.join(dir, "keys");
  const logPath = path.join(dir, "decisions.jsonl");
  const payees = over.payees === undefined ? { [seller.host]: { evm: [PAYEE] } } : (over.payees ?? {});
  if (over.catalog !== undefined) writeCatalog(dir, over.catalog);
  const raw = {
    listen: { host: "127.0.0.1", port: 0 }, keyDir, storePath: path.join(dir, "state.db"), logPath,
    svmRpcUrl: "http://127.0.0.1:1",
    // local fake sellers live on loopback; the SSRF guard blocks loopback unless allowlisted
    allowPrivateHosts: over.allowPrivateHosts ?? [seller.host],
    ...(over.cache_ttl_s !== undefined ? { cache_ttl_s: over.cache_ttl_s } : {}),
    ...(over.max_price_vs_catalog !== undefined ? { max_price_vs_catalog: over.max_price_vs_catalog } : {}),
    agents: { [sha(TOKEN)]: "agent-1", [sha(TOKEN2)]: "agent-2" },
    assets: [{ network: NET, asset: USDC, decimals: 6, usd_per_unit: "1", evm_domain: { name: "USDC", version: "2" } }],
    policy: {
      networks: [NET], cap_usd: "1", budget_usd: "10", window_s: 3600, max_validity_s: 300, min_amount_usd: "0.000001",
      max_signatures_per_window: 100, known_hosts_only: false, payees, block_after_undelivered: 0, undelivered_window_s: 3600,
      agents: { "agent-1": { budget_usd: "5" }, "agent-2": { budget_usd: "5" } }, ...over.policy,
    },
  };
  const cfg = parseConfig(raw);
  const fw = await startFirewall(cfg, over.catalogCheckMs !== undefined ? { catalogCheckMs: over.catalogCheckMs } : {});
  const base = `http://127.0.0.1:${fw.port}`;
  const call = async (url: string, token: string = TOKEN) => {
    const r = await fetch(`${base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url }) });
    return { status: r.status, json: (await r.json()) as FetchResult };
  };
  const report = async (window?: number, token: string = TOKEN) => {
    const r = await fetch(`${base}/report${window === undefined ? "" : `?window_s=${window}`}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, json: await r.json() as any };
  };
  return { fw, seller, cfg, base, keyDir, logPath, call, report };
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("M6 paid-response cache", () => {
  it("a repeat fetch is served from memory: no seller contact, no signature, logged as cached", async () => {
    const r = await rig({ cache_ttl_s: 300 });
    try {
      const u = `http://${r.seller.host}/doc?secret=hunter2`;
      const first = (await r.call(u)).json;
      assert.equal(first.paid?.usd6, "10000");
      assert.equal(first.cached, undefined);
      const seenBefore = r.seller.seen.length;
      const second = (await r.call(u)).json;
      assert.equal(second.status, 200);
      assert.equal(second.body, "paid content");
      assert.equal(second.paid, null);
      assert.equal(second.refused, null);
      assert.equal(second.cached?.usd6, "10000");
      assert.ok(second.cached!.ageS >= 0 && second.cached!.ageS < 5);
      assert.equal(r.seller.seen.length, seenBefore, "zero seller requests");
      assert.equal(paidHeaders(r).length, 1, "zero new signatures");
      const log = readLog(r);
      assert.equal(log.length, 2);
      assert.deepEqual({ ...log[1], ts: 0 }, { ts: 0, agent: "agent-1", host: r.seller.host, network: NET, asset: USDC, payee: PAYEE, usd6: "10000", allow: true, cached: true });
      assert.equal(fs.readFileSync(r.logPath, "utf8").includes("hunter2"), false);
      // a different URL (even same path, other query) is a different entry
      await r.call(`http://${r.seller.host}/doc?secret=other`);
      assert.equal(paidHeaders(r).length, 2);
    } finally { await done(r); }
  });

  it("cache is per agent: the second agent pays for itself", async () => {
    const r = await rig({ cache_ttl_s: 300 });
    try {
      const u = `http://${r.seller.host}/shared`;
      await r.call(u);
      const other = (await r.call(u, TOKEN2)).json;
      assert.equal(other.cached, undefined);
      assert.equal(other.paid?.usd6, "10000");
      assert.equal(paidHeaders(r).length, 2);
      assert.ok((await r.call(u, TOKEN2)).json.cached);
      assert.equal(paidHeaders(r).length, 2);
    } finally { await done(r); }
  });

  it("an entry expires after cache_ttl_s and the next fetch pays again", async () => {
    const r = await rig({ cache_ttl_s: 1 });
    try {
      const u = `http://${r.seller.host}/ttl`;
      await r.call(u);
      assert.ok((await r.call(u)).json.cached);
      await sleep(1150);
      const again = (await r.call(u)).json;
      assert.equal(again.cached, undefined);
      assert.equal(again.paid?.usd6, "10000");
      assert.equal(paidHeaders(r).length, 2);
    } finally { await done(r); }
  });

  it("refusals, undelivered and free responses are never cached", async () => {
    const r = await rig({ cache_ttl_s: 300 });
    try {
      r.seller.mode.set("/cap", () => [req({ amount: "2000000" })]);
      r.seller.mode.set("/u", () => "ok500");
      r.seller.mode.set("/f", () => "free");
      for (const p of ["/cap", "/u", "/f"]) {
        const a = (await r.call(`http://${r.seller.host}${p}`)).json;
        const n = r.seller.seen.length;
        const b = (await r.call(`http://${r.seller.host}${p}`)).json;
        assert.equal(a.cached, undefined, p);
        assert.equal(b.cached, undefined, p);
        assert.ok(r.seller.seen.length > n, `${p} contacts the seller again`);
      }
      assert.equal(readLog(r).some((l) => l.cached === true), false);
    } finally { await done(r); }
  });

  it("cache_ttl_s 0 (and omitted) disables the cache", async () => {
    for (const ttl of [0, undefined]) {
      const r = await rig(ttl === undefined ? {} : { cache_ttl_s: ttl });
      try {
        const u = `http://${r.seller.host}/off`;
        await r.call(u);
        const b = (await r.call(u)).json;
        assert.equal(b.cached, undefined);
        assert.equal(paidHeaders(r).length, 2);
      } finally { await done(r); }
    }
  });

  it("config validation: cache_ttl_s must be an integer >= 0", () => {
    const base = {
      listen: { host: "127.0.0.1", port: 8402 }, keyDir: "~/k", storePath: "~/s.db", logPath: "~/l.jsonl", agents: { [sha("t")]: "a" }, assets: [],
      policy: { networks: [NET], cap_usd: "1", budget_usd: "10", window_s: 60, max_validity_s: 300, min_amount_usd: "0.01", max_signatures_per_window: 5, known_hosts_only: false, payees: {}, block_after_undelivered: 0, undelivered_window_s: 0, agents: { a: { budget_usd: "1" } } },
    };
    assert.equal(parseConfig(base).cache_ttl_s, 0);
    assert.equal(parseConfig({ ...base, cache_ttl_s: 300 }).cache_ttl_s, 300);
    for (const bad of [-1, 1.5, "300", null, Number.NaN, 86_400 * 31]) {
      assert.throws(() => parseConfig({ ...base, cache_ttl_s: bad }), /cache_ttl_s/, String(bad));
    }
  });
});

describe("M6 GET /report", () => {
  it("numbers for a scripted history; other agents excluded; 401 without a token", async () => {
    const r = await rig({ cache_ttl_s: 300 });
    try {
      r.seller.mode.set("/u", () => "ok500");
      r.seller.mode.set("/cap", () => [req({ amount: "2000000" })]);
      const h = r.seller.host;
      await r.call(`http://${h}/d`);            // allowed, delivered
      await r.call(`http://${h}/d`);            // cache hit
      await r.call(`http://${h}/u`);            // allowed, undelivered
      await r.call(`http://${h}/cap`);          // refused CAP
      await r.call(`http://${h}/d`, TOKEN2);    // agent-2 pays; must not show up for agent-1
      const { status, json } = await r.report();
      assert.equal(status, 200);
      assert.deepEqual(json, {
        windowS: 3600, budgetUsd6: "5000000", spentUsd6: "20000", remainingUsd6: "4980000",
        paid: { count: 2, usd6: "20000" }, delivered: { count: 1, usd6: "10000" }, undelivered: { count: 1, usd6: "10000" },
        refused: { count: 1, byCode: { CAP: 1 } }, cached: { count: 1, savedUsd6: "10000" },
        bySeller: [{ host: h, paidUsd6: "20000", delivered: 1, undelivered: 1, refused: 1, cachedSavedUsd6: "10000" }],
        limits: { paused: false, capUsd6: "1000000", askAboveUsd6: null, windowLeftUsd6: "4980000", dayLeftUsd6: null, canPayUsd6: "1000000" },
      });
      const two = (await r.report(undefined, TOKEN2)).json;
      assert.equal(two.spentUsd6, "10000");
      assert.equal(two.refused.count, 0);
      assert.equal(two.cached.count, 0);
      assert.equal((await fetch(`${r.base}/report`)).status, 401);
      assert.equal((await r.report(undefined, "wrong")).status, 401);
    } finally { await done(r); }
  });

  it("window_s filters the log; bad values -> 400; no log yet -> zeros", async () => {
    const r = await rig();
    try {
      const empty = (await r.report()).json;
      assert.equal(empty.spentUsd6, "0");
      assert.equal(empty.remainingUsd6, "5000000");
      assert.deepEqual(empty.bySeller, []);
      const now = Math.floor(Date.now() / 1000);
      const line = (ts: number, extra: object) => JSON.stringify({ ts, agent: "agent-1", host: "old.example", network: NET, asset: USDC, payee: PAYEE, ...extra }) + "\n";
      fs.appendFileSync(r.logPath, line(now - 7200, { amountAtoms: "5000", usd6: "5000", allow: true, delivered: true }) + line(now - 10, { amountAtoms: "7000", usd6: "7000", allow: true, delivered: true }) + "not json\n");
      assert.equal((await r.report()).json.spentUsd6, "7000");
      assert.equal((await r.report(86_400)).json.spentUsd6, "12000");
      assert.equal((await r.report(5)).json.spentUsd6, "0");
      assert.equal((await r.report(99_999_999)).json.windowS, 30 * 86_400);
      for (const w of [0, -5]) assert.equal((await r.report(w)).status, 400);
      const junk = await fetch(`${r.base}/report?window_s=abc`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(junk.status, 400);
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

// ---- catalog: price check and /search
describe("M6 catalog price check", () => {
  const sellerUrl = (r: Rig, p: string) => `http://${r.seller.host}${p}`;
  // the seller asks 10000 atoms ($0.01); the catalog lists the same URL at another price
  async function rigWith(listed: string, ratio: number | undefined, listedPayTo = PAYEE): Promise<Rig> {
    // the seller's port is only known after rig() starts it, so the catalog is written afterwards (catalogCheckMs: 0 picks it up)
    const r = await rig({ max_price_vs_catalog: ratio, catalogCheckMs: 0 });
    writeCatalog(path.dirname(r.cfg.storePath), [catEntry(sellerUrl(r, "/w"), listed, {}, listedPayTo)]);
    return r;
  }

  it("OVERPRICED: refused, nothing signed, logged with a rounded ratio and no policy numbers", async () => {
    const r = await rigWith("100", 3); // listed 100 atoms, asks 10000 -> 100x
    try {
      const { json } = await r.call(sellerUrl(r, "/w"));
      assert.equal(json.refused?.code, "OVERPRICED");
      assert.equal(json.refused?.reason, "asks 100x the catalog price");
      assert.equal(json.paid, null);
      assert.equal(paidHeaders(r).length, 0);
      const log = readLog(r);
      assert.equal(log.length, 1);
      assert.equal(log[0].allow, false);
      assert.equal(log[0].code, "OVERPRICED");
      assert.ok(!/\b3\b/.test(log[0].reason), "the configured ratio is not revealed");
    } finally { await done(r); }
  });

  it("exactly at the ratio is allowed; just over is refused", async () => {
    const r = await rigWith("3333", 3); // 10000 <= 3333*3 = 9999? no: 10000 > 9999 -> refused
    try {
      assert.equal((await r.call(sellerUrl(r, "/w"))).json.refused?.code, "OVERPRICED");
    } finally { await done(r); }
    const r2 = await rigWith("3334", 3); // 3334*3 = 10002 >= 10000 -> allowed
    try {
      assert.equal((await r2.call(sellerUrl(r2, "/w"))).json.paid?.usd6, "10000");
    } finally { await done(r2); }
    const r3 = await rigWith("5000", 2); // exactly 2x
    try {
      assert.equal((await r3.call(sellerUrl(r3, "/w"))).json.status, 200);
      assert.equal(readLog(r3)[0].allow, true);
    } finally { await done(r3); }
  });

  it("a URL the catalog does not know passes as before", async () => {
    const r = await rigWith("100", 3);
    try {
      const { json } = await r.call(sellerUrl(r, "/other"));
      assert.equal(json.status, 200);
      assert.equal(json.paid?.usd6, "10000");
    } finally { await done(r); }
  });

  it("without max_price_vs_catalog there is no check", async () => {
    const r = await rigWith("100", undefined);
    try {
      const { json } = await r.call(sellerUrl(r, "/w"));
      assert.equal(json.paid?.usd6, "10000");
      assert.equal(readLog(r)[0].catalogPayeeChanged, undefined);
    } finally { await done(r); }
  });

  it("no catalog file at all: payments go through", async () => {
    const r = await rig({ max_price_vs_catalog: 1, catalogCheckMs: 0 });
    try { assert.equal((await r.call(sellerUrl(r, "/w"))).json.status, 200); } finally { await done(r); }
  });

  it("a changed payee is not refused here but flagged in the log line", async () => {
    const r = await rigWith("10000", 3, OTHER); // catalog lists another payee; the policy allows PAYEE
    try {
      const { json } = await r.call(sellerUrl(r, "/w"));
      assert.equal(json.status, 200);
      const log = readLog(r);
      assert.equal(log[0].allow, true);
      assert.equal(log[0].catalogPayeeChanged, true);
    } finally { await done(r); }
    const r2 = await rigWith("10000", 3, PAYEE);
    try {
      await r2.call(sellerUrl(r2, "/w"));
      assert.equal(readLog(r2)[0].catalogPayeeChanged, undefined);
    } finally { await done(r2); }
  });

  it("catalog is reloaded when the file's mtime changes, and a missing file clears it", async () => {
    const r = await rig({ max_price_vs_catalog: 3, catalogCheckMs: 0 });
    const dir = path.dirname(r.cfg.storePath);
    try {
      assert.equal((await r.call(sellerUrl(r, "/w"))).json.status, 200); // no catalog yet
      writeCatalog(dir, [catEntry(sellerUrl(r, "/w2"), "100")]);
      fs.utimesSync(path.join(dir, "catalog.json"), new Date(), new Date(Date.now() + 5000));
      assert.equal((await r.call(sellerUrl(r, "/w2"))).json.refused?.code, "OVERPRICED");
      fs.rmSync(path.join(dir, "catalog.json"));
      assert.equal((await r.call(sellerUrl(r, "/w2"))).json.status, 200);
    } finally { await done(r); }
  });

  it("file checks are rate limited (default 60 s): a changed file is not seen sooner", async () => {
    const r = await rig({ max_price_vs_catalog: 3 }); // default check interval
    const dir = path.dirname(r.cfg.storePath);
    try {
      writeCatalog(dir, [catEntry(sellerUrl(r, "/w"), "100")]);
      assert.equal((await r.call(sellerUrl(r, "/w"))).json.status, 200);
    } finally { await done(r); }
  });

  it("config: catalogDir defaults to the store directory; max_price_vs_catalog must be >= 1", () => {
    const base = {
      listen: { host: "127.0.0.1", port: 8402 }, keyDir: "~/k", storePath: "/a/b/s.db", logPath: "/a/b/l.jsonl",
      agents: { [sha("t")]: "a" }, assets: [],
      policy: { networks: [NET], cap_usd: "1", budget_usd: "10", window_s: 60, max_validity_s: 300, min_amount_usd: "0.01", max_signatures_per_window: 5, known_hosts_only: false, payees: {}, block_after_undelivered: 0, undelivered_window_s: 0, agents: {} },
    };
    assert.equal(parseConfig(base).catalogDir, "/a/b");
    assert.equal(parseConfig(base).max_price_vs_catalog, undefined);
    assert.equal(parseConfig({ ...base, catalogDir: "~/c", max_price_vs_catalog: 3 }).catalogDir, path.join(os.homedir(), "c"));
    assert.equal(parseConfig({ ...base, max_price_vs_catalog: 1 }).max_price_vs_catalog, 1);
    for (const v of [0.5, 0, -1, "3", NaN, null]) assert.throws(() => parseConfig({ ...base, max_price_vs_catalog: v }), /max_price_vs_catalog/);
    assert.throws(() => parseConfig({ ...base, catalogDir: "" }), /catalogDir/);
  });
});

describe("M6 GET /search", () => {
  const entries = (): unknown[] => [
    catEntry("https://a.example/weather", "1000"),
    { ...catEntry("https://b.example/weather-pro", "5000"), description: "weather " + "x".repeat(400) },
    { ...catEntry("https://c.example/stocks", "2000", { network: "eip155:1" }), description: "stock quotes" },
    { url: "https://d.example/sol", host: "d.example", description: "weather on solana", source: "payai",
      offers: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountAtoms: "100", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", usd: "0.0001" }] },
    { ...catEntry("https://e.example/up", "3000", { scheme: "upto" }), description: "weather upto" },
  ];
  const get = async (r: Rig, qs: string, token: string | null = TOKEN) => {
    const res = await fetch(`${r.base}/search${qs}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json()) as any };
  };

  it("401 without a valid token; 400 without q or with bad parameters", async () => {
    const r = await rig({ catalog: entries() });
    try {
      assert.equal((await get(r, "?q=weather", null)).status, 401);
      assert.equal((await get(r, "?q=weather", "nope")).status, 401);
      assert.equal((await get(r, "")).status, 400);
      assert.equal((await get(r, "?q=%20")).status, 400);
      assert.equal((await get(r, "?q=a&max_usd=1e3")).status, 400);
      assert.equal((await get(r, "?q=a&limit=0")).status, 400);
      assert.equal((await get(r, "?q=a&limit=x")).status, 400);
    } finally { await done(r); }
  });

  it("503 when no catalog is loaded", async () => {
    const r = await rig();
    try {
      const a = await get(r, "?q=weather");
      assert.equal(a.status, 503);
      assert.deepEqual(a.json, { error: "no catalog" });
    } finally { await done(r); }
  });

  it("returns results cheapest first with payable flags, capped descriptions, at most 3 offers", async () => {
    const many = catEntry("https://m.example/many", "9000");
    (many.offers as unknown[]).push(...[1, 2, 3, 4].map((i) => ({ scheme: "exact", network: "eip155:1", asset: USDC, amountAtoms: String(i), payTo: PAYEE, usd: "0." + i })));
    const r = await rig({ catalog: [...entries(), many] });
    try {
      const { status, json } = await get(r, "?q=weather");
      assert.equal(status, 200);
      assert.equal(json.fetchedAt, CATALOG_FETCHED_AT);
      assert.equal(json.total, 5);
      const urls = json.results.map((x: any) => x.url);
      assert.deepEqual(urls, ["https://d.example/sol", "https://a.example/weather", "https://e.example/up", "https://b.example/weather-pro", "https://m.example/many"]);
      const by = Object.fromEntries(json.results.map((x: any) => [x.url, x]));
      assert.equal(by["https://a.example/weather"].payable, true, "exact on an allowed network with an accepted asset");
      assert.equal(by["https://d.example/sol"].payable, false, "network not in policy.networks");
      assert.equal(by["https://e.example/up"].payable, false, "scheme upto");
      assert.equal(by["https://b.example/weather-pro"].description.length, 200);
      assert.deepEqual(Object.keys(by["https://a.example/weather"].offers[0]).sort(), ["asset", "network", "payTo", "usd"]);
      assert.equal(by["https://a.example/weather"].offers[0].usd, "0.001");
      assert.equal(by["https://m.example/many"].offers.length, 3);
    } finally { await done(r); }
  });

  it("filters (max_usd, network) and limit (default 10, cap 25)", async () => {
    const bulk = Array.from({ length: 40 }, (_, i) => ({ ...catEntry(`https://bulk.example/p${String(i).padStart(2, "0")}`, String(1000 + i)), description: "bulk item" }));
    const r = await rig({ catalog: [...entries(), ...bulk] });
    try {
      assert.equal((await get(r, "?q=bulk")).json.results.length, 10);
      const l = (await get(r, "?q=bulk&limit=100")).json;
      assert.equal(l.results.length, 25);
      assert.equal(l.total, 40);
      assert.equal((await get(r, "?q=bulk&limit=3")).json.results.length, 3);
      const cheap = (await get(r, "?q=weather&max_usd=0.002")).json;
      assert.deepEqual(cheap.results.map((x: any) => x.url).sort(), ["https://a.example/weather", "https://d.example/sol"]);
      const sol = (await get(r, `?q=weather&network=${encodeURIComponent("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")}`)).json;
      assert.deepEqual(sol.results.map((x: any) => x.url), ["https://d.example/sol"]);
      assert.equal((await get(r, "?q=nomatchatall")).json.results.length, 0);
    } finally { await done(r); }
  });

  it("search does not touch the seller or the log", async () => {
    const r = await rig({ catalog: entries() });
    try {
      await get(r, "?q=weather");
      assert.equal(r.seller.seen.length, 0);
      assert.equal(fs.existsSync(r.logPath), false);
    } finally { await done(r); }
  });
});
