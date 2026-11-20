// The Researcher agent: offers it accepts, how each purchase outcome is reported, the receipt. No network: the firewall is a stub.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefText, cleanTask, MAX_TASK, parseOffers, research, usdOf } from "../agents/researcher.ts";
import type { FetchOut, Step } from "../agents/researcher.ts";

const INDEX = "http://127.0.0.1:4021/index";
const ok = (body: unknown, usd6 = "10000"): FetchOut => ({ status: 200, paid: { usd6 }, refused: null, body: JSON.stringify(body) });
const free = (body: unknown): FetchOut => ({ status: 200, paid: null, refused: null, body: JSON.stringify(body) });

function stub(answers: Record<string, FetchOut | Error>) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      async fetch(url: string): Promise<FetchOut> {
        asked.push(url);
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
