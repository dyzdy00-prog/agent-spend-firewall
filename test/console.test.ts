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
import { csvCell, fmtUsd6, loadConfig, parseConfig, parseRuns, parseSchedules, runLine, startFirewall } from "../src/firewall.ts";
import type { AgentTemplates, FetchResult, FirewallOptions, PracticeScenarios, Run, RunningFirewall } from "../src/firewall.ts";

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
interface Seller { host: string; seen: Seen[]; price: Map<string, PaymentRequirements[]>; empty: Set<string>; slow: { ms: number }; close(): Promise<void> }
const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements =>
  ({ scheme: "exact", network: NET, asset: USDC, amount: "10000", payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...over });

async function startSeller(): Promise<Seller> {
  const seen: Seen[] = [];
  const price: Seller["price"] = new Map();
  const empty = new Set<string>(); // paths that take the payment and answer 200 with nothing
  const slow = { ms: 0 };          // delay before a paid answer, so two requests can overlap
  const server = http.createServer((rq, rs) => {
    const p = (rq.url ?? "/").split("?")[0]!;
    const sig = rq.headers["payment-signature"];
    const paid = typeof sig === "string" ? (decodePaymentSignatureHeader(sig) as unknown as PaymentPayload) : null;
    seen.push({ path: p, paid });
    if (paid) {
      const answer = () => {
        rs.writeHead(200, { "payment-response": encodePaymentResponseHeader({ success: true, transaction: "0xabc123", network: paid.accepted.network, payer: "x" } as never) });
        rs.end(empty.has(p) ? "  \n" : "paid content");
      };
      return void (slow.ms > 0 ? setTimeout(answer, slow.ms) : answer());
    }
    const pr: PaymentRequired = { x402Version: 2, error: "payment required", resource: { url: "http://x/" }, accepts: price.get(p) ?? [req()] };
    rs.writeHead(402, { "payment-required": encodePaymentRequiredHeader(pr) });
    rs.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { host: `127.0.0.1:${port}`, seen, price, empty, slow, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

interface Rig {
  fw: RunningFirewall; seller: Seller; base: string; file: string; logPath: string;
  call(u: string, token?: string): Promise<{ status: number; json: FetchResult }>;
  adm(method: string, p: string, body?: unknown, token?: string | null): Promise<{ status: number; json: any; text: string; headers: Headers }>;
  paidCount(): number;
}

async function rig(over: { admin?: boolean | "placeholder"; agentBudget?: string; approveAbove?: string; timeoutMs?: number; persisted?: boolean; policy?: Record<string, unknown>; extra?: Record<string, unknown>; practice?: (host: string) => PracticeScenarios; templates?: AgentTemplates; notifier?: FirewallOptions["notifier"] } = {}): Promise<Rig> {
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
  if (over.templates !== undefined) opts.templates = over.templates;
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
      assert.deepEqual(Object.keys(s.rules).sort(), ["approve_above_usd", "block_after_undelivered", "budget_usd", "cache_ttl_s", "cap_usd", "daily_budget_usd", "known_hosts_only", "max_price_jump", "max_price_vs_catalog", "new_seller_cap_usd", "share_cache", "window_s"]);
      assert.deepEqual(s.agents, [{ id: "agent-1", budget_usd: "5", cap_usd: null, daily_budget_usd: null, spent_day_usd: "0.00", revoked: false }]);
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
      assert.deepEqual(res.json.rules, { cap_usd: "0.005", budget_usd: "2", window_s: 120, approve_above_usd: "0.004", block_after_undelivered: 3, known_hosts_only: true, max_price_vs_catalog: 4, cache_ttl_s: 60, new_seller_cap_usd: null, max_price_jump: null, share_cache: false, daily_budget_usd: null });
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
      assert.deepEqual(st.agents.find((a: any) => a.id === "research"), { id: "research", budget_usd: "0.10", cap_usd: null, daily_budget_usd: null, spent_day_usd: "0.01", revoked: false });

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

  // ---- ready-made agents
  it("runs: 404 without templates; a run records its steps and result; one at a time per agent", async () => {
    const none = await rig();
    try {
      assert.deepEqual((await none.adm("GET", "/admin/state")).json.templates, []);
      assert.equal((await none.adm("GET", "/admin/runs")).status, 404);
      assert.equal((await none.adm("POST", "/admin/runs", { agent: "agent-1", template: "researcher", task: "x" })).status, 404);
    } finally { await done(none); }

    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const seen: string[] = [];
    const templates: AgentTemplates = {
      list: [{ id: "researcher", name: "Researcher", about: "buys notes" }],
      run: async (template, agent, task, onStep) => {
        seen.push(`${template}|${agent}|${task}`);
        if (task === "explode") throw new Error("secret detail");
        onStep({ kind: "bought", title: "T".repeat(500), host: "h.example", usd: "0.01", detail: "paid and delivered" });
        await gate;
        onStep({ kind: "stopped", title: "Second", host: "h.example", usd: "5.00", detail: "CAP: above cap" });
        return { receipt: { paidUsd: "0.01" } };
      },
    };
    const r = await rig({ templates });
    try {
      assert.deepEqual((await r.adm("GET", "/admin/state")).json.templates, [{ id: "researcher", name: "Researcher", about: "buys notes" }]);
      assert.equal((await r.adm("POST", "/admin/runs", { agent: "agent-1", template: "researcher", task: "x" }, null)).status, 401);
      for (const bad of [{ agent: "nobody", template: "researcher", task: "x" }, { agent: "agent-1", template: "other", task: "x" }, { agent: "agent-1", template: "researcher", task: "  " }, { agent: "agent-1", template: "researcher", task: "x".repeat(201) }, { agent: "agent-1", template: "researcher" }]) {
        assert.equal((await r.adm("POST", "/admin/runs", bad)).status, 400, JSON.stringify(bad).slice(0, 60));
      }
      assert.equal(seen.length, 0);

      const started = await r.adm("POST", "/admin/runs", { agent: "agent-1", template: "researcher", task: " solar\npanels " });
      assert.equal(started.status, 200);
      assert.equal(started.json.task, "solar panels");
      assert.equal(started.json.done, false);
      assert.equal((await r.adm("POST", "/admin/runs", { agent: "agent-1", template: "researcher", task: "second" })).status, 409);
      await sleep(20);
      let list = (await r.adm("GET", "/admin/runs")).json.runs;
      assert.equal(list.length, 1);
      assert.equal(list[0].steps.length, 1);
      assert.equal(list[0].steps[0].title.length, 80);
      release();
      await sleep(20);
      list = (await r.adm("GET", "/admin/runs")).json.runs;
      assert.equal(list[0].done, true);
      assert.equal(list[0].error, null);
      assert.deepEqual(list[0].steps.map((s: any) => s.kind), ["bought", "stopped"]);
      assert.deepEqual(list[0].result, { receipt: { paidUsd: "0.01" } });
      assert.deepEqual(seen, ["researcher|agent-1|solar panels"]);

      const failed = await r.adm("POST", "/admin/runs", { agent: "agent-1", template: "researcher", task: "explode" });
      assert.equal(failed.status, 200);
      await sleep(20);
      list = (await r.adm("GET", "/admin/runs")).json.runs;
      assert.equal(list.length, 2);
      assert.equal(list[0].error, "the run failed");
      assert.equal(JSON.stringify(list).includes("secret detail"), false);

      assert.equal((await r.adm("DELETE", "/admin/agents/agent-1")).status, 200);
      assert.equal((await r.adm("POST", "/admin/runs", { agent: "agent-1", template: "researcher", task: "x" })).json.error, "agent: revoked");
    } finally { await done(r); }
  });

  // ---- owner alerts
  const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF";
  const fakeNet = () => {
    const texts: string[] = [];
    const f = (async (_u: any, init: any) => { texts.push(JSON.parse(init.body).content); return new Response("ok", { status: 200 }); }) as typeof fetch;
    return { texts, f };
  };

  it("run history: finished runs are written next to the state file, filtered by agent and limit", async () => {
    const templates: AgentTemplates = {
      list: [{ id: "researcher", name: "Researcher", about: "buys notes" }],
      run: async (_t, _a, task) => ({ task, notes: [{ title: "N", text: "x".repeat(5000), host: "h.example" }], receipt: { paidUsd: "0.01" } }),
    };
    const r = await rig({ templates });
    const file = path.join(path.dirname(r.logPath), "runs.jsonl");
    try {
      assert.equal(fs.existsSync(file), false);
      await r.adm("POST", "/admin/agents", { id: "second", budget_usd: "0.05", cap_usd: null });
      for (const [agent, task] of [["agent-1", "one"], ["second", "two"], ["agent-1", "three"]]) {
        assert.equal((await r.adm("POST", "/admin/runs", { agent, template: "researcher", task })).status, 200);
        await sleep(15);
      }
      const all = (await r.adm("GET", "/admin/runs")).json.runs;
      assert.deepEqual(all.map((x: any) => x.task), ["three", "two", "one"]);
      assert.ok(all.every((x: any) => x.done && typeof x.ended === "number" && x.ended >= x.started));
      assert.deepEqual((await r.adm("GET", "/admin/runs?agent=agent-1")).json.runs.map((x: any) => x.task), ["three", "one"]);
      assert.deepEqual((await r.adm("GET", "/admin/runs?limit=1")).json.runs.map((x: any) => x.task), ["three"]);
      assert.deepEqual((await r.adm("GET", "/admin/runs?agent=nobody")).json.runs, []);
      for (const bad of ["0", "201", "x", "1.5"]) assert.equal((await r.adm("GET", `/admin/runs?limit=${bad}`)).status, 400, bad);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const text = fs.readFileSync(file, "utf8");
      assert.equal(text.trimEnd().split("\n").length, 3);
      // what a restart would load: the same three, newest first, with long notes cut
      const back = parseRuns(text);
      assert.deepEqual(back.map((x) => x.task), ["three", "two", "one"]);
      assert.equal((back[0]!.result as any).notes[0].text.length, 1000);
      assert.equal((back[0]!.result as any).receipt.paidUsd, "0.01");
    } finally { await done(r); }
  });

  it("schedules: created, run when due as the agent, skipped with a reason, paused, deleted, kept in a file", async () => {
    let release: () => void = () => {};
    const seen: string[] = [];
    const templates: AgentTemplates = {
      list: [{ id: "researcher", name: "Researcher", about: "buys notes" }],
      run: async (template, agent, task) => {
        seen.push(`${template}|${agent}|${task}`);
        if (task === "slow") await new Promise<void>((res) => { release = res; });
        return { receipt: { paidUsd: "0.00" } };
      },
    };
    const none = await rig();
    try {
      assert.equal((await none.adm("GET", "/admin/schedules")).status, 404);
      assert.equal((await none.adm("POST", "/admin/schedules", { agent: "agent-1", template: "researcher", task: "x", every_s: 3600 })).status, 404);
      assert.equal(none.fw.tickSchedules(), 0);
    } finally { await done(none); }

    const r = await rig({ templates });
    const file = path.join(path.dirname(r.logPath), "schedules.json");
    try {
      assert.deepEqual((await r.adm("GET", "/admin/schedules")).json, { schedules: [] });
      assert.equal((await r.adm("POST", "/admin/schedules", { agent: "agent-1", template: "researcher", task: "x", every_s: 3600 }, null)).status, 401);
      const ok = { agent: "agent-1", template: "researcher", task: "daily news", every_s: 3600 };
      for (const bad of [{ ...ok, agent: "nobody" }, { ...ok, template: "x" }, { ...ok, task: "" }, { ...ok, task: "y".repeat(201) }, { ...ok, every_s: 299 }, { ...ok, every_s: 7 * 86400 + 1 }, { ...ok, every_s: 3600.5 }, { ...ok, every_s: "3600" }, {}]) {
        assert.equal((await r.adm("POST", "/admin/schedules", bad)).status, 400, JSON.stringify(bad).slice(0, 70));
      }
      assert.equal(fs.existsSync(file), false);

      const t0 = Math.floor(Date.now() / 1000);
      const made = await r.adm("POST", "/admin/schedules", ok);
      assert.equal(made.status, 200);
      const id = made.json.id as string;
      assert.equal(made.json.enabled, true);
      assert.equal(made.json.last, null);
      assert.ok(made.json.next >= t0 + 3600 && made.json.next <= t0 + 3602);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(parseSchedules(fs.readFileSync(file, "utf8")).map((x) => x.task), ["daily news"]);

      // not due yet: creating a schedule runs nothing
      assert.equal(r.fw.tickSchedules(), 0);
      assert.deepEqual(seen, []);
      // due: it runs once as that agent and the next time moves one interval on
      const due = made.json.next + 5;
      assert.equal(r.fw.tickSchedules(due), 1);
      await sleep(15);
      assert.deepEqual(seen, ["researcher|agent-1|daily news"]);
      assert.equal(r.fw.tickSchedules(due), 0);
      let list = (await r.adm("GET", "/admin/schedules")).json.schedules;
      assert.equal(list[0].last, "ran");
      assert.equal(list[0].lastAt, due);
      assert.equal(list[0].next, due + 3600);
      const runs = (await r.adm("GET", "/admin/runs")).json.runs;
      assert.equal(runs[0].schedule, id);
      assert.equal(runs[0].task, "daily news");

      // the agent is busy with another task: skipped with the reason, tried again one interval later
      assert.equal((await r.adm("POST", "/admin/runs", { agent: "agent-1", template: "researcher", task: "slow" })).status, 200);
      assert.equal(r.fw.tickSchedules(due + 3600), 0);
      list = (await r.adm("GET", "/admin/schedules")).json.schedules;
      assert.equal(list[0].last, "skipped: this agent is already running a task");
      assert.equal(list[0].next, due + 7200);
      release();
      await sleep(15);

      // paused: never runs; resumed: the interval counts from now
      assert.equal((await r.adm("PUT", `/admin/schedules/${id}`, { enabled: "no" })).status, 400);
      assert.equal((await r.adm("PUT", "/admin/schedules/ffff", { enabled: false })).status, 404);
      assert.equal((await r.adm("PUT", `/admin/schedules/${id}`, { enabled: false })).json.enabled, false);
      assert.equal(r.fw.tickSchedules(due + 999999), 0);
      const t1 = Math.floor(Date.now() / 1000);
      const on = (await r.adm("PUT", `/admin/schedules/${id}`, { enabled: true })).json;
      assert.ok(on.enabled && on.next >= t1 + 3600 && on.next <= t1 + 3602);

      // a revoked agent's schedule is skipped, not run
      await r.adm("POST", "/admin/agents", { id: "temp", budget_usd: "0.05", cap_usd: null });
      const second = (await r.adm("POST", "/admin/schedules", { agent: "temp", template: "researcher", task: "other", every_s: 300 })).json;
      assert.equal((await r.adm("DELETE", "/admin/agents/temp")).status, 200);
      assert.equal(r.fw.tickSchedules(second.next + 1), 0);
      list = (await r.adm("GET", "/admin/schedules")).json.schedules;
      assert.equal(list[1].last, "skipped: agent: revoked");

      // at most 20; delete removes it from the list and the file
      for (let i = list.length; i < 20; i++) assert.equal((await r.adm("POST", "/admin/schedules", { ...ok, task: `n${i}` })).status, 200);
      assert.equal((await r.adm("POST", "/admin/schedules", ok)).status, 400);
      const del = await r.adm("DELETE", `/admin/schedules/${id}`);
      assert.equal(del.status, 200);
      assert.equal(del.json.schedules.length, 19);
      assert.equal((await r.adm("DELETE", `/admin/schedules/${id}`)).status, 404);
      assert.equal(parseSchedules(fs.readFileSync(file, "utf8")).some((x) => x.id === id), false);
    } finally { release(); await done(r); }
  });

  it("parseSchedules drops what is not a schedule", () => {
    const good = { id: "a1", agent: "a", template: "researcher", task: "t", every_s: 3600, enabled: true, created: 1, next: 2, last: null, lastAt: null };
    const text = JSON.stringify([good, { ...good, id: "" }, { ...good, every_s: 10 }, { ...good, next: -1 }, { ...good, task: "x".repeat(201) }, null, "x", { ...good, id: "b2", enabled: "yes", last: "ran", lastAt: 9 }]);
    assert.deepEqual(parseSchedules(text), [good, { ...good, id: "b2", enabled: false, last: "ran", lastAt: 9 }]);
    assert.deepEqual(parseSchedules("not json"), []);
    assert.deepEqual(parseSchedules("{}"), []);
    assert.equal(parseSchedules(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ ...good, id: `s${i}` })))).length, 20);
  });

  it("runLine and parseRuns: bounded lines, bad lines skipped, newest first, at most max", () => {
    const run = (i: number, over: Partial<Run> = {}): Run => ({ id: `r${i}`, agent: "a", template: "researcher", task: `t${i}`, started: 1000 + i, ended: 1001 + i, done: true, error: null,
      steps: [{ kind: "bought", title: "T", host: "h.example", usd: "0.01", detail: "paid and delivered" }], result: { receipt: {} }, ...over });
    const big = run(1, { result: { notes: Array.from({ length: 200 }, () => ({ title: "N", text: "y".repeat(900), host: "h" })), receipt: { paidUsd: "1" } } });
    const line = runLine(big);
    assert.ok(Buffer.byteLength(line) <= 64 * 1024);
    assert.deepEqual((JSON.parse(line).result as any).notes, []);
    assert.equal((JSON.parse(line).result as any).receipt.paidUsd, "1");
    assert.equal(JSON.parse(runLine(run(2, { result: "z".repeat(70000) }))).result, null);
    assert.equal(runLine(run(3)).includes("\n"), false);
    const text = [runLine(run(1)), "not json", "{}", JSON.stringify({ id: 5, agent: "a" }), "", runLine(run(2, { error: "the run failed", result: null })), JSON.stringify({ ...run(3), steps: "nope" }), runLine(run(4))].join("\n");
    const got = parseRuns(text);
    assert.deepEqual(got.map((x) => x.id), ["r4", "r2", "r1"]);
    assert.equal(got[1]!.error, "the run failed");
    assert.equal(got[0]!.done, true);
    assert.deepEqual(parseRuns(text, 2).map((x) => x.id), ["r4", "r2"]);
    assert.deepEqual(parseRuns(""), []);
    const odd = parseRuns(JSON.stringify({ ...run(9), ended: "soon", steps: [null, { kind: "k".repeat(500) }] }));
    assert.equal(odd[0]!.ended, null);
    assert.deepEqual(odd[0]!.steps, [{ kind: "k".repeat(160), title: "", host: "", usd: "", detail: "" }]);
  });

  it("new seller limit: small first payments only, the ordinary cap after one delivery; set and cleared through the rules", async () => {
    const r = await rig();
    const u = (p: string) => `http://${r.seller.host}${p}`;
    try {
      assert.equal((await r.adm("GET", "/admin/state")).json.rules.new_seller_cap_usd, null);
      for (const bad of ["0", "1", "2", 0.005, "abc", true]) assert.equal((await r.adm("PUT", "/admin/rules", { new_seller_cap_usd: bad })).status, 400, String(bad));
      const set = await r.adm("PUT", "/admin/rules", { new_seller_cap_usd: "0.005" });
      assert.equal(set.status, 200);
      assert.equal(set.json.rules.new_seller_cap_usd, "0.005");
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.new_seller_cap_usd, "0.005");
      // lowering the cap to the new-seller limit or below is refused: the limit must stay below the cap
      assert.equal((await r.adm("PUT", "/admin/rules", { cap_usd: "0.005" })).status, 400);

      // $0.01 to a seller that never delivered: refused, nothing signed
      const first = await r.call(u("/big"));
      assert.equal(first.json.refused?.code, "NEW_SELLER");
      assert.equal(r.paidCount(), 0);
      // $0.004 is under the limit: paid and delivered
      r.seller.price.set("/small", [req({ amount: "4000" })]);
      const small = await r.call(u("/small"));
      assert.equal(small.json.paid?.usd6, "4000");
      assert.equal(small.json.body, "paid content");
      // the seller has delivered once: $0.01 goes through
      assert.equal((await r.call(u("/big"))).json.paid?.usd6, "10000");
      assert.equal(r.paidCount(), 2);
      const log = readLog(r);
      assert.deepEqual(log.map((e: any) => e.code ?? "ok"), ["NEW_SELLER", "ok", "ok"]);

      const off = await r.adm("PUT", "/admin/rules", { new_seller_cap_usd: null });
      assert.equal(off.json.rules.new_seller_cap_usd, null);
      assert.equal("new_seller_cap_usd" in JSON.parse(fs.readFileSync(r.file, "utf8")).policy, false);
    } finally { await done(r); }
  });

  it("new seller limit: a seller that takes the first small payment and delivers nothing stays limited", async () => {
    const r = await rig({ policy: { new_seller_cap_usd: "0.005" } });
    const u = (p: string) => `http://${r.seller.host}${p}`;
    try {
      r.seller.price.set("/small", [req({ amount: "4000" })]);
      r.seller.empty.add("/small");
      const lost = await r.call(u("/small"));
      assert.equal(lost.json.paid?.usd6, "4000");
      assert.equal(lost.json.body.trim(), "");
      const e = readLog(r)[0];
      assert.equal(e.delivered, false);
      assert.equal(e.sellerError, "empty_response");
      assert.equal(r.fw.firewall.summaryOf(1).undelivered, 1);
      assert.equal((await r.call(u("/big"))).json.refused?.code, "NEW_SELLER");
    } finally { await done(r); }
  });

  it("price memory: the same address asking far more than last time is refused; the query does not make it new", async () => {
    const r = await rig();
    const u = (p: string) => `http://${r.seller.host}${p}`;
    try {
      assert.equal((await r.adm("GET", "/admin/state")).json.rules.max_price_jump, null);
      for (const bad of [0.5, 1001, "2", true]) assert.equal((await r.adm("PUT", "/admin/rules", { max_price_jump: bad })).status, 400, String(bad));
      // off: any price up to the cap is paid, and remembered
      assert.equal((await r.call(u("/data?n=1"))).json.paid?.usd6, "10000");
      r.seller.price.set("/data", [req({ amount: "90000" })]);
      assert.equal((await r.call(u("/data?n=2"))).json.paid?.usd6, "90000");

      const set = await r.adm("PUT", "/admin/rules", { max_price_jump: 2 });
      assert.equal(set.json.rules.max_price_jump, 2);
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).max_price_jump, 2);
      // last delivered price is $0.09: exactly twice is allowed, one atom more is not
      r.seller.price.set("/data", [req({ amount: "180000" })]);
      assert.equal((await r.call(u("/data?n=3"))).json.paid?.usd6, "180000");
      r.seller.price.set("/data", [req({ amount: "360001" })]);
      const paidBefore = r.paidCount();
      const jump = await r.call(u("/data?n=4"));
      assert.equal(jump.json.refused?.code, "PRICE_JUMP");
      assert.equal(jump.json.refused?.reason, "asks $0.360001, last time this address cost $0.18");
      assert.equal(r.paidCount(), paidBefore);
      const e = readLog(r).at(-1);
      assert.equal(e.code, "PRICE_JUMP");
      assert.equal(e.allow, false);
      // a cheaper quote is fine and becomes the new memory; another address on the same host has no memory
      r.seller.price.set("/data", [req({ amount: "5000" })]);
      assert.equal((await r.call(u("/data?n=5"))).json.paid?.usd6, "5000");
      r.seller.price.set("/data", [req({ amount: "10001" })]);
      assert.equal((await r.call(u("/data?n=6"))).json.refused?.code, "PRICE_JUMP");
      r.seller.price.set("/other", [req({ amount: "900000" })]);
      assert.equal((await r.call(u("/other"))).json.paid?.usd6, "900000");

      const off = await r.adm("PUT", "/admin/rules", { max_price_jump: null });
      assert.equal(off.json.rules.max_price_jump, null);
      assert.equal("max_price_jump" in JSON.parse(fs.readFileSync(r.file, "utf8")), false);
      assert.equal((await r.call(u("/data?n=7"))).json.paid?.usd6, "10001");
    } finally { await done(r); }
  });

  it("price memory: a purchase that was not delivered is not remembered as the price", async () => {
    const r = await rig({ extra: { max_price_jump: 2 } });
    const u = (p: string) => `http://${r.seller.host}${p}`;
    try {
      r.seller.price.set("/d", [req({ amount: "1000" })]);
      r.seller.empty.add("/d");
      assert.equal((await r.call(u("/d?n=1"))).json.paid?.usd6, "1000");
      r.seller.empty.delete("/d");
      r.seller.price.set("/d", [req({ amount: "50000" })]);
      assert.equal((await r.call(u("/d?n=2"))).json.paid?.usd6, "50000");
      r.seller.price.set("/d", [req({ amount: "100001" })]);
      assert.equal((await r.call(u("/d?n=3"))).json.refused?.code, "PRICE_JUMP");
    } finally { await done(r); }
  });

  it("the same paid address asked for twice at once is paid once; the second answer comes from the cache", async () => {
    const r = await rig({ extra: { cache_ttl_s: 60 } });
    const u = `http://${r.seller.host}/report`;
    try {
      r.seller.slow.ms = 150;
      const [a, b, c] = await Promise.all([r.call(u), r.call(u), r.call(u)]);
      assert.equal(r.paidCount(), 1);
      const kinds = [a, b, c].map((x) => (x.json.paid ? "paid" : x.json.cached ? "cached" : "other")).sort();
      assert.deepEqual(kinds, ["cached", "cached", "paid"]);
      for (const x of [a, b, c]) assert.equal(x.json.body, "paid content");
      assert.deepEqual(readLog(r).map((e: any) => (e.cached ? "cached" : "paid")).sort(), ["cached", "cached", "paid"]);
      // different addresses do not wait for each other
      r.seller.seen.length = 0;
      const t0 = Date.now();
      await Promise.all([r.call(`${u}?n=1`), r.call(`${u}?n=2`)]);
      assert.equal(r.paidCount(), 2);
      assert.ok(Date.now() - t0 < 290, "two different addresses were served one after the other");
    } finally { await done(r); }
  });

  it("two requests at once for an address that is not delivered: both pay, one after the other; without a cache nothing waits", async () => {
    const r = await rig({ extra: { cache_ttl_s: 60 } });
    const u = `http://${r.seller.host}/lost`;
    try {
      r.seller.empty.add("/lost");
      r.seller.slow.ms = 60;
      const [a, b] = await Promise.all([r.call(u), r.call(u)]);
      assert.equal(r.paidCount(), 2); // nothing was delivered, so there was nothing to share
      assert.ok(a.json.paid && b.json.paid);
    } finally { await done(r); }
    const plain = await rig(); // cache off: the old behaviour, every request pays
    try {
      plain.seller.slow.ms = 60;
      const u2 = `http://${plain.seller.host}/x`;
      await Promise.all([plain.call(u2), plain.call(u2)]);
      assert.equal(plain.paidCount(), 2);
    } finally { await done(plain); }
  });

  it("shared purchases: off by default; when on, another agent gets the cached answer and the log says who paid", async () => {
    const r = await rig({ extra: { cache_ttl_s: 60 } });
    const u = `http://${r.seller.host}/data`;
    try {
      const made = await r.adm("POST", "/admin/agents", { id: "second", budget_usd: "1", cap_usd: null });
      const second = made.json.token as string;
      assert.equal((await r.adm("GET", "/admin/state")).json.rules.share_cache, false);
      // off: each agent pays for its own copy
      assert.equal((await r.call(u)).json.paid?.usd6, "10000");
      assert.equal((await r.call(u, second)).json.paid?.usd6, "10000");
      assert.equal(r.paidCount(), 2);

      assert.equal((await r.adm("PUT", "/admin/rules", { share_cache: "yes" })).status, 400);
      const on = await r.adm("PUT", "/admin/rules", { share_cache: true });
      assert.equal(on.json.rules.share_cache, true);
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).share_cache, true);

      // on: the first agent buys a new address, the second gets it for nothing
      const first = await r.call(`${u}?n=2`);
      assert.equal(first.json.paid?.usd6, "10000");
      const reuse = await r.call(`${u}?n=2`, second);
      assert.equal(reuse.json.paid, null);
      assert.deepEqual({ usd6: reuse.json.cached?.usd6, from: reuse.json.cached?.from }, { usd6: "10000", from: "agent-1" });
      assert.equal(reuse.json.body, "paid content");
      assert.equal(r.paidCount(), 3);
      const e = readLog(r).at(-1);
      assert.deepEqual([e.agent, e.cached, e.cachedFrom], ["second", true, "agent-1"]);
      // the agent that paid sees its own copy without a "from"
      const own = await r.call(`${u}?n=2`);
      assert.equal(own.json.cached?.from, undefined);
      assert.equal(readLog(r).at(-1).cachedFrom, undefined);
      // the second agent's spend did not move
      assert.equal((await r.adm("GET", "/admin/activity?limit=50")).json.entries.filter((x: any) => x.agent === "second" && x.allow && !x.cached).length, 1);

      // two agents at once for a new address: one payment
      r.seller.slow.ms = 120;
      const before = r.paidCount();
      const [x, y] = await Promise.all([r.call(`${u}?n=3`), r.call(`${u}?n=3`, second)]);
      assert.equal(r.paidCount(), before + 1);
      assert.deepEqual([x, y].map((v) => (v.json.paid ? "paid" : "cached")).sort(), ["cached", "paid"]);

      // off again: the second agent pays for its own copy of an address the first one holds
      await r.adm("PUT", "/admin/rules", { share_cache: false, daily_budget_usd: null });
      r.seller.slow.ms = 0;
      await r.call(`${u}?n=4`);
      assert.equal((await r.call(`${u}?n=4`, second)).json.paid?.usd6, "10000");
    } finally { await done(r); }
  });

  it("shared purchases: an agent limited to other hosts does not get a shared answer from this one", async () => {
    const NARROW = "tok-narrow-0123456789abcdef";
    const r = await rig({
      extra: { cache_ttl_s: 60, share_cache: true, agents: { [sha(TOKEN)]: "agent-1", [sha(NARROW)]: "narrow", [sha("tok-wide-0123456789abcdef")]: "wide" } },
      policy: { agents: { "agent-1": { budget_usd: "5" }, narrow: { budget_usd: "1", hosts: ["other.example"] }, wide: { budget_usd: "1" } } },
    });
    const u = `http://${r.seller.host}/data`;
    try {
      assert.equal((await r.call(u)).json.paid?.usd6, "10000");
      // an agent without a host list shares
      assert.equal((await r.call(u, "tok-wide-0123456789abcdef")).json.cached?.from, "agent-1");
      // the limited agent gets nothing from the cache and its own attempt is refused by its host list
      const no = await r.call(u, NARROW);
      assert.equal(no.json.cached, undefined);
      assert.equal(no.json.refused?.code, "HOST");
      assert.equal(no.json.body.includes("paid content"), false);
      assert.equal(r.paidCount(), 1);
    } finally { await done(r); }
  });

  it("reader key: write-only; state says only whether one is set; kept out of the config file", async () => {
    const r = await rig({ persisted: true });
    const key = "sk-test-reader-0123456789abcdef";
    const file = path.join(path.dirname(r.logPath), "anthropic.key");
    try {
      fs.rmSync(file, { force: true });
      assert.equal(r.fw.firewall.readerKey.status().source === "file", false);
      assert.equal((await r.adm("PUT", "/admin/reader", { key: "short" })).status, 400);
      assert.equal((await r.adm("PUT", "/admin/reader", {})).status, 400);
      assert.equal(fs.existsSync(file), false);
      const set = await r.adm("PUT", "/admin/reader", { key });
      assert.equal(set.status, 200);
      assert.deepEqual(set.json.reader, { configured: true, source: "file" });
      assert.equal(JSON.stringify(set.json).includes(key), false);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(r.fw.firewall.readerKey.get(), key);
      assert.equal(fs.readFileSync(r.file, "utf8").includes(key), false);
      const st = await r.adm("GET", "/admin/state");
      assert.equal(JSON.stringify(st.json).includes(key), false);
      const del = await r.adm("DELETE", "/admin/reader");
      assert.equal(del.status, 200);
      assert.equal(del.json.reader.source === "file", false);
      assert.equal(fs.existsSync(file), false);
    } finally { await done(r); }
  });

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

  it("alerts: the payment that takes an agent to 80% of its budget warns the owner once, before the stop", async () => {
    const net = fakeNet();
    const r = await rig({ agentBudget: "0.05", notifier: { fetch: net.f } });
    try {
      // alerts off: nothing is sent whatever is spent
      assert.equal((await r.call(`http://${r.seller.host}/p0`)).json.paid?.usd6, "10000");
      assert.equal((await r.adm("PUT", "/admin/alerts", { kind: "discord", url: HOOK })).status, 200);
      for (const p of ["/p1", "/p2"]) assert.equal((await r.call(`http://${r.seller.host}${p}`)).json.paid?.usd6, "10000");
      await sleep(30);
      assert.equal(net.texts.length, 0);
      assert.equal((await r.call(`http://${r.seller.host}/p3`)).json.paid?.usd6, "10000");
      await sleep(30);
      assert.deepEqual(net.texts, ["Budget warning: agent-1 has used 80% of its budget, $0.04 of $0.05 in the current window. At 100% its payments stop. Raise it in the console, Agents."]);
      assert.equal((await r.call(`http://${r.seller.host}/p4`)).json.paid?.usd6, "10000");
      await sleep(30);
      assert.equal(net.texts.length, 1);
      assert.equal((await r.call(`http://${r.seller.host}/p5`)).json.refused?.code, "AGENT_BUDGET");
      await sleep(30);
      assert.equal(net.texts.length, 2);
      assert.match(net.texts[1]!, /^Stopped: agent-1 /);
      assert.equal(r.paidCount(), 5);
    } finally { await done(r); }
  });

  it("daily limit for one agent: stops it after the hourly window has refilled; set, raised and cleared on the agent", async () => {
    const r = await rig({ policy: { window_s: 1 } }); // a one-second window, so it refills during the test
    const u = (n: number) => `http://${r.seller.host}/d${n}`;
    try {
      const before = (await r.adm("GET", "/admin/state")).json;
      assert.deepEqual([before.agents[0].daily_budget_usd, before.agents[0].spent_day_usd, before.spent_day_usd], [null, "0.00", "0.00"]);
      for (const bad of [{}, { daily_budget_usd: "0" }, { daily_budget_usd: 2 }, { daily_budget_usd: "abc" }, { budget_usd: null }, { budget_usd: "0" }, { cap_usd: "1" }]) {
        assert.equal((await r.adm("PUT", "/admin/agents/agent-1", bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await r.adm("PUT", "/admin/agents/nobody", { daily_budget_usd: "1" })).status, 404);
      assert.equal((await r.adm("PUT", "/admin/agents/agent-1", { daily_budget_usd: "1" }, null)).status, 401);

      const set = await r.adm("PUT", "/admin/agents/agent-1", { daily_budget_usd: "0.02" });
      assert.equal(set.status, 200);
      assert.equal(set.json.agents[0].daily_budget_usd, "0.02");
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.agents["agent-1"].daily_budget_usd, "0.02");
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.agents["agent-1"].budget_usd, "5");

      assert.equal((await r.call(u(1))).json.paid?.usd6, "10000");
      assert.equal((await r.call(u(2))).json.paid?.usd6, "10000");
      await sleep(1200); // the window is empty again: only the day still counts
      assert.equal(r.fw.firewall.reportFor("agent-1").spentUsd6, "0");
      const stop = await r.call(u(3));
      assert.equal(stop.json.refused?.code, "DAILY_BUDGET");
      assert.equal(stop.json.refused?.reason, "agent daily limit reached");
      assert.equal(r.paidCount(), 2);
      const st = (await r.adm("GET", "/admin/state")).json;
      assert.deepEqual([st.agents[0].spent_day_usd, st.spent_day_usd], ["0.02", "0.02"]);

      // raised: the next payment goes through
      assert.equal((await r.adm("PUT", "/admin/agents/agent-1", { daily_budget_usd: "0.03" })).status, 200);
      assert.equal((await r.call(u(3))).json.paid?.usd6, "10000");
      assert.equal((await r.call(u(4))).json.refused?.code, "DAILY_BUDGET");
      // cleared: no daily limit, and the key is gone from the file
      const off = await r.adm("PUT", "/admin/agents/agent-1", { daily_budget_usd: null });
      assert.equal(off.json.agents[0].daily_budget_usd, null);
      assert.equal("daily_budget_usd" in JSON.parse(fs.readFileSync(r.file, "utf8")).policy.agents["agent-1"], false);
      assert.equal((await r.call(u(4))).json.paid?.usd6, "10000");

      // a revoked agent's limits are not edited
      await r.adm("DELETE", "/admin/agents/agent-1");
      assert.equal((await r.adm("PUT", "/admin/agents/agent-1", { daily_budget_usd: "1" })).status, 409);
    } finally { await done(r); }
  });

  it("an agent's hourly budget can be changed after it was created", async () => {
    const r = await rig();
    const u = (n: number) => `http://${r.seller.host}/h${n}`;
    try {
      const set = await r.adm("PUT", "/admin/agents/agent-1", { budget_usd: "0.01" });
      assert.equal(set.json.agents[0].budget_usd, "0.01");
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.agents["agent-1"].budget_usd, "0.01");
      assert.equal((await r.call(u(1))).json.paid?.usd6, "10000");
      assert.equal((await r.call(u(2))).json.refused?.code, "AGENT_BUDGET");
      await r.adm("PUT", "/admin/agents/agent-1", { budget_usd: "0.05" });
      assert.equal((await r.call(u(2))).json.paid?.usd6, "10000");
      // the token still works and nothing else about the agent changed
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.agents["agent-1"]), ["budget_usd"]);
    } finally { await done(r); }
  });

  it("daily limit for all agents: set in the rules; a new agent can be created with its own", async () => {
    const r = await rig();
    const u = (n: number) => `http://${r.seller.host}/a${n}`;
    try {
      assert.equal((await r.adm("GET", "/admin/state")).json.rules.daily_budget_usd, null);
      for (const bad of ["0", 1, "abc", true]) assert.equal((await r.adm("PUT", "/admin/rules", { daily_budget_usd: bad })).status, 400, String(bad));
      for (const bad of ["0", 1, "x"]) assert.equal((await r.adm("POST", "/admin/agents", { id: "bad", budget_usd: "1", daily_budget_usd: bad })).status, 400, String(bad));
      const made = await r.adm("POST", "/admin/agents", { id: "second", budget_usd: "1", cap_usd: null, daily_budget_usd: "0.01" });
      assert.equal(made.status, 201);
      const second = made.json.token as string;
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.agents.second.daily_budget_usd, "0.01");

      const set = await r.adm("PUT", "/admin/rules", { daily_budget_usd: "0.03" });
      assert.equal(set.json.rules.daily_budget_usd, "0.03");
      assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).policy.daily_budget_usd, "0.03");

      // the second agent: its own day is one cent
      assert.equal((await r.call(u(1), second)).json.paid?.usd6, "10000");
      const own = await r.call(u(2), second);
      assert.deepEqual([own.json.refused?.code, own.json.refused?.reason], ["DAILY_BUDGET", "agent daily limit reached"]);
      // the first agent has no limit of its own; the shared one stops it at three cents in all
      assert.equal((await r.call(u(3))).json.paid?.usd6, "10000");
      assert.equal((await r.call(u(4))).json.paid?.usd6, "10000");
      const all = await r.call(u(5));
      assert.deepEqual([all.json.refused?.code, all.json.refused?.reason], ["DAILY_BUDGET", "daily limit reached"]);
      assert.equal(r.paidCount(), 3);
      const st = (await r.adm("GET", "/admin/state")).json;
      assert.equal(st.spent_day_usd, "0.03");
      assert.deepEqual(st.agents.map((a: any) => [a.id, a.spent_day_usd, a.daily_budget_usd]), [["agent-1", "0.02", null], ["second", "0.01", "0.01"]]);

      const off = await r.adm("PUT", "/admin/rules", { daily_budget_usd: null });
      assert.equal(off.json.rules.daily_budget_usd, null);
      assert.equal("daily_budget_usd" in JSON.parse(fs.readFileSync(r.file, "utf8")).policy, false);
      assert.equal((await r.call(u(5))).json.paid?.usd6, "10000");
    } finally { await done(r); }
  });

  it("alerts: the payment that takes an agent to 80% of its daily limit warns the owner once", async () => {
    const net = fakeNet();
    const r = await rig({ policy: { agents: { "agent-1": { budget_usd: "5", daily_budget_usd: "0.05" } } }, notifier: { fetch: net.f } });
    try {
      assert.equal((await r.adm("PUT", "/admin/alerts", { kind: "discord", url: HOOK })).status, 200);
      for (const p of ["/p1", "/p2", "/p3"]) assert.equal((await r.call(`http://${r.seller.host}${p}`)).json.paid?.usd6, "10000");
      await sleep(30);
      assert.equal(net.texts.length, 0);
      assert.equal((await r.call(`http://${r.seller.host}/p4`)).json.paid?.usd6, "10000");
      await sleep(30);
      assert.deepEqual(net.texts, ["Daily limit warning: agent-1 has used 80% of its daily limit, $0.04 of $0.05 in the last 24 hours. At 100% its payments stop. Raise it in the console, Agents."]);
      assert.equal((await r.call(`http://${r.seller.host}/p5`)).json.paid?.usd6, "10000");
      await sleep(30);
      assert.equal(net.texts.length, 1);
    } finally { await done(r); }
  });

  it("alerts: the daily summary counts the last 24 hours; sent on demand and once a day after the hour", async () => {
    const net = fakeNet();
    const r = await rig({ notifier: { fetch: net.f } });
    try {
      assert.equal((await r.adm("POST", "/admin/alerts/summary")).status, 400);
      assert.equal((await r.adm("POST", "/admin/alerts/summary", undefined, null)).status, 401);
      assert.equal((await r.adm("PUT", "/admin/alerts", { kind: "discord", url: HOOK })).status, 200);
      const tomorrow = new Date(Date.now() + 86_400_000); tomorrow.setHours(9, 0, 0, 0);
      // a day with no activity sends nothing, and is not retried
      assert.equal(await r.fw.firewall.dailyTick(tomorrow), false);
      assert.equal(net.texts.length, 0);

      for (const p of ["/a", "/b"]) assert.equal((await r.call(`http://${r.seller.host}${p}`)).json.paid?.usd6, "10000");
      await r.call(`http://${r.seller.host}/a`);
      r.seller.price.set("/huge", [req({ amount: "5000000" })]);
      assert.equal((await r.call(`http://${r.seller.host}/huge`)).json.refused?.code, "CAP");
      await sleep(30);
      const before = net.texts.length;
      const sum = r.fw.firewall.summaryOf(24);
      assert.equal(sum.requests, 4);
      assert.equal(sum.stopped, 1);
      assert.equal(sum.paid + sum.cached, 3);
      assert.deepEqual(r.fw.firewall.summaryOf(0).requests, 0);

      assert.deepEqual((await r.adm("POST", "/admin/alerts/summary")).json, { ok: true });
      assert.equal(net.texts.length, before + 1);
      assert.match(net.texts[before]!, /^Last 24 hours: 4 requests\. /);

      const day2 = new Date(tomorrow.getTime() + 86_400_000);
      const early = new Date(day2); early.setHours(7, 0, 0, 0);
      assert.equal(await r.fw.firewall.dailyTick(early), false);
      assert.equal(await r.fw.firewall.dailyTick(day2), true);
      assert.equal(await r.fw.firewall.dailyTick(day2), false);
      assert.equal(net.texts.length, before + 2);
    } finally { await done(r); }
  });

  it("activity: since returns the whole period, newest first; a bad value is refused", async () => {
    const r = await rig();
    try {
      for (const p of ["/a", "/b", "/c"]) assert.equal((await r.call(`http://${r.seller.host}${p}`)).json.paid?.usd6, "10000");
      const now = Math.floor(Date.now() / 1000);
      const all = await r.adm("GET", "/admin/activity?since=0");
      assert.equal(all.status, 200);
      assert.equal(all.json.entries.length, 3);
      assert.equal(all.json.truncated, false);
      assert.ok(all.json.entries[0].ts >= all.json.entries[2].ts);
      assert.equal((await r.adm("GET", `/admin/activity?since=${now + 60}`)).json.entries.length, 0);
      assert.equal((await r.adm("GET", "/admin/activity?since=0&limit=1")).json.entries.length, 3);
      assert.equal((await r.adm("GET", "/admin/activity?limit=1")).json.truncated, undefined);
      for (const bad of ["-1", "abc", "1.5", ""]) assert.equal((await r.adm("GET", `/admin/activity?since=${bad}`)).status, 400, bad);
      assert.equal((await r.adm("GET", "/admin/activity?since=0", undefined, null)).status, 401);
    } finally { await done(r); }
  });
});
