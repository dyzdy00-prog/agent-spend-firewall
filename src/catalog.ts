import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostOf, toAtoms } from "./policy.ts";

export type CatalogSource = "cdp" | "payai";

export interface CatalogOffer {
  scheme: string;
  network: string;
  asset: string;
  amountAtoms: string;
  payTo: string;
  usd?: string;
}

export interface CatalogEntry {
  url: string;
  host: string;
  description: string;
  source: CatalogSource;
  offers: CatalogOffer[];
}

export const SOURCE_URLS: Record<CatalogSource, string> = {
  cdp: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
  payai: "https://facilitator.payai.network/discovery/resources",
};

const PAGE_SIZE = 1000; // both catalogs clamp larger limits to 1000
const PAGE_DELAY_MS = 250;
const TIMEOUT_MS = 30_000;
const MAX_OFFERS = 16;
const MAX_DESC = 300;
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

// Pre-CAIP-2 names still present in the PayAI catalog.
const LEGACY_NETWORKS: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  solana: SOLANA_MAINNET,
  "solana-devnet": SOLANA_DEVNET,
};

const USDC: { network: string; asset: string }[] = [
  { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { network: SOLANA_MAINNET, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { network: SOLANA_DEVNET, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
];

function sameAsset(network: string, a: string, b: string): boolean {
  return network.startsWith("eip155:") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameAddr(network: string, a: string, b: string): boolean {
  return sameAsset(network, a, b);
}

function canonNetwork(n: string): string {
  return LEGACY_NETWORKS[n] ?? n;
}

export function usdOf(offer: { network: string; asset: string; amountAtoms: string }): string | undefined {
  const network = canonNetwork(offer.network);
  if (!USDC.some((u) => u.network === network && sameAsset(network, u.asset, offer.asset))) return undefined;
  if (!/^[0-9]+$/.test(offer.amountAtoms)) return undefined;
  const atoms = BigInt(offer.amountAtoms);
  const whole = atoms / 1_000_000n;
  const frac = (atoms % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function atomString(v: unknown): string | null {
  if (typeof v === "string" && /^[0-9]{1,40}$/.test(v)) return v.replace(/^0+(?=\d)/, "");
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

function cleanText(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DESC);
}

export function normalize(source: CatalogSource, rawItems: unknown): CatalogEntry[] {
  if (!Array.isArray(rawItems)) return [];
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const it of rawItems) {
    if (!isObj(it)) continue;
    const url = typeof it.resource === "string" ? it.resource : typeof it.url === "string" ? it.url : "";
    const host = url ? hostOf(url) : null;
    if (host === null || seen.has(url)) continue;
    if (!Array.isArray(it.accepts)) continue;
    const offers: CatalogOffer[] = [];
    for (const a of it.accepts) {
      if (!isObj(a)) continue;
      const amount = atomString(a.amount ?? a.maxAmountRequired);
      if (amount === null) continue;
      if (typeof a.scheme !== "string" || typeof a.network !== "string" || typeof a.asset !== "string" || typeof a.payTo !== "string") continue;
      if (!a.scheme || !a.network || !a.asset || !a.payTo) continue;
      const offer: CatalogOffer = {
        scheme: a.scheme,
        network: canonNetwork(a.network),
        asset: a.asset,
        amountAtoms: amount,
        payTo: a.payTo,
      };
      const usd = usdOf(offer);
      if (usd !== undefined) offer.usd = usd;
      offers.push(offer);
      if (offers.length >= MAX_OFFERS) break;
    }
    if (offers.length === 0) continue;
    let description = cleanText(it.description);
    if (description === "" && isObj(it.metadata)) description = cleanText(it.metadata.description);
    if (description === "") description = cleanText(it.serviceName);
    seen.add(url);
    out.push({ url, host, description, source, offers });
  }
  return out;
}

interface CatalogFile {
  version: 1;
  fetchedAt: number;
  sources: Partial<Record<CatalogSource, { fetchedAt: number; count: number }>>;
  entries: CatalogEntry[];
}

function readFile(dir: string): CatalogFile | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "catalog.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw) as CatalogFile;
    if (!isObj(j) || j.version !== 1 || !Array.isArray(j.entries) || typeof j.fetchedAt !== "number") return null;
    return j;
  } catch {
    return null;
  }
}

export function load(dir: string): { entries: CatalogEntry[]; fetchedAt: number } | null {
  const f = readFile(dir);
  return f === null ? null : { entries: f.entries, fetchedAt: f.fetchedAt };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function downloadSource(
  source: CatalogSource,
  max: number,
  fetchImpl: typeof fetch,
): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; ; page++) {
    const limit = Math.min(PAGE_SIZE, max - offset);
    if (limit <= 0) break;
    if (page > 0) await sleep(PAGE_DELAY_MS);
    const res = await fetchImpl(`${SOURCE_URLS[source]}?limit=${limit}&offset=${offset}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isObj(body) || !Array.isArray(body.items)) throw new Error(`${source}: unexpected response shape`);
    for (const e of normalize(source, body.items)) {
      if (!seen.has(e.url)) {
        seen.add(e.url);
        entries.push(e);
      }
    }
    offset += body.items.length;
    const total = isObj(body.pagination) && typeof body.pagination.total === "number" ? body.pagination.total : 0;
    if (body.items.length === 0 || offset >= total || offset >= max) break;
  }
  return entries;
}

export async function refresh(
  dir: string,
  opts: { maxPerSource?: number; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ cdp: number; payai: number }> {
  const max = opts.maxPerSource ?? 100_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const prev = readFile(dir);
  const result = { cdp: 0, payai: 0 };
  const fresh: Partial<Record<CatalogSource, CatalogEntry[]>> = {};
  for (const source of ["cdp", "payai"] as const) {
    try {
      fresh[source] = await downloadSource(source, max, fetchImpl);
      result[source] = fresh[source]!.length;
    } catch {
      // keep previous entries for this source
    }
  }
  const sources: CatalogFile["sources"] = {};
  const entries: CatalogEntry[] = [];
  for (const source of ["cdp", "payai"] as const) {
    const got = fresh[source];
    const kept = got ?? (prev?.entries.filter((e) => e.source === source) ?? []);
    entries.push(...kept);
    const t = got ? now : (prev?.sources[source]?.fetchedAt ?? 0);
    sources[source] = { fetchedAt: t, count: kept.length };
  }
  const file: CatalogFile = { version: 1, fetchedAt: now, sources, entries };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `catalog.json.${process.pid}.${now}.tmp`);
  writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, join(dir, "catalog.json"));
  return result;
}

function micro(usd: string | undefined): bigint | null {
  if (usd === undefined) return null;
  try {
    return toAtoms(usd, 6);
  } catch {
    return null;
  }
}

export function search(
  entries: CatalogEntry[],
  query: string,
  opts: { maxUsd?: string; network?: string; limit?: number } = {},
): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  const cap = opts.maxUsd !== undefined ? toAtoms(opts.maxUsd, 6) : null;
  const network = opts.network !== undefined ? canonNetwork(opts.network) : null;
  const limit = opts.limit ?? 10;
  const scored: { e: CatalogEntry; price: bigint | null }[] = [];
  for (const e of entries) {
    const text = `${e.url} ${e.description}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    let offers = e.offers;
    if (network !== null) offers = offers.filter((o) => o.network === network);
    if (cap !== null) offers = offers.filter((o) => {
      const m = micro(o.usd);
      return m !== null && m <= cap;
    });
    if (offers.length === 0) continue;
    offers = [...offers].sort((a, b) => {
      const x = micro(a.usd);
      const y = micro(b.usd);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    scored.push({ e: { ...e, offers }, price: micro(offers[0]!.usd) });
  }
  scored.sort((a, b) => {
    if (a.price === null && b.price === null) return a.e.url < b.e.url ? -1 : 1;
    if (a.price === null) return 1;
    if (b.price === null) return -1;
    if (a.price !== b.price) return a.price < b.price ? -1 : 1;
    return a.e.url < b.e.url ? -1 : a.e.url > b.e.url ? 1 : 0;
  });
  return scored.slice(0, Math.max(0, limit)).map((s) => s.e);
}

function normUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase().replace(/\.(?=:|$)/, "")}${path}`;
}

export function lookup(entries: CatalogEntry[], url: string): CatalogEntry | null {
  const want = normUrl(url);
  if (want === null) return null;
  for (const e of entries) if (normUrl(e.url) === want) return e;
  return null;
}

export function priceCheck(
  entry: CatalogEntry | null,
  live: { network: string; asset: string; amountAtoms: string; payTo: string },
  maxRatio: number,
): { known: boolean; overpriced: boolean; ratio?: number; payeeChanged?: boolean; catalogAtoms?: string } {
  if (entry === null) return { known: false, overpriced: false };
  const network = canonNetwork(live.network);
  const same = entry.offers.filter((o) => canonNetwork(o.network) === network && sameAsset(network, o.asset, live.asset));
  if (same.length === 0 || !/^[0-9]+$/.test(live.amountAtoms)) return { known: false, overpriced: false };
  // Prefer the offer with the same payee; otherwise the cheapest one.
  let pick = same.find((o) => sameAddr(network, o.payTo, live.payTo));
  if (pick === undefined) {
    pick = same.reduce((a, b) => (BigInt(b.amountAtoms) < BigInt(a.amountAtoms) ? b : a));
  }
  const cat = BigInt(pick.amountAtoms);
  const liveAtoms = BigInt(live.amountAtoms);
  const scale = BigInt(Math.max(0, Math.round(maxRatio * 1000)));
  const overpriced = liveAtoms * 1000n > cat * scale;
  const out: { known: boolean; overpriced: boolean; ratio?: number; payeeChanged?: boolean; catalogAtoms?: string } = {
    known: true,
    overpriced,
    payeeChanged: !sameAddr(network, pick.payTo, live.payTo),
    catalogAtoms: pick.amountAtoms,
  };
  if (cat > 0n) out.ratio = Number((liveAtoms * 1000n) / cat) / 1000;
  return out;
}

// ---- CLI ----

function short(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function cli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const defaultDir = join(homedir(), ".agent-spend-firewall");
  if (cmd === "refresh") {
    const dir = argv[1] ?? defaultDir;
    const r = await refresh(dir);
    console.log(`catalog refreshed in ${dir}: cdp=${r.cdp} payai=${r.payai}`);
  } else if (cmd === "search") {
    const words = argv.slice(1).filter((w) => !w.startsWith("--"));
    const cat = load(process.env.ASF_DIR ?? defaultDir);
    if (cat === null) {
      console.error("no catalog yet: run `node src/catalog.ts refresh` first");
      process.exitCode = 1;
      return;
    }
    const hits = search(cat.entries, words.join(" "));
    for (const e of hits) {
      const o = e.offers[0]!;
      console.log(`${(o.usd ?? "?").padStart(9)} USD  ${short(o.network, 14).padEnd(14)}  ${short(e.url, 70).padEnd(70)}  ${short(e.description, 60)}`);
    }
    console.log(`${hits.length} result(s), catalog from ${new Date(cat.fetchedAt).toISOString()}`);
  } else {
    console.error("usage: node src/catalog.ts refresh [dir] | search <words…>   (search reads $ASF_DIR or ~/.agent-spend-firewall)");
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  await cli(process.argv.slice(2));
}
