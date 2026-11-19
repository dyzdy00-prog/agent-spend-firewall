// M8 tests: admin API, approvals, /app. Local fake seller (node:http), no network, no funds.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { csvCell, fmtUsd6, loadConfig, parseConfig, startFirewall } from "../src/firewall.ts";
import type { FetchResult, FirewallOptions, PracticeScenarios, RunningFirewall } from "../src/firewall.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:84532";
const PAYEE = "0x2222222222222222222222222222222222222222";
const TOKEN = "tok-agent-1-very-secret";
const ADMIN = "admin-token-very-secret";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asf-console-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ---- fake seller (same approach as firewall.test.ts)
interface Seen { path: string; paid: PaymentPayload | null }
interface Seller { host: string; seen: Seen[]; price: Map<string, PaymentRequirements[]>; close(): Promise<void> }
const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements =>
  ({ scheme: "exact", network: NET, asset: USDC, amount: "10000", payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...over });

async function startSeller(): Promise<Seller> {
  const seen: Seen[] = [];
  const price: Seller["price"] = new Map();
  const server = http.createServer((rq, rs) => {
    const p = (rq.url ?? "/").split("?")[0]!;
    const sig = rq.headers["payment-signature"];
    const paid = typeof sig === "string" ? (decodePaymentSignatureHeader(sig) as unknown as PaymentPayload) : null;
    seen.push({ path: p, paid });
    if (paid) {
      rs.writeHead(200, { "payment-response": encodePaymentResponseHeader({ success: true, transaction: "0xabc123", network: paid.accepted.network, payer: "x" } as never) });
      return void rs.end("paid content");
    }
    const pr: PaymentRequired = { x402Version: 2, error: "payment required", resource: { url: "http://x/" }, accepts: price.get(p) ?? [req()] };
    rs.writeHead(402, { "payment-required": encodePaymentRequiredHeader(pr) });
    rs.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { host: `127.0.0.1:${port}`, seen, price, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

interface Rig {
  fw: RunningFirewall; seller: Seller; base: string; file: string; logPath: string;
  call(u: string, token?: string): Promise<{ status: number; json: FetchResult }>;
  adm(method: string, p: string, body?: unknown, token?: string | null): Promise<{ status: number; json: any; text: string; headers: Headers }>;
  paidCount(): number;
}

async function rig(over: { admin?: boolean | "placeholder"; agentBudget?: string; approveAbove?: string; timeoutMs?: number; persisted?: boolean; policy?: Record<string, unknown>; extra?: Record<string, unknown>; practice?: (host: string) => PracticeScenarios; notifier?: FirewallOptions["notifier"] } = {}): Promise<Rig> {
  const seller = await startSeller();
  const dir = fs.mkdtempSync(path.join(tmpRoot, "r-"));
  const logPath = path.join(dir, "decisions.jsonl");
  const raw: Record<string, unknown> = {
    listen: { host: "127.0.0.1", port: 0 }, keyDir: path.join(dir, "keys"), storePath: path.join(dir, "state.db"), logPath,
    svmRpcUrl: "http://127.0.0.1:1", allowPrivateHosts: [seller.host],
    agents: { [sha(TOKEN)]: "agent-1" },
    assets: [{ network: NET, asset: USDC, decimals: 6, usd_per_unit: "1", evm_domain: { name: "USDC", version: "2" } }],
    policy: {
      networks: [NET], cap_usd: "1", budget_usd: "10", window_s: 3600, max_validity_s: 300, min_amount_usd: "0.000001",
      max_signatures_per_window: 100, known_hosts_only: false, payees: { [seller.host]: { evm: [PAYEE] } },
      block_after_undelivered: 0, undelivered_window_s: 3600, agents: { "agent-1": { budget_usd: over.agentBudget ?? "5" } },
      ...over.policy,
    },
    ...over.extra,
  };
  if (over.admin !== false) raw["adminTokenSha256"] = over.admin === "placeholder" ? "REPLACE_WITH_SHA256_HEX_OF_THE_ADMIN_TOKEN" : sha(ADMIN);
  if (over.approveAbove !== undefined) raw["approve_above_usd"] = over.approveAbove;
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
  const cfg = loadConfig(file);
  const opts: FirewallOptions = {};
  if (over.practice !== undefined) opts.practice = over.practice(seller.host);
  if (over.notifier !== undefined) opts.notifier = over.notifier;
  if (over.persisted !== false) opts.configPath = file;
  if (over.timeoutMs !== undefined) opts.approvalTimeoutMs = over.timeoutMs;
  const fw = await startFirewall(cfg, opts);
  const base = `http://127.0.0.1:${fw.port}`;
  const call = async (u: string, token: string = TOKEN) => {
    const r = await fetch(`${base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url: u }) });
    return { status: r.status, json: (await r.json()) as FetchResult };
  };
  const adm = async (method: string, p: string, body?: unknown, token: string | null = ADMIN) => {
    const h: Record<string, string> = {};
    if (token !== null) h["authorization"] = `Bearer ${token}`;
    if (body !== undefined) h["content-type"] = "application/json";
    const r = await fetch(`${base}${p}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* csv or html */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { fw, seller, base, file, logPath, call, adm, paidCount: () => seller.seen.filter((s) => s.paid).length };
}
async function done(r: Rig) { await r.fw.close(); await r.seller.close(); }
const readLog = (r: Rig) => (fs.existsSync(r.logPath) ? fs.readFileSync(r.logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitPending(r: Rig, n: number): Promise<any[]> {
  for (let i = 0; i < 200; i++) {
    const p = (await r.adm("GET", "/admin/approvals")).json.pending as any[];
    if (p.length >= n) return p;
    await sleep(25);
  }
  throw new Error(`fewer than ${n} pending approvals`);
}

describe("M8 console", () => {
  it("every /admin route is 404 without adminTokenSha256, and with the example placeholder", async () => {
    for (const admin of [false, "placeholder"] as const) {
      const r = await rig({ admin });
      try {
        for (const [m, p] of [["GET", "/admin/state"], ["PUT", "/admin/rules"], ["POST", "/admin/agents"], ["DELETE", "/admin/agents/x"], ["GET", "/admin/approvals"], ["POST", "/admin/approvals/ab"], ["GET", "/admin/activity"], ["GET", "/admin/export.csv"]] as const) {
          assert.equal((await r.adm(m, p, undefined, ADMIN)).status, 404, `${m} ${p}`);
        }
      } finally { await done(r); }
    }
  });

  it("wrong, missing and malformed admin tokens -> 401; an agent token is not an admin token", async () => {
    const r = await rig();
    try {
      assert.equal((await r.adm("GET", "/admin/state", undefined, "wrong")).status, 401);
      assert.equal((await r.adm("GET", "/admin/state", undefined, null)).status, 401);
      assert.equal((await r.adm("GET", "/admin/state", undefined, TOKEN)).status, 401);
      const basic = await fetch(`${r.base}/admin/state`, { headers: { authorization: `Basic ${ADMIN}` } });
      assert.equal(basic.status, 401);
      assert.equal((await r.adm("PUT", "/admin/rules", { cap_usd: "0.5" }, "wrong")).status, 401);
      assert.equal((await r.adm("GET", "/admin/state")).status, 200);
    } finally { await done(r); }
  });

  it("GET /admin/state shape; persisted false without a config path", async () => {
    const r = await rig({ persisted: false });
    try {
      const s = (await r.adm("GET", "/admin/state")).json;
      assert.equal(s.persisted, false);
      assert.deepEqual(Object.keys(s.rules).sort(), ["approve_above_usd", "block_after_undelivered", "budget_usd", "cache_ttl_s", "cap_usd", "known_hosts_only", "max_price_vs_catalog", "window_s"]);
      assert.deepEqual(s.agents, [{ id: "agent-1", budget_usd: "5", cap_usd: null, revoked: false }]);
      assert.deepEqual(s.networks, [NET]);
      assert.equal(s.pending, 0);
      assert.match(s.addresses.evm, /^0x[0-9a-fA-F]{40}$/);
      // memory-only changes still apply
      assert.equal((await r.adm("PUT", "/admin/rules", { cap_usd: "0.5" })).json.rules.cap_usd, "0.5");
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.cap_usd, "1");
    } finally { await done(r); }
  });

  it("rules: each validation failure changes neither the running policy nor the file", async () => {
    const r = await rig();
    try {
      const before = fs.readFileSync(r.file, "utf8");
      const stateBefore = JSON.stringify((await r.adm("GET", "/admin/state")).json);
      const bad: unknown[] = [
        { cap_usd: "0" }, { cap_usd: "abc" }, { cap_usd: 1 }, { cap_usd: "0.1234567" }, { cap_usd: "-1" },
        { budget_usd: "0.5", cap_usd: "1" }, { budget_usd: "0.5" },
        { approve_above_usd: "1" }, { approve_above_usd: "2" }, { approve_above_usd: "x" }, { cap_usd: "0.4", approve_above_usd: "0.4" },
        { window_s: 59 }, { window_s: 2_592_001 }, { window_s: 60.5 }, { window_s: "3600" },
        { block_after_undelivered: -1 }, { block_after_undelivered: 101 },
        { known_hosts_only: "yes" }, { max_price_vs_catalog: 0.5 }, { max_price_vs_catalog: "3" },
        { cache_ttl_s: -1 }, { cache_ttl_s: 2_592_001 }, { surprise: 1 },
      ];
      for (const b of bad) {
        const res = await r.adm("PUT", "/admin/rules", b);
        assert.equal(res.status, 400, JSON.stringify(b));
        assert.equal(typeof res.json.error, "string");
      }
      assert.equal((await r.adm("PUT", "/admin/rules", [1])).status, 400);
      assert.equal(fs.readFileSync(r.file, "utf8"), before);
      assert.equal(JSON.stringify((await r.adm("GET", "/admin/state")).json), stateBefore);
    } finally { await done(r); }
  });

  it("rules: checkPolicy runs on the merged policy", async () => {
    const r = await rig({ policy: { block_after_undelivered: 0, undelivered_window_s: 0 } });
    try {
      const before = fs.readFileSync(r.file, "utf8");
      const res = await r.adm("PUT", "/admin/rules", { block_after_undelivered: 5 });
      assert.equal(res.status, 400);
      assert.match(res.json.error, /undelivered_window_s/);
      assert.equal(fs.readFileSync(r.file, "utf8"), before);
    } finally { await done(r); }
  });

  it("rules: a valid change applies to the next /fetch, is written 0600 with other keys untouched, and survives a reload", async () => {
    const r = await rig();
    try {
      const rawBefore = JSON.parse(fs.readFileSync(r.file, "utf8"));
      assert.equal((await r.call(`http://${r.seller.host}/a`)).json.paid?.usd6, "10000");
      const res = await r.adm("PUT", "/admin/rules", { cap_usd: "0.005", budget_usd: "2", window_s: 120, approve_above_usd: "0.004", known_hosts_only: true, max_price_vs_catalog: 4, cache_ttl_s: 60, block_after_undelivered: 3 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.rules, { cap_usd: "0.005", budget_usd: "2", window_s: 120, approve_above_usd: "0.004", block_after_undelivered: 3, known_hosts_only: true, max_price_vs_catalog: 4, cache_ttl_s: 60 });
      const n1 = await r.call(`http://${r.seller.host}/b`);
      assert.equal(n1.json.refused?.code, "CAP");
      const rawAfter = JSON.parse(fs.readFileSync(r.file, "utf8"));
      assert.equal(rawAfter.policy.cap_usd, "0.005");
      assert.equal(rawAfter.approve_above_usd, "0.004");
      assert.equal(rawAfter.max_price_vs_catalog, 4);
      assert.equal(rawAfter.cache_ttl_s, 60);
      assert.equal(rawAfter.storePath, rawBefore.storePath);
      assert.deepEqual(rawAfter.agents, rawBefore.agents);
      assert.deepEqual(rawAfter.policy.payees, rawBefore.policy.payees);
      assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(path.dirname(r.file)).filter((f) => f.includes(".tmp-")), []);
      const reloaded = loadConfig(r.file);
      assert.equal(reloaded.policy.cap_usd, "0.005");
      assert.equal(reloaded.policy.window_s, 120);
      assert.equal(reloaded.policy.known_hosts_only, true);
      assert.equal(reloaded.approve_above_usd, "0.004");
      assert.equal(reloaded.max_price_vs_catalog, 4);
      // null removes the optional keys
      const off = await r.adm("PUT", "/admin/rules", { approve_above_usd: null, max_price_vs_catalog: null });
      assert.equal(off.json.rules.approve_above_usd, null);
      assert.equal(off.json.rules.max_price_vs_catalog, null);
      const rawOff = JSON.parse(fs.readFileSync(r.file, "utf8"));
      assert.equal("approve_above_usd" in rawOff, false);
      assert.equal("max_price_vs_catalog" in rawOff, false);
    } finally { await done(r); }
  });

  it("agents: created token works for /fetch, /report, /search; only its hash is stored; revoke -> 401 and persisted", async () => {
    const r = await rig();
    try {
      const created = await r.adm("POST", "/admin/agents", { id: "research", budget_usd: "0.10", cap_usd: null });
      assert.equal(created.status, 201);
      const token = created.json.token as string;
      assert.equal(created.json.id, "research");
      assert.match(token, /^[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(created.json).sort(), ["id", "token"]);

      const f = await r.call(`http://${r.seller.host}/a`, token);
      assert.equal(f.json.paid?.usd6, "10000");
      assert.equal((await fetch(`${r.base}/report`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
      assert.notEqual((await fetch(`${r.base}/search?q=x`, { headers: { authorization: `Bearer ${token}` } })).status, 401);

      // the token is nowhere: not in the config file, state, activity, log; its hash is
      const file = fs.readFileSync(r.file, "utf8");
      assert.equal(file.includes(token), false);
      assert.equal(file.includes(sha(token)), true);
      const raw = JSON.parse(file);
      assert.equal(raw.agents[sha(token)], "research");
      assert.deepEqual(raw.policy.agents.research, { budget_usd: "0.10" });
      for (const p of ["/admin/state", "/admin/activity", "/admin/export.csv"]) assert.equal((await r.adm("GET", p)).text.includes(token), false, p);
      assert.equal(fs.readFileSync(r.logPath, "utf8").includes(token), false);
      const st = (await r.adm("GET", "/admin/state")).json;
      assert.deepEqual(st.agents.find((a: any) => a.id === "research"), { id: "research", budget_usd: "0.10", cap_usd: null, revoked: false });

      // the new agent obeys its own budget (0.10): 10 payments of 0.01 fit, the 11th does not
      for (let i = 0; i < 9; i++) assert.equal((await r.call(`http://${r.seller.host}/p${i}`, token)).json.paid?.usd6, "10000");
      assert.equal((await r.call(`http://${r.seller.host}/over`, token)).json.refused?.code, "AGENT_BUDGET");

      // duplicates and bad input
      assert.equal((await r.adm("POST", "/admin/agents", { id: "research", budget_usd: "1" })).status, 409);
      assert.equal((await r.adm("POST", "/admin/agents", { id: "agent-1", budget_usd: "1" })).status, 409);
      for (const b of [{ id: "Bad", budget_usd: "1" }, { id: "", budget_usd: "1" }, { id: "x".repeat(41), budget_usd: "1" }, { id: "ok", budget_usd: "abc" }, { id: "ok", budget_usd: "0" }, { id: "ok", budget_usd: "1", cap_usd: "x" }, { id: "__proto__", budget_usd: "1" }]) {
        assert.equal((await r.adm("POST", "/admin/agents", b)).status, 400, JSON.stringify(b));
      }

      // revoke
      assert.equal((await r.adm("DELETE", "/admin/agents/nobody")).status, 404);
      assert.equal((await r.adm("DELETE", "/admin/agents/research")).status, 200);
      assert.equal((await r.call(`http://${r.seller.host}/z`, token)).status, 401);
      assert.equal((await fetch(`${r.base}/report`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
      const st2 = (await r.adm("GET", "/admin/state")).json;
      assert.equal(st2.agents.find((a: any) => a.id === "research").revoked, true);
      assert.equal(st2.agents.find((a: any) => a.id === "agent-1").revoked, false);
      assert.equal((await r.call(`http://${r.seller.host}/y`)).status, 200); // other agents unaffected
      const reloaded = loadConfig(r.file);
      assert.equal(sha(token) in reloaded.agents, false);
      assert.deepEqual(reloaded.revokedAgents, ["research"]);
      assert.equal(Object.hasOwn(reloaded.agents, sha(TOKEN)), true);
      assert.equal((await r.adm("POST", "/admin/agents", { id: "research", budget_usd: "1" })).status, 409);
    } finally { await done(r); }
  });

  it("approvals: approve signs and pays; the log line says approved", async () => {
    const r = await rig({ approveAbove: "0.30" });
    try {
      r.seller.price.set("/big", [req({ amount: "400000" })]);
      const pending = r.call(`http://${r.seller.host}/big/secret/path`);
      r.seller.price.set("/big/secret/path", [req({ amount: "400000" })]);
      const list = await waitPending(r, 1);
      assert.equal(list.length, 1);
      const a = list[0];
      assert.deepEqual(Object.keys(a).sort(), ["agent", "expiresAt", "host", "id", "network", "payee", "ts", "usd"]);
      assert.equal(a.agent, "agent-1"); assert.equal(a.host, r.seller.host); assert.equal(a.network, NET);
      assert.equal(a.usd, "0.40"); assert.equal(a.payee, PAYEE);
      assert.ok(a.expiresAt > a.ts);
      assert.equal(JSON.stringify(a).includes("secret"), false);
      assert.equal(r.paidCount(), 0);
      assert.equal((await r.adm("GET", "/admin/state")).json.pending, 1);
      assert.equal((await r.adm("POST", `/admin/approvals/${a.id}`, { decision: "maybe" })).status, 400);
      assert.equal((await r.adm("POST", `/admin/approvals/${a.id}`, { decision: "approve" })).status, 200);
      const res = await pending;
      assert.equal(res.json.paid?.usd6, "400000");
      assert.equal(res.json.refused, null);
      assert.equal(r.paidCount(), 1);
      assert.equal((await r.adm("POST", `/admin/approvals/${a.id}`, { decision: "approve" })).status, 404); // already decided
      const last = readLog(r).at(-1);
      assert.equal(last.allow, true); assert.equal(last.approved, true); assert.equal(last.delivered, true);
      // a payment at or below the threshold never waits
      assert.equal((await r.call(`http://${r.seller.host}/small`)).json.paid?.usd6, "10000");
      assert.equal((await r.adm("GET", "/admin/approvals")).json.pending.length, 0);
    } finally { await done(r); }
  });

  it("approvals: pending counts against the budget; deny signs nothing and releases it", async () => {
    const r = await rig({ approveAbove: "0.30", agentBudget: "0.50" });
    try {
      for (const p of ["/a", "/b", "/c"]) r.seller.price.set(p, [req({ amount: "400000" })]);
      const first = r.call(`http://${r.seller.host}/a`);
      const [a] = await waitPending(r, 1);
      // reservation is visible to the budget while pending
      const second = await r.call(`http://${r.seller.host}/b`);
      assert.equal(second.json.refused?.code, "AGENT_BUDGET");
      assert.equal((await r.adm("POST", `/admin/approvals/${a.id}`, { decision: "deny" })).status, 200);
      const res = await first;
      assert.deepEqual(res.json.refused, { code: "APPROVAL", reason: "owner denied" });
      assert.equal(res.json.paid, null);
      assert.equal(r.paidCount(), 0);
      const line = readLog(r).filter((e) => e.code === "APPROVAL").at(-1);
      assert.equal(line.allow, false); assert.equal(line.reason, "owner denied");
      // the reservation is gone: the same payment can be asked for (and approved) again
      const third = r.call(`http://${r.seller.host}/c`);
      const [c] = await waitPending(r, 1);
      assert.equal((await r.adm("POST", `/admin/approvals/${c.id}`, { decision: "approve" })).status, 200);
      assert.equal((await third).json.paid?.usd6, "400000");
      assert.equal(r.paidCount(), 1);
      // 0.40 of 0.50 spent now: a second 0.40 is over budget again
      assert.equal((await r.call(`http://${r.seller.host}/b`)).json.refused?.code, "AGENT_BUDGET");
    } finally { await done(r); }
  });

  it("approvals: no answer in time -> APPROVAL, nothing signed, reservation released", async () => {
    const r = await rig({ approveAbove: "0.30", agentBudget: "0.50", timeoutMs: 250 });
    try {
      r.seller.price.set("/a", [req({ amount: "400000" })]);
      const t0 = Date.now();
      const res = await r.call(`http://${r.seller.host}/a`);
      assert.ok(Date.now() - t0 >= 200);
      assert.deepEqual(res.json.refused, { code: "APPROVAL", reason: "no answer in time" });
      assert.equal(r.paidCount(), 0);
      assert.equal((await r.adm("GET", "/admin/approvals")).json.pending.length, 0);
      const line = readLog(r).at(-1);
      assert.equal(line.allow, false); assert.equal(line.code, "APPROVAL");
      // released: asking again reaches the approval step again (not AGENT_BUDGET)
      const again = await r.call(`http://${r.seller.host}/a`);
      assert.equal(again.json.refused?.reason, "no answer in time");
    } finally { await done(r); }
  });

  it("approvals: at most 20 pending; the 21st is refused immediately", async () => {
    const r = await rig({ approveAbove: "0.001", timeoutMs: 20_000 });
    try {
      const calls: Promise<{ status: number; json: FetchResult }>[] = [];
      for (let i = 0; i < 20; i++) calls.push(r.call(`http://${r.seller.host}/p${i}`));
      const list = await waitPending(r, 20);
      assert.equal(list.length, 20);
      const extra = await r.call(`http://${r.seller.host}/p20`);
      assert.deepEqual(extra.json.refused, { code: "APPROVAL", reason: "too many pending" });
      assert.equal(r.paidCount(), 0);
      for (const a of list) await r.adm("POST", `/admin/approvals/${a.id}`, { decision: "deny" });
      for (const c of await Promise.all(calls)) assert.equal(c.json.refused?.reason, "owner denied");
      assert.equal(r.paidCount(), 0);
      assert.equal((await r.adm("GET", "/admin/approvals")).json.pending.length, 0);
    } finally { await done(r); }
  });

  it("closing the firewall answers waiting requests (denied) instead of hanging", async () => {
    const r = await rig({ approveAbove: "0.001", timeoutMs: 20_000 });
    const p = r.call(`http://${r.seller.host}/a`).catch(() => null);
    await waitPending(r, 1);
    await done(r);
    await p; // resolves or the connection drops; it must not hang
    assert.equal(r.paidCount(), 0);
  });

  it("activity and export: newest first, formula cells escaped", async () => {
    const r = await rig();
    try {
      r.seller.price.set("/evil", [req({ payTo: "=HYPERLINK(\"http://evil\",\"x\")" })]);
      await r.call(`http://${r.seller.host}/ok`);
      const evil = await r.call(`http://${r.seller.host}/evil`);
      assert.ok(evil.json.refused);
      const act = (await r.adm("GET", "/admin/activity?limit=1")).json;
      assert.equal(act.entries.length, 1);
      assert.equal(act.entries[0].allow, false);
      assert.equal((await r.adm("GET", "/admin/activity?limit=0")).status, 400);
      assert.equal((await r.adm("GET", "/admin/activity")).json.entries.length, 2);
      const csv = await r.adm("GET", "/admin/export.csv");
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
      const lines = csv.text.trimEnd().split("\n");
      assert.equal(lines[0], "ts,agent,host,network,usd,payee,decision,code,reason,delivered,tx");
      assert.equal(lines.length, 3);
      assert.match(lines[1]!, /,agent-1,.*,0\.01,0x2222.*,allow,,,true,0xabc123$/);
      assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), csv.text);
      assert.equal(/(^|,)=/.test(csv.text), false);
    } finally { await done(r); }
  });

  it("csvCell and fmtUsd6 helpers", () => {
    for (const c of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) assert.ok(csvCell(c).replace(/^"/, "").startsWith("'"), c);
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell("a,b"), `"a,b"`);
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell(true), "true");
    assert.equal(fmtUsd6(400000n), "0.40");
    assert.equal(fmtUsd6(10000n), "0.01");
    assert.equal(fmtUsd6(1n), "0.000001");
    assert.equal(fmtUsd6(5_000_000n), "5.00");
  });

  it("GET /app serves src/console.html with the CSP header (404 while the file is missing)", async () => {
    const r = await rig();
    try {
      const file = path.join(import.meta.dirname, "..", "src", "console.html");
      const res = await fetch(`${r.base}/app`);
      if (fs.existsSync(file)) {
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-security-policy"), "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
        assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
        assert.equal(await res.text(), fs.readFileSync(file, "utf8"));
      } else {
        assert.equal(res.status, 404);
      }
      // no admin token needed for the static page; foreign Host header still refused
      assert.equal((await fetch(`${r.base}/app`, { method: "POST" })).status, 404);
    } finally { await done(r); }
  });

  it("parseConfig: adminTokenSha256, approve_above_usd, approval_timeout_s", () => {
    const base = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "bench", "config.example.json"), "utf8"));
    base.agents = { [sha("t")]: "bench-agent" };
    assert.equal(parseConfig({ ...base, adminTokenSha256: "REPLACE_WITH_SHA256_HEX_OF_THE_ADMIN_TOKEN" }).adminTokenSha256, undefined);
    assert.equal(parseConfig({ ...base, adminTokenSha256: sha("a") }).adminTokenSha256, sha("a"));
    assert.throws(() => parseConfig({ ...base, adminTokenSha256: "nope" }), /adminTokenSha256/);
    assert.equal(parseConfig(base).approval_timeout_s, 120);
    assert.equal(parseConfig({ ...base, approval_timeout_s: 10 }).approval_timeout_s, 10);
    for (const v of [9, 3601, 1.5, "60"]) assert.throws(() => parseConfig({ ...base, approval_timeout_s: v }), /approval_timeout_s/);
    assert.equal(parseConfig({ ...base, approve_above_usd: "0.25" }).approve_above_usd, "0.25");
    assert.throws(() => parseConfig({ ...base, approve_above_usd: "abc" }), /approve_above_usd/);
    assert.equal(parseConfig(base).approve_above_usd, undefined);
  });

  it("POST /admin/practice is 404 and state.practice is empty unless practice scenarios were given", async () => {
    const r = await rig();
    try {
      assert.deepEqual((await r.adm("GET", "/admin/state")).json.practice, []);
      assert.equal((await r.adm("POST", "/admin/practice", { agent: "agent-1", scenario: "buy" })).status, 404);
      assert.equal(r.seller.seen.length, 0);
    } finally { await done(r); }
  });

  it("practice: a named scenario runs through the normal fetch path as the chosen agent", async () => {
    const practice = (host: string): PracticeScenarios => {
      const table: Record<string, string[]> = { buy: [`http://${host}/a`], two: [`http://${host}/b`, `http://${host}/c`], big: [`http://${host}/big`], none: [] };
      return { settlement: "simulated", names: Object.keys(table), urls: (n) => table[n] ?? [] };
    };
    const r = await rig({ practice });
    try {
      r.seller.price.set("/big", [req({ amount: "2000000" })]);
      assert.deepEqual((await r.adm("GET", "/admin/state")).json.practice, ["buy", "two", "big", "none"]);
      assert.equal((await r.adm("GET", "/admin/state")).json.practice_settlement, "simulated");
      assert.equal((await r.adm("POST", "/admin/practice", { agent: "agent-1", scenario: "buy" }, null)).status, 401);

      const ok = await r.adm("POST", "/admin/practice", { agent: "agent-1", scenario: "buy" });
      assert.equal(ok.status, 200);
      assert.deepEqual(Object.keys(ok.json).sort(), ["cached", "paid", "refused", "status"]);
      assert.equal(ok.json.status, 200);
      assert.equal(ok.json.paid.usd6, "10000");
      assert.equal(ok.json.refused, null);
      assert.equal(r.paidCount(), 1);

      const two = await r.adm("POST", "/admin/practice", { agent: "agent-1", scenario: "two" });
      assert.equal(two.status, 200);
      assert.deepEqual(r.seller.seen.filter((x) => x.paid).map((x) => x.path), ["/a", "/b", "/c"]);

      const big = await r.adm("POST", "/admin/practice", { agent: "agent-1", scenario: "big" });
      assert.equal(big.json.refused.code, "CAP");
      assert.equal(big.json.paid, null);

      const log = readLog(r);
      assert.equal(log.length, 4);
      assert.ok(log.every((e: any) => e.agent === "agent-1"));

      const before = r.seller.seen.length;
      for (const body of [{ agent: "agent-1", scenario: "nope" }, { agent: "agent-1", scenario: "none" }, { agent: "ghost", scenario: "buy" }, { agent: "agent-1" }, { scenario: "buy" },
        { agent: "agent-1", scenario: `http://${r.seller.host}/a` }, []]) {
        assert.equal((await r.adm("POST", "/admin/practice", body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await r.adm("DELETE", "/admin/agents/agent-1")).status, 200);
      const rev = await r.adm("POST", "/admin/practice", { agent: "agent-1", scenario: "buy" });
      assert.equal(rev.status, 400);
      assert.equal(rev.json.error, "agent: revoked");
      assert.equal(r.seller.seen.length, before);
    } finally { await done(r); }
  });

  // ---- owner alerts
  const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF";
  const fakeNet = () => {
    const texts: string[] = [];
    const f = (async (_u: any, init: any) => { texts.push(JSON.parse(init.body).content); return new Response("ok", { status: 200 }); }) as typeof fetch;
    return { texts, f };
  };

  it("alerts: off by default; the target is write-only and kept out of the config file", async () => {
    const net = fakeNet();
    const r = await rig({ notifier: { fetch: net.f } });
    try {
      assert.equal((await r.adm("GET", "/admin/state")).json.alerts, null);
      assert.equal((await r.adm("PUT", "/admin/alerts", { kind: "discord", url: HOOK }, null)).status, 401);
      assert.equal((await r.adm("POST", "/admin/alerts/test")).status, 400);
      assert.equal((await r.adm("PUT", "/admin/alerts", { kind: "discord", url: "https://evil.example/api/webhooks/1/abc" })).status, 400);
      assert.equal((await r.adm("PUT", "/admin/alerts", { kind: "discord", url: HOOK, extra: true })).status, 400);

      const put = await r.adm("PUT", "/admin/alerts", { kind: "discord", url: HOOK });
      assert.equal(put.status, 200);
      assert.deepEqual(put.json.alerts, { kind: "discord", where: "discord.com", sent: 0, failed: 0, last_error: null });
      assert.equal(put.text.includes("abcdefghij"), false);
      assert.equal(fs.readFileSync(r.file, "utf8").includes("discord"), false);
      const stored = path.join(path.dirname(r.file), "notify.json");
      assert.equal(fs.statSync(stored).mode & 0o777, 0o600);

      const t = await r.adm("POST", "/admin/alerts/test");
      assert.deepEqual(t.json, { ok: true });
      assert.equal(net.texts.length, 1);
      assert.equal((await r.adm("GET", "/admin/state")).json.alerts.sent, 1);

      assert.equal((await r.adm("DELETE", "/admin/alerts")).json.alerts, null);
      assert.equal(fs.existsSync(stored), false);
    } finally { await done(r); }
  });

  it("alerts: a refusal, a waiting payment and an unanswered one reach the owner; the owner's own denial does not", async () => {
    const net = fakeNet();
    const r = await rig({ approveAbove: "0.30", timeoutMs: 250, notifier: { fetch: net.f } });
    try {
      assert.equal((await r.adm("PUT", "/admin/alerts", { kind: "discord", url: HOOK })).status, 200);
      r.seller.price.set("/huge", [req({ amount: "5000000" })]);
      for (let i = 0; i < 3; i++) assert.equal((await r.call(`http://${r.seller.host}/huge`)).json.refused?.code, "CAP");
      await sleep(30);
      assert.equal(net.texts.length, 1);
      assert.match(net.texts[0]!, /^Stopped: agent-1 to 127\.0\.0\.1:\d+, \$5\.00\. CAP: /);

      r.seller.price.set("/big", [req({ amount: "400000" })]);
      const denied = r.call(`http://${r.seller.host}/big`);
      const a = (await waitPending(r, 1))[0];
      await sleep(30);
      assert.equal(net.texts.length, 2);
      assert.match(net.texts[1]!, /^Approval needed: agent-1 wants to pay \$0\.40 to /);
      assert.equal((await r.adm("POST", `/admin/approvals/${a.id}`, { decision: "deny" })).status, 200);
      assert.equal((await denied).json.refused?.reason, "owner denied");
      await sleep(30);
      assert.equal(net.texts.length, 2);

      r.seller.price.set("/big2", [req({ amount: "400000" })]);
      const late = await r.call(`http://${r.seller.host}/big2`);
      assert.equal(late.json.refused?.reason, "no answer in time");
      await sleep(30);
      assert.equal(net.texts.length, 4);
      assert.match(net.texts[3]!, /APPROVAL: no answer in time/);
      assert.equal(r.paidCount(), 0);
    } finally { await done(r); }
  });
});
