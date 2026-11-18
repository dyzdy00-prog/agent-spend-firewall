// M6: the firewall process. Contract: contracts/M6-firewall.md.
// The agent never holds a key and never talks to the seller: it asks this process to fetch a URL.
// Every signature goes through reader (M2/M3) -> policy + state (M1/M4) -> guarded signer (M5).
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { readEvm } from "./evm.ts";
import { defaultKeyDir, loadOrCreateKeys } from "./keys.ts";
import { checkPolicy, evaluate, findAsset, hostOf, minPruneKeepS, toAtoms, usd6Of } from "./policy.ts";
import { guardedEvmSigner, guardedSvmSigner, RefusedError } from "./signers.ts";
import type { Gate } from "./signers.ts";
import { openStore } from "./store.ts";
import { readSvm } from "./svm.ts";
import type {
  AssetRule, Chain, Decision, EvmSignable, PaymentIntent, Policy, ReaderContext, ReadResult, RefusalCode, Store,
} from "./types.ts";

// ---------------------------------------------------------------- config

export interface FirewallConfig {
  listen: { host: string; port: number };
  keyDir: string;
  storePath: string;
  logPath: string;
  svmRpcUrl?: string;
  /** sha256 hex of the bearer token -> agent id */
  agents: Record<string, string>;
  assets: AssetRule[];
  policy: Policy;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function isLoopbackHost(h: string): boolean {
  return h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Pure: validates a parsed config object and expands `~`. Throws on anything unusable (fail closed). */
export function parseConfig(raw: unknown): FirewallConfig {
  const bad: string[] = [];
  if (!isObj(raw)) throw new Error("config: must be a JSON object");
  const str = (name: string, v: unknown): string => {
    if (typeof v !== "string" || v === "") { bad.push(`${name} must be a non-empty string`); return ""; }
    return v;
  };
  const dec = (name: string, v: unknown): string => {
    try { toAtoms(v as string, 6); } catch { bad.push(`${name} must be a decimal string with at most 6 fraction digits`); }
    return v as string;
  };
  const int = (name: string, v: unknown, min: number): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) { bad.push(`${name} must be an integer >= ${min}`); return 0; }
    return v;
  };

  const l = raw.listen;
  let listen = { host: "", port: 0 };
  if (!isObj(l)) bad.push("listen must be an object");
  else listen = { host: str("listen.host", l.host), port: int("listen.port", l.port, 0) };
  if (listen.port > 65535) bad.push("listen.port out of range");

  const keyDir = expandHome(raw.keyDir === undefined ? defaultKeyDir() : str("keyDir", raw.keyDir));
  const storePath = expandHome(str("storePath", raw.storePath));
  const logPath = expandHome(str("logPath", raw.logPath));

  let svmRpcUrl: string | undefined;
  if (raw.svmRpcUrl !== undefined) {
    svmRpcUrl = str("svmRpcUrl", raw.svmRpcUrl);
    try {
      const u = new URL(svmRpcUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") bad.push("svmRpcUrl must be http(s)");
    } catch { bad.push("svmRpcUrl is not a URL"); }
  }

  const agents: Record<string, string> = {};
  if (!isObj(raw.agents)) bad.push("agents must be an object");
  else {
    for (const [h, id] of Object.entries(raw.agents)) {
      if (!/^[0-9a-f]{64}$/.test(h)) bad.push("agents keys must be lowercase sha256 hex (64 chars)");
      else if (typeof id !== "string" || id === "") bad.push("agents values must be non-empty agent ids");
      else Object.defineProperty(agents, h, { value: id, enumerable: true, writable: true, configurable: true });
    }
  }

  const assets: AssetRule[] = [];
  if (!Array.isArray(raw.assets)) bad.push("assets must be an array");
  else {
    raw.assets.forEach((a, i) => {
      if (!isObj(a)) { bad.push(`assets[${i}] must be an object`); return; }
      const rule: AssetRule = {
        network: str(`assets[${i}].network`, a.network),
        asset: str(`assets[${i}].asset`, a.asset),
        decimals: int(`assets[${i}].decimals`, a.decimals, 0),
        usd_per_unit: dec(`assets[${i}].usd_per_unit`, a.usd_per_unit),
      };
      if (a.evm_domain !== undefined) {
        const d = a.evm_domain;
        if (!isObj(d) || typeof d.name !== "string" || typeof d.version !== "string") bad.push(`assets[${i}].evm_domain invalid`);
        else rule.evm_domain = { name: d.name, version: d.version };
      }
      if (a.svm_token_program !== undefined) rule.svm_token_program = str(`assets[${i}].svm_token_program`, a.svm_token_program);
      assets.push(rule);
    });
  }

  const p = raw.policy;
  let policy = {} as Policy;
  if (!isObj(p)) bad.push("policy must be an object");
  else {
    if (p.assets !== undefined) bad.push("policy.assets must not be set; define `assets` at the top level");
    const networks = Array.isArray(p.networks) && p.networks.every((n) => typeof n === "string" && n !== "")
      ? (p.networks as string[]) : (bad.push("policy.networks must be an array of strings"), []);
    const payees: Policy["payees"] = Object.create(null);
    if (!isObj(p.payees)) bad.push("policy.payees must be an object");
    else {
      for (const [host, byChain] of Object.entries(p.payees)) {
        if (!isObj(byChain)) { bad.push("policy.payees entries must be objects"); continue; }
        const entry: Partial<Record<Chain, string[]>> = {};
        for (const [chain, list] of Object.entries(byChain)) {
          if ((chain !== "evm" && chain !== "svm") || !Array.isArray(list) || !list.every((x) => typeof x === "string")) {
            bad.push(`policy.payees[${host}] must map evm/svm to string arrays`); continue;
          }
          entry[chain] = list as string[];
        }
        Object.defineProperty(payees, host, { value: entry, enumerable: true, writable: true, configurable: true });
      }
    }
    const pagents: Policy["agents"] = Object.create(null);
    if (!isObj(p.agents)) bad.push("policy.agents must be an object");
    else {
      for (const [id, r] of Object.entries(p.agents)) {
        if (!isObj(r)) { bad.push(`policy.agents[${id}] must be an object`); continue; }
        const rule: Policy["agents"][string] = { budget_usd: dec(`policy.agents[${id}].budget_usd`, r.budget_usd) };
        if (r.cap_usd !== undefined) rule.cap_usd = dec(`policy.agents[${id}].cap_usd`, r.cap_usd);
        if (r.hosts !== undefined) {
          if (!Array.isArray(r.hosts) || !r.hosts.every((h) => typeof h === "string")) bad.push(`policy.agents[${id}].hosts must be strings`);
          else rule.hosts = r.hosts as string[];
        }
        Object.defineProperty(pagents, id, { value: rule, enumerable: true, writable: true, configurable: true });
      }
    }
    if (typeof p.known_hosts_only !== "boolean") bad.push("policy.known_hosts_only must be a boolean");
    policy = {
      networks,
      assets,
      cap_usd: dec("policy.cap_usd", p.cap_usd),
      budget_usd: dec("policy.budget_usd", p.budget_usd),
      window_s: int("policy.window_s", p.window_s, 1),
      max_validity_s: int("policy.max_validity_s", p.max_validity_s, 1),
      min_amount_usd: dec("policy.min_amount_usd", p.min_amount_usd),
      max_signatures_per_window: int("policy.max_signatures_per_window", p.max_signatures_per_window, 0),
      known_hosts_only: p.known_hosts_only === true,
      payees,
      block_after_undelivered: int("policy.block_after_undelivered", p.block_after_undelivered, 0),
      undelivered_window_s: int("policy.undelivered_window_s", p.undelivered_window_s, 0),
      agents: pagents,
    };
    if (p.host_budget_usd !== undefined) policy.host_budget_usd = dec("policy.host_budget_usd", p.host_budget_usd);
  }

  if (bad.length === 0) {
    try { checkPolicy(policy); } catch (e) { bad.push(e instanceof Error ? e.message : String(e)); }
    if (policy.networks.some((n) => n.startsWith("solana:")) && svmRpcUrl === undefined) bad.push("svmRpcUrl is required when a Solana network is enabled");
  }
  if (bad.length) throw new Error(`invalid config: ${bad.join("; ")}`);
  const cfg: FirewallConfig = { listen, keyDir, storePath, logPath, agents, assets, policy };
  if (svmRpcUrl !== undefined) cfg.svmRpcUrl = svmRpcUrl;
  return cfg;
}

export function loadConfig(file: string): FirewallConfig {
  let text: string;
  try { text = fs.readFileSync(expandHome(file), "utf8"); } catch { throw new Error("config: cannot read file"); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("config: not valid JSON"); }
  return parseConfig(raw);
}

// ---------------------------------------------------------------- helpers

const MAX_REQ_BODY = 8 * 1024;
const MAX_RESP_BODY = 256 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export interface FetchResult {
  status: number;
  paid: { usd6: string; network: string; payee: string; tx?: string } | null;
  refused: { code: RefusalCode; reason: string } | null;
  body: string;
}

interface LogEntry {
  ts: number; agent: string; host: string; network: string; asset: string; amountAtoms: string;
  usd6?: string; payee: string; allow: boolean; code?: string; reason?: string; delivered?: boolean; tx?: string; sellerError?: string;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= max) { await reader.cancel().catch(() => {}); break; }
  }
  const all = Buffer.concat(chunks);
  return new TextDecoder("utf-8").decode(all.subarray(0, max));
}

type Raw = { status: number; headers: Headers; body: string };

async function getOnce(url: string, headers: Record<string, string>): Promise<Raw> {
  const res = await fetch(url, { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await readCapped(res, MAX_RESP_BODY);
  return { status: res.status, headers: res.headers, body };
}

const isRedirect = (s: number): boolean => s >= 300 && s < 400;
const refusedResult = (status: number, code: RefusalCode, reason: string, body = ""): FetchResult => ({
  status, paid: null, refused: { code, reason }, body,
});

function chainOf(network: string): Chain | null {
  if (network.startsWith("eip155:")) return "evm";
  if (network.startsWith("solana:")) return "svm";
  return null;
}

// ---------------------------------------------------------------- core

export interface Firewall {
  fetchFor(agent: string, url: string): Promise<FetchResult>;
  readLog(limit: number): LogEntry[];
  close(): void;
  addresses: { evm: string; svm: string };
}

export async function createFirewall(cfg: FirewallConfig): Promise<Firewall> {
  checkPolicy(cfg.policy);
  const keys = await loadOrCreateKeys(cfg.keyDir);
  const store: Store = openStore(cfg.storePath);
  fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true, mode: 0o700 });
  const policy = cfg.policy;
  const keepS = minPruneKeepS(policy);
  const doPrune = () => { try { store.prune(Math.floor(Date.now() / 1000), keepS); } catch { /* next tick */ } };
  doPrune();
  const timer = setInterval(doPrune, 3_600_000);
  timer.unref();
  const evmPayer = keys.evmAddress.toLowerCase();

  const writeLog = (e: LogEntry) => {
    fs.appendFileSync(cfg.logPath, JSON.stringify(e) + "\n", { mode: 0o600 });
  };

  async function fetchFor(agent: string, url: string): Promise<FetchResult> {
    const host = hostOf(url);
    if (host === null) return refusedResult(400, "HOST", "url is not a valid http(s) URL");

    let first: Raw;
    try { first = await getOnce(url, { accept: "*/*" }); } catch { return { status: 502, paid: null, refused: null, body: "" }; }
    if (isRedirect(first.status)) return refusedResult(502, "HOST", "redirect");
    if (first.status !== 402) return { status: first.status, paid: null, refused: null, body: first.body };

    // ---- 402: parse and choose a requirement (nothing is signed before the gate approves)
    const httpClient = new x402HTTPClient(new x402Client());
    let pr: PaymentRequired;
    try {
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(first.body); } catch { parsedBody = undefined; }
      pr = httpClient.getPaymentRequiredResponse((n) => first.headers.get(n), parsedBody);
    } catch {
      return refusedResult(first.status, "FORMAT", "unparseable 402 response", first.body);
    }
    if (pr.x402Version !== 2 || !Array.isArray(pr.accepts)) {
      return refusedResult(first.status, "NETWORK", "only x402 v2 is supported", first.body);
    }
    const exact = pr.accepts.filter((r) => isObj(r) && r.scheme === "exact" && typeof r.network === "string");
    const inNet = exact.filter((r) => policy.networks.includes(r.network));
    const log0 = exact[0] ?? pr.accepts[0];
    const logBase = (r: PaymentRequirements | undefined) => ({
      ts: Math.floor(Date.now() / 1000), agent, host,
      network: String(r?.network ?? ""), asset: String(r?.asset ?? ""),
      amountAtoms: String(r?.amount ?? ""), payee: String(r?.payTo ?? ""),
    });
    if (inNet.length === 0) {
      const reason = exact.length === 0 ? "no exact-scheme requirement" : "no requirement on an allowed network";
      writeLog({ ...logBase(log0), allow: false, code: "NETWORK", reason });
      return refusedResult(first.status, "NETWORK", reason, first.body);
    }
    const chosen = inNet.find((r) => typeof r.asset === "string" && chainOf(r.network) !== null && findAsset(policy.assets, r.network, r.asset) !== null);
    if (chosen === undefined) {
      writeLog({ ...logBase(inNet[0]), allow: false, code: "ASSET", reason: "no requirement with an accepted asset" });
      return refusedResult(first.status, "ASSET", "no requirement with an accepted asset", first.body);
    }
    const chain = chainOf(chosen.network)!;
    if (!/^[0-9]+$/.test(String(chosen.amount)) || !Number.isSafeInteger(chosen.maxTimeoutSeconds) ||
        typeof chosen.payTo !== "string" || chosen.payTo === "") {
      writeLog({ ...logBase(chosen), allow: false, code: "FORMAT", reason: "malformed requirement" });
      return refusedResult(first.status, "FORMAT", "malformed payment requirement", first.body);
    }

    // ---- gate: reader -> policy/state; the signer signs only what comes out of here
    const now = Math.floor(Date.now() / 1000);
    const payer = chain === "evm" ? evmPayer : keys.svmAddress;
    const ctx: ReaderContext = {
      payer, host, agent, now, assets: policy.assets,
      expected: { network: chosen.network, asset: chosen.asset, amount: BigInt(chosen.amount), payTo: chosen.payTo, maxTimeoutSeconds: chosen.maxTimeoutSeconds },
    };
    let intent: PaymentIntent | undefined;
    let decision: Decision | undefined;
    let refusal: { code: RefusalCode; reason: string } | undefined;
    let gateUsed = false;

    const policyStep = <S>(r: ReadResult<S>): { ok: true; signable: S } | { ok: false; code: RefusalCode; reason: string } => {
      if (!r.ok) { refusal = { code: r.code, reason: r.reason }; return { ok: false, code: r.code, reason: r.reason }; }
      intent = r.intent;
      let d: Decision;
      try { d = store.decideAndRecord(r.intent, now, (view) => evaluate(r.intent, policy, view, now)); }
      catch { refusal = { code: "FORMAT", reason: "policy evaluation failed" }; return { ok: false, ...refusal }; }
      if (!d.allow) { refusal = { code: d.code, reason: d.reason }; return { ok: false, code: d.code, reason: d.reason }; }
      decision = d;
      return { ok: true, signable: r.signable };
    };
    const once = async <S>(f: () => Promise<ReadResult<S>> | ReadResult<S>) => {
      if (gateUsed) {
        refusal = { code: "REPLAY", reason: "gate already used for this request" };
        return { ok: false as const, ...refusal };
      }
      gateUsed = true;
      return policyStep(await f());
    };

    const scoped = new x402Client();
    // The x402 library's own spend controls (default $1 cap, default assets) are replaced by our policy.
    scoped.setSpendControls(false);
    if (chain === "evm") {
      const gate: Gate<EvmSignable> = (raw) => once(() => readEvm(raw, ctx));
      scoped.register(chosen.network, new ExactEvmScheme(guardedEvmSigner(cfg.keyDir, gate)));
    } else {
      const gate: Gate<Uint8Array> = (raw) => once(() => readSvm(raw as Uint8Array, ctx));
      const signer = await guardedSvmSigner(cfg.keyDir, gate);
      scoped.register(chosen.network, new ExactSvmScheme(signer as never, cfg.svmRpcUrl !== undefined ? { rpcUrl: cfg.svmRpcUrl } : undefined));
    }

    const single: PaymentRequired = { ...pr, accepts: [chosen] };
    let header: Record<string, string> | undefined;
    let createErr: unknown;
    try {
      const payload = await new x402HTTPClient(scoped).createPaymentPayload(single);
      header = new x402HTTPClient(scoped).encodePaymentSignatureHeader(payload);
    } catch (e) { createErr = e; }

    const known = intent as PaymentIntent | undefined;
    const ref = refusal as { code: RefusalCode; reason: string } | undefined;
    const dec = decision as Decision | undefined;
    const asset = findAsset(policy.assets, chosen.network, chosen.asset);
    const logFor = (): Omit<LogEntry, "allow"> => {
      const b = logBase(chosen);
      let usd6: string | undefined;
      if (known && asset) { try { usd6 = usd6Of(known, asset).toString(); } catch { /* policy asset malformed */ } }
      return usd6 === undefined ? b : { ...b, usd6 };
    };

    if (header === undefined) {
      if (ref) {
        writeLog({ ...logFor(), allow: false, code: ref.code, reason: ref.reason });
        return refusedResult(first.status, ref.code, ref.reason, first.body);
      }
      const msg = createErr instanceof RefusedError ? createErr.reason : "payment creation failed";
      writeLog({ ...logFor(), allow: dec?.allow === true, code: "FORMAT", reason: msg, delivered: false });
      return refusedResult(502, "FORMAT", msg, first.body);
    }

    // ---- paid retry
    let second: Raw | undefined;
    try { second = await getOnce(url, { accept: "*/*", ...header }); } catch { second = undefined; }
    let tx: string | undefined;
    let settled = false;
    let settleError: string | undefined;
    if (second) {
      try {
        const s = httpClient.getPaymentSettleResponse((n) => second!.headers.get(n));
        settled = s.success !== false;
        const why = (s as { errorReason?: unknown }).errorReason;
        if (!settled && typeof why === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(why)) settleError = why;
        if (typeof s.transaction === "string" && s.transaction !== "") tx = s.transaction;
      } catch { settled = false; }
    }
    const status = second?.status ?? 502;
    // When the seller rejects the payment it answers 402 again; keep its short machine reason
    // (for example "invalid_exact_evm_insufficient_balance") so the owner can see why.
    let sellerError: string | undefined = settleError;
    if (second && status === 402) {
      try {
        const pr = httpClient.getPaymentRequiredResponse((n) => second!.headers.get(n), undefined) as { error?: unknown };
        if (typeof pr.error === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(pr.error)) sellerError = pr.error;
      } catch { sellerError = undefined; }
    }
    const delivered = second !== undefined && status < 400 && !isRedirect(status) && settled;
    if (!delivered) store.markUndelivered(host, Math.floor(Date.now() / 1000));
    const usd6 = (dec && dec.allow ? dec.usd6 : 0n).toString();
    const paid: NonNullable<FetchResult["paid"]> = { usd6, network: chosen.network, payee: known?.payee ?? chosen.payTo };
    if (tx !== undefined) paid.tx = tx;
    writeLog({ ...logFor(), usd6, allow: true, delivered, ...(tx !== undefined ? { tx } : {}), ...(sellerError ? { sellerError } : {}) });
    return { status, paid, refused: null, body: second?.body ?? "" };
  }

  function readLog(limit: number): LogEntry[] {
    let text: string;
    try { text = fs.readFileSync(cfg.logPath, "utf8"); } catch { return []; }
    const out: LogEntry[] = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (lines[i] === "") continue;
      try { out.push(JSON.parse(lines[i]!) as LogEntry); } catch { /* skip torn line */ }
    }
    return out;
  }

  return { fetchFor, readLog, close: () => { clearInterval(timer); store.close(); }, addresses: { evm: keys.evmAddress, svm: keys.svmAddress } };
}

// ---------------------------------------------------------------- HTTP server

export interface RunningFirewall {
  host: string;
  port: number;
  firewall: Firewall;
  close(): Promise<void>;
}

function authenticate(agents: Map<string, Buffer>, header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = /^Bearer (.+)$/i.exec(header);
  if (!m) return null;
  const digest = createHash("sha256").update(m[1]!).digest();
  let found: string | null = null;
  // No early exit: every entry is compared in constant time.
  for (const [id, hash] of agents) if (timingSafeEqual(hash, digest)) found = id;
  return found;
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

const HOST_HEADER_OK = /^(127(\.\d{1,3}){3}|localhost|\[::1\])(:\d+)?$/i;

export async function startFirewall(cfg: FirewallConfig): Promise<RunningFirewall> {
  if (!isLoopbackHost(cfg.listen.host)) throw new Error("listen.host must be a loopback address");
  const firewall = await createFirewall(cfg);
  // Several tokens may map to one agent id; one entry per hash.
  const entries = new Map<string, Buffer>();
  for (const [hex, id] of Object.entries(cfg.agents)) entries.set(`${id}\0${hex}`, Buffer.from(hex, "hex"));
  const idOfKey = (k: string) => k.slice(0, k.indexOf("\0"));
  const authenticateAgent = (header: string | undefined): string | null => {
    const r = authenticate(entries, header);
    return r === null ? null : idOfKey(r);
  };
  const dashboard = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard.html");

  const send = (res: http.ServerResponse, status: number, obj: unknown) => {
    const b = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "cache-control": "no-store" });
    res.end(b);
  };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only loopback host names are served.
      if (!HOST_HEADER_OK.test(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/fetch") {
        const agent = authenticateAgent(req.headers.authorization);
        if (agent === null) return send(res, 401, { error: "unauthorized" });
        const body = await readBody(req, MAX_REQ_BODY);
        if (body === null) { res.setHeader("connection", "close"); return send(res, 413, { error: "body too large" }); }
        let target: unknown;
        try { target = (JSON.parse(body.toString("utf8")) as { url?: unknown }).url; } catch { return send(res, 400, { error: "bad json" }); }
        if (typeof target !== "string" || hostOf(target) === null) return send(res, 400, { error: "bad url" });
        return send(res, 200, await firewall.fetchFor(agent, target));
      }
      if (req.method === "GET" && url.pathname === "/api/log") {
        const n = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 100;
        return send(res, 200, firewall.readLog(limit));
      }
      if (req.method === "GET" && url.pathname === "/") {
        let html: Buffer;
        try { html = fs.readFileSync(dashboard); } catch { return send(res, 404, { error: "dashboard not found" }); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length, "cache-control": "no-store" });
        return void res.end(html);
      }
      return send(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.listen.port, cfg.listen.host, () => { server.off("error", reject); resolve(); });
    });
  } catch (e) { firewall.close(); throw e; }
  const addr = server.address() as { port: number };
  return {
    host: cfg.listen.host, port: addr.port, firewall,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { firewall.close(); resolve(); });
    }),
  };
}
