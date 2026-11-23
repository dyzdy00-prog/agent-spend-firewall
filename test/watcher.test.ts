// The Watcher agent: one address bought fresh each run, compared with the last answer. No network: the firewall is a stub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FetchOut, Step } from "../agents/researcher.ts";
import { emptyWatch, fieldOf, fingerprint, parseWatch, specOpts, watch, watchText } from "../agents/watcher.ts";

const OFFER = { url: "http://127.0.0.1:4021/feed?topic=river", title: "Feed", usd: "0.01" };
const paid = (text: string): FetchOut => ({ status: 200, paid: { usd6: "10000" }, refused: null, body: JSON.stringify({ title: "Feed", text }) });

function stub(answer: FetchOut | Error) {
  const asked: { url: string; maxUsd: string | undefined; fresh: boolean | undefined }[] = [];
  return {
    asked,
    client: {
      async fetch(url: string, maxUsd?: string, fresh?: boolean): Promise<FetchOut> {
        asked.push({ url, maxUsd, fresh });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

describe("watcher agent", () => {
  it("fingerprint: the same text gives the same 16 hex characters, another text another", () => {
    assert.match(fingerprint("reading 1"), /^[0-9a-f]{16}$/);
    assert.equal(fingerprint("reading 1"), fingerprint("reading 1"));
    assert.notEqual(fingerprint("reading 1"), fingerprint("reading 2"));
  });

  it("first look, the same, changed: one fresh purchase each run, held to the listed price", async () => {
    const steps: Step[] = [];
    const s1 = stub(paid("reading 1"));
    const first = await watch(s1.client, OFFER, "river", null, { onStep: (x) => steps.push(x) });
    assert.deepEqual(s1.asked, [{ url: OFFER.url, maxUsd: "0.01", fresh: true }]);
    assert.deepEqual(first.receipt, { checked: 1, changed: 0, first: 1, stopped: 0, undelivered: 0, failed: 0, paidUsd: "0.01" });
    assert.equal(first.fingerprint, fingerprint(JSON.stringify({ title: "Feed", text: "reading 1" })));
    assert.equal(first.notes[0]!.text, "reading 1");
    assert.deepEqual(steps.map((x) => x.kind), ["bought", "first"]);

    const same = await watch(stub(paid("reading 1")).client, OFFER, "river", first.fingerprint!);
    assert.deepEqual([same.receipt.checked, same.receipt.changed, same.receipt.first], [1, 0, 0]);

    const steps2: Step[] = [];
    const diff = await watch(stub(paid("reading 2")).client, OFFER, "river", first.fingerprint!, { onStep: (x) => steps2.push(x) });
    assert.deepEqual([diff.receipt.checked, diff.receipt.changed, diff.receipt.first, diff.receipt.paidUsd], [1, 1, 0, "0.01"]);
    assert.deepEqual(steps2.map((x) => `${x.kind} ${x.detail}`), ["bought paid and delivered", "changed different from the last run"]);
    assert.notEqual(diff.fingerprint, first.fingerprint);

    const loose = stub(paid("x"));
    await watch(loose.client, OFFER, "river", null, { holdToListing: false });
    assert.deepEqual(loose.asked, [{ url: OFFER.url, maxUsd: undefined, fresh: true }]);
  });

  it("nothing delivered: no fingerprint, nothing called changed, the reason is said", async () => {
    const no = await watch(stub({ status: 402, paid: null, refused: { code: "PAUSED", reason: "this agent is paused by the owner" }, body: "" }).client, OFFER, "river", "0123456789abcdef");
    assert.deepEqual([no.error, no.fingerprint, no.receipt.checked, no.receipt.changed, no.receipt.stopped], ["the firewall stopped the payment", undefined, 0, 0, 1]);
    const lost = await watch(stub({ status: 500, paid: { usd6: "10000" }, refused: null, body: "" }).client, OFFER, "river", "0123456789abcdef");
    assert.deepEqual([lost.error, lost.receipt.undelivered, lost.receipt.paidUsd, lost.receipt.changed], ["paid, and the seller sent nothing", 1, "0.01", 0]);
    const down = await watch(stub(new Error("x")).client, OFFER, "river", null);
    assert.deepEqual([down.error, down.receipt.failed], ["the address did not answer", 1]);
  });

  it("parseWatch and fieldOf", () => {
    assert.deepEqual(parseWatch("river level"), { topic: "river level" });
    assert.deepEqual(parseWatch("river level | level"), { topic: "river level", field: "level" });
    assert.deepEqual(parseWatch("river level|data.items.0.price>4.5"), { topic: "river level", field: "data.items.0.price", op: ">", limit: 4.5 });
    assert.deepEqual(parseWatch("btc | price < -2"), { topic: "btc", field: "price", op: "<", limit: -2 });
    // not that shape: all of it is the topic
    for (const t of ["a | b c", "a | b > x", "| level", "a | level >", "a | b = 4"]) assert.deepEqual(parseWatch(t), { topic: t }, t);
    assert.deepEqual(specOpts(parseWatch("a | b > 4")), { field: "b", op: ">", limit: 4 });
    assert.deepEqual(specOpts(parseWatch("a")), {});
    const body = JSON.stringify({ level: 3.2, data: { items: [{ price: "7.5" }] }, none: null });
    assert.equal(fieldOf(body, "level"), 3.2);
    assert.equal(fieldOf(body, "data.items.0.price"), "7.5");
    assert.equal(fieldOf(body, "none"), null);
    for (const f of ["missing", "level.x", "data.items.3", "__proto__", "constructor"]) assert.equal(fieldOf(body, f), undefined, f);
    assert.equal(fieldOf("not json", "level"), undefined);
  });

  it("one field: the rest of the answer may change without it being called changed", async () => {
    const body = (level: number, stamp: string): FetchOut => ({ status: 200, paid: { usd6: "10000" }, refused: null, body: JSON.stringify({ level, stamp }) });
    const a = await watch(stub(body(3.2, "10:00")).client, OFFER, "river | level", null, { field: "level" });
    assert.deepEqual([a.receipt.first, a.field, a.value], [1, "level", "3.2"]);
    const steps: Step[] = [];
    const b = await watch(stub(body(3.2, "10:01")).client, OFFER, "river | level", a.fingerprint!, { field: "level", onStep: (x) => steps.push(x) });
    assert.deepEqual([b.receipt.changed, b.receipt.checked], [0, 1]);
    assert.equal(steps.at(-1)!.detail, "level is 3.2: the same as the last run");
    // the whole answer did change: without the field it would be CHANGED
    const whole = await watch(stub(body(3.2, "10:01")).client, OFFER, "river", fingerprint(JSON.stringify({ level: 3.2, stamp: "10:00" })));
    assert.equal(whole.receipt.changed, 1);
    const c = await watch(stub(body(3.4, "10:02")).client, OFFER, "river | level", a.fingerprint!, { field: "level" });
    assert.deepEqual([c.receipt.changed, c.value], [1, "3.4"]);
    const gone = await watch(stub(body(3.4, "10:02")).client, OFFER, "river | depth", a.fingerprint!, { field: "depth" });
    assert.deepEqual([gone.error, gone.fingerprint, gone.receipt.checked, gone.receipt.paidUsd], ['the answer has no field "depth"', undefined, 0, "0.01"]);
  });

  it("a line: told when the number crosses it, not at every move, and again only after it came back", async () => {
    const body = (level: unknown): FetchOut => ({ status: 200, paid: { usd6: "10000" }, refused: null, body: JSON.stringify({ level }) });
    const o = { field: "level", op: ">" as const, limit: 4 };
    const run = async (level: unknown, last: string | null) => {
      const steps: Step[] = [];
      const b = await watch(stub(body(level)).client, OFFER, "river | level > 4", last, { ...o, onStep: (x) => steps.push(x) });
      return { b, said: steps.at(-1)?.detail };
    };
    const r1 = await run(3.2, null);
    assert.deepEqual([r1.b.receipt.first, r1.b.receipt.changed, r1.b.met, r1.said], [1, 0, false, "first look: level is 3.2, not above 4"]);
    const r2 = await run(3.9, r1.b.fingerprint!);
    assert.deepEqual([r2.b.receipt.changed, r2.said], [0, "level is 3.9, not above 4"]);
    const r3 = await run(4.3, r2.b.fingerprint!);
    assert.deepEqual([r3.b.receipt.changed, r3.b.met, r3.said], [1, true, "level is 4.3, above 4"]);
    const r4 = await run(4.8, r3.b.fingerprint!);
    assert.deepEqual([r4.b.receipt.changed, r4.said], [0, "level is 4.8, still above 4"]);
    const r5 = await run(4, r4.b.fingerprint!); // exactly on the line is not above it
    assert.deepEqual([r5.b.receipt.changed, r5.b.met], [0, false]);
    const r6 = await run("4.1", r5.b.fingerprint!); // a number sent as text counts
    assert.deepEqual([r6.b.receipt.changed, r6.b.met], [1, true]);
    // a first look that is already past the line is told at once
    const hot = await run(9, null);
    assert.deepEqual([hot.b.receipt.first, hot.b.receipt.changed], [1, 1]);
    const below = await watch(stub(body(1.5)).client, OFFER, "river | level < 2", null, { field: "level", op: "<", limit: 2 });
    assert.deepEqual([below.met, below.receipt.changed], [true, 1]);
    const bad = await run("high", r1.b.fingerprint!);
    assert.deepEqual([bad.b.error, bad.b.fingerprint, bad.b.receipt.changed], ['the field "level" is not a number', undefined, 0]);
    assert.match(watchText(r3.b, []), /level is 4\.3: PAST THE LINE\./);
  });

  it("a move: told when the number is N percent away from the one last told, so drift adds up", async () => {
    assert.deepEqual(parseWatch("btc price | usd ~ 5%"), { topic: "btc price", field: "usd", op: "~", limit: 5 });
    assert.deepEqual(parseWatch("btc price | usd ~2.5"), { topic: "btc price", field: "usd", op: "~", limit: 2.5 });
    assert.deepEqual(parseWatch("btc price | usd ~ 0%"), { topic: "btc price | usd ~ 0%" });
    assert.deepEqual(parseWatch("btc price | usd > 5%"), { topic: "btc price | usd > 5%" });
    const body = (usd: unknown): FetchOut => ({ status: 200, paid: { usd6: "10000" }, refused: null, body: JSON.stringify({ usd }) });
    const run = async (usd: unknown, last: string | null) => {
      const steps: Step[] = [];
      const b = await watch(stub(body(usd)).client, OFFER, "btc price | usd ~ 5%", last, { field: "usd", op: "~", limit: 5, onStep: (x) => steps.push(x) });
      return { b, said: steps.at(-1)?.detail };
    };
    const r1 = await run(100, null);
    assert.deepEqual([r1.b.receipt.first, r1.b.receipt.changed, r1.b.fingerprint, r1.said], [1, 0, "ref:100", "first look: usd is 100, told when it moves 5%"]);
    const r2 = await run(103, r1.b.fingerprint!);
    assert.deepEqual([r2.b.receipt.changed, r2.b.moved, r2.b.fingerprint, r2.said], [0, 3, "ref:100", "usd is 103, 3% from 100, told at 5%"]);
    const r3 = await run(106, r2.b.fingerprint!); // 3% and 3% again: 6% from what was told
    assert.deepEqual([r3.b.receipt.changed, r3.b.moved, r3.b.fingerprint, r3.said], [1, 6, "ref:106", "usd is 106, up 6% from 100"]);
    const r4 = await run(100, r3.b.fingerprint!);
    assert.deepEqual([r4.b.receipt.changed, r4.said], [1, "usd is 100, down 5.7% from 106"]);
    const r5 = await run(100, r4.b.fingerprint!);
    assert.deepEqual([r5.b.receipt.changed, r5.b.moved, r5.b.met], [0, 0, undefined]);
    const zero = await run(1, "ref:0");
    assert.deepEqual([zero.b.receipt.changed, zero.said], [1, "usd is 1, up away from 0"]);
    const old = await run(100, "0123456789abcdef"); // a fingerprint from before the watch had a move: starts over
    assert.deepEqual([old.b.receipt.first, old.b.receipt.changed], [1, 0]);
    const bad = await run("high", "ref:100");
    assert.deepEqual([bad.b.error, bad.b.fingerprint], ['the field "usd" is not a number', undefined]);
  });

  it("a long answer: the field is found past what a note keeps, and a change there is seen", async () => {
    const long = (price: number, tail: string): FetchOut => ({ status: 200, paid: { usd6: "1000" }, refused: null, body: JSON.stringify({ filler: "x".repeat(9000), deep: { price }, tail }) });
    const a = await watch(stub(long(7, "a")).client, OFFER, "t | deep.price", null, { field: "deep.price" });
    assert.deepEqual([a.error, a.value, a.receipt.first], [undefined, "7", 1]);
    assert.ok(a.notes[0]!.text.length <= 4000);
    // the whole answer: a difference after the first 4000 characters is a change
    const w1 = await watch(stub(long(7, "a")).client, OFFER, "t", null);
    const w2 = await watch(stub(long(7, "b")).client, OFFER, "t", w1.fingerprint!);
    assert.equal(w2.receipt.changed, 1);
    const w3 = await watch(stub(long(7, "a")).client, OFFER, "t", w1.fingerprint!);
    assert.equal(w3.receipt.changed, 0);
  });

  it("watchText and emptyWatch", async () => {
    const steps: Step[] = [];
    const b = await watch(stub(paid("reading 2")).client, OFFER, "river", fingerprint("reading 1"), { onStep: (x) => steps.push(x) });
    const t = watchText(b, steps);
    assert.match(t, /^Watching: river/);
    assert.match(t, /CHANGED since the last run\./);
    assert.match(t, /Receipt: \$0\.01 paid, 0 stopped by the firewall, 0 paid and not delivered\./);
    assert.match(t, new RegExp(`Fingerprint: ${b.fingerprint}`));
    const e = emptyWatch("river", "no seller");
    assert.match(watchText(e, []), /Not checked: no seller\./);
    assert.equal(emptyWatch("river").error, undefined);
  });
});
