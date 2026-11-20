// Researcher: a ready-made buying agent. Given a topic it reads a seller's index of paid notes, buys them
// through the firewall and returns the notes with a receipt: what was bought, what was stopped, what was paid for
// and never delivered. It holds no key and has no model: it only asks the firewall to fetch.
// A model can do the reading afterwards; the receipt is what this file is about.
//
// Run by hand: node agents/researcher.ts "your topic"
//   ASF_URL                firewall address (default http://127.0.0.1:8402)
//   ASF_AGENT_TOKEN_FILE   this agent's token (default ~/.agent-spend-firewall/agent.token)
//   ASF_RESEARCH_INDEX     where the offers come from (default: the practice seller's index)
//   ASF_RESEARCH_HOSTS     other hosts an offer may point to, comma separated (default: the practice seller's ports)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What the firewall answers to a fetch. The subset this agent reads. */
export interface FetchOut {
  status: number;
  paid: { usd6: string } | null;
  refused: { code: string; reason: string } | null;
  body: string;
  cached?: { usd6: string; ageS: number };
}
export interface ResearchClient { fetch(url: string): Promise<FetchOut> }

export interface Offer { url: string; title: string; usd: string }
export type StepKind = "bought" | "cached" | "stopped" | "undelivered" | "failed";
export interface Step { kind: StepKind; title: string; host: string; usd: string; detail: string }
export interface Note { title: string; text: string; host: string }
export interface Receipt {
  offered: number; bought: number; cached: number; stopped: number; undelivered: number; failed: number;
  /** Money that left the wallet, delivered or not. */
  paidUsd: string;
  /** What the cache answered without paying again. */
  savedUsd: string;
}
export interface Brief { task: string; notes: Note[]; receipt: Receipt; error?: string }
export interface ResearchOptions {
  /** At most this many offers are bought (default 6). */
  maxSources?: number;
  /** Hosts ("name:port") an offer may point to, besides the index's own host. */
  hosts?: readonly string[];
  onStep?: (s: Step) => void;
}

export const MAX_TASK = 200;
const MAX_OFFERS = 20;
const DEC = /^[0-9]{1,9}(\.[0-9]{1,6})?$/;
const line = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max);

/** Pure: "0.01" from micro-dollars. */
export function usdOf(usd6: string): string {
  let v: bigint;
  try { v = BigInt(usd6); } catch { return "0.00"; }
  if (v < 0n) return "0.00";
  const s = v.toString().padStart(7, "0");
  let f = s.slice(-6).replace(/0+$/, "");
  if (f.length < 2) f = f.padEnd(2, "0");
  return `${s.slice(0, -6)}.${f}`;
}

/** Pure: a task as the agent will use it, or null when there is nothing to research. */
export function cleanTask(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = line(v, MAX_TASK + 1);
  return t === "" || t.length > MAX_TASK ? null : t;
}

/** Pure: the offers in an index body that point to an allowed host. Anything malformed is dropped. */
export function parseOffers(body: string, allowedHosts: readonly string[]): Offer[] {
  let v: unknown;
  try { v = JSON.parse(body); } catch { return []; }
  const list = (v as { offers?: unknown } | null)?.offers;
  if (!Array.isArray(list)) return [];
  const out: Offer[] = [];
  for (const o of list.slice(0, MAX_OFFERS)) {
    if (typeof o !== "object" || o === null) continue;
    const { url, title, usd } = o as Record<string, unknown>;
    if (typeof url !== "string" || typeof usd !== "string" || !DEC.test(usd)) continue;
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username !== "" || u.password !== "") continue;
    if (!allowedHosts.includes(u.host)) continue;
    out.push({ url: u.href, title: line(title, 80) || u.pathname, usd });
  }
  return out;
}

function noteOf(body: string, fallbackTitle: string, host: string): Note {
  try {
    const j = JSON.parse(body) as { title?: unknown; text?: unknown } | null;
    if (j !== null && typeof j === "object" && typeof j.text === "string") return { title: line(j.title, 80) || fallbackTitle, text: line(j.text, 600), host };
  } catch { /* not JSON: keep the start of the body */ }
  return { title: fallbackTitle, text: line(body, 600), host };
}

/** Buys what the index offers for `task`, one request at a time, and reports every outcome. Never throws. */
export async function research(client: ResearchClient, indexUrl: string, task: string, opts: ResearchOptions = {}): Promise<Brief> {
  const receipt: Receipt = { offered: 0, bought: 0, cached: 0, stopped: 0, undelivered: 0, failed: 0, paidUsd: "0.00", savedUsd: "0.00" };
  const brief: Brief = { task, notes: [], receipt };
  let paid = 0n, saved = 0n;
  let index: URL;
  try { index = new URL(indexUrl); } catch { return { ...brief, error: "the index address is not a URL" }; }
  index.searchParams.set("topic", task);

  let first: FetchOut;
  try { first = await client.fetch(index.href); } catch { return { ...brief, error: "the firewall did not answer" }; }
  if (first.refused !== null) return { ...brief, error: `the index was refused: ${line(first.refused.code, 20)}: ${line(first.refused.reason, 80)}` };
  if (first.status !== 200) return { ...brief, error: `the index answered ${first.status}` };
  const offers = parseOffers(first.body, [index.host, ...(opts.hosts ?? [])]);
  receipt.offered = offers.length;
  if (offers.length === 0) return { ...brief, error: "the index offered nothing this agent may buy" };

  for (const o of offers.slice(0, opts.maxSources ?? 6)) {
    const host = new URL(o.url).host;
    const step = (kind: StepKind, usd: string, detail: string) => opts.onStep?.({ kind, title: o.title, host, usd, detail });
    let r: FetchOut;
    try { r = await client.fetch(o.url); } catch { receipt.failed++; step("failed", o.usd, "the firewall did not answer"); continue; }
    if (r.refused !== null) {
      receipt.stopped++;
      step("stopped", o.usd, `${line(r.refused.code, 20)}: ${line(r.refused.reason, 80)}`);
    } else if (r.cached !== undefined) {
      receipt.cached++;
      try { saved += BigInt(r.cached.usd6); } catch { /* counted without an amount */ }
      brief.notes.push(noteOf(r.body, o.title, host));
      step("cached", "0.00", `answered from the cache, first paid $${usdOf(r.cached.usd6)}`);
    } else if (r.paid !== null && r.status < 400) {
      receipt.bought++;
      try { paid += BigInt(r.paid.usd6); } catch { /* counted without an amount */ }
      brief.notes.push(noteOf(r.body, o.title, host));
      step("bought", usdOf(r.paid.usd6), "paid and delivered");
    } else if (r.paid !== null) {
      receipt.undelivered++;
      try { paid += BigInt(r.paid.usd6); } catch { /* counted without an amount */ }
      step("undelivered", usdOf(r.paid.usd6), `paid, then the seller answered ${r.status}`);
    } else if (r.status === 200) {
      receipt.bought++;
      brief.notes.push(noteOf(r.body, o.title, host));
      step("bought", "0.00", "free");
    } else {
      receipt.failed++;
      step("failed", o.usd, `the seller answered ${r.status}`);
    }
  }
  receipt.paidUsd = usdOf(paid.toString());
  receipt.savedUsd = usdOf(saved.toString());
  return brief;
}

/** Pure: the brief as plain text for a terminal. */
export function briefText(b: Brief, steps: readonly Step[]): string {
  const out = [`Topic: ${b.task}`, ""];
  if (b.error !== undefined) out.push(`Stopped early: ${b.error}`, "");
  for (const s of steps) out.push(`  ${s.kind.toUpperCase().padEnd(11)} $${s.usd.padEnd(6)} ${s.host}  ${s.title}  (${s.detail})`);
  const r = b.receipt;
  out.push("", `Receipt: $${r.paidUsd} paid. ${r.bought} bought, ${r.cached} from cache ($${r.savedUsd} saved), ${r.stopped} stopped by the firewall, ${r.undelivered} paid and not delivered, ${r.failed} failed.`, "");
  for (const n of b.notes) out.push(`- ${n.title} (${n.host})`, `  ${n.text}`);
  return out.join("\n");
}

if (import.meta.main) {
  const task = cleanTask(process.argv.slice(2).join(" "));
  if (task === null) {
    console.error(`usage: node agents/researcher.ts "your topic" (at most ${MAX_TASK} characters)`);
    process.exit(2);
  }
  const base = (process.env.ASF_URL ?? "http://127.0.0.1:8402").replace(/\/+$/, "");
  const tokenFile = process.env.ASF_AGENT_TOKEN_FILE ?? path.join(os.homedir(), ".agent-spend-firewall", "agent.token");
  const index = process.env.ASF_RESEARCH_INDEX ?? "http://127.0.0.1:4021/index";
  let token = "";
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { console.error(`cannot read the agent token file: ${tokenFile}`); process.exit(1); }
  const client: ResearchClient = {
    async fetch(url) {
      const r = await fetch(`${base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url }) });
      if (r.status !== 200) throw new Error(`firewall answered ${r.status}`);
      return (await r.json()) as FetchOut;
    },
  };
  const steps: Step[] = [];
  // The practice seller answers on neighbouring ports; its index points at these two besides its own.
  const hosts = (process.env.ASF_RESEARCH_HOSTS ?? "127.0.0.1:4022,127.0.0.1:4025").split(",").map((s) => s.trim()).filter(Boolean);
  const brief = await research(client, index, task, { hosts, onStep: (s) => steps.push(s) });
  console.log(briefText(brief, steps));
  process.exit(brief.error === undefined ? 0 : 1);
}
