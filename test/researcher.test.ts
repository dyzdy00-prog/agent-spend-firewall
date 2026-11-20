// The Researcher agent: offers it accepts, how each purchase outcome is reported, the receipt. No network: the firewall is a stub.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefText, buy, catalogOffers, cleanTask, emptyBrief, MAX_NOTE, MAX_TASK, parseOffers, research, topicWords, usdOf } from "../agents/researcher.ts";
import type { CatalogHit, FetchOut, Step } from "../agents/researcher.ts";

const INDEX = "http://127.0.0.1:4021/index";
const ok = (body: unknown, usd6 = "10000"): FetchOut => ({ status: 200, paid: { usd6 }, refused: null, body: JSON.stringify(body) });
const free = (body: unknown): FetchOut => ({ status: 200, paid: null, refused: null, body: JSON.stringify(body) });

function stub(answers: Record<string, FetchOut | Error>) {
  const asked: string[] = [];
  const ceilings: (string | undefined)[] = [];
  return {
    asked, ceilings,
    client: {
      async fetch(url: string, maxUsd?: string): Promise<FetchOut> {
        asked.push(url);
        ceilings.push(maxUsd);
        const u = new URL(url);
        const a = answers[u.pathname];
        if (a === undefined) return { status: 404, paid: null, refused: null, body: "" };
        if (a instanceof Error) throw a;
        return a;
      },
    },
  };
}

describe("researcher agent", () => {
  it("usdOf and cleanTask", () => {
    assert.equal(usdOf("10000"), "0.01");
    assert.equal(usdOf("5000000"), "5.00");
    assert.equal(usdOf("1"), "0.000001");
    assert.equal(usdOf("x"), "0.00");
    assert.equal(usdOf("-5"), "0.00");
    assert.equal(cleanTask("  solar\npanels  "), "solar panels");
    assert.equal(cleanTask(""), null);
    assert.equal(cleanTask("   "), null);
    assert.equal(cleanTask(42), null);
    assert.equal(cleanTask("x".repeat(MAX_TASK)), "x".repeat(MAX_TASK));
    assert.equal(cleanTask("x".repeat(MAX_TASK + 1)), null);
  });

  it("parseOffers keeps only well-formed offers on allowed hosts", () => {
    const body = JSON.stringify({ offers: [
      { url: "http://127.0.0.1:4021/note/a", title: "A", usd: "0.01" },
      { url: "http://127.0.0.1:4022/note/b", title: "B\n<b>", usd: "0.02" },
      { url: "http://evil.example/x", title: "E", usd: "0.01" },
      { url: "http://user:pw@127.0.0.1:4021/x", title: "U", usd: "0.01" },
      { url: "file:///etc/passwd", title: "F", usd: "0.01" },
      { url: "http://127.0.0.1:4021/free", title: "P", usd: "cheap" },
      { url: "http://127.0.0.1:4021/free", title: "N", usd: 1 },
      "nonsense", null,
      { url: "http://127.0.0.1:4021/untitled", usd: "0.01" },
    ] });
    const got = parseOffers(body, ["127.0.0.1:4021", "127.0.0.1:4022"]);
    assert.deepEqual(got.map((o) => o.title), ["A", "B <b>", "/untitled"]);
    assert.deepEqual(parseOffers(body, ["127.0.0.1:4021"]).length, 2);
    assert.deepEqual(parseOffers("not json", ["127.0.0.1:4021"]), []);
    assert.deepEqual(parseOffers("{}", ["127.0.0.1:4021"]), []);
    const many = JSON.stringify({ offers: Array.from({ length: 50 }, (_, i) => ({ url: `http://h.example/${i}`, title: "t", usd: "0.01" })) });
    assert.equal(parseOffers(many, ["h.example"]).length, 20);
  });

  it("buys in order and reports each outcome; the receipt adds up", async () => {
    const offers = [
      { url: "http://127.0.0.1:4021/a", title: "Bought", usd: "0.01" },
      { url: "http://127.0.0.1:4021/b", title: "Cached", usd: "0.02" },
      { url: "http://127.0.0.1:4022/c", title: "Stopped", usd: "0.02" },
      { url: "http://127.0.0.1:4021/d", title: "Lost", usd: "0.01" },
      { url: "http://127.0.0.1:4021/e", title: "Free", usd: "0.00" },
      { url: "http://127.0.0.1:4021/f", title: "Gone", usd: "0.01" },
      { url: "http://127.0.0.1:4021/g", title: "Down", usd: "0.01" },
      { url: "http://127.0.0.1:4021/h", title: "Never asked", usd: "0.01" },
    ];
    const s = stub({
      "/index": free({ offers }),
      "/a": ok({ title: "Note A", text: "about it" }),
      "/b": { status: 200, paid: null, refused: null, body: JSON.stringify({ text: "again" }), cached: { usd6: "20000", ageS: 9 } },
      "/c": { status: 402, paid: null, refused: { code: "CAP", reason: "above cap" }, body: "" },
      "/d": { status: 500, paid: { usd6: "10000" }, refused: null, body: "boom" },
      "/e": free("plain text, not an object"),
      "/g": new Error("down"),
      "/h": ok({ text: "x" }),
    });
    const steps: Step[] = [];
    const b = await research(s.client, INDEX, "solar panels", { hosts: ["127.0.0.1:4022"], maxSources: 7, onStep: (x) => steps.push(x) });
    assert.equal(b.error, undefined);
    assert.equal(new URL(s.asked[0]!).searchParams.get("topic"), "solar panels");
    assert.equal(s.asked.length, 8); // the index and seven offers; the eighth is over maxSources
    assert.deepEqual(steps.map((x) => x.kind), ["bought", "cached", "stopped", "undelivered", "bought", "failed", "failed"]);
    assert.deepEqual(steps.map((x) => x.usd), ["0.01", "0.00", "0.02", "0.01", "0.00", "0.01", "0.01"]);
    assert.equal(steps[2]!.detail, "CAP: above cap");
    assert.equal(steps[2]!.host, "127.0.0.1:4022");
    assert.deepEqual(b.receipt, { offered: 8, bought: 2, cached: 1, stopped: 1, undelivered: 1, failed: 2, paidUsd: "0.02", savedUsd: "0.02" });
    assert.deepEqual(b.notes.map((n) => n.title), ["Note A", "Cached", "Free"]);
    assert.equal(b.notes[0]!.text, "about it");
    const text = briefText(b, steps);
    assert.ok(text.includes("Receipt: $0.02 paid. 2 bought, 1 from cache ($0.02 saved), 1 stopped by the firewall, 1 paid and not delivered, 2 failed."));
  });

  it("topicWords drops filler, short words and repeats; at most six", () => {
    assert.deepEqual(topicWords("What are the latest Bitcoin protocol changes?"), ["bitcoin", "protocol", "changes"]);
    assert.deepEqual(topicWords("AI ai Weather, weather! in NYC"), ["weather", "nyc"]);
    assert.deepEqual(topicWords("\u0160iaul\u0117s orai 2026"), ["\u0161iaul\u0117s", "orai", "2026"]);
    assert.deepEqual(topicWords("one two three four five six seven eight"), ["one", "two", "three", "four", "five", "six"]);
    assert.deepEqual(topicWords("the and for"), []);
  });

  it("catalogOffers ranks by words matched, then price; one per seller; skips what a plain GET cannot ask for", () => {
    const hit = (url: string, description: string, usd = "0.01"): CatalogHit => ({ url, description, usd });
    const all = [
      hit("https://a.example/btc/changes", "Bitcoin protocol changes as JSON"),
      hit("https://a.example/btc/other", "Bitcoin protocol notes", "0.001"),
      hit("https://b.example/protocol", "x402 protocol changes", "0.02"),
      hit("https://c.example/protocol", "another protocol changes feed", "0.005"),
      hit("https://d.example/holidays", "calendar changes only"),
      hit("https://e.example/markets/:id/bitcoin", "Bitcoin protocol changes for one market"),
      hit("https://f.example/x/{id}", "Bitcoin protocol changes template"),
      hit("http://g.example/plain", "Bitcoin protocol changes over http"),
      hit("https://h.example/doc#part", "Bitcoin protocol changes fragment"),
      hit("https://i.example/odd", "Bitcoin protocol changes odd price", "cheap"),
      hit("not a url", "Bitcoin protocol changes"),
    ];
    const search = (w: string) => all.filter((h) => `${h.url} ${h.description}`.toLowerCase().includes(w));
    const got = catalogOffers("bitcoin protocol changes", search);
    assert.deepEqual(got.map((o) => o.url), ["https://a.example/btc/changes", "https://c.example/protocol", "https://b.example/protocol"]);
    assert.equal(got[0]!.title, "Bitcoin protocol changes as JSON");
    assert.equal(got[1]!.usd, "0.005");
    assert.deepEqual(catalogOffers("bitcoin protocol changes", search, 1).map((o) => o.url), ["https://a.example/btc/changes"]);
    assert.deepEqual(catalogOffers("changes", search).map((o) => new URL(o.url).host), ["c.example", "a.example", "d.example", "b.example"]);
    assert.deepEqual(catalogOffers("zebra pottery", search), []);
    assert.deepEqual(catalogOffers("the and", search), []);
    // the same entry returned twice for one word counts once
    const twice = catalogOffers("bitcoin changes", (w) => (w === "bitcoin" ? [all[4]!, all[4]!, all[0]!] : [all[0]!]));
    assert.deepEqual(twice.map((o) => o.url), ["https://a.example/btc/changes", "https://d.example/holidays"]);
    assert.equal(catalogOffers("bitcoin", () => [hit("https://t.example/x", "")])[0]!.title, "t.example/x");
  });

  it("buy takes offers from anywhere; a note keeps up to MAX_NOTE characters of any body", async () => {
    const s = stub({ "/big": ok({ rows: "y".repeat(MAX_NOTE * 2) }), "/b": ok({ text: "short" }, "2000") });
    const steps: Step[] = [];
    const b = await buy(s.client, [
      { url: "https://x.example/big", title: "Big feed", usd: "0.01" },
      { url: "https://y.example/b", title: "Small", usd: "0.002" },
      { url: "https://z.example/none", title: "Missing", usd: "0.01" },
    ], "topic", { onStep: (x) => steps.push(x), maxSources: 2 });
    assert.deepEqual(s.asked, ["https://x.example/big", "https://y.example/b"]);
    // each request carries the listing's price as the most the agent agrees to pay
    assert.deepEqual(s.ceilings, ["0.01", "0.002"]);
    const loose = stub({ "/big": ok({ text: "x" }) });
    await buy(loose.client, [{ url: "https://x.example/big", title: "Big feed", usd: "0.01" }], "topic", { holdToListing: false });
    assert.deepEqual(loose.ceilings, [undefined]);
    assert.deepEqual(steps.map((x) => `${x.kind} ${x.host} ${x.usd}`), ["bought x.example 0.01", "bought y.example 0.002"]);
    assert.equal(b.notes[0]!.text.length, MAX_NOTE);
    assert.equal(b.notes[0]!.title, "Big feed");
    assert.deepEqual(b.receipt, { offered: 3, bought: 2, cached: 0, stopped: 0, undelivered: 0, failed: 0, paidUsd: "0.012", savedUsd: "0.00" });
    assert.deepEqual(emptyBrief("t", "why"), { task: "t", notes: [], receipt: { offered: 0, bought: 0, cached: 0, stopped: 0, undelivered: 0, failed: 0, paidUsd: "0.00", savedUsd: "0.00" }, error: "why" });
    assert.equal("error" in emptyBrief("t"), false);
  });

  it("stops early with a reason when there is nothing to buy", async () => {
    assert.equal((await research(stub({}).client, "not a url", "t")).error, "the index address is not a URL");
    assert.equal((await research(stub({}).client, INDEX, "t")).error, "the index answered 404");
    assert.equal((await research(stub({ "/index": new Error("x") }).client, INDEX, "t")).error, "the firewall did not answer");
    assert.equal((await research(stub({ "/index": { status: 502, paid: null, refused: { code: "HOST", reason: "private or internal address" }, body: "" } }).client, INDEX, "t")).error, "the index was refused: HOST: private or internal address");
    const elsewhere = await research(stub({ "/index": free({ offers: [{ url: "http://evil.example/x", title: "E", usd: "0.01" }] }) }).client, INDEX, "t");
    assert.equal(elsewhere.error, "the index offered nothing this agent may buy");
    assert.equal(elsewhere.receipt.paidUsd, "0.00");
  });
});
