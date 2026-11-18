import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, lookup, normalize, priceCheck, refresh, search, usdOf, SOURCE_URLS } from "../src/catalog.ts";
import type { CatalogEntry } from "../src/catalog.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const cdp = fx("catalog-cdp");
const payai = fx("catalog-payai");
const tmp = () => mkdtempSync(join(tmpdir(), "catalog-"));

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function entry(url: string, offers: CatalogEntry["offers"], description = ""): CatalogEntry {
  return { url, host: new URL(url).host, description, source: "cdp", offers: offers.map((o) => { const usd = usdOf(o); return usd === undefined ? o : { ...o, usd }; }) };
}
const baseOffer = (amt: string, payTo = "0xAbC0000000000000000000000000000000000001") => ({
  scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amountAtoms: amt, payTo,
});

test("usdOf: known USDC assets, 6 decimals, no floats", () => {
  assert.equal(usdOf(baseOffer("5000")), "0.005");
  assert.equal(usdOf(baseOffer("1000000")), "1");
  assert.equal(usdOf(baseOffer("0")), "0");
  assert.equal(usdOf({ ...baseOffer("1500000"), asset: BASE_USDC.toLowerCase() }), "1.5");
  assert.equal(usdOf({ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amountAtoms: "10000" }), "0.01");
  assert.equal(usdOf({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: SOL_USDC, amountAtoms: "123456789" }), "123.456789");
  assert.equal(usdOf({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amountAtoms: "1" }), "0.000001");
  assert.equal(usdOf({ network: "eip155:8453", asset: "0x0000000000000000000000000000000000000001", amountAtoms: "5" }), undefined);
  assert.equal(usdOf({ network: "eip155:1", asset: BASE_USDC, amountAtoms: "5" }), undefined);
  // Solana asset compare is case sensitive
  assert.equal(usdOf({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: SOL_USDC.toLowerCase(), amountAtoms: "5" }), undefined);
});

test("normalize: fixtures, legacy networks, lowercase host", () => {
  const a = normalize("cdp", cdp.items);
  const b = normalize("payai", payai.items);
  assert.equal(a.length, 20);
  assert.equal(b.length, 20);
  for (const e of [...a, ...b]) {
    assert.equal(e.host, e.host.toLowerCase());
    assert.ok(e.offers.length > 0);
    assert.ok(!/[\n\r\t]/.test(e.description));
  }
  assert.ok(a.some((e) => e.offers.some((o) => o.usd !== undefined)));
  // legacy "base" + maxAmountRequired items in the PayAI fixture
  assert.ok(b.some((e) => e.offers.some((o) => o.network === "eip155:8453")));
  assert.ok(!b.some((e) => e.offers.some((o) => o.network === "base" || o.network === "solana")));
});

test("normalize: skips malformed, caps offers, cleans text", () => {
  const good = { resource: "HTTPS://Example.COM/Path", description: "a\nb\u0000c", accepts: [{ scheme: "exact", network: "base", asset: BASE_USDC, amount: "10000", payTo: "0xP" }] };
  const out = normalize("payai", [
    good,
    null, 5, "x", [],
    { resource: "ftp://x.com/a", accepts: good.accepts },
    { resource: "https://u:p@x.com/a", accepts: good.accepts },
    { resource: "https://x.com/a" },
    { resource: "https://x.com/b", accepts: [{ scheme: "exact", network: "base", asset: "a", amount: "-1", payTo: "p" }] },
    { resource: "https://x.com/c", accepts: [{ scheme: "exact", network: "base", asset: "a", amount: "1.5", payTo: "p" }] },
    { resource: "https://x.com/d", accepts: [{ scheme: "exact", network: "base", asset: "a", payTo: "p" }] },
    { resource: "https://x.com/e", accepts: [{ scheme: "exact", network: "base", asset: "a", maxAmountRequired: "007", payTo: "p" }] },
    { ...good },
    { resource: "https://big.example/x", accepts: Array.from({ length: 300 }, (_, i) => ({ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: String(i), payTo: "0x1" })) },
  ]);
  assert.deepEqual(out.map((e) => e.url), ["HTTPS://Example.COM/Path", "https://x.com/e", "https://big.example/x"]);
  assert.equal(out[0]!.host, "example.com");
  assert.equal(out[0]!.description, "a b c");
  assert.equal(out[0]!.offers[0]!.network, "eip155:8453");
  assert.equal(out[0]!.offers[0]!.usd, "0.01");
  assert.equal(out[1]!.offers[0]!.amountAtoms, "7");
  assert.equal(out[2]!.offers.length, 16);
  assert.deepEqual(normalize("cdp", "nope"), []);
});

test("search: all words, cheapest first, filters, limit", () => {
  const e = [
    entry("https://a.example/weather", [baseOffer("50000")], "Weather forecast API"),
    entry("https://b.example/wx", [baseOffer("10000"), { ...baseOffer("2000"), network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }], "weather data"),
    entry("https://c.example/other", [baseOffer("1")], "stocks"),
    entry("https://d.example/weather-pro", [{ ...baseOffer("7"), asset: "0xUnknown" }], "weather, unknown asset price"),
    entry("https://e.example/forecast", [baseOffer("20000")], "Forecast weather hourly"),
  ].map((x) => x);
  const all = search(e, "WEATHER");
  assert.deepEqual(all.map((x) => x.url), ["https://b.example/wx", "https://e.example/forecast", "https://a.example/weather", "https://d.example/weather-pro"]);
  assert.equal(all[0]!.offers[0]!.usd, "0.002"); // cheapest offer first within an entry
  assert.deepEqual(search(e, "weather forecast").map((x) => x.url), ["https://e.example/forecast", "https://a.example/weather"]);
  assert.deepEqual(search(e, "weather", { maxUsd: "0.02" }).map((x) => x.url), ["https://b.example/wx", "https://e.example/forecast"]);
  const net = search(e, "weather", { network: "eip155:84532" });
  assert.deepEqual(net.map((x) => x.url), ["https://b.example/wx"]);
  assert.equal(net[0]!.offers.length, 1);
  assert.equal(search(e, "weather", { limit: 2 }).length, 2);
  assert.equal(search(e, "weather").length, 4); // default limit 10
  assert.equal(search(e, "nomatch").length, 0);
  assert.equal(e[1]!.offers.length, 2); // input not mutated
});

test("lookup: ignores query string, trailing slash, host case", () => {
  const e = [entry("https://api.example.com/v1/price?x=1", [baseOffer("1")]), entry("https://api.example.com/other/", [baseOffer("2")])];
  assert.equal(lookup(e, "https://API.example.com/v1/price")?.offers[0]!.amountAtoms, "1");
  assert.equal(lookup(e, "https://api.example.com/v1/price/?y=2")?.offers[0]!.amountAtoms, "1");
  assert.equal(lookup(e, "https://api.example.com/other")?.offers[0]!.amountAtoms, "2");
  assert.equal(lookup(e, "https://api.example.com/v1")?.offers.length, undefined);
  assert.equal(lookup(e, "http://api.example.com/v1/price"), null);
  assert.equal(lookup(e, "not a url"), null);
});

test("priceCheck", () => {
  const e = entry("https://x.example/a", [baseOffer("10000", "0xAbC0000000000000000000000000000000000001")]);
  const live = { network: "eip155:8453", asset: BASE_USDC.toLowerCase(), amountAtoms: "10000", payTo: "0xabc0000000000000000000000000000000000001" };
  assert.deepEqual(priceCheck(e, live, 1.5), { known: true, overpriced: false, ratio: 1, payeeChanged: false, catalogAtoms: "10000" });
  assert.equal(priceCheck(e, { ...live, amountAtoms: "15000" }, 1.5).overpriced, false); // exactly at the limit
  assert.equal(priceCheck(e, { ...live, amountAtoms: "15001" }, 1.5).overpriced, true);
  const hi = priceCheck(e, { ...live, amountAtoms: "100000" }, 2);
  assert.equal(hi.overpriced, true);
  assert.equal(hi.ratio, 10);
  assert.equal(priceCheck(e, { ...live, amountAtoms: "5000" }, 1).overpriced, false);
  assert.equal(priceCheck(e, { ...live, payTo: "0xdead" }, 1.5).payeeChanged, true);
  assert.deepEqual(priceCheck(null, live, 1.5), { known: false, overpriced: false });
  assert.equal(priceCheck(e, { ...live, network: "eip155:84532" }, 1.5).known, false);
  assert.equal(priceCheck(e, { ...live, asset: "0xother" }, 1.5).known, false);
  // large values stay exact (no float)
  const big = entry("https://x.example/b", [baseOffer("9007199254740993")]);
  assert.equal(priceCheck(big, { ...live, amountAtoms: "9007199254740994" }, 1).overpriced, true);
  assert.equal(priceCheck(big, { ...live, amountAtoms: "9007199254740993" }, 1).overpriced, false);
  // zero catalog price
  assert.equal(priceCheck(entry("https://x.example/z", [baseOffer("0")]), { ...live, amountAtoms: "1" }, 2).overpriced, true);
  // solana: exact payee compare
  const s = entry("https://x.example/s", [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: SOL_USDC, amountAtoms: "100", payTo: "AbC" }]);
  const sl = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: SOL_USDC, amountAtoms: "100", payTo: "abc" };
  assert.equal(priceCheck(s, sl, 1.5).payeeChanged, true);
  assert.equal(priceCheck(s, { ...sl, payTo: "AbC" }, 1.5).payeeChanged, false);
  // multiple offers: prefers same payee
  const m = entry("https://x.example/m", [baseOffer("100", "0x1"), baseOffer("50", "0x2")]);
  assert.equal(priceCheck(m, { ...live, payTo: "0x1", amountAtoms: "100" }, 1).overpriced, false);
});

function fakeFetch(opts: { failPayai?: boolean; log?: string[]; pageSize?: number } = {}): typeof fetch {
  const pageSize = opts.pageSize ?? 8;
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    opts.log?.push(u.toString());
    const isCdp = u.toString().startsWith(SOURCE_URLS.cdp);
    if (!isCdp && opts.failPayai) return new Response("boom", { status: 503 });
    const data = isCdp ? cdp : payai;
    const limit = Math.min(Number(u.searchParams.get("limit")), pageSize);
    const offset = Number(u.searchParams.get("offset"));
    const items = data.items.slice(offset, offset + limit);
    return Response.json({ items, pagination: { limit, offset, total: data.items.length }, x402Version: 2 });
  }) as typeof fetch;
}

test("refresh: pages, atomic 0600 write, load", async () => {
  const dir = tmp();
  const log: string[] = [];
  const r = await refresh(dir, { fetchImpl: fakeFetch({ log }), now: 1000 });
  assert.deepEqual(r, { cdp: 20, payai: 20 });
  assert.equal(log.filter((l) => l.startsWith(SOURCE_URLS.cdp)).length, 3); // 8 + 8 + 4
  assert.ok(log.some((l) => l.includes("offset=16")));
  const c = load(dir)!;
  assert.equal(c.fetchedAt, 1000);
  assert.equal(c.entries.length, 40);
  assert.equal(c.entries.filter((e) => e.source === "cdp").length, 20);
  assert.equal(statSync(join(dir, "catalog.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["catalog.json"]); // no tmp leftovers
});

test("refresh: maxPerSource limits download", async () => {
  const dir = tmp();
  const log: string[] = [];
  const r = await refresh(dir, { fetchImpl: fakeFetch({ log, pageSize: 100 }), maxPerSource: 5 });
  assert.deepEqual(r, { cdp: 5, payai: 5 });
  assert.ok(log.every((l) => l.includes("limit=5")));
});

test("refresh: failing source keeps previous entries", async () => {
  const dir = tmp();
  await refresh(dir, { fetchImpl: fakeFetch(), now: 1 });
  const r = await refresh(dir, { fetchImpl: fakeFetch({ failPayai: true }), maxPerSource: 10, now: 2 });
  assert.deepEqual(r, { cdp: 10, payai: 0 });
  const c = load(dir)!;
  assert.equal(c.entries.filter((e) => e.source === "cdp").length, 10);
  assert.equal(c.entries.filter((e) => e.source === "payai").length, 20); // previous kept
  assert.equal(c.fetchedAt, 2);
  assert.equal(statSync(join(dir, "catalog.json")).mode & 0o777, 0o600);
});

test("refresh: network error and garbage body count as failure", async () => {
  const dir = tmp();
  await refresh(dir, { fetchImpl: fakeFetch(), now: 1 });
  const bad = (async (input: string | URL | Request) => {
    if (String(input).startsWith(SOURCE_URLS.cdp)) throw new Error("offline");
    return Response.json({ nope: true });
  }) as typeof fetch;
  const r = await refresh(dir, { fetchImpl: bad, now: 2 });
  assert.deepEqual(r, { cdp: 0, payai: 0 });
  assert.equal(load(dir)!.entries.length, 40);
});

test("load: missing or corrupt file gives null", () => {
  const dir = tmp();
  assert.equal(load(dir), null);
  writeFileSync(join(dir, "catalog.json"), "{not json");
  assert.equal(load(dir), null);
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ version: 2 }));
  assert.equal(load(dir), null);
});
