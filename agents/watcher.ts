// Watcher: a ready-made agent for things that change. Each run it buys one paid address again, fresh, and compares
// what came back with what it saw the last time. It reports FIRST LOOK, SAME or CHANGED, with a receipt. Put it on a
// schedule and the owner hears only when the answer is different. Like the other ready-made agents it holds no key
// and has no model: it only asks the firewall to fetch.
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
  /** Fingerprint of the answer bought in this run; absent when nothing was delivered. */
  fingerprint?: string;
  error?: string;
}
export interface WatchOptions {
  onStep?: (s: Step) => void;
  /** false: pay whatever the seller asks, within the owner's rules. Default: never more than the listing said. */
  holdToListing?: boolean;
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
  const fp = fingerprint(note.text);
  r.checked = 1;
  out.notes.push(note);
  out.fingerprint = fp;
  const host = new URL(offer.url).host;
  if (last === null) {
    r.first = 1;
    opts.onStep?.({ kind: "first", title: offer.title, host, usd: "0.00", detail: "first look: kept to compare with the next run" });
  } else if (fp !== last) {
    r.changed = 1;
    opts.onStep?.({ kind: "changed", title: offer.title, host, usd: "0.00", detail: "different from the last run" });
  } else {
    opts.onStep?.({ kind: "same", title: offer.title, host, usd: "0.00", detail: "the same as the last run" });
  }
  return out;
}

/** Pure: the result as plain text for a terminal. */
export function watchText(b: WatchBrief, steps: readonly Step[]): string {
  const out = [`Watching: ${b.task}`, ""];
  for (const s of steps) out.push(`  ${s.kind.toUpperCase().padEnd(11)} $${s.usd.padEnd(6)} ${s.host}  ${s.title}  (${s.detail})`);
  const r = b.receipt;
  out.push("");
  if (b.error !== undefined) out.push(`Not checked: ${b.error}.`);
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
  const feed = new URL(process.env.ASF_WATCH_FEED ?? "http://127.0.0.1:4021/feed");
  if (process.env.ASF_WATCH_FEED === undefined) feed.searchParams.set("topic", task);
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
  const brief = await watch(client, { url: feed.href, title: "Feed", usd: process.env.ASF_WATCH_USD ?? "0.01" }, task, lastSeen, { onStep: (s) => steps.push(s) });
  console.log(watchText(brief, steps));
  process.exit(brief.error === undefined ? 0 : 1);
}
