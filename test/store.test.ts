// Blind tests for M4 (state), written from contracts/M4-state.md, src/types.ts and DECISIONS.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "../src/store.ts";
import type { Decision, PaymentIntent, StateView } from "../src/types.ts";

let n = 0;
function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    chain: "evm", network: "eip155:84532", scheme: "exact", asset: "0xaa", amount: 1n,
    payee: "0xbb", payer: "0xcc", validUntil: 5000, replayKey: `k${n++}`,
    host: "example.com", agent: "a1", ...over,
  };
}
const allow = (usd6: bigint) => (): Decision => ({ allow: true, usd6 });
const refuse = (): Decision => ({ allow: false, code: "BUDGET", reason: "no" });

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "m4-"));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

describe("M4 store", () => {
  it("SCHEMA_VERSION is 2", () => assert.equal(SCHEMA_VERSION, 2));

  it("allow records spend; since bound is exclusive", () => {
    const s = openStore(":memory:");
    s.decideAndRecord(intent(), 100, allow(5n));
    assert.equal(s.spentUsd6(99), 5n);
    assert.equal(s.spentUsd6(100), 0n);
    assert.equal(s.count(99), 1);
    assert.equal(s.count(100), 0);
    s.close();
  });

  it("M8 releaseSpend removes exactly one matching spend row and the replay key, keeps the pin", () => {
    const s = openStore(":memory:");
    const a = intent();
    const b = intent({ replayKey: "other" });
    s.decideAndRecord(a, 100, allow(5n));
    s.decideAndRecord(b, 100, allow(5n));
    assert.equal(s.spentUsd6(0), 10n);
    assert.equal(s.releaseSpend(a, 100, 5n), true);
    assert.equal(s.spentUsd6(0), 5n);
    assert.equal(s.count(0), 1);
    assert.equal(s.seenReplayKey(a.replayKey, 0), false);
    assert.equal(s.seenReplayKey(b.replayKey, 0), true);
    assert.equal(s.pinnedPayee("example.com", "evm"), "0xbb");
    assert.equal(s.releaseSpend(a, 100, 5n), true); // the other identical row is fungible
    assert.equal(s.releaseSpend(a, 100, 5n), false);
    assert.equal(s.spentUsd6(0), 0n);
    s.close();
  });

  it("refusal writes nothing", () => {
    const s = openStore(":memory:");
    const it1 = intent();
    const d = s.decideAndRecord(it1, 100, refuse);
    assert.equal(d.allow, false);
    assert.equal(s.spentUsd6(0), 0n);
    assert.equal(s.count(0), 0);
    assert.equal(s.pinnedPayee("example.com", "evm"), null);
    assert.equal(s.seenReplayKey(it1.replayKey, 0), false);
    s.close();
  });

  it("returns the decision from decide", () => {
    const s = openStore(":memory:");
    const d = s.decideAndRecord(intent(), 100, allow(7n));
    assert.deepEqual(d, { allow: true, usd6: 7n });
    const r = s.decideAndRecord(intent(), 100, refuse);
    assert.deepEqual(r, { allow: false, code: "BUDGET", reason: "no" });
    s.close();
  });

  it("exception in decide is rethrown and nothing is written", () => {
    const s = openStore(":memory:");
    const i = intent();
    assert.throws(() => s.decideAndRecord(i, 100, () => { throw new Error("boom"); }), /boom/);
    assert.equal(s.count(0), 0);
    assert.equal(s.seenReplayKey(i.replayKey, 0), false);
    assert.equal(s.pinnedPayee("example.com", "evm"), null);
    // store still usable afterwards (transaction rolled back)
    s.decideAndRecord(intent(), 100, allow(1n));
    assert.equal(s.count(0), 1);
    s.close();
  });

  it("view inside decide sees committed state", () => {
    const s = openStore(":memory:");
    s.decideAndRecord(intent(), 100, allow(10n));
    let seen = -1n;
    s.decideAndRecord(intent(), 101, (v) => { seen = v.spentUsd6(0); return refuse(); });
    assert.equal(seen, 10n);
    s.close();
  });

  it("filters {agent} and {host}; count filter agent", () => {
    const s = openStore(":memory:");
    s.decideAndRecord(intent({ agent: "a1", host: "h1" }), 100, allow(1n));
    s.decideAndRecord(intent({ agent: "a2", host: "h1" }), 100, allow(10n));
    s.decideAndRecord(intent({ agent: "a1", host: "h2" }), 100, allow(100n));
    assert.equal(s.spentUsd6(0), 111n);
    assert.equal(s.spentUsd6(0, { agent: "a1" }), 101n);
    assert.equal(s.spentUsd6(0, { host: "h1" }), 11n);
    assert.equal(s.spentUsd6(0, { agent: "a1", host: "h1" }), 1n);
    assert.equal(s.spentUsd6(0, { agent: "nobody" }), 0n);
    assert.equal(s.count(0, { agent: "a1" }), 2);
    assert.equal(s.count(0, { agent: "a2" }), 1);
    assert.equal(s.count(0), 3);
    s.close();
  });

  it("payee pin is set only if none exists, per (host, chain)", () => {
    const s = openStore(":memory:");
    s.decideAndRecord(intent({ payee: "first" }), 100, allow(1n));
    s.decideAndRecord(intent({ payee: "second" }), 101, allow(1n));
    assert.equal(s.pinnedPayee("example.com", "evm"), "first");
    assert.equal(s.pinnedPayee("example.com", "svm"), null);
    assert.equal(s.pinnedPayee("other.com", "evm"), null);
    s.decideAndRecord(intent({ chain: "svm", payee: "solpayee" }), 102, allow(1n));
    assert.equal(s.pinnedPayee("example.com", "svm"), "solpayee");
    assert.equal(s.pinnedPayee("example.com", "evm"), "first");
    s.close();
  });

  it("seenReplayKey: true at valid_until == now, false at now+1", () => {
    const s = openStore(":memory:");
    const i = intent({ validUntil: 500 });
    s.decideAndRecord(i, 100, allow(1n));
    assert.equal(s.seenReplayKey(i.replayKey, 100), true);
    assert.equal(s.seenReplayKey(i.replayKey, 500), true);
    assert.equal(s.seenReplayKey(i.replayKey, 501), false);
    assert.equal(s.seenReplayKey("unknown", 100), false);
    s.close();
  });

  it("undeliveredCount: exclusive since, per host", () => {
    const s = openStore(":memory:");
    s.markUndelivered("h1", 100);
    s.markUndelivered("h1", 200);
    s.markUndelivered("h2", 150);
    assert.equal(s.undeliveredCount("h1", 0), 2);
    assert.equal(s.undeliveredCount("h1", 100), 1);
    assert.equal(s.undeliveredCount("h1", 200), 0);
    assert.equal(s.undeliveredCount("h2", 0), 1);
    assert.equal(s.undeliveredCount("none", 0), 0);
    s.close();
  });

  it("negative usd6 on allow throws and rolls back", () => {
    const s = openStore(":memory:");
    const i = intent();
    assert.throws(() => s.decideAndRecord(i, 100, allow(-1n)));
    assert.equal(s.count(0), 0);
    assert.equal(s.spentUsd6(0), 0n);
    assert.equal(s.seenReplayKey(i.replayKey, 0), false);
    assert.equal(s.pinnedPayee("example.com", "evm"), null);
    s.close();
  });

  it("calls after close() throw", () => {
    const s = openStore(":memory:");
    s.close();
    assert.throws(() => s.spentUsd6(0));
    assert.throws(() => s.count(0));
    assert.throws(() => s.pinnedPayee("h", "evm"));
    assert.throws(() => s.undeliveredCount("h", 0));
    assert.throws(() => s.seenReplayKey("k", 0));
    assert.throws(() => s.markUndelivered("h", 0));
    assert.throws(() => s.prune(0, 0));
    assert.throws(() => s.decideAndRecord(intent(), 0, refuse));
  });

  it("sums beyond 2^63 exactly as bigint", () => {
    const s = openStore(":memory:");
    const big = 2n ** 63n;
    s.decideAndRecord(intent(), 100, allow(big));
    s.decideAndRecord(intent(), 100, allow(big));
    s.decideAndRecord(intent(), 100, allow(12345n));
    assert.equal(s.spentUsd6(0), 2n * big + 12345n);
    assert.equal(s.spentUsd6(0, { agent: "a1" }), 2n * big + 12345n);
    s.close();
  });

  it("names like __proto__ and constructor work as host/agent", () => {
    const s = openStore(":memory:");
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      s.decideAndRecord(intent({ host: name, agent: name, payee: "p-" + name }), 100, allow(3n));
      assert.equal(s.spentUsd6(0, { agent: name }), 3n);
      assert.equal(s.spentUsd6(0, { host: name }), 3n);
      assert.equal(s.count(0, { agent: name }), 1);
      assert.equal(s.pinnedPayee(name, "evm"), "p-" + name);
    }
    assert.equal(s.spentUsd6(0, { agent: "valueOf" }), 0n);
    s.markUndelivered("__proto__", 50);
    assert.equal(s.undeliveredCount("__proto__", 0), 1);
    s.close();
  });

  it("prune: exact bounds, keeps pins", () => {
    const s = openStore(":memory:");
    // now=1000, keepS=100 -> rows with ts <= 900 deleted
    s.decideAndRecord(intent({ validUntil: 999, replayKey: "rk-old" }), 900, allow(1n));
    s.decideAndRecord(intent({ validUntil: 1000, replayKey: "rk-edge" }), 901, allow(10n));
    s.markUndelivered("h", 900);
    s.markUndelivered("h", 901);
    s.prune(1000, 100);
    assert.equal(s.spentUsd6(0), 10n);
    assert.equal(s.count(0), 1);
    assert.equal(s.undeliveredCount("h", 0), 1);
    // replay keys: valid_until < now deleted; == now kept
    assert.equal(s.seenReplayKey("rk-old", 0), false);
    assert.equal(s.seenReplayKey("rk-edge", 0), true);
    // pin survives even though first spend row is gone
    assert.equal(s.pinnedPayee("example.com", "evm"), "0xbb");
    s.prune(1_000_000, 1);
    assert.equal(s.count(0), 0);
    assert.equal(s.seenReplayKey("rk-edge", 0), false);
    assert.equal(s.pinnedPayee("example.com", "evm"), "0xbb");
    s.close();
  });

  it("persists across reopen", withDir((dir) => {
    const p = join(dir, "s.db");
    const a = openStore(p);
    const i = intent();
    a.decideAndRecord(i, 100, allow(42n));
    a.close();
    const b = openStore(p);
    assert.equal(b.spentUsd6(0), 42n);
    assert.equal(b.seenReplayKey(i.replayKey, 100), true);
    assert.equal(b.pinnedPayee("example.com", "evm"), "0xbb");
    b.close();
  }));

  it("PRAGMA user_version holds the schema version", withDir((dir) => {
    const p = join(dir, "s.db");
    openStore(p).close();
    const db = new DatabaseSync(p);
    const row = db.prepare("PRAGMA user_version").get() as Record<string, number>;
    assert.equal(row.user_version, SCHEMA_VERSION);
    db.close();
  }));

  it("deliveredBefore: false until markDelivered, per host, kept for good", withDir((dir) => {
    const p = join(dir, "s.db");
    const s = openStore(p);
    assert.equal(s.deliveredBefore("h1"), false);
    s.markDelivered("h1", 100);
    s.markDelivered("h1", 200); // a second delivery changes nothing
    assert.equal(s.deliveredBefore("h1"), true);
    assert.equal(s.deliveredBefore("h2"), false);
    assert.equal(s.deliveredBefore("__proto__"), false);
    s.prune(10 ** 10, 1); // far in the future: spend and prices go, this stays
    assert.equal(s.deliveredBefore("h1"), true);
    s.close();
    const b = openStore(p);
    assert.equal(b.deliveredBefore("h1"), true);
    b.close();
    assert.throws(() => s.deliveredBefore("h1"));
    assert.throws(() => s.markDelivered("h1", 1));
  }));

  it("priceChanges: an address remembered before changes were kept gets its old price as the first entry", withDir((dir) => {
    const p = join(dir, "s.db");
    const a = openStore(p);
    a.recordPrice("h1", "/a", 10000n, 100);
    a.close();
    const db = new DatabaseSync(p);
    db.exec("DROP TABLE price_changes");
    db.close();
    const b = openStore(p);
    assert.deepEqual(b.priceChanges("h1", 50), []);
    b.recordPrice("h1", "/a", 10000n, 200);
    assert.deepEqual(b.priceChanges("h1", 50), [], "the same price is still no change");
    b.recordPrice("h1", "/a", 40000n, 300);
    assert.deepEqual(b.priceChanges("h1", 50).map((x) => [x.usd6, x.ts]), [[40000n, 300], [10000n, 200]]);
    b.close();
  }));

  it("lastPrice: per host and path, the newest wins, old ones are pruned", () => {
    const s = openStore(":memory:");
    assert.equal(s.lastPrice("h1", "/a"), null);
    s.recordPrice("h1", "/a", 10000n, 100);
    s.recordPrice("h1", "/b", 20000n, 100);
    s.recordPrice("h2", "/a", 30000n, 100);
    assert.equal(s.lastPrice("h1", "/a"), 10000n);
    assert.equal(s.lastPrice("h1", "/b"), 20000n);
    assert.equal(s.lastPrice("h2", "/a"), 30000n);
    assert.deepEqual(s.pricesOf("h1", 50), [{ path: "/a", usd6: 10000n, ts: 100 }, { path: "/b", usd6: 20000n, ts: 100 }]);
    assert.deepEqual(s.pricesOf("nobody", 50), []);
    assert.deepEqual(s.priceChanges("h1", 50).map((x) => [x.path, x.usd6, x.ts]), [["/b", 20000n, 100], ["/a", 10000n, 100]]);
    s.recordPrice("h3", "/b", 20000n, 100);
    s.recordPrice("h3", "/b", 20000n, 150);
    assert.equal(s.priceChanges("h3", 50).length, 1, "the same price again is not a change");
    s.recordPrice("h3", "/b", 25000n, 160);
    s.recordPrice("h3", "/b", 20000n, 170);
    assert.deepEqual(s.priceChanges("h3", 2).map((x) => [x.path, x.usd6, x.ts]), [["/b", 20000n, 170], ["/b", 25000n, 160]]);
    assert.deepEqual(s.priceChanges("h2", 50).length, 1);
    s.recordPrice("h1", "/a", 2n ** 70n, 200);
    assert.deepEqual(s.pricesOf("h1", 1), [{ path: "/a", usd6: 2n ** 70n, ts: 200 }]);
    s.recordPrice("h1", "/a", 10000n, 200);
    s.recordPrice("h1", "/a", 2n ** 70n, 200);
    assert.equal(s.lastPrice("h1", "/a"), 2n ** 70n);
    assert.throws(() => s.recordPrice("h1", "/a", -1n, 300));
    assert.equal(s.lastPrice("h1", "/a"), 2n ** 70n);
    // prices are kept 90 days from when they were recorded
    s.prune(100 + 90 * 86400 - 1, 1);
    assert.equal(s.lastPrice("h1", "/b"), 20000n);
    s.prune(100 + 90 * 86400, 1);
    assert.equal(s.lastPrice("h1", "/b"), null);
    assert.equal(s.lastPrice("h2", "/a"), null);
    assert.equal(s.lastPrice("h1", "/a"), 2n ** 70n);
    s.close();
    assert.throws(() => s.lastPrice("h1", "/a"));
  });

  it("a version 1 file is upgraded in place and keeps its data", withDir((dir) => {
    const p = join(dir, "s.db");
    const a = openStore(p);
    const i = intent();
    a.decideAndRecord(i, 100, allow(42n));
    a.markUndelivered("example.com", 100);
    a.close();
    // make it look like a file written before version 2
    const db = new DatabaseSync(p);
    db.exec("DROP TABLE trusted; DROP TABLE prices; PRAGMA user_version = 1");
    db.close();
    const b = openStore(p);
    assert.equal(b.spentUsd6(0), 42n);
    assert.equal(b.pinnedPayee("example.com", "evm"), "0xbb");
    assert.equal(b.undeliveredCount("example.com", 0), 1);
    assert.equal(b.deliveredBefore("example.com"), false); // nobody is trusted by the upgrade itself
    b.markDelivered("example.com", 200);
    b.recordPrice("example.com", "/x", 5n, 200);
    b.close();
    const check = new DatabaseSync(p);
    assert.equal((check.prepare("PRAGMA user_version").get() as Record<string, number>).user_version, 2);
    check.close();
    const c = openStore(p);
    assert.equal(c.deliveredBefore("example.com"), true);
    assert.equal(c.lastPrice("example.com", "/x"), 5n);
    c.close();
  }));

  it("wrong schema version throws", withDir((dir) => {
    const p = join(dir, "s.db");
    openStore(p).close();
    const db = new DatabaseSync(p);
    db.exec("PRAGMA user_version = 3");
    db.close();
    assert.throws(() => openStore(p), /schema version 3, expected 2/);
  }));

  it("corrupted file throws", withDir((dir) => {
    const p = join(dir, "bad.db");
    writeFileSync(p, Buffer.alloc(8192, 0x41));
    assert.throws(() => openStore(p));
    const p2 = join(dir, "bad2.db");
    const s = openStore(p2);
    s.decideAndRecord(intent(), 100, allow(1n));
    s.close();
    const db = new DatabaseSync(p2);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    // overwrite the middle of the file with junk, keeping the header intact
    const buf = readFileSync(p2);
    buf.fill(0xff, 100, buf.length);
    writeFileSync(p2, buf);
    assert.throws(() => openStore(p2));
  }));

  it("budget race: two Store instances on one file", withDir((dir) => {
    const p = join(dir, "r.db");
    const a = openStore(p);
    const b = openStore(p);
    const budget = 100n;
    let allowed = 0;
    for (let k = 0; k < 150; k++) {
      const s = k % 2 ? a : b;
      const d = s.decideAndRecord(intent(), 1000, (v: StateView) =>
        v.spentUsd6(0) + 1n <= budget ? { allow: true, usd6: 1n } : refuse());
      if (d.allow) allowed++;
    }
    assert.equal(allowed, 100);
    assert.equal(a.spentUsd6(0), 100n);
    assert.equal(b.spentUsd6(0), 100n);
    a.close(); b.close();
  }));

  it("budget race: 10 worker threads on one file never exceed the budget", withDir(async (dir) => {
    const p = join(dir, "w.db");
    openStore(p).close();
    const N = 10, iterations = 30, usd6 = 7n, budget = 1000n;
    const results = await Promise.all(Array.from({ length: N }, (_, id) => new Promise<number>((res, rej) => {
      const w = new Worker(new URL("./store-worker.ts", import.meta.url), {
        workerData: { path: p, budget: String(budget), usd6: String(usd6), iterations, id },
      });
      w.once("message", res);
      w.once("error", rej);
    })));
    const allows = results.reduce((x, y) => x + y, 0);
    const s = openStore(p);
    const total = s.spentUsd6(0);
    assert.ok(total <= budget, `total ${total} exceeds budget`);
    assert.equal(total, BigInt(allows) * usd6);
    assert.equal(s.count(0), allows);
    // budget 1000 / 7 -> 142 spends fit; demand (300) exceeds that, so the cap must be reached
    assert.equal(allows, 142);
    s.close();
  }));
});

