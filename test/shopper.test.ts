// The Shopper agent: cheapest listing first, next one when a payment is stopped or nothing is delivered, stop at the
// first delivery. No network: the firewall is a stub.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { byPrice, emptyShop, microOf, shop, shopFrom, shopText } from "../agents/shopper.ts";
import type { FetchOut, Offer, Step } from "../agents/researcher.ts";

const ok = (body: unknown, usd6: string): FetchOut => ({ status: 200, paid: { usd6 }, refused: null, body: JSON.stringify(body) });
function stub(answers: Record<string, FetchOut | Error>) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      async fetch(url: string): Promise<FetchOut> {
        const u = new URL(url);
        asked.push(u.pathname);
        const a = answers[u.pathname];
        if (a === undefined) return { status: 404, paid: null, refused: null, body: "" };
        if (a instanceof Error) throw a;
        return a;
      },
    },
  };
}
const OFFERS: Offer[] = [
  { url: "http://127.0.0.1:4021/a", title: "Seller A", usd: "0.03" },
  { url: "http://127.0.0.1:4022/b", title: "Seller B", usd: "0.01" },
  { url: "http://127.0.0.1:4026/c", title: "Seller C", usd: "0.01" },
  { url: "http://127.0.0.1:4027/d", title: "Seller D", usd: "0.02" },
];
const CAP: FetchOut = { status: 402, paid: null, refused: { code: "CAP", reason: "payment exceeds per-payment cap" }, body: "" };
const LOST: FetchOut = { status: 500, paid: { usd6: "10000" }, refused: null, body: "boom" };

describe("shopper agent", () => {
  it("microOf and byPrice", () => {
    assert.equal(microOf("0.02"), 20000n);
    assert.equal(microOf("5"), 5000000n);
    assert.equal(microOf("0.000001"), 1n);
    for (const bad of ["", "cheap", "-1", "1.", ".5", "0.0000001", "1e3"]) assert.equal(microOf(bad), null);
    assert.deepEqual(byPrice(OFFERS).map((o) => o.title), ["Seller B", "Seller C", "Seller D", "Seller A"]);
    assert.deepEqual(byPrice([]), []);
  });

  it("the two cheapest go wrong, the third delivers, the dearest is never asked", async () => {
    const s = stub({ "/b": CAP, "/c": LOST, "/d": ok({ title: "Seller D", text: "the goods" }, "20000"), "/a": ok({ text: "never" }, "30000") });
    const steps: Step[] = [];
    const b = await shop(s.client, OFFERS, "air quality dataset", { onStep: (x) => steps.push(x) });
    assert.deepEqual(s.asked, ["/b", "/c", "/d"]);
    assert.deepEqual(steps.map((x) => `${x.kind} ${x.title} ${x.usd}`), ["stopped Seller B 0.01", "undelivered Seller C 0.01", "bought Seller D 0.02", "skipped Seller A 0.03"]);
    assert.equal(b.error, undefined);
    assert.equal(b.kind, "shopper");
    assert.deepEqual(b.receipt, { offered: 4, tried: 3, bought: 1, cached: 0, stopped: 1, undelivered: 1, failed: 0, skipped: 1, paidUsd: "0.03", priceUsd: "0.02", dearestUsd: "0.03", savedUsd: "0.01", lostUsd: "0.01" });
    assert.deepEqual(b.notes, [{ title: "Seller D", text: "the goods", host: "127.0.0.1:4027" }]);
    const text = shopText(b, steps);
    assert.ok(text.includes("Bought for $0.02. The dearest listing asked $0.03: $0.01 less."));
    assert.ok(text.includes("$0.03 left the wallet, $0.01 of it to sellers that delivered nothing. 3 of 4 listings tried, 1 stopped by the firewall, 0 failed, 1 not needed."));
  });

  it("the cheapest delivers: one request, the rest are not asked", async () => {
    const s = stub({ "/b": ok({ text: "x" }, "10000") });
    const b = await shop(s.client, OFFERS, "t");
    assert.deepEqual(s.asked, ["/b"]);
    assert.deepEqual(b.receipt, { offered: 4, tried: 1, bought: 1, cached: 0, stopped: 0, undelivered: 0, failed: 0, skipped: 3, paidUsd: "0.01", priceUsd: "0.01", dearestUsd: "0.03", savedUsd: "0.02", lostUsd: "0.00" });
  });

  it("a cached answer counts as delivered and costs nothing now", async () => {
    const s = stub({ "/b": { status: 200, paid: null, refused: null, body: JSON.stringify({ text: "again" }), cached: { usd6: "10000", ageS: 4 } } });
    const b = await shop(s.client, OFFERS, "t");
    assert.equal(b.receipt.bought, 1);
    assert.equal(b.receipt.cached, 1);
    assert.ok(shopText(b, []).includes("Answered from the firewall's cache: nothing paid this time."));
    assert.equal(b.receipt.paidUsd, "0.00");
    assert.equal(b.receipt.priceUsd, "0.00");
    assert.equal(b.receipt.savedUsd, "0.03");
  });

  it("nobody delivers: every listing is tried, the loss is counted, the run says so", async () => {
    const s = stub({ "/b": CAP, "/c": LOST, "/d": new Error("down") });
    const steps: Step[] = [];
    const b = await shop(s.client, OFFERS, "t", { onStep: (x) => steps.push(x) });
    assert.deepEqual(s.asked, ["/b", "/c", "/d", "/a"]);
    assert.deepEqual(steps.map((x) => x.kind), ["stopped", "undelivered", "failed", "failed"]);
    assert.equal(b.error, "no listing delivered");
    assert.deepEqual(b.receipt, { offered: 4, tried: 4, bought: 0, cached: 0, stopped: 1, undelivered: 1, failed: 2, skipped: 0, paidUsd: "0.01", priceUsd: "0.00", dearestUsd: "0.03", savedUsd: "0.00", lostUsd: "0.01" });
    assert.ok(shopText(b, steps).includes("Nothing bought: no listing delivered."));
    assert.equal((await shop(s.client, [], "t")).error, "there is nothing to compare");
  });

  it("shopFrom reads the listings from a quotes address and reports why it could not", async () => {
    const quotes = "http://127.0.0.1:4021/quotes";
    const hosts = ["127.0.0.1:4022", "127.0.0.1:4026", "127.0.0.1:4027"];
    const free = (body: unknown): FetchOut => ({ status: 200, paid: null, refused: null, body: JSON.stringify(body) });
    const s = stub({ "/quotes": free({ offers: OFFERS }), "/b": CAP, "/c": LOST, "/d": ok({ text: "x" }, "20000") });
    const b = await shopFrom(s.client, quotes, "air quality", { hosts });
    assert.deepEqual(s.asked, ["/quotes", "/b", "/c", "/d"]);
    assert.equal(b.receipt.priceUsd, "0.02");
    // without the extra hosts only the quotes address's own host may be bought from
    const own = await shopFrom(stub({ "/quotes": free({ offers: OFFERS }), "/a": ok({ text: "x" }, "30000") }).client, quotes, "t");
    assert.deepEqual(own.receipt, { ...emptyShop("t").receipt, offered: 1, tried: 1, bought: 1, paidUsd: "0.03", priceUsd: "0.03", dearestUsd: "0.03" });
    assert.equal((await shopFrom(stub({}).client, "not a url", "t")).error, "the quotes address is not a URL");
    assert.equal((await shopFrom(stub({}).client, quotes, "t")).error, "the quotes address answered 404");
    assert.equal((await shopFrom(stub({ "/quotes": new Error("x") }).client, quotes, "t")).error, "the firewall did not answer");
    assert.equal((await shopFrom(stub({ "/quotes": free({ offers: [{ url: "http://evil.example/x", title: "E", usd: "0.01" }] }) }).client, quotes, "t")).error, "no listing this agent may buy");
    assert.equal((await shopFrom(stub({ "/quotes": { status: 502, paid: null, refused: { code: "HOST", reason: "private or internal address" }, body: "" } }).client, quotes, "t")).error, "the quotes were refused: HOST: private or internal address");
  });
});
