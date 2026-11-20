// The Watcher agent: one address bought fresh each run, compared with the last answer. No network: the firewall is a stub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FetchOut, Step } from "../agents/researcher.ts";
import { emptyWatch, fingerprint, watch, watchText } from "../agents/watcher.ts";

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
    assert.equal(first.fingerprint, fingerprint("reading 1"));
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
