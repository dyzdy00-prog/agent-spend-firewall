// M6: the firewall process. Contract: contracts/M6-firewall.md.
// The agent never holds a key and never talks to the seller: it asks this process to fetch a URL.
// Every signature goes through reader (M2/M3) -> policy + state (M1/M4) -> guarded signer (M5).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import { DAY_S, checkPolicy, evaluate, findAsset, hostOf, minPruneKeepS, toAtoms, usd6Of } from "./policy.ts";
import { guardedEvmSigner, guardedSvmSigner, RefusedError } from "./signers.ts";
import type { Gate } from "./signers.ts";
import { openStore } from "./store.ts";
import type { FirewallStore } from "./store.ts";
import { load as loadCatalog, lookup as catalogLookup, priceCheck, search as catalogSearch } from "./catalog.ts";
import type { CatalogEntry } from "./catalog.ts";
import { createReaderKey, type ReaderKey } from "./readerkey.ts";
import { readSvm } from "./svm.ts";
import { BlockedAddressError, guardedGet } from "./netguard.ts";
import { createNotifier, crossedWarn, dueDay } from "./notify.ts";
import type { Notifier, NotifierOptions, Summary } from "./notify.ts";
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
  /** host[:port] values (as hostOf returns them) that may resolve to private or loopback addresses — the local bench only. */
  allowPrivateHosts: string[];
  /** sha256 hex of the bearer token -> agent id */
  agents: Record<string, string>;
  assets: AssetRule[];
  policy: Policy;
  /** Seconds a delivered paid response is served again from memory without paying (0 = off). */
  cache_ttl_s: number;
  /** When true, a purchase one agent paid for answers the same URL for the owner's other agents while it is cached. Default false. */
  share_cache: boolean;
  /** The owner's stop switch: while true nothing is signed, for any agent. Kept in the config file, so a restart stays paused. */
  paused: boolean;
  /** Directory holding `catalog.json` (written by `node src/catalog.ts refresh`). Default: the directory of `storePath`. */
  catalogDir: string;
  /** Refuse (OVERPRICED) when the live price exceeds the catalog price by more than this factor. Absent = no check. */
  max_price_vs_catalog?: number;
  /** Refuse (PRICE_JUMP) when an address asks more than this factor times what it cost the last time it delivered. Absent = no check. */
  max_price_jump?: number;
  /** M8: sha256 hex of the owner's admin token. Absent (or the example placeholder) = console disabled. */
  adminTokenSha256?: string;
  /** M8: payments whose usd value is above this wait for the owner. Absent = no approvals. */
  approve_above_usd?: string;
  /** M8: seconds a payment waits for the owner (10..3600, default 120). */
  approval_timeout_s: number;
  /** M8: agent ids whose tokens were revoked through the admin API (kept so the console can list them). */
  revokedAgents: string[];
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
/** Short machine reason from a base64-JSON `PAYMENT-RESPONSE` header, if it reports a failed settlement. */
export function settleReasonFromHeader(h: string | null): string | undefined {
  if (!h) return undefined;
  try {
    const j = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as { success?: unknown; errorReason?: unknown };
    if (j.success === false && typeof j.errorReason === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(j.errorReason)) return j.errorReason;
  } catch { /* not base64 JSON */ }
  return undefined;
}

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

  const allowPrivateHosts: string[] = [];
  if (raw.allowPrivateHosts !== undefined) {
    if (!Array.isArray(raw.allowPrivateHosts) || !raw.allowPrivateHosts.every((h) => typeof h === "string" && h !== "")) {
      bad.push("allowPrivateHosts must be an array of host[:port] strings");
    } else allowPrivateHosts.push(...(raw.allowPrivateHosts as string[]).map((h) => h.toLowerCase()));
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
        if (r.daily_budget_usd !== undefined) rule.daily_budget_usd = dec(`policy.agents[${id}].daily_budget_usd`, r.daily_budget_usd);
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
    if (p.new_seller_cap_usd !== undefined) policy.new_seller_cap_usd = dec("policy.new_seller_cap_usd", p.new_seller_cap_usd);
    if (p.daily_budget_usd !== undefined) policy.daily_budget_usd = dec("policy.daily_budget_usd", p.daily_budget_usd);
    if (p.host_daily_budget_usd !== undefined) policy.host_daily_budget_usd = dec("policy.host_daily_budget_usd", p.host_daily_budget_usd);
  }

  if (bad.length === 0) {
    try { checkPolicy(policy); } catch (e) { bad.push(e instanceof Error ? e.message : String(e)); }
    if (policy.networks.some((n) => n.startsWith("solana:")) && svmRpcUrl === undefined) bad.push("svmRpcUrl is required when a Solana network is enabled");
  }
  let cache_ttl_s = 0;
  if (raw.cache_ttl_s !== undefined) cache_ttl_s = int("cache_ttl_s", raw.cache_ttl_s, 0);
  if (cache_ttl_s > 86_400 * 30) bad.push("cache_ttl_s must be at most 30 days");
  if (raw.share_cache !== undefined && typeof raw.share_cache !== "boolean") bad.push("share_cache must be true or false");
  const share_cache = raw.share_cache === true;
  if (raw.paused !== undefined && typeof raw.paused !== "boolean") bad.push("paused must be true or false");
  const paused = raw.paused === true;
  let catalogDir = path.dirname(storePath);
  if (raw.catalogDir !== undefined) catalogDir = expandHome(str("catalogDir", raw.catalogDir));
  let maxRatio: number | undefined;
  if (raw.max_price_vs_catalog !== undefined) {
    const v = raw.max_price_vs_catalog;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 1_000_000) bad.push("max_price_vs_catalog must be a number >= 1");
    else maxRatio = v;
  }
  let maxJump: number | undefined;
  if (raw.max_price_jump !== undefined) {
    const v = raw.max_price_jump;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 1000) bad.push("max_price_jump must be a number from 1 to 1000");
    else maxJump = v;
  }
  let adminTokenSha256: string | undefined;
  if (raw.adminTokenSha256 !== undefined) {
    const v = raw.adminTokenSha256;
    if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) adminTokenSha256 = v;
    else if (typeof v === "string" && v.startsWith("REPLACE_WITH")) adminTokenSha256 = undefined; // example placeholder: console disabled
    else bad.push("adminTokenSha256 must be lowercase sha256 hex (64 chars)");
  }
  let approve_above_usd: string | undefined;
  if (raw.approve_above_usd !== undefined) approve_above_usd = dec("approve_above_usd", raw.approve_above_usd);
  let approval_timeout_s = 120;
  if (raw.approval_timeout_s !== undefined) {
    approval_timeout_s = int("approval_timeout_s", raw.approval_timeout_s, 10);
    if (approval_timeout_s > 3600) bad.push("approval_timeout_s must be at most 3600");
  }
  const revokedAgents: string[] = [];
  if (raw.revokedAgents !== undefined) {
    if (!Array.isArray(raw.revokedAgents) || !raw.revokedAgents.every((x) => typeof x === "string" && x !== "")) bad.push("revokedAgents must be an array of agent ids");
    else revokedAgents.push(...(raw.revokedAgents as string[]));
  }
  if (bad.length) throw new Error(`invalid config: ${bad.join("; ")}`);
  const cfg: FirewallConfig = { listen, keyDir, storePath, logPath, allowPrivateHosts, agents, assets, policy, cache_ttl_s, share_cache, paused, catalogDir, approval_timeout_s, revokedAgents };
  if (adminTokenSha256 !== undefined) cfg.adminTokenSha256 = adminTokenSha256;
  if (approve_above_usd !== undefined) cfg.approve_above_usd = approve_above_usd;
  if (maxRatio !== undefined) cfg.max_price_vs_catalog = maxRatio;
  if (maxJump !== undefined) cfg.max_price_jump = maxJump;
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
  /** Present when the body came from the paid-response cache: no seller contact, no signature, nothing spent. `from` names the agent that paid, when it was another one. */
  cached?: { usd6: string; ageS: number; from?: string };
}

interface LogEntry {
  ts: number; agent: string; host: string; network: string; asset: string; amountAtoms?: string;
  usd6?: string; payee: string; allow: boolean; code?: string; reason?: string; delivered?: boolean; tx?: string; sellerError?: string;
  cached?: boolean; catalogPayeeChanged?: boolean; approved?: boolean;
  /** With `cached`: the agent whose purchase answered this request, when it was another agent. */
  cachedFrom?: string;
}

export interface CatalogHit {
  url: string; description: string; source: string;
  offers: { network: string; asset: string; usd: string | null; payTo: string }[];
  payable: boolean;
}
export interface CatalogSearchResult { fetchedAt: number; total: number; results: CatalogHit[] }

export interface SpendReport {
  windowS: number;
  budgetUsd6: string;
  spentUsd6: string;
  remainingUsd6: string;
  paid: { count: number; usd6: string };
  delivered: { count: number; usd6: string };
  undelivered: { count: number; usd6: string };
  refused: { count: number; byCode: Record<string, number> };
  cached: { count: number; savedUsd6: string };
  bySeller: { host: string; paidUsd6: string; delivered: number; undelivered: number; refused: number; cachedSavedUsd6: string }[];
  /** What this agent can pay right now, from the same counters the rules use. Always for the current budget window, whatever `windowS` is. */
  limits: SpendLimits;
}

export interface SpendLimits {
  /** The owner's stop switch is on: nothing can be paid. */
  paused: boolean;
  /** Most for one payment: the lower of the owner's limit and this agent's own. */
  capUsd6: string;
  /** Payments above this wait for the owner's click; null when the owner is not asked. */
  askAboveUsd6: string | null;
  /** Left in the current budget window: the lower of this agent's budget and the budget all agents share. */
  windowLeftUsd6: string;
  /** Left in the last-24-hours limits (this agent's and the shared one); null when neither is set. */
  dayLeftUsd6: string | null;
  /** The largest single payment the limits above allow at this moment; "0" while paused. Seller-specific rules can still refuse less. */
  canPayUsd6: string;
}

export const MAX_REPORT_WINDOW_S = 30 * 86_400;
const CACHE_MAX_ENTRIES = 500;

import type { Raw } from "./netguard.ts";

function getOnce(url: string, headers: Record<string, string>, allowPrivate: boolean): Promise<Raw> {
  return guardedGet(url, headers, { allowPrivate, timeoutMs: FETCH_TIMEOUT_MS, maxBody: MAX_RESP_BODY });
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
  reportFor(agent: string, windowS?: number): SpendReport;
  /** null when no catalog is loaded. */
  searchCatalog(q: string, opts: { maxUsd?: string; network?: string; limit: number }): CatalogSearchResult | null;
  /** M8: payments waiting for the owner (host only, never the URL path). */
  pendingApprovals(): PendingApproval[];
  /** M8: false if the id is unknown or already decided. */
  decideApproval(id: string, decision: "approve" | "deny"): boolean;
  /** Owner alerts (src/notify.ts). The target file sits next to the state file. */
  alerts: Notifier;
  /** Optional model key for the Reader (agents/reader.ts). Write-only from the console. */
  readerKey: ReaderKey;
  /** Counts over the decision log for the last `hours`, for the daily message. */
  summaryOf(hours: number): Summary;
  /** The owner's stop switch. Turning it on also refuses every payment that is waiting for approval. Returns how many were refused. */
  setPaused(on: boolean): number;
  /** What was signed in the last 24 hours, as the daily limits count it ("0.40"): all agents, or one. */
  spentDay(agent?: string): string;
  /** Sends the daily message if it is due: once a local day, after DAILY_HOUR, only when alerts are on and there was activity. */
  dailyTick(now?: Date): Promise<boolean>;
  close(): void;
  addresses: { evm: string; svm: string };
}

export interface PendingApproval {
  id: string; agent: string; host: string; network: string; usd: string; payee: string;
  /** unix seconds */
  ts: number;
  /** unix seconds */
  expiresAt: number;
}

export interface FirewallOptions {
  /** Minimum time between catalog file checks (default 60 s). Tests only. */
  catalogCheckMs?: number;
  /** Overrides `approval_timeout_s` (milliseconds, may be below the 10 s config minimum). Tests only. */
  approvalTimeoutMs?: number;
  /** Path of the config file the process was started with; the admin API persists changes there. Absent = memory only. */
  configPath?: string;
  /**
   * Practice mode (`npm start -- --practice`): named scenarios the owner can fire from the console as one of the agents.
   * `urls` returns the URLs to fetch in order; the caller never supplies a URL. Absent = `POST /admin/practice` is 404.
   */
  practice?: PracticeScenarios;
  /** Ready-made agents the console can run as one of the owner's agents. Absent = `POST /admin/runs` is 404. */
  templates?: AgentTemplates;
  /** Where the Reader's model key lives. Default: `anthropic.key` next to the state file, else ANTHROPIC_API_KEY. */
  readerKey?: ReaderKey;
  /** Replaces the HTTP client and the clock of owner alerts. Tests only. */
  notifier?: NotifierOptions;
}

export interface RunStep { kind: string; title: string; host: string; usd: string; detail: string }
export interface AgentTemplates {
  list: readonly { id: string; name: string; about: string }[];
  /** Runs the template as `agent`. Every purchase goes through `fetchFor` like any agent's; `onStep` reports each outcome. */
  run(template: string, agent: string, task: string, onStep: (s: RunStep) => void): Promise<unknown>;
}
export interface Run {
  id: string; agent: string; template: string; task: string; started: number; ended: number | null;
  done: boolean; error: string | null; steps: RunStep[]; result: unknown;
  /** The schedule that started it; absent when the owner pressed Run. */
  schedule?: string;
}
/** A ready-made agent run on a timer. Kept in `schedules.json` next to the state file. */
export interface Schedule {
  id: string; agent: string; template: string; task: string;
  /** Seconds between runs. */
  every_s: number;
  enabled: boolean; created: number;
  /** Unix seconds of the next run. */
  next: number;
  /** What happened the last time it was due: "ran", or why it was skipped. null before the first time. */
  last: string | null;
  lastAt: number | null;
}
export const MAX_SCHEDULES = 20;
export const MIN_EVERY_S = 300;
export const MAX_EVERY_S = 7 * 86400;

/** Pure: the schedules in a schedules.json text. Anything malformed is dropped. */
export function parseSchedules(text: string): Schedule[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(j)) return [];
  const out: Schedule[] = [];
  const str = (v: unknown, n: number): v is string => typeof v === "string" && v !== "" && v.length <= n;
  const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  for (const v of j) {
    if (typeof v !== "object" || v === null) continue;
    const s = v as Partial<Schedule>;
    if (!str(s.id, 40) || !str(s.agent, 80) || !str(s.template, 40) || !str(s.task, MAX_TASK_LEN)) continue;
    if (!int(s.every_s) || s.every_s < MIN_EVERY_S || s.every_s > MAX_EVERY_S || !int(s.created) || !int(s.next)) continue;
    out.push({ id: s.id, agent: s.agent, template: s.template, task: s.task, every_s: s.every_s, enabled: s.enabled === true, created: s.created, next: s.next,
      last: typeof s.last === "string" ? s.last.slice(0, 80) : null, lastAt: int(s.lastAt) ? s.lastAt : null });
    if (out.length === MAX_SCHEDULES) break;
  }
  return out;
}

/** Finished runs kept in memory and, one JSON line each, in `runs.jsonl` next to the state file. */
const MAX_RUNS = 200;
const RUNS_DEFAULT = 20;
const RUN_NOTE_CHARS = 1000;
const RUN_LINE_BYTES = 64 * 1024;

/** Pure: a finished run as it is written to disk: long note texts cut, and no notes at all if the line is still too long. */
export function runLine(run: Run): string {
  const cut = (result: unknown, notes: boolean): unknown => {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return result ?? null;
    const r = { ...(result as Record<string, unknown>) };
    if (Array.isArray(r["notes"])) {
      r["notes"] = notes ? r["notes"].map((n) => (typeof n === "object" && n !== null && typeof (n as { text?: unknown }).text === "string"
        ? { ...n, text: (n as { text: string }).text.slice(0, RUN_NOTE_CHARS) } : n)) : [];
    }
    return r;
  };
  let line = JSON.stringify({ ...run, result: cut(run.result, true) });
  if (Buffer.byteLength(line) > RUN_LINE_BYTES) line = JSON.stringify({ ...run, result: cut(run.result, false) });
  if (Buffer.byteLength(line) > RUN_LINE_BYTES) line = JSON.stringify({ ...run, result: null });
  return line;
}

/** Pure: the finished runs in a runs.jsonl text, newest first, at most `max`. Lines that are not a run are skipped. */
export function parseRuns(text: string, max: number = MAX_RUNS): Run[] {
  const out: Run[] = [];
  const str = (v: unknown, n: number): v is string => typeof v === "string" && v.length <= n;
  for (const l of text.split("\n")) {
    if (l.trim() === "") continue;
    let j: unknown;
    try { j = JSON.parse(l); } catch { continue; }
    if (typeof j !== "object" || j === null) continue;
    const r = j as Partial<Run>;
    if (!str(r.id, 40) || !str(r.agent, 80) || !str(r.template, 40) || !str(r.task, 400) || typeof r.started !== "number" || !Array.isArray(r.steps)) continue;
    const steps: RunStep[] = [];
    for (const s of r.steps.slice(0, MAX_RUN_STEPS)) {
      if (typeof s !== "object" || s === null) continue;
      const t = (k: keyof RunStep) => String((s as RunStep)[k] ?? "").slice(0, 160);
      steps.push({ kind: t("kind"), title: t("title"), host: t("host"), usd: t("usd"), detail: t("detail") });
    }
    out.push({ id: r.id, agent: r.agent, template: r.template, task: r.task, started: r.started, ended: typeof r.ended === "number" ? r.ended : null,
      done: true, error: typeof r.error === "string" ? r.error.slice(0, 160) : null, steps, result: r.result ?? null, ...(str(r.schedule, 40) ? { schedule: r.schedule } : {}) });
  }
  return out.slice(-max).reverse();
}
const MAX_RUN_STEPS = 50;
const MAX_TASK_LEN = 200;

export interface PracticeScenarios {
  /** "simulated": a local practice facilitator accepts the signed payment and nothing goes to a chain. "testnet": real testnet settlement. */
  settlement: "simulated" | "testnet";
  names: readonly string[];
  urls(name: string): string[];
}

export const MAX_PENDING_APPROVALS = 20;

/** Decimal USD string from micro-dollars, at least two fraction digits ("0.40"). */
export function fmtUsd6(v: bigint): string {
  const s = v.toString().padStart(7, "0");
  let f = s.slice(-6).replace(/0+$/, "");
  if (f.length < 2) f = f.padEnd(2, "0");
  return `${s.slice(0, -6)}.${f}`;
}

const DESC_MAX = 200;

export async function createFirewall(cfg: FirewallConfig, opts: FirewallOptions = {}): Promise<Firewall> {
  checkPolicy(cfg.policy);
  const keys = await loadOrCreateKeys(cfg.keyDir);
  const store: FirewallStore = openStore(cfg.storePath);
  fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true, mode: 0o700 });
  const policy = cfg.policy;
  // Recomputed each time: the admin API can change the windows while the process runs.
  const doPrune = () => { try { store.prune(Math.floor(Date.now() / 1000), minPruneKeepS(policy)); } catch { /* next tick */ } };
  doPrune();
  const timer = setInterval(doPrune, 3_600_000);
  timer.unref();
  const evmPayer = keys.evmAddress.toLowerCase();

  const alerts = createNotifier(path.join(path.dirname(cfg.storePath), "notify.json"), opts.notifier);
  const readerKey = opts.readerKey ?? createReaderKey(path.join(path.dirname(cfg.storePath), "anthropic.key"));
  const usdOfLog = (e: LogEntry): string | undefined => {
    try { return typeof e.usd6 === "string" ? fmtUsd6(BigInt(e.usd6)) : undefined; } catch { return undefined; }
  };
  const writeLog = (e: LogEntry) => {
    fs.appendFileSync(cfg.logPath, JSON.stringify(e) + "\n", { mode: 0o600 });
    // Owner alerts: a refusal the owner did not make themselves, or a payment that bought nothing.
    if (!e.allow) {
      if (e.code === "APPROVAL" && e.reason !== "no answer in time") return;
      if (e.code === "PAUSED") return;
      const usd = usdOfLog(e);
      alerts.event({ type: "refused", agent: e.agent, host: e.host, code: e.code ?? "REFUSED", reason: e.reason ?? "", ...(usd !== undefined ? { usd } : {}) });
    } else if (e.cached !== true && e.delivered === false && e.code === undefined) {
      alerts.event({ type: "undelivered", agent: e.agent, host: e.host, usd: usdOfLog(e) ?? "0.00" });
    }
    // A payment that takes the agent past the warning share of its budget: the owner hears before the agent is stopped.
    if (e.allow && e.cached !== true && e.code === undefined && alerts.status() !== null) {
      try {
        const r = reportFor(e.agent), spent = BigInt(r.spentUsd6), budget = BigInt(r.budgetUsd6);
        if (crossedWarn(spent, BigInt(e.usd6 ?? "0"), budget)) {
          alerts.event({ type: "budget", agent: e.agent, spentUsd: fmtUsd6(spent), budgetUsd: fmtUsd6(budget), pct: Number(spent * 100n / budget) });
        }
        const rule = Object.hasOwn(policy.agents, e.agent) ? policy.agents[e.agent] : undefined;
        if (rule?.daily_budget_usd !== undefined) {
          const lim = toAtoms(rule.daily_budget_usd, 6), day = store.spentUsd6(Math.floor(Date.now() / 1000) - DAY_S, { agent: e.agent });
          if (crossedWarn(day, BigInt(e.usd6 ?? "0"), lim)) {
            alerts.event({ type: "budget", agent: e.agent, spentUsd: fmtUsd6(day), budgetUsd: fmtUsd6(lim), pct: Number(day * 100n / lim), daily: true });
          }
        }
      } catch { /* a warning must never break a payment */ }
    }
  };

  // Service catalog (read only; the owner refreshes it with `node src/catalog.ts refresh`). Reloaded when the file changes.
  const catalogFile = path.join(cfg.catalogDir, "catalog.json");
  const checkMs = opts.catalogCheckMs ?? 60_000;
  let catalog: { entries: CatalogEntry[]; fetchedAt: number } | null = null;
  let catalogMtime = -1;
  let catalogCheckedAt = 0;
  const reloadCatalog = () => {
    const nowMs = Date.now();
    if (catalogCheckedAt !== 0 && nowMs - catalogCheckedAt < checkMs) return;
    catalogCheckedAt = nowMs;
    let m: number;
    try { m = fs.statSync(catalogFile).mtimeMs; } catch { catalog = null; catalogMtime = -1; return; }
    if (m === catalogMtime) return;
    catalogMtime = m;
    catalog = loadCatalog(cfg.catalogDir);
  };
  reloadCatalog();

  function searchCatalog(q: string, o: { maxUsd?: string; network?: string; limit: number }): CatalogSearchResult | null {
    reloadCatalog();
    if (catalog === null) return null;
    const so: { maxUsd?: string; network?: string; limit: number } = { limit: Number.MAX_SAFE_INTEGER };
    if (o.maxUsd !== undefined) so.maxUsd = o.maxUsd;
    if (o.network !== undefined) so.network = o.network;
    const all = catalogSearch(catalog.entries, q, so);
    const results: CatalogHit[] = all.slice(0, o.limit).map((e) => ({
      url: e.url,
      description: e.description.slice(0, DESC_MAX),
      source: e.source,
      offers: e.offers.slice(0, 3).map((x) => ({ network: x.network, asset: x.asset, usd: x.usd ?? null, payTo: x.payTo })),
      payable: e.offers.some((x) => x.scheme === "exact" && policy.networks.includes(x.network) && findAsset(policy.assets, x.network, x.asset) !== null),
    }));
    return { fetchedAt: catalog.fetchedAt, total: all.length, results };
  }

  // Paid-response cache: per process, per (agent, full URL); lost on restart. Map keeps insertion order = oldest first.
  const cache = new Map<string, { status: number; body: string; usd6: string; at: number; network: string; asset: string; payee: string; agent: string; url: string }>();
  const cacheKey = (agent: string, url: string) => `${agent}\0${url}`;
  /** URL -> cache key of the newest delivered purchase of it, by any agent. Read only when share_cache is on. */
  const sharedIndex = new Map<string, string>();
  /** Purchases in progress, so the same paid URL asked for twice at once is paid once. */
  const inflight = new Map<string, Promise<void>>();
  /** A cached answer for this agent and URL, logged, or null. */
  const fromCache = (agent: string, url: string, host: string): FetchResult | null => {
    if (cfg.cache_ttl_s <= 0) return null;
    const fresh = (k: string) => {
      const hit = cache.get(k);
      if (hit === undefined) return null;
      if (Date.now() - hit.at >= cfg.cache_ttl_s * 1000) { cache.delete(k); return null; }
      return hit;
    };
    let hit = fresh(cacheKey(agent, url));
    if (hit === null && cfg.share_cache && Object.hasOwn(policy.agents, agent)) {
      // Another agent's purchase, unless this agent is not allowed to buy from that host at all.
      const hosts = policy.agents[agent]!.hosts;
      const k = sharedIndex.get(url);
      if (k !== undefined && (hosts === undefined || hosts.includes(host))) hit = fresh(k);
    }
    if (hit === null) return null;
    const from = hit.agent !== agent ? { cachedFrom: hit.agent } : {};
    writeLog({ ts: Math.floor(Date.now() / 1000), agent, host, network: hit.network, asset: hit.asset, payee: hit.payee, usd6: hit.usd6, allow: true, cached: true, ...from });
    return { status: hit.status, paid: null, refused: null, body: hit.body, cached: { usd6: hit.usd6, ageS: Math.floor((Date.now() - hit.at) / 1000), ...(hit.agent !== agent ? { from: hit.agent } : {}) } };
  };

  // M8: payments waiting for the owner. The spend is already reserved in the store while they wait.
  interface Waiting extends PendingApproval { settle(v: "approve" | "deny" | "timeout" | "closing" | "paused"): void }
  const waiting = new Map<string, Waiting>();
  const approvalWaitMs = () => opts.approvalTimeoutMs ?? cfg.approval_timeout_s * 1000;
  const waitForOwner = (intent: PaymentIntent, usd6: bigint): Promise<"approve" | "deny" | "timeout" | "closing" | "paused" | "full"> => {
    if (waiting.size >= MAX_PENDING_APPROVALS) return Promise.resolve("full");
    const id = randomBytes(8).toString("hex");
    const ms = approvalWaitMs();
    return new Promise((resolve) => {
      const nowMs = Date.now();
      const timer = setTimeout(() => entry.settle("timeout"), ms);
      const entry: Waiting = {
        id, agent: intent.agent, host: intent.host, network: intent.network, usd: fmtUsd6(usd6), payee: intent.payee,
        ts: Math.floor(nowMs / 1000), expiresAt: Math.floor((nowMs + ms) / 1000),
        settle: (v) => {
          if (!waiting.delete(id)) return;
          clearTimeout(timer);
          resolve(v);
        },
      };
      waiting.set(id, entry);
      alerts.event({ type: "approval", agent: intent.agent, host: intent.host, usd: entry.usd, waitS: Math.round(ms / 1000) });
    });
  };
  function pendingApprovals(): PendingApproval[] {
    return [...waiting.values()].map(({ id, agent, host, network, usd, payee, ts, expiresAt }) => ({ id, agent, host, network, usd, payee, ts, expiresAt }));
  }
  const PAUSED_REASON = "payments are paused by the owner";
  function setPaused(on: boolean): number {
    cfg.paused = on;
    if (!on) return 0;
    const all = [...waiting.values()];
    for (const w of all) w.settle("paused");
    return all.length;
  }
  function decideApproval(id: string, decision: "approve" | "deny"): boolean {
    const w = waiting.get(id);
    if (w === undefined) return false;
    w.settle(decision);
    return true;
  }

  async function fetchFor(agent: string, url: string): Promise<FetchResult> {
    const host = hostOf(url);
    if (host === null) return refusedResult(400, "HOST", "url is not a valid http(s) URL");

    const hit = fromCache(agent, url, host);
    if (hit !== null) return hit;

    let first: Raw;
    const allowPrivate = cfg.allowPrivateHosts.includes(host);
    try { first = await getOnce(url, { accept: "*/*" }, allowPrivate); } catch (e) {
      if (e instanceof BlockedAddressError) return refusedResult(502, "HOST", "private or internal address");
      return { status: 502, paid: null, refused: null, body: "" };
    }
    if (isRedirect(first.status)) return refusedResult(502, "HOST", "redirect");
    if (first.status !== 402) return { status: first.status, paid: null, refused: null, body: first.body };

    // ---- the same paid address is being bought right now: wait for that purchase instead of paying twice.
    // Per agent, or across agents when purchases are shared. If the purchase is not delivered, the next in line buys.
    const flightKey = cfg.share_cache ? `*\0${url}` : cacheKey(agent, url);
    if (cfg.cache_ttl_s > 0) {
      for (let i = 0; i < 3; i++) {
        const running = inflight.get(flightKey);
        if (running === undefined) break;
        await running;
        const waited = fromCache(agent, url, host);
        if (waited !== null) return waited;
      }
    }
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => { release = r; });
    const owner = cfg.cache_ttl_s > 0 && !inflight.has(flightKey);
    if (owner) inflight.set(flightKey, mine);
    try { return await payFor(agent, url, host, first, allowPrivate); }
    finally { if (owner) inflight.delete(flightKey); release(); }
  }

  /** The paid path: `first` is the seller's 402. Everything that can sign lives here. */
  async function payFor(agent: string, url: string, host: string, first: Raw, allowPrivate: boolean): Promise<FetchResult> {
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
    let catalogPayeeChanged = false;
    const logBase = (r: PaymentRequirements | undefined) => ({
      ts: Math.floor(Date.now() / 1000), agent, host,
      network: String(r?.network ?? ""), asset: String(r?.asset ?? ""),
      amountAtoms: String(r?.amount ?? ""), payee: String(r?.payTo ?? ""),
      ...(catalogPayeeChanged ? { catalogPayeeChanged: true } : {}),
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

    // ---- the owner's stop switch: nothing is read, checked or signed while it is on
    if (cfg.paused) {
      let usd: { usd6: string } | Record<string, never> = {};
      try {
        const a = findAsset(policy.assets, chosen.network, chosen.asset);
        if (a !== null) usd = { usd6: usd6Of({ amount: BigInt(chosen.amount) } as PaymentIntent, a).toString() };
      } catch { /* logged without an amount */ }
      writeLog({ ...logBase(chosen), ...usd, allow: false, code: "PAUSED", reason: PAUSED_REASON });
      return refusedResult(first.status, "PAUSED", PAUSED_REASON, first.body);
    }

    // ---- catalog price check (optional): a quote far above the public listing is refused before anything is signed
    if (cfg.max_price_vs_catalog !== undefined) {
      reloadCatalog();
      const entry = catalog === null ? null : catalogLookup(catalog.entries, url);
      if (entry !== null) {
        const pc = priceCheck(entry, { network: chosen.network, asset: chosen.asset, amountAtoms: chosen.amount, payTo: chosen.payTo }, cfg.max_price_vs_catalog);
        if (pc.known) {
          catalogPayeeChanged = pc.payeeChanged === true;
          if (pc.overpriced) {
            const r = pc.ratio;
            const reason = r === undefined ? "asks more than the catalog price (listed as free)"
              : `asks ${r >= 10 ? Math.round(r) : Math.round(r * 10) / 10}x the catalog price`;
            writeLog({ ...logBase(chosen), allow: false, code: "OVERPRICED", reason });
            return refusedResult(first.status, "OVERPRICED", reason, first.body);
          }
        }
      }
    }

    // ---- price memory (optional): the same address asking far more than it cost last time is refused before anything is signed.
    // The key is host and path without the query, so "?city=..." does not make an address new.
    let pathKey = "/";
    try { pathKey = new URL(url).pathname.slice(0, 300); } catch { /* hostOf already accepted the URL */ }
    if (cfg.max_price_jump !== undefined) {
      const a = findAsset(policy.assets, chosen.network, chosen.asset);
      let asked: bigint | null = null;
      let last: bigint | null = null;
      try {
        if (a !== null) asked = usd6Of({ amount: BigInt(chosen.amount) } as PaymentIntent, a);
        last = store.lastPrice(host, pathKey);
      } catch { asked = null; }
      if (asked !== null && last !== null && last > 0n && asked * 1000n > last * BigInt(Math.round(cfg.max_price_jump * 1000))) {
        const reason = `asks $${fmtUsd6(asked)}, last time this address cost $${fmtUsd6(last)}`;
        writeLog({ ...logBase(chosen), usd6: asked.toString(), allow: false, code: "PRICE_JUMP", reason });
        return refusedResult(first.status, "PRICE_JUMP", reason, first.body);
      }
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
    let approved = false;

    const policyStep = async <S>(r: ReadResult<S>): Promise<{ ok: true; signable: S } | { ok: false; code: RefusalCode; reason: string }> => {
      if (!r.ok) { refusal = { code: r.code, reason: r.reason }; return { ok: false, code: r.code, reason: r.reason }; }
      intent = r.intent;
      let d: Decision;
      try { d = store.decideAndRecord(r.intent, now, (view) => evaluate(r.intent, policy, view, now)); }
      catch { refusal = { code: "FORMAT", reason: "policy evaluation failed" }; return { ok: false, ...refusal }; }
      if (!d.allow) { refusal = { code: d.code, reason: d.reason }; return { ok: false, code: d.code, reason: d.reason }; }
      // M8: the spend is now reserved. Above the owner's threshold the signature waits for an answer.
      if (cfg.approve_above_usd !== undefined && d.usd6 > toAtoms(cfg.approve_above_usd, 6)) {
        const verdict = await waitForOwner(r.intent, d.usd6);
        if (verdict !== "approve") {
          try { store.releaseSpend(r.intent, now, d.usd6); } catch { /* stays counted: fail closed */ }
          const reason = verdict === "deny" ? "owner denied" : verdict === "timeout" ? "no answer in time"
            : verdict === "full" ? "too many pending" : verdict === "paused" ? PAUSED_REASON : "firewall closing";
          refusal = { code: verdict === "paused" ? "PAUSED" : "APPROVAL", reason };
          return { ok: false, ...refusal };
        }
        approved = true;
      }
      // Paused between the first check and here (the price checks and the wait above take time): release and refuse.
      if (cfg.paused) {
        try { store.releaseSpend(r.intent, now, d.usd6); } catch { /* stays counted: fail closed */ }
        refusal = { code: "PAUSED", reason: PAUSED_REASON };
        return { ok: false, ...refusal };
      }
      decision = d;
      return { ok: true, signable: r.signable };
    };
    const once = async <S>(f: () => Promise<ReadResult<S>> | ReadResult<S>) => {
      if (gateUsed) {
        refusal = { code: "REPLAY", reason: "gate already used for this request" };
        return { ok: false as const, ...refusal };
      }
      gateUsed = true;
      return await policyStep(await f());
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
    try { second = await getOnce(url, { accept: "*/*", ...header }, allowPrivate); } catch { second = undefined; }
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
      } catch {
        settled = false;
        // The library rejects a failed settle response; read its reason directly (base64 JSON header).
        settleError = settleReasonFromHeader(second.headers.get("payment-response"));
      }
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
    // A settled payment answered with nothing is not a delivery: the seller took the money and sent no data.
    const empty = second !== undefined && status < 400 && !isRedirect(status) && settled && second.body.trim() === "";
    if (empty && sellerError === undefined) sellerError = "empty_response";
    const delivered = second !== undefined && status < 400 && !isRedirect(status) && settled && !empty;
    if (!delivered) store.markUndelivered(host, Math.floor(Date.now() / 1000));
    else if (dec && dec.allow) {
      // What the seller has earned: the ordinary cap from now on, and a remembered price for this address.
      try {
        const t = Math.floor(Date.now() / 1000);
        store.markDelivered(host, t);
        store.recordPrice(host, pathKey, dec.usd6, t);
      } catch { /* the payment is done; the next one is judged without this memory */ }
    }
    const usd6 = (dec && dec.allow ? dec.usd6 : 0n).toString();
    const paid: NonNullable<FetchResult["paid"]> = { usd6, network: chosen.network, payee: known?.payee ?? chosen.payTo };
    if (tx !== undefined) paid.tx = tx;
    writeLog({ ...logFor(), usd6, allow: true, ...(approved ? { approved: true } : {}), delivered, ...(tx !== undefined ? { tx } : {}), ...(sellerError ? { sellerError } : {}) });
    if (delivered && cfg.cache_ttl_s > 0 && dec?.allow === true) {
      const k = cacheKey(agent, url);
      cache.delete(k);
      cache.set(k, { status, body: second?.body ?? "", usd6, at: Date.now(), network: chosen.network, asset: chosen.asset, payee: paid.payee, agent, url });
      sharedIndex.set(url, k);
      while (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string;
        const gone = cache.get(oldest);
        if (gone !== undefined && sharedIndex.get(gone.url) === oldest) sharedIndex.delete(gone.url);
        cache.delete(oldest);
      }
      if (sharedIndex.size > CACHE_MAX_ENTRIES * 2) for (const [u, key] of sharedIndex) if (!cache.has(key)) sharedIndex.delete(u);
    }
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

  function summaryOf(hours: number): Summary {
    const from = Math.floor(Date.now() / 1000) - hours * 3600;
    let requests = 0, paid = 0, stopped = 0, cached = 0, undelivered = 0, paidV = 0n, savedV = 0n;
    for (const e of readLog(MAX_PERIOD_ENTRIES)) {
      if (typeof e.ts !== "number" || e.ts <= from) continue;
      requests++;
      let v = 0n;
      try { if (typeof e.usd6 === "string") v = BigInt(e.usd6); } catch { /* counted without an amount */ }
      if (!e.allow) stopped++;
      else if (e.cached === true) { cached++; savedV += v; }
      else { paid++; paidV += v; if (e.delivered === false) undelivered++; }
    }
    return { hours, requests, paid, paidUsd: fmtUsd6(paidV), stopped, cached, savedUsd: fmtUsd6(savedV), undelivered };
  }

  // The daily message. A process started after the hour does not send for that day: the owner has just opened the console.
  let lastDay = dueDay(new Date(), "") ?? "";
  async function dailyTick(now: Date = new Date()): Promise<boolean> {
    const day = dueDay(now, lastDay);
    if (day === null) return false;
    lastDay = day;
    if (alerts.status() === null) return false;
    const s = summaryOf(24);
    if (s.requests === 0) return false;
    return (await alerts.summary(s)).ok;
  }
  const dailyTimer = setInterval(() => { void dailyTick().catch(() => {}); }, 60_000);
  dailyTimer.unref();

  function reportFor(agent: string, windowS: number = policy.window_s): SpendReport {
    const nowS = Math.floor(Date.now() / 1000);
    const w = Math.max(1, Math.min(MAX_REPORT_WINDOW_S, Math.floor(windowS)));
    const big = (v: unknown): bigint => { try { return typeof v === "string" ? BigInt(v) : 0n; } catch { return 0n; } };
    let text = "";
    try { text = fs.readFileSync(cfg.logPath, "utf8"); } catch { /* no log yet */ }
    const sellers = new Map<string, { paid: bigint; del: number; und: number; ref: number; saved: bigint }>();
    const sel = (h: string) => { let x = sellers.get(h); if (!x) { x = { paid: 0n, del: 0, und: 0, ref: 0, saved: 0n }; sellers.set(h, x); } return x; };
    let paidN = 0, delN = 0, undN = 0, refN = 0, cachedN = 0;
    let paid = 0n, delV = 0n, undV = 0n, saved = 0n;
    const byCode: Record<string, number> = Object.create(null);
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let e: LogEntry;
      try { e = JSON.parse(line) as LogEntry; } catch { continue; }
      if (e.agent !== agent || typeof e.ts !== "number" || e.ts <= nowS - w) continue;
      const s = sel(String(e.host));
      if (!e.allow) { refN++; byCode[String(e.code ?? "UNKNOWN")] = (byCode[String(e.code ?? "UNKNOWN")] ?? 0) + 1; s.ref++; continue; }
      const v = big(e.usd6);
      if (e.cached === true) { cachedN++; saved += v; s.saved += v; continue; }
      paidN++; paid += v; s.paid += v;
      if (e.delivered === true) { delN++; delV += v; s.del++; } else { undN++; undV += v; s.und++; }
    }
    let agentBudget = 0n;
    const rule = Object.hasOwn(policy.agents, agent) ? policy.agents[agent] : undefined;
    if (rule) agentBudget = toAtoms(rule.budget_usd, 6);
    const budget = rule ? (() => { const g = toAtoms(policy.budget_usd, 6); return g < agentBudget ? g : agentBudget; })() : 0n;
    const bySeller = [...sellers].map(([host, x]) => ({ host, paidUsd6: x.paid.toString(), delivered: x.del, undelivered: x.und, refused: x.ref, cachedSavedUsd6: x.saved.toString() }))
      .sort((a, b) => { const d = BigInt(b.paidUsd6) - BigInt(a.paidUsd6); return d > 0n ? 1 : d < 0n ? -1 : 0; })
      .slice(0, 20);
    return {
      windowS: w, budgetUsd6: budget.toString(), spentUsd6: paid.toString(), remainingUsd6: (budget > paid ? budget - paid : 0n).toString(),
      paid: { count: paidN, usd6: paid.toString() }, delivered: { count: delN, usd6: delV.toString() }, undelivered: { count: undN, usd6: undV.toString() },
      refused: { count: refN, byCode: { ...byCode } }, cached: { count: cachedN, savedUsd6: saved.toString() }, bySeller,
      limits: limitsFor(agent),
    };
  }

  function limitsFor(agent: string): SpendLimits {
    const rule = Object.hasOwn(policy.agents, agent) ? policy.agents[agent] : undefined;
    const nowS = Math.floor(Date.now() / 1000);
    const min = (a: bigint, b: bigint) => (a < b ? a : b);
    const left = (limit: string, spent: bigint) => { const l = toAtoms(limit, 6); return l > spent ? l - spent : 0n; };
    const ask = cfg.approve_above_usd === undefined ? null : toAtoms(cfg.approve_above_usd, 6).toString();
    if (rule === undefined) return { paused: cfg.paused, capUsd6: "0", askAboveUsd6: ask, windowLeftUsd6: "0", dayLeftUsd6: null, canPayUsd6: "0" };
    let cap = toAtoms(policy.cap_usd, 6);
    if (rule.cap_usd !== undefined) cap = min(cap, toAtoms(rule.cap_usd, 6));
    const since = nowS - policy.window_s, day = nowS - DAY_S;
    const windowLeft = min(left(policy.budget_usd, store.spentUsd6(since)), left(rule.budget_usd, store.spentUsd6(since, { agent })));
    let dayLeft: bigint | null = null;
    if (policy.daily_budget_usd !== undefined) dayLeft = left(policy.daily_budget_usd, store.spentUsd6(day));
    if (rule.daily_budget_usd !== undefined) { const d = left(rule.daily_budget_usd, store.spentUsd6(day, { agent })); dayLeft = dayLeft === null ? d : min(dayLeft, d); }
    let can = min(cap, windowLeft);
    if (dayLeft !== null) can = min(can, dayLeft);
    if (cfg.paused) can = 0n;
    return { paused: cfg.paused, capUsd6: cap.toString(), askAboveUsd6: ask, windowLeftUsd6: windowLeft.toString(), dayLeftUsd6: dayLeft === null ? null : dayLeft.toString(), canPayUsd6: can.toString() };
  }

  const spentDay = (agent?: string): string =>
    fmtUsd6(store.spentUsd6(Math.floor(Date.now() / 1000) - DAY_S, agent === undefined ? undefined : { agent }));

  return {
    fetchFor, readLog, reportFor, searchCatalog, pendingApprovals, decideApproval, alerts, readerKey, summaryOf, dailyTick, spentDay, setPaused,
    close: () => { clearInterval(timer); clearInterval(dailyTimer); for (const w of [...waiting.values()]) w.settle("closing"); store.close(); },
    addresses: { evm: keys.evmAddress, svm: keys.svmAddress },
  };
}

// ---------------------------------------------------------------- HTTP server

export interface RunningFirewall {
  host: string;
  port: number;
  firewall: Firewall;
  /** Starts the schedules that are due at `nowS` (default: now). The server calls this every 30 s; tests call it directly. */
  tickSchedules(nowS?: number): number;
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

// ---------------------------------------------------------------- M8: admin API

const MAX_ADMIN_BODY = 16 * 1024;
/** Most log entries one `GET /admin/activity?since=` answer carries (newest first). */
export const MAX_PERIOD_ENTRIES = 20_000;
const DEC6 = /^[0-9]+(\.[0-9]{1,6})?$/;
const AGENT_ID = /^[a-z0-9-]{1,40}$/;
const OPTIONAL_LIMITS = ["daily_budget_usd", "host_budget_usd", "host_daily_budget_usd"] as const;
const RULE_KEYS = ["cap_usd", "budget_usd", "window_s", "approve_above_usd", "block_after_undelivered", "known_hosts_only", "max_price_vs_catalog", "cache_ttl_s", "new_seller_cap_usd", "max_price_jump", "share_cache", "daily_budget_usd", "host_budget_usd", "host_daily_budget_usd"] as const;

/** Spreadsheet formula injection: a cell that starts with = + - @ (or a control char Excel also treats so) gets a leading quote. */
export function csvCell(v: unknown): string {
  let t = v === undefined || v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function makeAdmin(cfg: FirewallConfig, firewall: Firewall, configPath: string | undefined, entries: Map<string, Buffer>, practice?: PracticeScenarios, templates?: AgentTemplates) {
  // Run history survives a restart. A run still working when the process stops is not kept.
  const runsFile = path.join(path.dirname(cfg.storePath), "runs.jsonl");
  let runs: Run[] = [];
  if (templates !== undefined) {
    try {
      const text = fs.readFileSync(runsFile, "utf8");
      runs = parseRuns(text);
      // Keep the file from growing without bound: once it holds twice what is shown, rewrite it with what is shown.
      if (text.split("\n").length > MAX_RUNS * 2) fs.writeFileSync(runsFile, [...runs].reverse().map(runLine).join("\n") + "\n", { mode: 0o600 });
    } catch { /* no history yet */ }
  }
  const schedulesFile = path.join(path.dirname(cfg.storePath), "schedules.json");
  let schedules: Schedule[] = [];
  if (templates !== undefined) { try { schedules = parseSchedules(fs.readFileSync(schedulesFile, "utf8")); } catch { /* none yet */ } }
  const saveSchedules = (): boolean => {
    const tmp = `${schedulesFile}.${process.pid}.tmp`;
    try {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, schedulesFile);
      return true;
    } catch { fs.rmSync(tmp, { force: true }); return false; }
  };
  const cleanTask = (v: unknown): string | null => {
    const t = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim() : "";
    return t === "" || t.length > MAX_TASK_LEN ? null : t;
  };
  /** Why this agent cannot run this template now, or null. */
  const cannotRun = (agent: unknown, template: unknown): { status: number; error: string } | null => {
    if (templates === undefined) return { status: 404, error: "not found" };
    if (typeof agent !== "string" || !agentIds().includes(agent)) return { status: 400, error: "agent: unknown" };
    if (cfg.revokedAgents.includes(agent)) return { status: 400, error: "agent: revoked" };
    if (typeof template !== "string" || !templates.list.some((t) => t.id === template)) return { status: 400, error: "template: unknown" };
    if (runs.some((r) => !r.done && r.agent === agent)) return { status: 409, error: "this agent is already running a task" };
    return null;
  };
  const beginRun = (agent: string, template: string, task: string, schedule?: string): Run => {
    const run: Run = { id: randomBytes(6).toString("hex"), agent, template, task, started: Math.floor(Date.now() / 1000), ended: null, done: false, error: null, steps: [], result: null, ...(schedule === undefined ? {} : { schedule }) };
    runs.unshift(run);
    while (runs.length > MAX_RUNS) { const i = runs.findLastIndex((r) => r.done); if (i < 0) break; runs.splice(i, 1); }
    const text = (s: unknown, max: number) => String(s ?? "").slice(0, max);
    const onStep = (s: RunStep) => {
      if (run.steps.length < MAX_RUN_STEPS) run.steps.push({ kind: text(s.kind, 20), title: text(s.title, 80), host: text(s.host, 80), usd: text(s.usd, 20), detail: text(s.detail, 160) });
    };
    void templates!.run(template, agent, task, onStep).then(
      (result) => { run.result = result ?? null; keepRun(run); },
      () => { run.error = "the run failed"; keepRun(run); },
    );
    return run;
  };
  /** Starts every schedule that is due. A schedule that cannot run now is skipped until its next time, with the reason kept. Returns how many started. */
  const tick = (nowS: number = Math.floor(Date.now() / 1000)): number => {
    if (templates === undefined) return 0;
    let started = 0, changed = false;
    for (const s of schedules) {
      if (!s.enabled || s.next > nowS) continue;
      const no = cfg.paused ? { status: 409, error: "payments are paused" } : cannotRun(s.agent, s.template);
      if (no === null) { beginRun(s.agent, s.template, s.task, s.id); s.last = "ran"; started++; }
      else s.last = `skipped: ${no.error}`;
      s.lastAt = nowS;
      s.next = nowS + s.every_s;
      changed = true;
    }
    if (changed) saveSchedules();
    return started;
  };
  const keepRun = (run: Run) => {
    run.ended = Math.floor(Date.now() / 1000);
    run.done = true;
    try { fs.appendFileSync(runsFile, runLine(run) + "\n", { mode: 0o600 }); } catch { /* history is a convenience: the decision log is the record */ }
  };
  const policy = cfg.policy;
  const adminHash = cfg.adminTokenSha256 === undefined ? null : Buffer.from(cfg.adminTokenSha256, "hex");
  const reply = (res: http.ServerResponse, status: number, obj: unknown) => {
    const b = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "cache-control": "no-store" });
    res.end(b);
  };

  /** Rewrites the config file (read fresh, so other keys stay as they are); tmp + rename, mode 0600. Throws if it cannot. */
  const persist = (mutate: (raw: Record<string, any>) => void): void => {
    if (configPath === undefined) return;
    const file = expandHome(configPath);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    mutate(raw);
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  };

  const rulesJson = () => ({
    cap_usd: policy.cap_usd, budget_usd: policy.budget_usd, window_s: policy.window_s,
    approve_above_usd: cfg.approve_above_usd ?? null,
    block_after_undelivered: policy.block_after_undelivered, known_hosts_only: policy.known_hosts_only,
    max_price_vs_catalog: cfg.max_price_vs_catalog ?? null, cache_ttl_s: cfg.cache_ttl_s,
    new_seller_cap_usd: policy.new_seller_cap_usd ?? null, max_price_jump: cfg.max_price_jump ?? null,
    share_cache: cfg.share_cache,
    daily_budget_usd: policy.daily_budget_usd ?? null,
    host_budget_usd: policy.host_budget_usd ?? null,
    host_daily_budget_usd: policy.host_daily_budget_usd ?? null,
  });
  const agentIds = (): string[] => {
    const ids = new Set<string>([...Object.keys(policy.agents), ...cfg.revokedAgents, ...Object.values(cfg.agents)]);
    return [...ids].sort();
  };
  const stateJson = () => ({
    persisted: configPath !== undefined,
    addresses: firewall.addresses,
    networks: [...policy.networks],
    rules: rulesJson(),
    approval_timeout_s: cfg.approval_timeout_s,
    agents: agentIds().map((id) => {
      const r = Object.hasOwn(policy.agents, id) ? policy.agents[id] : undefined;
      return { id, budget_usd: r?.budget_usd ?? null, cap_usd: r?.cap_usd ?? null, daily_budget_usd: r?.daily_budget_usd ?? null,
        spent_day_usd: firewall.spentDay(id), revoked: cfg.revokedAgents.includes(id) };
    }),
    spent_day_usd: firewall.spentDay(),
    paused: cfg.paused,
    pending: firewall.pendingApprovals().length,
    practice: practice === undefined ? [] : [...practice.names],
    practice_settlement: practice === undefined ? null : practice.settlement,
    alerts: firewall.alerts.status(),
    templates: templates === undefined ? [] : templates.list.map((t) => ({ id: t.id, name: t.name, about: t.about })),
    reader: firewall.readerKey.status(),
  });

  /** Validates a PUT /admin/rules body against the running config. Returns the error text or the parsed changes. */
  const checkRules = (body: unknown): { error: string } | { changes: Record<string, unknown> } => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be a JSON object" };
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!(RULE_KEYS as readonly string[]).includes(k)) return { error: `${k}: unknown field` };
    const has = (k: string) => Object.hasOwn(b, k);
    const dec = (k: string): string | { error: string } => {
      const v = b[k];
      return typeof v === "string" && DEC6.test(v) ? v : { error: `${k}: must be a decimal string with at most 6 fraction digits` };
    };
    const int = (k: string, lo: number, hi: number): number | { error: string } => {
      const v = b[k];
      return typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : { error: `${k}: must be an integer from ${lo} to ${hi}` };
    };
    const ch: Record<string, unknown> = {};
    for (const k of ["cap_usd", "budget_usd"]) {
      if (!has(k)) continue;
      const v = dec(k); if (typeof v !== "string") return v;
      ch[k] = v;
    }
    if (has("approve_above_usd") && b["approve_above_usd"] !== null) {
      const v = dec("approve_above_usd"); if (typeof v !== "string") return v;
      ch["approve_above_usd"] = v;
    } else if (has("approve_above_usd")) ch["approve_above_usd"] = null;
    if (has("window_s")) { const v = int("window_s", 60, 2_592_000); if (typeof v !== "number") return v; ch["window_s"] = v; }
    if (has("block_after_undelivered")) { const v = int("block_after_undelivered", 0, 100); if (typeof v !== "number") return v; ch["block_after_undelivered"] = v; }
    if (has("cache_ttl_s")) { const v = int("cache_ttl_s", 0, 2_592_000); if (typeof v !== "number") return v; ch["cache_ttl_s"] = v; }
    if (has("known_hosts_only")) {
      if (typeof b["known_hosts_only"] !== "boolean") return { error: "known_hosts_only: must be true or false" };
      ch["known_hosts_only"] = b["known_hosts_only"];
    }
    if (has("share_cache")) {
      if (typeof b["share_cache"] !== "boolean") return { error: "share_cache: must be true or false" };
      ch["share_cache"] = b["share_cache"];
    }
    if (has("max_price_vs_catalog")) {
      const v = b["max_price_vs_catalog"];
      if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1_000_000)) return { error: "max_price_vs_catalog: must be null or a number of at least 1" };
      ch["max_price_vs_catalog"] = v;
    }
    if (has("new_seller_cap_usd") && b["new_seller_cap_usd"] !== null) {
      const v = dec("new_seller_cap_usd"); if (typeof v !== "string") return v;
      ch["new_seller_cap_usd"] = v;
    } else if (has("new_seller_cap_usd")) ch["new_seller_cap_usd"] = null;
    // Optional ceilings stored under `policy`: null clears, otherwise a decimal above 0.
    for (const k of OPTIONAL_LIMITS) {
      if (!has(k)) continue;
      if (b[k] === null) { ch[k] = null; continue; }
      const v = dec(k); if (typeof v !== "string") return v;
      if (toAtoms(v, 6) <= 0n) return { error: `${k}: must be above 0 (or null)` };
      ch[k] = v;
    }
    if (has("max_price_jump")) {
      const v = b["max_price_jump"];
      if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1000)) return { error: "max_price_jump: must be null or a number from 1 to 1000" };
      ch["max_price_jump"] = v;
    }
    const cap = (ch["cap_usd"] as string | undefined) ?? policy.cap_usd;
    const budget = (ch["budget_usd"] as string | undefined) ?? policy.budget_usd;
    const approve = has("approve_above_usd") ? (ch["approve_above_usd"] as string | null) : (cfg.approve_above_usd ?? null);
    if (toAtoms(cap, 6) <= 0n) return { error: "cap_usd: must be greater than 0" };
    if ((has("cap_usd") || has("budget_usd")) && toAtoms(budget, 6) < toAtoms(cap, 6)) return { error: "budget_usd: must be at least cap_usd" };
    if ((has("cap_usd") || has("approve_above_usd")) && approve !== null && toAtoms(approve, 6) >= toAtoms(cap, 6)) {
      return { error: "approve_above_usd: must be below cap_usd (or null)" };
    }
    const newSeller = has("new_seller_cap_usd") ? (ch["new_seller_cap_usd"] as string | null) : (policy.new_seller_cap_usd ?? null);
    if ((has("cap_usd") || has("new_seller_cap_usd")) && newSeller !== null && (toAtoms(newSeller, 6) <= 0n || toAtoms(newSeller, 6) >= toAtoms(cap, 6))) {
      return { error: "new_seller_cap_usd: must be above 0 and below cap_usd (or null)" };
    }
    try {
      const { new_seller_cap_usd: _old, ...rest } = policy;
      checkPolicy({
        ...rest,
        cap_usd: cap,
        ...(newSeller === null ? {} : { new_seller_cap_usd: newSeller }),
        window_s: (ch["window_s"] as number | undefined) ?? policy.window_s,
        block_after_undelivered: (ch["block_after_undelivered"] as number | undefined) ?? policy.block_after_undelivered,
      });
    } catch (e) { return { error: e instanceof Error ? e.message : "invalid policy" }; }
    return { changes: ch };
  };

  const applyRules = (ch: Record<string, unknown>) => {
    persist((raw) => {
      raw.policy = raw.policy ?? {};
      for (const k of ["cap_usd", "budget_usd", "window_s", "block_after_undelivered", "known_hosts_only"]) if (Object.hasOwn(ch, k)) raw.policy[k] = ch[k];
      for (const k of ["approve_above_usd", "max_price_vs_catalog", "max_price_jump"]) {
        if (!Object.hasOwn(ch, k)) continue;
        if (ch[k] === null) delete raw[k]; else raw[k] = ch[k];
      }
      if (Object.hasOwn(ch, "new_seller_cap_usd")) {
        if (ch["new_seller_cap_usd"] === null) delete raw.policy.new_seller_cap_usd; else raw.policy.new_seller_cap_usd = ch["new_seller_cap_usd"];
      }
      for (const k of OPTIONAL_LIMITS) {
        if (!Object.hasOwn(ch, k)) continue;
        if (ch[k] === null) delete raw.policy[k]; else raw.policy[k] = ch[k];
      }
      if (Object.hasOwn(ch, "cache_ttl_s")) raw.cache_ttl_s = ch["cache_ttl_s"];
      if (Object.hasOwn(ch, "share_cache")) raw.share_cache = ch["share_cache"];
    });
    for (const k of OPTIONAL_LIMITS) {
      if (!Object.hasOwn(ch, k)) continue;
      if (ch[k] === null) delete policy[k]; else policy[k] = ch[k] as string;
    }
    // Everything below is synchronous: no request ever sees a half-applied rule set.
    if (Object.hasOwn(ch, "cap_usd")) policy.cap_usd = ch["cap_usd"] as string;
    if (Object.hasOwn(ch, "budget_usd")) policy.budget_usd = ch["budget_usd"] as string;
    if (Object.hasOwn(ch, "window_s")) policy.window_s = ch["window_s"] as number;
    if (Object.hasOwn(ch, "block_after_undelivered")) policy.block_after_undelivered = ch["block_after_undelivered"] as number;
    if (Object.hasOwn(ch, "known_hosts_only")) policy.known_hosts_only = ch["known_hosts_only"] as boolean;
    if (Object.hasOwn(ch, "cache_ttl_s")) cfg.cache_ttl_s = ch["cache_ttl_s"] as number;
    if (Object.hasOwn(ch, "share_cache")) cfg.share_cache = ch["share_cache"] as boolean;
    if (Object.hasOwn(ch, "approve_above_usd")) {
      if (ch["approve_above_usd"] === null) delete cfg.approve_above_usd; else cfg.approve_above_usd = ch["approve_above_usd"] as string;
    }
    if (Object.hasOwn(ch, "max_price_vs_catalog")) {
      if (ch["max_price_vs_catalog"] === null) delete cfg.max_price_vs_catalog; else cfg.max_price_vs_catalog = ch["max_price_vs_catalog"] as number;
    }
    if (Object.hasOwn(ch, "max_price_jump")) {
      if (ch["max_price_jump"] === null) delete cfg.max_price_jump; else cfg.max_price_jump = ch["max_price_jump"] as number;
    }
    if (Object.hasOwn(ch, "new_seller_cap_usd")) {
      if (ch["new_seller_cap_usd"] === null) delete policy.new_seller_cap_usd; else policy.new_seller_cap_usd = ch["new_seller_cap_usd"] as string;
    }
  };

  const csv = (): string => {
    const head = "ts,agent,host,network,usd,payee,decision,code,reason,delivered,tx";
    const rows = firewall.readLog(Number.MAX_SAFE_INTEGER).reverse().map((e) => {
      let usd = "";
      try { if (typeof e.usd6 === "string") usd = fmtUsd6(BigInt(e.usd6)); } catch { /* leave empty */ }
      const decision = !e.allow ? "refuse" : e.cached === true ? "cached" : "allow";
      return [e.ts, e.agent, e.host, e.network, usd, e.payee, decision, e.code, e.reason, e.delivered, e.tx].map(csvCell).join(",");
    });
    return [head, ...rows].join("\n") + "\n";
  };

  const authorized = (header: string | undefined): boolean => {
    if (adminHash === null || header === undefined) return false;
    const m = /^Bearer (.+)$/i.exec(header);
    if (!m) return false;
    return timingSafeEqual(adminHash, createHash("sha256").update(m[1]!).digest());
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (adminHash === null) return reply(res, 404, { error: "not found" });
    if (!authorized(req.headers.authorization)) return reply(res, 401, { error: "unauthorized" });
    const method = req.method ?? "";
    const p = url.pathname;
    const jsonBody = async (): Promise<{ ok: true; value: unknown } | { ok: false }> => {
      const body = await readBody(req, MAX_ADMIN_BODY);
      if (body === null) { res.setHeader("connection", "close"); reply(res, 413, { error: "body too large" }); return { ok: false }; }
      try { return { ok: true, value: JSON.parse(body.toString("utf8")) }; } catch { reply(res, 400, { error: "bad json" }); return { ok: false }; }
    };

    if (p === "/admin/state" && method === "GET") return reply(res, 200, stateJson());

    if (p === "/admin/pause" && method === "PUT") {
      const b = await jsonBody(); if (!b.ok) return;
      const v = b.value as Record<string, unknown> | null;
      if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== 1 || typeof v["paused"] !== "boolean") {
        return reply(res, 400, { error: "body must be { \"paused\": true } or { \"paused\": false }" });
      }
      const on = v["paused"];
      try { persist((raw) => { if (on) raw.paused = true; else delete raw.paused; }); }
      catch { return reply(res, 500, { error: "cannot write the config file; nothing changed" }); }
      const refused = firewall.setPaused(on);
      return reply(res, 200, { ...stateJson(), refused_waiting: refused });
    }

    if (p === "/admin/rules" && method === "PUT") {
      const b = await jsonBody(); if (!b.ok) return;
      const r = checkRules(b.value);
      if ("error" in r) return reply(res, 400, r);
      try { applyRules(r.changes); } catch { return reply(res, 500, { error: "cannot write the config file; nothing changed" }); }
      return reply(res, 200, stateJson());
    }

    if (p === "/admin/agents" && method === "POST") {
      const b = await jsonBody(); if (!b.ok) return;
      const v = b.value as Record<string, unknown> | null;
      if (typeof v !== "object" || v === null || Array.isArray(v)) return reply(res, 400, { error: "body must be a JSON object" });
      for (const k of Object.keys(v)) if (!["id", "budget_usd", "cap_usd", "daily_budget_usd"].includes(k)) return reply(res, 400, { error: `${k}: unknown field` });
      const id = v["id"];
      if (typeof id !== "string" || !AGENT_ID.test(id)) return reply(res, 400, { error: "id: 1-40 characters from a-z, 0-9 and -" });
      const budget = v["budget_usd"];
      if (typeof budget !== "string" || !DEC6.test(budget) || toAtoms(budget, 6) <= 0n) return reply(res, 400, { error: "budget_usd: must be a decimal string greater than 0" });
      const cap = v["cap_usd"] ?? null;
      if (cap !== null && (typeof cap !== "string" || !DEC6.test(cap) || toAtoms(cap, 6) <= 0n)) return reply(res, 400, { error: "cap_usd: must be null or a decimal string greater than 0" });
      const daily = v["daily_budget_usd"] ?? null;
      if (daily !== null && (typeof daily !== "string" || !DEC6.test(daily) || toAtoms(daily, 6) <= 0n)) return reply(res, 400, { error: "daily_budget_usd: must be null or a decimal string greater than 0" });
      if (agentIds().includes(id)) return reply(res, 409, { error: "agent id already exists" });
      const token = randomBytes(32).toString("hex");
      const hash = createHash("sha256").update(token).digest("hex");
      const rule: Policy["agents"][string] = { budget_usd: budget };
      if (cap !== null) rule.cap_usd = cap as string;
      if (daily !== null) rule.daily_budget_usd = daily as string;
      try {
        persist((raw) => {
          raw.agents = raw.agents ?? {};
          raw.agents[hash] = id;
          raw.policy = raw.policy ?? {};
          raw.policy.agents = raw.policy.agents ?? {};
          raw.policy.agents[id] = rule;
        });
      } catch { return reply(res, 500, { error: "cannot write the config file; nothing changed" }); }
      Object.defineProperty(policy.agents, id, { value: rule, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(cfg.agents, hash, { value: id, enumerable: true, writable: true, configurable: true });
      entries.set(`${id}\0${hash}`, Buffer.from(hash, "hex"));
      return reply(res, 201, { id, token });
    }

    const del = /^\/admin\/agents\/([^/]+)$/.exec(p);
    // Change an agent's limits. Its token, its spend so far and its other settings stay as they are.
    if (del && method === "PUT") {
      let id: string;
      try { id = decodeURIComponent(del[1]!); } catch { return reply(res, 404, { error: "unknown agent" }); }
      if (!Object.hasOwn(policy.agents, id)) return reply(res, 404, { error: "unknown agent" });
      if (cfg.revokedAgents.includes(id)) return reply(res, 409, { error: "agent is revoked" });
      const b = await jsonBody(); if (!b.ok) return;
      const v = b.value as Record<string, unknown> | null;
      if (typeof v !== "object" || v === null || Array.isArray(v)) return reply(res, 400, { error: "body must be a JSON object" });
      const keys = Object.keys(v);
      for (const k of keys) if (!["budget_usd", "daily_budget_usd"].includes(k)) return reply(res, 400, { error: `${k}: unknown field` });
      if (keys.length === 0) return reply(res, 400, { error: "nothing to change" });
      const amount = (x: unknown): x is string => typeof x === "string" && DEC6.test(x) && toAtoms(x, 6) > 0n;
      if (Object.hasOwn(v, "budget_usd") && !amount(v["budget_usd"])) return reply(res, 400, { error: "budget_usd: must be a decimal string greater than 0" });
      if (Object.hasOwn(v, "daily_budget_usd") && v["daily_budget_usd"] !== null && !amount(v["daily_budget_usd"])) return reply(res, 400, { error: "daily_budget_usd: must be null or a decimal string greater than 0" });
      const set = (r: Record<string, unknown>) => {
        if (Object.hasOwn(v, "budget_usd")) r["budget_usd"] = v["budget_usd"];
        if (Object.hasOwn(v, "daily_budget_usd")) { if (v["daily_budget_usd"] === null) delete r["daily_budget_usd"]; else r["daily_budget_usd"] = v["daily_budget_usd"]; }
      };
      try {
        persist((raw) => {
          raw.policy = raw.policy ?? {};
          raw.policy.agents = raw.policy.agents ?? {};
          const r = typeof raw.policy.agents[id] === "object" && raw.policy.agents[id] !== null ? raw.policy.agents[id] : (raw.policy.agents[id] = {});
          set(r);
        });
      } catch { return reply(res, 500, { error: "cannot write the config file; nothing changed" }); }
      set(policy.agents[id] as unknown as Record<string, unknown>);
      return reply(res, 200, stateJson());
    }
    if (del && method === "DELETE") {
      let id: string;
      try { id = decodeURIComponent(del[1]!); } catch { return reply(res, 404, { error: "unknown agent" }); }
      if (!agentIds().includes(id)) return reply(res, 404, { error: "unknown agent" });
      try {
        persist((raw) => {
          if (raw.agents && typeof raw.agents === "object") for (const [h, v] of Object.entries(raw.agents)) if (v === id) delete raw.agents[h];
          const list: string[] = Array.isArray(raw.revokedAgents) ? raw.revokedAgents : [];
          if (!list.includes(id)) list.push(id);
          raw.revokedAgents = list;
        });
      } catch { return reply(res, 500, { error: "cannot write the config file; nothing changed" }); }
      for (const [h, v] of Object.entries(cfg.agents)) if (v === id) delete cfg.agents[h];
      for (const k of [...entries.keys()]) if (k.startsWith(`${id}\0`)) entries.delete(k);
      if (!cfg.revokedAgents.includes(id)) cfg.revokedAgents.push(id);
      return reply(res, 200, { id, revoked: true });
    }

    if (p === "/admin/practice" && method === "POST") {
      if (practice === undefined) return reply(res, 404, { error: "not found" });
      const b = await jsonBody(); if (!b.ok) return;
      const v = b.value as { agent?: unknown; scenario?: unknown } | null;
      const agent = v?.agent, scenario = v?.scenario;
      if (typeof agent !== "string" || !agentIds().includes(agent)) return reply(res, 400, { error: "agent: unknown" });
      if (cfg.revokedAgents.includes(agent)) return reply(res, 400, { error: "agent: revoked" });
      if (typeof scenario !== "string" || !practice.names.includes(scenario)) return reply(res, 400, { error: "scenario: unknown" });
      // Same path as an agent's own request: policy, approval, signing, log. The body is not returned.
      let last: FetchResult | null = null;
      for (const u of practice.urls(scenario)) last = await firewall.fetchFor(agent, u);
      if (last === null) return reply(res, 400, { error: "scenario: empty" });
      return reply(res, 200, { status: last.status, paid: last.paid, refused: last.refused, cached: last.cached ?? null });
    }

    // Ready-made agents. A run is one of the owner's agents doing a task; it spends from that agent's budget.
    if (p === "/admin/runs" && method === "GET") {
      if (templates === undefined) return reply(res, 404, { error: "not found" });
      const who = url.searchParams.get("agent");
      const lq = url.searchParams.get("limit");
      const limit = lq === null ? RUNS_DEFAULT : Number(lq);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUNS) return reply(res, 400, { error: `limit: 1 to ${MAX_RUNS}` });
      return reply(res, 200, { runs: (who === null ? runs : runs.filter((r) => r.agent === who)).slice(0, limit) });
    }
    if (p === "/admin/runs" && method === "POST") {
      if (templates === undefined) return reply(res, 404, { error: "not found" });
      const b = await jsonBody(); if (!b.ok) return;
      const v = b.value as { agent?: unknown; template?: unknown; task?: unknown } | null;
      const task = cleanTask(v?.task);
      const no = cannotRun(v?.agent, v?.template);
      // The order of the checks is part of the contract: agent, template, task, then "already running".
      if (no !== null && no.status !== 409) return reply(res, no.status, { error: no.error });
      if (task === null) return reply(res, 400, { error: `task: 1 to ${MAX_TASK_LEN} characters` });
      if (no !== null) return reply(res, no.status, { error: no.error });
      if (cfg.paused) return reply(res, 409, { error: "payments are paused: resume them before running an agent" });
      return reply(res, 200, beginRun(v!.agent as string, v!.template as string, task));
    }

    // Schedules: a ready-made agent run on a timer, as one of the owner's agents. It spends from that agent's budget like any run.
    if (p === "/admin/schedules" && method === "GET") {
      if (templates === undefined) return reply(res, 404, { error: "not found" });
      return reply(res, 200, { schedules });
    }
    if (p === "/admin/schedules" && method === "POST") {
      if (templates === undefined) return reply(res, 404, { error: "not found" });
      const b = await jsonBody(); if (!b.ok) return;
      const v = b.value as { agent?: unknown; template?: unknown; task?: unknown; every_s?: unknown } | null;
      const no = cannotRun(v?.agent, v?.template);
      if (no !== null && no.status !== 409) return reply(res, no.status, { error: no.error });
      const task = cleanTask(v?.task);
      if (task === null) return reply(res, 400, { error: `task: 1 to ${MAX_TASK_LEN} characters` });
      const every = v?.every_s;
      if (typeof every !== "number" || !Number.isInteger(every) || every < MIN_EVERY_S || every > MAX_EVERY_S) return reply(res, 400, { error: `every_s: ${MIN_EVERY_S} to ${MAX_EVERY_S} seconds` });
      if (schedules.length >= MAX_SCHEDULES) return reply(res, 400, { error: `at most ${MAX_SCHEDULES} schedules` });
      const nowS = Math.floor(Date.now() / 1000);
      // The first run is one interval away: creating a schedule spends nothing by itself.
      const s: Schedule = { id: randomBytes(6).toString("hex"), agent: v!.agent as string, template: v!.template as string, task, every_s: every, enabled: true, created: nowS, next: nowS + every, last: null, lastAt: null };
      schedules.push(s);
      if (!saveSchedules()) { schedules.pop(); return reply(res, 500, { error: "cannot write the schedules file" }); }
      return reply(res, 200, s);
    }
    const sch = /^\/admin\/schedules\/([0-9a-f]{1,40})$/.exec(p);
    if (sch !== null && (method === "PUT" || method === "DELETE")) {
      if (templates === undefined) return reply(res, 404, { error: "not found" });
      const i = schedules.findIndex((s) => s.id === sch[1]);
      if (i < 0) return reply(res, 404, { error: "no such schedule" });
      if (method === "DELETE") {
        schedules.splice(i, 1);
        saveSchedules();
        return reply(res, 200, { schedules });
      }
      const b = await jsonBody(); if (!b.ok) return;
      const en = (b.value as { enabled?: unknown } | null)?.enabled;
      if (typeof en !== "boolean") return reply(res, 400, { error: "enabled: true or false" });
      const s = schedules[i]!;
      // Resuming counts the interval from now, so a long pause does not end in an immediate run.
      if (en && !s.enabled) s.next = Math.floor(Date.now() / 1000) + s.every_s;
      s.enabled = en;
      saveSchedules();
      return reply(res, 200, s);
    }

    // The Reader's model key. Write-only: state says whether one is set, never the key.
    if (p === "/admin/reader" && method === "PUT") {
      const b = await jsonBody(); if (!b.ok) return;
      const err = firewall.readerKey.set((b.value as { key?: unknown } | null)?.key);
      if (err !== null) return reply(res, err.startsWith("cannot write") ? 500 : 400, { error: err });
      return reply(res, 200, stateJson());
    }
    if (p === "/admin/reader" && method === "DELETE") { firewall.readerKey.clear(); return reply(res, 200, stateJson()); }

    // Owner alerts. The target itself is write-only: state shows the kind and where it points, never the address or token.
    if (p === "/admin/alerts" && method === "PUT") {
      const b = await jsonBody(); if (!b.ok) return;
      const err = firewall.alerts.set(b.value);
      if (err !== null) return reply(res, err.startsWith("cannot write") ? 500 : 400, { error: err });
      return reply(res, 200, stateJson());
    }
    if (p === "/admin/alerts" && method === "DELETE") { firewall.alerts.clear(); return reply(res, 200, stateJson()); }
    if (p === "/admin/alerts/test" && method === "POST") {
      if (firewall.alerts.status() === null) return reply(res, 400, { error: "alerts are off" });
      return reply(res, 200, await firewall.alerts.test());
    }
    if (p === "/admin/alerts/summary" && method === "POST") {
      if (firewall.alerts.status() === null) return reply(res, 400, { error: "alerts are off" });
      return reply(res, 200, await firewall.alerts.summary(firewall.summaryOf(24)));
    }

    if (p === "/admin/approvals" && method === "GET") return reply(res, 200, { pending: firewall.pendingApprovals() });

    const dec = /^\/admin\/approvals\/([0-9a-f]{1,64})$/.exec(p);
    if (dec && method === "POST") {
      const b = await jsonBody(); if (!b.ok) return;
      const d = (b.value as { decision?: unknown } | null)?.decision;
      if (d !== "approve" && d !== "deny") return reply(res, 400, { error: "decision: must be approve or deny" });
      if (!firewall.decideApproval(dec[1]!, d)) return reply(res, 404, { error: "unknown or already decided" });
      return reply(res, 200, { id: dec[1], decision: d });
    }

    if (p === "/admin/activity" && method === "GET") {
      const q = url.searchParams.get("limit");
      let limit = 100;
      if (q !== null) {
        if (!/^[0-9]{1,6}$/.test(q) || Number(q) < 1) return reply(res, 400, { error: "limit: must be a positive integer" });
        limit = Math.min(500, Number(q));
      }
      // With `since` (unix seconds) the console reads a whole period for the owner report; the cap is higher then.
      const sq = url.searchParams.get("since");
      if (sq === null) return reply(res, 200, { entries: firewall.readLog(limit) });
      if (!/^[0-9]{1,12}$/.test(sq)) return reply(res, 400, { error: "since: must be unix seconds" });
      const since = Number(sq);
      const all = firewall.readLog(MAX_PERIOD_ENTRIES + 1).filter((e) => typeof e.ts === "number" && e.ts > since);
      return reply(res, 200, { entries: all.slice(0, MAX_PERIOD_ENTRIES), truncated: all.length > MAX_PERIOD_ENTRIES });
    }

    if (p === "/admin/export.csv" && method === "GET") {
      const text = csv();
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store",
        "content-disposition": 'attachment; filename="decisions.csv"',
      });
      return void res.end(text);
    }
    return reply(res, 404, { error: "not found" });
  }
  return { handle, tick };
}

const HOST_HEADER_OK = /^(127(\.\d{1,3}){3}|localhost|\[::1\])(:\d+)?$/i;

export async function startFirewall(cfg: FirewallConfig, opts: FirewallOptions = {}): Promise<RunningFirewall> {
  if (!isLoopbackHost(cfg.listen.host)) throw new Error("listen.host must be a loopback address");
  const firewall = await createFirewall(cfg, opts);
  // Several tokens may map to one agent id; one entry per hash.
  const entries = new Map<string, Buffer>();
  for (const [hex, id] of Object.entries(cfg.agents)) entries.set(`${id}\0${hex}`, Buffer.from(hex, "hex"));
  const idOfKey = (k: string) => k.slice(0, k.indexOf("\0"));
  const authenticateAgent = (header: string | undefined): string | null => {
    const r = authenticate(entries, header);
    return r === null ? null : idOfKey(r);
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dashboard = path.join(here, "dashboard.html");
  const consoleFile = path.join(here, "console.html");
  const admin = makeAdmin(cfg, firewall, opts.configPath, entries, opts.practice, opts.templates);

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
      if (req.method === "GET" && url.pathname === "/report") {
        const agent = authenticateAgent(req.headers.authorization);
        if (agent === null) return send(res, 401, { error: "unauthorized" });
        const q = url.searchParams.get("window_s");
        let w: number | undefined;
        if (q !== null) {
          if (!/^[0-9]{1,10}$/.test(q) || Number(q) < 1) return send(res, 400, { error: "bad window_s" });
          w = Math.min(Number(q), MAX_REPORT_WINDOW_S);
        }
        return send(res, 200, firewall.reportFor(agent, w));
      }
      if (req.method === "GET" && url.pathname === "/search") {
        const agent = authenticateAgent(req.headers.authorization);
        if (agent === null) return send(res, 401, { error: "unauthorized" });
        const q = url.searchParams.get("q");
        if (q === null || q.trim() === "" || q.length > 200) return send(res, 400, { error: "bad q" });
        const so: { maxUsd?: string; network?: string; limit: number } = { limit: 10 };
        const mu = url.searchParams.get("max_usd");
        if (mu !== null) {
          try { toAtoms(mu, 6); } catch { return send(res, 400, { error: "bad max_usd" }); }
          so.maxUsd = mu;
        }
        const nw = url.searchParams.get("network");
        if (nw !== null && nw !== "") {
          if (nw.length > 80) return send(res, 400, { error: "bad network" });
          so.network = nw;
        }
        const lim = url.searchParams.get("limit");
        if (lim !== null) {
          if (!/^[0-9]{1,4}$/.test(lim) || Number(lim) < 1) return send(res, 400, { error: "bad limit" });
          so.limit = Math.min(25, Number(lim));
        }
        const r = firewall.searchCatalog(q, so);
        if (r === null) return send(res, 503, { error: "no catalog" });
        return send(res, 200, r);
      }
      if (req.method === "GET" && url.pathname === "/api/log") {
        const n = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 100;
        return send(res, 200, firewall.readLog(limit));
      }
      if (url.pathname === "/app" || url.pathname.startsWith("/admin/")) {
        if (url.pathname === "/app") {
          if (req.method !== "GET") return send(res, 404, { error: "not found" });
          let html: Buffer;
          try { html = fs.readFileSync(consoleFile); } catch { return send(res, 404, { error: "console not found" }); }
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8", "content-length": html.length, "cache-control": "no-store",
            "content-security-policy": "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
          });
          return void res.end(html);
        }
        return await admin.handle(req, res, url);
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
  const scheduleTimer = setInterval(() => { try { admin.tick(); } catch { /* the next tick tries again */ } }, 30_000);
  scheduleTimer.unref();
  return {
    host: cfg.listen.host, port: addr.port, firewall,
    tickSchedules: (nowS?: number) => admin.tick(nowS),
    close: () => new Promise<void>((resolve) => {
      clearInterval(scheduleTimer);
      server.closeAllConnections();
      server.close(() => { firewall.close(); resolve(); });
    }),
  };
}
