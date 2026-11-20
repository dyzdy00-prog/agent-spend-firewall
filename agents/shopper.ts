// Shopper: a ready-made buying agent. Given one thing to buy and several sellers' listed prices for it, it tries the
// cheapest listing first and moves to the next one when the firewall stops the payment or the seller does not
// deliver. It stops at the first delivery. The receipt says what it paid, what the dearest listing asked, and what
// was lost on the way. Like the Researcher it holds no key and has no model: it only asks the firewall to fetch.
//
// Run by hand: node agents/shopper.ts "what to buy"
//   ASF_URL                firewall address (default http://127.0.0.1:8402)
//   ASF_AGENT_TOKEN_FILE   this agent's token (default ~/.agent-spend-firewall/agent.token)
//   ASF_SHOP_QUOTES        where the listings come from (default: the practice seller's /quotes)
//   ASF_SHOP_HOSTS         other hosts a listing may point to, comma separated (default: the practice seller's ports)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buy, cleanTask, MAX_TASK, parseOffers, usdOf } from "./researcher.ts";
import type { FetchOut, Note, Offer, ResearchClient, Step } from "./researcher.ts";

export interface ShopReceipt {
  offered: number;
  /** Listings a request was sent for. */
  tried: number;
  /** 1 when something was delivered, else 0. */
  bought: number;
  /** 1 when that delivery came from the firewall's cache and cost nothing now. */
  cached: number;
  stopped: number; undelivered: number; failed: number;
  /** Listings never asked, because a cheaper one delivered. */
  skipped: number;
  /** Money that left the wallet, delivered or not. */
  paidUsd: string;
  /** What the delivered purchase cost. */
  priceUsd: string;
  /** The highest listed price among the offers. */
  dearestUsd: string;
  /** dearestUsd minus priceUsd, when something was delivered. */
  savedUsd: string;
  /** Paid to sellers that delivered nothing. */
  lostUsd: string;
}
export interface ShopBrief { kind: "shopper"; task: string; notes: Note[]; receipt: ShopReceipt; error?: string }
export interface ShopOptions {
  /** Hosts ("name:port") a listing may point to, besides the quotes address's own host. */
  hosts?: readonly string[];
  onStep?: (s: Step) => void;
  /** false: pay whatever the seller asks, within the owner's rules. Default: never more than the listing said. */
  holdToListing?: boolean;
}

/** Pure: micro-dollars from a listed price like "0.02"; null when it is not a plain decimal. */
export function microOf(usd: string): bigint | null {
  const m = /^([0-9]{1,9})(?:\.([0-9]{1,6}))?$/.exec(usd);
  return m === null ? null : BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Pure: a run that bought nothing, with the reason. */
export function emptyShop(task: string, error?: string): ShopBrief {
  const receipt: ShopReceipt = { offered: 0, tried: 0, bought: 0, cached: 0, stopped: 0, undelivered: 0, failed: 0, skipped: 0, paidUsd: "0.00", priceUsd: "0.00", dearestUsd: "0.00", savedUsd: "0.00", lostUsd: "0.00" };
  return error === undefined ? { kind: "shopper", task, notes: [], receipt } : { kind: "shopper", task, notes: [], receipt, error };
}

/** Pure: cheapest listing first; listings at the same price keep their order. */
export function byPrice(offers: readonly Offer[]): Offer[] {
  return offers.map((o, i) => ({ o, i, p: microOf(o.usd) ?? 0n })).sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : a.i - b.i)).map((x) => x.o);
}

/** Tries the listings cheapest first and stops at the first delivery. Never throws. */
export async function shop(client: ResearchClient, offers: readonly Offer[], task: string, opts: ShopOptions = {}): Promise<ShopBrief> {
  const out = emptyShop(task);
  const r = out.receipt;
  const order = byPrice(offers);
  r.offered = order.length;
  if (order.length === 0) return { ...out, error: "there is nothing to compare" };
  let paid = 0n, lost = 0n, price: bigint | null = null, dearest = 0n;
  for (const o of order) { const p = microOf(o.usd) ?? 0n; if (p > dearest) dearest = p; }
  for (const o of order) {
    if (price !== null) {
      r.skipped++;
      opts.onStep?.({ kind: "skipped", title: o.title, host: new URL(o.url).host, usd: o.usd, detail: "not asked: a cheaper listing already delivered" });
      continue;
    }
    const one = await buy(client, [o], task, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }), ...(opts.holdToListing === false ? { holdToListing: false } : {}) });
    r.tried++;
    const spent = microOf(one.receipt.paidUsd) ?? 0n;
    paid += spent;
    r.stopped += one.receipt.stopped; r.failed += one.receipt.failed; r.undelivered += one.receipt.undelivered;
    if (one.receipt.undelivered > 0) lost += spent;
    if (one.notes.length > 0) {
      r.bought = 1;
      // A cached answer cost nothing now; what the seller's listing says is what it would have cost.
      r.cached = one.receipt.cached > 0 ? 1 : 0;
      price = one.receipt.cached > 0 ? 0n : spent;
      out.notes.push(...one.notes);
    }
  }
  r.paidUsd = usdOf(paid.toString());
  r.lostUsd = usdOf(lost.toString());
  r.dearestUsd = usdOf(dearest.toString());
  if (price !== null) {
    r.priceUsd = usdOf(price.toString());
    r.savedUsd = usdOf((dearest > price ? dearest - price : 0n).toString());
    return out;
  }
  return { ...out, error: "no listing delivered" };
}

/** Reads the listings for `task` from a seller's quotes address, then shops. Never throws. */
export async function shopFrom(client: ResearchClient, quotesUrl: string, task: string, opts: ShopOptions = {}): Promise<ShopBrief> {
  let u: URL;
  try { u = new URL(quotesUrl); } catch { return emptyShop(task, "the quotes address is not a URL"); }
  u.searchParams.set("item", task);
  let first: FetchOut;
  try { first = await client.fetch(u.href); } catch { return emptyShop(task, "the firewall did not answer"); }
  if (first.refused !== null) return emptyShop(task, `the quotes were refused: ${first.refused.code}: ${first.refused.reason}`.slice(0, 140));
  if (first.status !== 200) return emptyShop(task, `the quotes address answered ${first.status}`);
  const offers = parseOffers(first.body, [u.host, ...(opts.hosts ?? [])]);
  if (offers.length === 0) return emptyShop(task, "no listing this agent may buy");
  return shop(client, offers, task, opts);
}

/** Pure: the result as plain text for a terminal. */
export function shopText(b: ShopBrief, steps: readonly Step[]): string {
  const out = [`Buying: ${b.task}`, ""];
  for (const s of steps) out.push(`  ${s.kind.toUpperCase().padEnd(11)} $${s.usd.padEnd(6)} ${s.host}  ${s.title}  (${s.detail})`);
  const r = b.receipt;
  out.push("");
  if (b.error !== undefined) out.push(`Nothing bought: ${b.error}.`);
  else if (r.cached > 0) out.push("Answered from the firewall's cache: nothing paid this time.");
  else out.push(`Bought for $${r.priceUsd}. The dearest listing asked $${r.dearestUsd}: $${r.savedUsd} less.`);
  out.push(`Receipt: $${r.paidUsd} left the wallet, $${r.lostUsd} of it to sellers that delivered nothing. ${r.tried} of ${r.offered} listings tried, ${r.stopped} stopped by the firewall, ${r.failed} failed, ${r.skipped} not needed.`, "");
  for (const n of b.notes) out.push(`- ${n.title} (${n.host})`, `  ${n.text.slice(0, 600)}`);
  return out.join("\n");
}

if (import.meta.main) {
  const task = cleanTask(process.argv.slice(2).join(" "));
  if (task === null) {
    console.error(`usage: node agents/shopper.ts "what to buy" (at most ${MAX_TASK} characters)`);
    process.exit(2);
  }
  const base = (process.env.ASF_URL ?? "http://127.0.0.1:8402").replace(/\/+$/, "");
  const tokenFile = process.env.ASF_AGENT_TOKEN_FILE ?? path.join(os.homedir(), ".agent-spend-firewall", "agent.token");
  const quotes = process.env.ASF_SHOP_QUOTES ?? "http://127.0.0.1:4021/quotes";
  let token = "";
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { console.error(`cannot read the agent token file: ${tokenFile}`); process.exit(1); }
  const client: ResearchClient = {
    async fetch(url, maxUsd) {
      const r = await fetch(`${base}/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(maxUsd === undefined ? { url } : { url, max_usd: maxUsd }) });
      if (r.status !== 200) throw new Error(`firewall answered ${r.status}`);
      return (await r.json()) as FetchOut;
    },
  };
  const steps: Step[] = [];
  const hosts = (process.env.ASF_SHOP_HOSTS ?? "127.0.0.1:4022,127.0.0.1:4026,127.0.0.1:4027").split(",").map((s) => s.trim()).filter(Boolean);
  const brief = await shopFrom(client, quotes, task, { hosts, onStep: (s) => steps.push(s) });
  console.log(shopText(brief, steps));
  process.exit(brief.error === undefined ? 0 : 1);
}
