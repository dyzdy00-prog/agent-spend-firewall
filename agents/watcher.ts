// Watcher: a ready-made agent for things that change. Each run it buys one paid address again, fresh, and compares
// what came back with what it saw the last time. It reports FIRST LOOK, SAME or CHANGED, with a receipt. Put it on a
// schedule and the owner hears only when the answer is different. Like the other ready-made agents it holds no key
// and has no model: it only asks the firewall to fetch.
//
// What to watch can end with " | field" to compare one field of a JSON answer instead of the whole text, and with
// " | field > 4" or " | field < 4" to be told only when that number is past a line:
//   "river level"                 the whole answer
//   "river level | level"         only the field `level` (a path like data.items.0.price works too)
//   "river level | level > 4"     only whether `level` is above 4
//
// Run by hand: node agents/watcher.ts "what to watch"
//   ASF_URL                firewall address (default http://127.0.0.1:8402)
//   ASF_AGENT_TOKEN_FILE   this agent's token (default ~/.agent-spend-firewall/agent.token)
//   ASF_WATCH_FEED         the paid address to watch (default: the practice seller's /feed)
//   ASF_WATCH_USD          what that address is listed at (default 0.01)
//   ASF_WATCH_LAST         the fingerprint the last run printed; without it every run is a first look
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buy, cleanTask, MAX_TASK } from "./researcher.ts";
import type { FetchOut, Note, Offer, ResearchClient, Step } from "./researcher.ts";

export interface WatchReceipt {
  /** 1 when a fresh answer was bought and compared, else 0. */
  checked: number;
  /** 1 when that answer differs from the last one seen. */
  changed: number;
  /** 1 when there was nothing to compare with. */
  first: number;
  stopped: number; undelivered: number; failed: number;
  /** Money that left the wallet, delivered or not. */
  paidUsd: string;
}
export interface WatchBrief {
  kind: "watcher"; task: string; notes: Note[]; receipt: WatchReceipt;
  /** Fingerprint of what was compared in this run (the answer, the field, or the side of the line); absent when nothing was compared. */
  fingerprint?: string;
  /** The field that was watched and what it held, when the task named one. */
  field?: string;
  value?: string;
  /** With a line: whether the number is past it now. */
  met?: boolean;
  error?: string;
}
export interface WatchSpec { topic: string; field?: string; op?: ">" | "<"; limit?: number }

/** Pure: "topic | field > 4" taken apart. Anything that is not that shape is all topic. */
export function parseWatch(task: string): WatchSpec {
  const m = /^(.*\S)\s*\|\s*([A-Za-z0-9_$][A-Za-z0-9_$.-]{0,79})\s*(?:([<>])\s*(-?[0-9]{1,12}(?:\.[0-9]{1,9})?))?\s*$/.exec(task);
  if (m === null) return { topic: task };
  const spec: WatchSpec = { topic: m[1]!, field: m[2]! };
  if (m[3] !== undefined) { spec.op = m[3] as ">" | "<"; spec.limit = Number(m[4]); }
  return spec;
}

/** Pure: the value at a dotted path ("data.items.0.price") in a JSON text; undefined when the text is not JSON or the path is not there. */
export function fieldOf(text: string, field: string): unknown {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return undefined; }
  for (const k of field.split(".")) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
export interface WatchOptions {
  onStep?: (s: Step) => void;
  /** false: pay whatever the seller asks, within the owner's rules. Default: never more than the listing said. */
  holdToListing?: boolean;
  /** Compare this field of a JSON answer instead of the whole text. */
  field?: string;
  /** With `field` and `limit`: be told only when the number is above (">") or below ("<") the line. */
  op?: ">" | "<";
  limit?: number;
}

/** Pure: a short fingerprint of an answer. Two answers with the same text have the same fingerprint. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Pure: a run that looked at nothing, with the reason. */
export function emptyWatch(task: string, error?: string): WatchBrief {
  const receipt: WatchReceipt = { checked: 0, changed: 0, first: 0, stopped: 0, undelivered: 0, failed: 0, paidUsd: "0.00" };
  return error === undefined ? { kind: "watcher", task, notes: [], receipt } : { kind: "watcher", task, notes: [], receipt, error };
}

/** Buys `offer` fresh and compares it with `last` (the fingerprint of the previous answer, or null). Never throws. */
export async function watch(client: ResearchClient, offer: Offer, task: string, last: string | null, opts: WatchOptions = {}): Promise<WatchBrief> {
  const out = emptyWatch(task);
  const r = out.receipt;
  const one = await buy(client, [offer], task, {
    fresh: true,
    ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }),
    ...(opts.holdToListing === false ? { holdToListing: false } : {}),
  });
  r.stopped = one.receipt.stopped; r.undelivered = one.receipt.undelivered; r.failed = one.receipt.failed;
  r.paidUsd = one.receipt.paidUsd;
  const note = one.notes[0];
  if (note === undefined) return { ...out, error: r.stopped > 0 ? "the firewall stopped the payment" : r.undelivered > 0 ? "paid, and the seller sent nothing" : "the address did not answer" };
  out.notes.push(note);
  const host = new URL(offer.url).host;
  let fp = fingerprint(note.text);
  if (opts.field !== undefined) {
    const v = fieldOf(note.text, opts.field);
    if (v === undefined) return { ...out, field: opts.field, error: `the answer has no field "${opts.field}"` };
    const shown = (typeof v === "string" ? v : JSON.stringify(v)).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 80);
    out.field = opts.field; out.value = shown;
    fp = fingerprint(JSON.stringify(v));
    if (opts.op !== undefined && opts.limit !== undefined) {
      const n = typeof v === "number" ? v : typeof v === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(v.trim()) ? Number(v) : NaN;
      if (!Number.isFinite(n)) return { ...out, error: `the field "${opts.field}" is not a number` };
      const met = opts.op === ">" ? n > opts.limit : n < opts.limit;
      const side = opts.op === ">" ? "above" : "below";
      out.met = met;
      r.checked = 1;
      // Only the side of the line is remembered: the owner is told when it is crossed, not at every move.
      out.fingerprint = fingerprint(met ? "met" : "unmet");
      if (last === null) r.first = 1;
      if (met && last !== out.fingerprint) {
        r.changed = 1;
        opts.onStep?.({ kind: "changed", title: offer.title, host, usd: "0.00", detail: `${opts.field} is ${shown}, ${side} ${opts.limit}` });
      } else if (last === null) {
        opts.onStep?.({ kind: "first", title: offer.title, host, usd: "0.00", detail: `first look: ${opts.field} is ${shown}, not ${side} ${opts.limit}` });
      } else {
        opts.onStep?.({ kind: "same", title: offer.title, host, usd: "0.00", detail: met ? `${opts.field} is ${shown}, still ${side} ${opts.limit}` : `${opts.field} is ${shown}, not ${side} ${opts.limit}` });
      }
      return out;
    }
  }
  r.checked = 1;
  out.fingerprint = fp;
  const what = out.field === undefined ? "" : `${out.field} is ${out.value}: `;
  if (last === null) {
    r.first = 1;
    opts.onStep?.({ kind: "first", title: offer.title, host, usd: "0.00", detail: `${what}first look, kept to compare with the next run` });
  } else if (fp !== last) {
    r.changed = 1;
    opts.onStep?.({ kind: "changed", title: offer.title, host, usd: "0.00", detail: `${what}different from the last run` });
  } else {
    opts.onStep?.({ kind: "same", title: offer.title, host, usd: "0.00", detail: `${what}the same as the last run` });
  }
  return out;
}

/** Pure: the options a parsed task asks for. */
export function specOpts(spec: WatchSpec): Pick<WatchOptions, "field" | "op" | "limit"> {
  return { ...(spec.field === undefined ? {} : { field: spec.field }), ...(spec.op === undefined || spec.limit === undefined ? {} : { op: spec.op, limit: spec.limit }) };
}

/** Pure: the result as plain text for a terminal. */
export function watchText(b: WatchBrief, steps: readonly Step[]): string {
  const out = [`Watching: ${b.task}`, ""];
  for (const s of steps) out.push(`  ${s.kind.toUpperCase().padEnd(11)} $${s.usd.padEnd(6)} ${s.host}  ${s.title}  (${s.detail})`);
  const r = b.receipt;
  out.push("");
  if (b.error !== undefined) out.push(`Not checked: ${b.error}.`);
  else if (b.met !== undefined) out.push(`${b.field} is ${b.value}: ${b.met ? (r.changed > 0 ? "PAST THE LINE." : "still past the line.") : "not past the line."}`);
  else out.push(r.first > 0 ? "First look. Nothing to compare with yet." : r.changed > 0 ? "CHANGED since the last run." : "The same as the last run.");
  out.push(`Receipt: $${r.paidUsd} paid, ${r.stopped} stopped by the firewall, ${r.undelivered} paid and not delivered.`);
  if (b.fingerprint !== undefined) out.push(`Fingerprint: ${b.fingerprint}`);
  out.push("");
  for (const n of b.notes) out.push(`- ${n.title} (${n.host})`, `  ${n.text.slice(0, 600)}`);
  return out.join("\n");
}

if (import.meta.main) {
  const task = cleanTask(process.argv.slice(2).join(" "));
  if (task === null) {
    console.error(`usage: node agents/watcher.ts "what to watch" (at most ${MAX_TASK} characters)`);
    process.exit(2);
  }
  const base = (process.env.ASF_URL ?? "http://127.0.0.1:8402").replace(/\/+$/, "");
  const tokenFile = process.env.ASF_AGENT_TOKEN_FILE ?? path.join(os.homedir(), ".agent-spend-firewall", "agent.token");
  const spec = parseWatch(task);
  const feed = new URL(process.env.ASF_WATCH_FEED ?? "http://127.0.0.1:4021/feed");
  if (process.env.ASF_WATCH_FEED === undefined) feed.searchParams.set("topic", spec.topic);
  const lastSeen = /^[0-9a-f]{16}$/.test(process.env.ASF_WATCH_LAST ?? "") ? process.env.ASF_WATCH_LAST! : null;
  let token = "";
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { console.error(`cannot read the agent token file: ${tokenFile}`); process.exit(1); }
  const client: ResearchClient = {
    async fetch(url, maxUsd, fresh) {
      const body: Record<string, unknown> = { url };
      if (maxUsd !== undefined) body["max_usd"] = maxUsd;
      if (fresh === true) body["fresh"] = true;
      const r = await fetch(`${base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status !== 200) throw new Error(`firewall answered ${r.status}`);
      return (await r.json()) as FetchOut;
    },
  };
  const steps: Step[] = [];
  const brief = await watch(client, { url: feed.href, title: "Feed", usd: process.env.ASF_WATCH_USD ?? "0.01" }, task, lastSeen, { onStep: (s) => steps.push(s), ...specOpts(spec) });
  console.log(watchText(brief, steps));
  process.exit(brief.error === undefined ? 0 : 1);
}
