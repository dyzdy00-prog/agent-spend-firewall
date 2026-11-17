// Blind tests for M1 (policy), written strictly from contracts/M1-policy.md,
// src/types.ts and the 2026-11-18 rows of DECISIONS.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate, hostOf, toAtoms, usd6Of, findAsset } from "../src/policy.ts";
import type { AssetRule, Chain, Decision, PaymentIntent, Policy, RefusalCode, StateView } from "../src/types.ts";

const EVM_NET = "eip155:84532";
const SVM_NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const EVM_USDC = "0xAbCdEf0000000000000000000000000000000001";
const EVM_DAI18 = "0xDa1800000000000000000000000000000000000d";
const SVM_MINT = "MintAbcXyz111111111111111111111111111111111";
const EVM_PAYEE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVM_OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SVM_PAYEE = "PayeeAbcDef22222222222222222222222222222222";
const NOW = 1_000_000;

interface St {
  spent: bigint;
  agentSpent: bigint;
  hostSpent: bigint;
  count: number;
  pinned: string | null;
  undelivered: number;
  seen: boolean;
  calls: {
    spent: { since: number; filter?: { agent?: string; host?: string } }[];
    count: number[];
    pinned: [string, Chain][];
    undelivered: [string, number][];
    seen: [string, number][];
  };
}

function newState(): St {
  return {
    spent: 0n, agentSpent: 0n, hostSpent: 0n, count: 0, pinned: null, undelivered: 0, seen: false,
    calls: { spent: [], count: [], pinned: [], undelivered: [], seen: [] },
  };
}

function makeView(st: St): StateView {
  return {
    spentUsd6(since, filter) {
      st.calls.spent.push(filter === undefined ? { since } : { since, filter });
      if (filter?.agent !== undefined) return st.agentSpent;
      if (filter?.host !== undefined) return st.hostSpent;
      return st.spent;
    },
    count(since) { st.calls.count.push(since); return st.count; },
    pinnedPayee(host, chain) { st.calls.pinned.push([host, chain]); return st.pinned; },
    undeliveredCount(host, since) { st.calls.undelivered.push([host, since]); return st.undelivered; },
    seenReplayKey(key, now) { st.calls.seen.push([key, now]); return st.seen; },
  };
}

interface Sc { intent: PaymentIntent; policy: Policy; st: St; now: number }

function basePolicy(): Policy {
  return {
    networks: [EVM_NET, SVM_NET],
    assets: [
      { network: EVM_NET, asset: EVM_USDC, decimals: 6, usd_per_unit: "1" },
      { network: SVM_NET, asset: SVM_MINT, decimals: 6, usd_per_unit: "1" },
    ],
    cap_usd: "1",
    budget_usd: "10",
    window_s: 3600,
    max_validity_s: 600,
    min_amount_usd: "0.01",
    max_signatures_per_window: 5,
    host_budget_usd: "5",
    known_hosts_only: false,
    payees: {},
    block_after_undelivered: 3,
    undelivered_window_s: 900,
    agents: { alice: { budget_usd: "5" } },
  };
}

function baseIntent(): PaymentIntent {
  return {
    chain: "evm", network: EVM_NET, scheme: "exact", asset: EVM_USDC.toLowerCase(),
    amount: 100000n, payee: EVM_PAYEE, payer: "0xcccccccccccccccccccccccccccccccccccccccc",
    validUntil: NOW + 300, replayKey: "0xreplay1", host: "api.example.com", agent: "alice",
  };
}

function base(): Sc { return { intent: baseIntent(), policy: basePolicy(), st: newState(), now: NOW }; }

function toSvm(sc: Sc): void {
  sc.intent.chain = "svm";
  sc.intent.network = SVM_NET;
  sc.intent.asset = SVM_MINT;
  sc.intent.payee = SVM_PAYEE;
  sc.intent.payer = "PayerSvm33333333333333333333333333333333333";
}

function run(sc: Sc): Decision { return evaluate(sc.intent, sc.policy, makeView(sc.st), sc.now); }

function refused(d: Decision, code: RefusalCode): void {
  assert.equal(d.allow, false, `expected ${code}, got allow`);
  if (d.allow) return;
  assert.equal(d.code, code, `expected ${code}, got ${d.code}: ${d.reason}`);
  assert.equal(typeof d.reason, "string");
  assert.ok(d.reason.length > 0);
}

function allowed(d: Decision): bigint {
  assert.equal(d.allow, true, d.allow ? "" : `unexpected refusal ${d.code}: ${d.reason}`);
  if (!d.allow) throw new Error("unreachable");
  return d.usd6;
}

describe("evaluate: allow path", () => {
  it("allows a baseline payment and returns usd6", () => {
    assert.equal(allowed(run(base())), 100000n);
  });
  it("allows a Solana payment", () => {
    const sc = base();
    toSvm(sc);
    assert.equal(allowed(run(sc)), 100000n);
  });
  it("passes the expected arguments to the state view", () => {
    const sc = base();
    allowed(run(sc));
    assert.deepEqual(sc.st.calls.seen, [["0xreplay1", NOW]]);
    assert.deepEqual(sc.st.calls.count, [NOW - 3600]);
    assert.deepEqual(sc.st.calls.undelivered, [["api.example.com", NOW - 900]]);
    assert.ok(sc.st.calls.spent.length >= 3);
    for (const c of sc.st.calls.spent) assert.equal(c.since, NOW - 3600);
    assert.ok(sc.st.calls.spent.some((c) => c.filter?.agent === "alice"));
    assert.ok(sc.st.calls.spent.some((c) => c.filter?.host === "api.example.com"));
  });
});

describe("evaluate: 1 AGENT", () => {
  it("refuses unknown agent", () => {
    const sc = base();
    sc.intent.agent = "mallory";
    refused(run(sc), "AGENT");
  });
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    it(`refuses inherited name ${name} as agent id`, () => {
      const sc = base();
      sc.intent.agent = name;
      refused(run(sc), "AGENT");
    });
  }
  it("allows an own agent key named __proto__", () => {
    const sc = base();
    sc.policy.agents = JSON.parse('{"__proto__": {"budget_usd": "5"}}');
    sc.intent.agent = "__proto__";
    assert.equal(allowed(run(sc)), 100000n);
  });
  it("allows an own agent key named constructor", () => {
    const sc = base();
    sc.policy.agents = { constructor: { budget_usd: "5" } };
    sc.intent.agent = "constructor";
    assert.equal(allowed(run(sc)), 100000n);
  });
});

describe("evaluate: 2 NETWORK and 3 ASSET", () => {
  it("refuses a network not in policy.networks", () => {
    const sc = base();
    sc.intent.network = "eip155:1";
    refused(run(sc), "NETWORK");
  });
  it("refuses a network in the assets list but not in policy.networks", () => {
    const sc = base();
    sc.policy.networks = [SVM_NET];
    refused(run(sc), "NETWORK");
  });
  it("refuses an unknown asset", () => {
    const sc = base();
    sc.intent.asset = "0x1111111111111111111111111111111111111111";
    refused(run(sc), "ASSET");
  });
  it("matches EVM assets case-insensitively", () => {
    const sc = base();
    sc.intent.asset = EVM_USDC; // mixed case, as in the policy
    allowed(run(sc));
    sc.intent.asset = EVM_USDC.toUpperCase().replace("0X", "0x");
    allowed(run(sc));
  });
  it("matches Solana mints exactly", () => {
    const sc = base();
    toSvm(sc);
    sc.intent.asset = SVM_MINT.toLowerCase();
    refused(run(sc), "ASSET");
  });
  it("refuses an asset that exists only on another network", () => {
    const sc = base();
    sc.policy.networks.push("eip155:8453");
    sc.intent.network = "eip155:8453";
    refused(run(sc), "ASSET");
  });
});

describe("evaluate: 4 AMOUNT", () => {
  it("refuses zero", () => {
    const sc = base();
    sc.intent.amount = 0n;
    refused(run(sc), "AMOUNT");
  });
  it("refuses negative", () => {
    const sc = base();
    sc.intent.amount = -1n;
    refused(run(sc), "AMOUNT");
  });
  it("min 0.01 USD at price 1: exactly 10000 atoms allowed, 9999 refused", () => {
    const sc = base();
    sc.intent.amount = 10000n;
    allowed(run(sc));
    sc.intent.amount = 9999n;
    refused(run(sc), "AMOUNT");
  });
  it("min is converted at the asset price and rounded up (price 3: 3334 ok, 3333 refused)", () => {
    const sc = base();
    sc.policy.assets[0]!.usd_per_unit = "3";
    sc.intent.amount = 3334n;
    allowed(run(sc));
    sc.intent.amount = 3333n;
    refused(run(sc), "AMOUNT");
  });
  it("min with an exactly divisible price is not rounded up (price 2: 5000 ok, 4999 refused)", () => {
    const sc = base();
    sc.policy.assets[0]!.usd_per_unit = "2";
    sc.intent.amount = 5000n;
    allowed(run(sc));
    sc.intent.amount = 4999n;
    refused(run(sc), "AMOUNT");
  });
  it("usd_per_unit of 0 refuses with AMOUNT", () => {
    const sc = base();
    sc.policy.assets[0]!.usd_per_unit = "0";
    refused(run(sc), "AMOUNT");
  });
  it("18-decimal asset: min 0.01 USD = 1e16 atoms", () => {
    const sc = base();
    sc.policy.assets.push({ network: EVM_NET, asset: EVM_DAI18, decimals: 18, usd_per_unit: "1" });
    sc.intent.asset = EVM_DAI18.toLowerCase();
    sc.intent.amount = 10n ** 16n;
    allowed(run(sc));
    sc.intent.amount = 10n ** 16n - 1n;
    refused(run(sc), "AMOUNT");
  });
  it("min_amount_usd of 0 still refuses amount 0", () => {
    const sc = base();
    sc.policy.min_amount_usd = "0";
    sc.intent.amount = 0n;
    refused(run(sc), "AMOUNT");
    sc.intent.amount = 1n;
    allowed(run(sc));
  });
});

describe("evaluate: 5 CAP", () => {
  it("global cap 1 USD: exactly 1000000 allowed, one atom over refused", () => {
    const sc = base();
    sc.intent.amount = 1_000_000n;
    assert.equal(allowed(run(sc)), 1_000_000n);
    sc.intent.amount = 1_000_001n;
    refused(run(sc), "CAP");
  });
  it("agent cap lower than global wins (0.5)", () => {
    const sc = base();
    sc.policy.agents.alice!.cap_usd = "0.5";
    sc.intent.amount = 500_000n;
    allowed(run(sc));
    sc.intent.amount = 500_001n;
    refused(run(sc), "CAP");
  });
  it("agent cap higher than global: global wins", () => {
    const sc = base();
    sc.policy.agents.alice!.cap_usd = "2";
    sc.intent.amount = 1_000_000n;
    allowed(run(sc));
    sc.intent.amount = 1_000_001n;
    refused(run(sc), "CAP");
  });
  it("agent cap equal to global", () => {
    const sc = base();
    sc.policy.agents.alice!.cap_usd = "1";
    sc.intent.amount = 1_000_000n;
    allowed(run(sc));
    sc.intent.amount = 1_000_001n;
    refused(run(sc), "CAP");
  });
  it("cap compares rounded-up usd6 (18 decimals: 1e18 ok, 1e18+1 refused)", () => {
    const sc = base();
    sc.policy.assets.push({ network: EVM_NET, asset: EVM_DAI18, decimals: 18, usd_per_unit: "1" });
    sc.intent.asset = EVM_DAI18.toLowerCase();
    sc.intent.amount = 10n ** 18n;
    assert.equal(allowed(run(sc)), 1_000_000n);
    sc.intent.amount = 10n ** 18n + 1n;
    refused(run(sc), "CAP");
  });
  it("cap applies on usd value, not atoms (price 2: 500000 atoms = 1 USD ok)", () => {
    const sc = base();
    sc.policy.assets[0]!.usd_per_unit = "2";
    sc.intent.amount = 500_000n;
    assert.equal(allowed(run(sc)), 1_000_000n);
    sc.intent.amount = 500_001n;
    refused(run(sc), "CAP");
  });
});

describe("evaluate: 6 VALIDITY", () => {
  it("validUntil == now refused", () => {
    const sc = base();
    sc.intent.validUntil = NOW;
    refused(run(sc), "VALIDITY");
  });
  it("validUntil in the past refused", () => {
    const sc = base();
    sc.intent.validUntil = NOW - 1;
    refused(run(sc), "VALIDITY");
  });
  it("validUntil == now + 1 allowed", () => {
    const sc = base();
    sc.intent.validUntil = NOW + 1;
    allowed(run(sc));
  });
  it("validUntil - now == max_validity_s allowed, one second more refused", () => {
    const sc = base();
    sc.intent.validUntil = NOW + 600;
    allowed(run(sc));
    sc.intent.validUntil = NOW + 601;
    refused(run(sc), "VALIDITY");
  });
});

describe("evaluate: 7 REPLAY", () => {
  it("refuses when the view has seen the key", () => {
    const sc = base();
    sc.st.seen = true;
    refused(run(sc), "REPLAY");
    assert.deepEqual(sc.st.calls.seen, [["0xreplay1", NOW]]);
  });
});

describe("evaluate: 8 HOST", () => {
  it("agent without hosts allows any host", () => {
    const sc = base();
    sc.intent.host = "anything.example:9000";
    allowed(run(sc));
  });
  it("refuses a host outside the agent allowlist, allows one inside", () => {
    const sc = base();
    sc.policy.agents.alice!.hosts = ["api.example.com", "other.example.com:8443"];
    allowed(run(sc));
    sc.intent.host = "other.example.com:8443";
    allowed(run(sc));
    sc.intent.host = "other.example.com";
    refused(run(sc), "HOST");
    sc.intent.host = "evil.example.com";
    refused(run(sc), "HOST");
  });
  for (const name of ["__proto__", "constructor", "toString"]) {
    it(`host ${name} is refused when not in the allowlist`, () => {
      const sc = base();
      sc.policy.agents.alice!.hosts = ["api.example.com"];
      sc.intent.host = name;
      refused(run(sc), "HOST");
    });
    it(`host ${name} is allowed when listed`, () => {
      const sc = base();
      sc.policy.agents.alice!.hosts = [name];
      sc.intent.host = name;
      allowed(run(sc));
    });
  }
});

describe("evaluate: 9 UNDELIVERED", () => {
  it("below the threshold allowed, at the threshold refused", () => {
    const sc = base();
    sc.st.undelivered = 2;
    allowed(run(sc));
    sc.st.undelivered = 3;
    refused(run(sc), "UNDELIVERED");
  });
  it("queries with since = now - undelivered_window_s", () => {
    const sc = base();
    allowed(run(sc));
    assert.deepEqual(sc.st.calls.undelivered, [["api.example.com", NOW - 900]]);
  });
  it("threshold 0 disables the check", () => {
    const sc = base();
    sc.policy.block_after_undelivered = 0;
    sc.st.undelivered = 1_000_000;
    allowed(run(sc));
  });
  it("threshold 1 refuses at a single undelivered request", () => {
    const sc = base();
    sc.policy.block_after_undelivered = 1;
    sc.st.undelivered = 0;
    allowed(run(sc));
    sc.st.undelivered = 1;
    refused(run(sc), "UNDELIVERED");
  });
});

describe("evaluate: 10 PAYEE", () => {
  it("EVM allowlist: not in list refused, in list allowed", () => {
    const sc = base();
    sc.policy.payees = { "api.example.com": { evm: [EVM_OTHER] } };
    refused(run(sc), "PAYEE");
    sc.policy.payees = { "api.example.com": { evm: [EVM_OTHER, EVM_PAYEE] } };
    allowed(run(sc));
  });
  it("EVM comparison is case-insensitive on both sides", () => {
    const sc = base();
    sc.policy.payees = { "api.example.com": { evm: ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] } };
    allowed(run(sc));
    sc.policy.payees = { "api.example.com": { evm: [EVM_PAYEE] } };
    sc.intent.payee = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    allowed(run(sc));
  });
  it("Solana comparison is case-sensitive", () => {
    const sc = base();
    toSvm(sc);
    sc.policy.payees = { "api.example.com": { svm: [SVM_PAYEE] } };
    allowed(run(sc));
    sc.policy.payees = { "api.example.com": { svm: [SVM_PAYEE.toLowerCase()] } };
    refused(run(sc), "PAYEE");
    sc.policy.payees = { "api.example.com": { svm: [SVM_PAYEE.toUpperCase()] } };
    refused(run(sc), "PAYEE");
  });
  it("an empty allowlist is a list: refuses every payee", () => {
    const sc = base();
    sc.policy.payees = { "api.example.com": { evm: [] } };
    refused(run(sc), "PAYEE");
  });
  it("a list for the other chain only does not count as a list", () => {
    const sc = base();
    sc.policy.payees = { "api.example.com": { svm: [SVM_PAYEE] } };
    allowed(run(sc));
    sc.policy.known_hosts_only = true;
    refused(run(sc), "PAYEE");
  });
  it("a list for a different host does not apply", () => {
    const sc = base();
    sc.policy.payees = { "other.example.com": { evm: [EVM_OTHER] } };
    allowed(run(sc));
  });
  it("known_hosts_only without a list refuses", () => {
    const sc = base();
    sc.policy.known_hosts_only = true;
    refused(run(sc), "PAYEE");
  });
  it("known_hosts_only with a matching list allows", () => {
    const sc = base();
    sc.policy.known_hosts_only = true;
    sc.policy.payees = { "api.example.com": { evm: [EVM_PAYEE] } };
    allowed(run(sc));
  });
  it("an existing list takes precedence over the pin", () => {
    const sc = base();
    sc.policy.payees = { "api.example.com": { evm: [EVM_PAYEE] } };
    sc.st.pinned = EVM_OTHER;
    allowed(run(sc));
  });
  it("a list that excludes the payee refuses even if the pin matches", () => {
    const sc = base();
    sc.policy.payees = { "api.example.com": { evm: [EVM_OTHER] } };
    sc.st.pinned = EVM_PAYEE;
    refused(run(sc), "PAYEE");
  });
  it("no pin: allowed", () => {
    const sc = base();
    sc.st.pinned = null;
    allowed(run(sc));
    assert.deepEqual(sc.st.calls.pinned, [["api.example.com", "evm"]]);
  });
  it("pin that differs refuses", () => {
    const sc = base();
    sc.st.pinned = EVM_OTHER;
    refused(run(sc), "PAYEE");
  });
  it("EVM pin compares case-insensitively", () => {
    const sc = base();
    sc.st.pinned = EVM_PAYEE.toUpperCase().replace("0X", "0x");
    allowed(run(sc));
  });
  it("Solana pin compares exactly", () => {
    const sc = base();
    toSvm(sc);
    sc.st.pinned = SVM_PAYEE;
    allowed(run(sc));
    sc.st.pinned = SVM_PAYEE.toLowerCase();
    refused(run(sc), "PAYEE");
    assert.deepEqual(sc.st.calls.pinned.at(-1), ["api.example.com", "svm"]);
  });
  for (const name of ["__proto__", "constructor", "toString"]) {
    it(`host ${name} without own payees entry behaves like an unknown host`, () => {
      const sc = base();
      sc.intent.host = name;
      allowed(run(sc));
      sc.policy.known_hosts_only = true;
      refused(run(sc), "PAYEE");
    });
    it(`host ${name} with an own payees entry uses its list`, () => {
      const sc = base();
      sc.intent.host = name;
      sc.policy.payees = JSON.parse(`{"${name}": {"evm": ["${EVM_OTHER}"]}}`);
      refused(run(sc), "PAYEE");
      sc.policy.payees = JSON.parse(`{"${name}": {"evm": ["${EVM_PAYEE}"]}}`);
      allowed(run(sc));
    });
  }
});

describe("evaluate: 11 COUNT", () => {
  it("count below the limit allowed, at the limit refused", () => {
    const sc = base();
    sc.st.count = 4;
    allowed(run(sc));
    sc.st.count = 5;
    refused(run(sc), "COUNT");
  });
  it("queries with since = now - window_s", () => {
    const sc = base();
    allowed(run(sc));
    assert.deepEqual(sc.st.calls.count, [NOW - 3600]);
  });
});

describe("evaluate: 12 BUDGET", () => {
  it("spent + usd6 exactly equal to the budget is allowed, one atom over refused", () => {
    const sc = base();
    sc.st.spent = 9_900_000n;
    allowed(run(sc));
    sc.st.spent = 9_900_001n;
    refused(run(sc), "BUDGET");
  });
  it("queries the global spend without a filter, since now - window_s", () => {
    const sc = base();
    allowed(run(sc));
    assert.ok(sc.st.calls.spent.some((c) => c.filter === undefined && c.since === NOW - 3600));
  });
});

describe("evaluate: 13 AGENT_BUDGET", () => {
  it("exact boundary", () => {
    const sc = base();
    sc.st.agentSpent = 4_900_000n;
    allowed(run(sc));
    sc.st.agentSpent = 4_900_001n;
    refused(run(sc), "AGENT_BUDGET");
  });
});

describe("evaluate: 14 HOST_BUDGET", () => {
  it("exact boundary", () => {
    const sc = base();
    sc.st.hostSpent = 4_900_000n;
    allowed(run(sc));
    sc.st.hostSpent = 4_900_001n;
    refused(run(sc), "HOST_BUDGET");
  });
  it("host_budget_usd unset: the host spend is irrelevant", () => {
    const sc = base();
    delete sc.policy.host_budget_usd;
    sc.st.hostSpent = 10n ** 15n;
    allowed(run(sc));
  });
});

describe("evaluate: check order", () => {
  type Breaker = [RefusalCode, (sc: Sc) => void];
  // Each breaker violates exactly one rule from the baseline and is independent of the others.
  const breakers: Breaker[] = [
    ["AGENT", (sc) => { sc.intent.agent = "mallory"; }],
    ["NETWORK", (sc) => { sc.intent.network = "eip155:1"; }],
    ["ASSET", (sc) => { sc.intent.asset = "0x1111111111111111111111111111111111111111"; }],
    ["AMOUNT", (sc) => { sc.policy.min_amount_usd = "0.5"; }],
    ["CAP", (sc) => { sc.policy.cap_usd = "0.05"; }],
    ["VALIDITY", (sc) => { sc.intent.validUntil = NOW - 1; }],
    ["REPLAY", (sc) => { sc.st.seen = true; }],
    ["HOST", (sc) => { sc.policy.agents.alice!.hosts = ["elsewhere.example"]; }],
    ["UNDELIVERED", (sc) => { sc.st.undelivered = 3; }],
    ["PAYEE", (sc) => { sc.policy.payees = { "api.example.com": { evm: [EVM_OTHER] } }; }],
    ["COUNT", (sc) => { sc.st.count = 5; }],
    ["BUDGET", (sc) => { sc.st.spent = 10_000_000n; }],
    ["AGENT_BUDGET", (sc) => { sc.st.agentSpent = 5_000_000n; }],
    ["HOST_BUDGET", (sc) => { sc.st.hostSpent = 5_000_000n; }],
  ];
  for (const [code, brk] of breakers) {
    it(`breaker for ${code} alone yields ${code}`, () => {
      const sc = base();
      brk(sc);
      refused(run(sc), code);
    });
  }
  for (let i = 0; i < breakers.length; i++) {
    for (let j = i + 1; j < breakers.length; j++) {
      const [ci, bi] = breakers[i]!;
      const [cj, bj] = breakers[j]!;
      it(`${ci} comes before ${cj}`, () => {
        const sc = base();
        bj(sc);
        bi(sc);
        refused(run(sc), ci);
      });
    }
  }
  it("all rules broken at once returns AGENT", () => {
    const sc = base();
    for (const [, b] of breakers) b(sc);
    refused(run(sc), "AGENT");
  });
});

describe("evaluate: 18-decimal rounding never exceeds the budget", () => {
  it("1-atom payments accumulate by rounded-up usd6 and stop at the budget", () => {
    const sc = base();
    sc.policy.assets.push({ network: EVM_NET, asset: EVM_DAI18, decimals: 18, usd_per_unit: "1" });
    sc.intent.asset = EVM_DAI18.toLowerCase();
    sc.intent.amount = 1n;
    sc.policy.min_amount_usd = "0";
    sc.policy.budget_usd = "0.00001"; // 10 usd6
    sc.policy.max_signatures_per_window = 1000;
    delete sc.policy.host_budget_usd;
    let total = 0n;
    let allows = 0;
    for (let i = 0; i < 25; i++) {
      sc.st.spent = total;
      sc.st.agentSpent = total;
      const d = run(sc);
      if (d.allow) {
        assert.equal(d.usd6, 1n);
        total += d.usd6;
        allows++;
      } else {
        assert.equal(d.code, "BUDGET");
      }
      assert.ok(total <= 10n, "recorded spend exceeded the budget");
    }
    assert.equal(allows, 10);
    assert.equal(total, 10n);
  });
  it("sub-usd6 payments are never recorded as free", () => {
    const sc = base();
    sc.policy.assets.push({ network: EVM_NET, asset: EVM_DAI18, decimals: 18, usd_per_unit: "1" });
    sc.intent.asset = EVM_DAI18.toLowerCase();
    sc.policy.min_amount_usd = "0";
    sc.intent.amount = 999_999_999_999n; // just below 1e-6 USD
    assert.equal(allowed(run(sc)), 1n);
    sc.intent.amount = 10n ** 12n;
    assert.equal(allowed(run(sc)), 1n);
    sc.intent.amount = 10n ** 12n + 1n;
    assert.equal(allowed(run(sc)), 2n);
  });
});

describe("evaluate: refusal reasons do not leak other policy amounts", () => {
  const G = { cap: ["3.141592", "3141592"], agentCap: ["2.718281", "2718281"], budget: ["123.456", "123456000"],
    agentBudget: ["45.678", "45678000"], hostBudget: ["67.891", "67891000"], min: ["0.000321"], sigs: ["987"] };
  type Key = keyof typeof G;
  function distinct(): Sc {
    const sc = base();
    sc.policy.cap_usd = "3.141592";
    sc.policy.budget_usd = "123.456";
    sc.policy.host_budget_usd = "67.891";
    sc.policy.min_amount_usd = "0.000321";
    sc.policy.max_signatures_per_window = 987;
    sc.policy.agents.alice = { budget_usd: "45.678", cap_usd: "2.718281" };
    return sc;
  }
  const cases: [string, RefusalCode, Key, (sc: Sc) => void][] = [
    ["CAP", "CAP", "agentCap", (sc) => { sc.intent.amount = 2_718_282n; }],
    ["AMOUNT", "AMOUNT", "min", (sc) => { sc.intent.amount = 320n; }],
    ["COUNT", "COUNT", "sigs", (sc) => { sc.st.count = 987; }],
    ["BUDGET", "BUDGET", "budget", (sc) => { sc.st.spent = 123_356_001n; }],
    ["AGENT_BUDGET", "AGENT_BUDGET", "agentBudget", (sc) => { sc.st.agentSpent = 45_578_001n; }],
    ["HOST_BUDGET", "HOST_BUDGET", "hostBudget", (sc) => { sc.st.hostSpent = 67_791_001n; }],
  ];
  for (const [name, code, own, setup] of cases) {
    it(`${name} reason mentions no other policy amount`, () => {
      const sc = distinct();
      setup(sc);
      const d = run(sc);
      refused(d, code);
      if (d.allow) return;
      for (const key of Object.keys(G) as Key[]) {
        if (key === own) continue;
        for (const s of G[key]) {
          assert.ok(!d.reason.includes(s), `reason leaks ${key} value ${s}: ${d.reason}`);
        }
      }
    });
  }
});

describe("hostOf", () => {
  const ok: [string, string][] = [
    ["https://example.com/path?q=1#h", "example.com"],
    ["http://example.com", "example.com"],
    ["https://EXAMPLE.Com/", "example.com"],
    ["HTTPS://example.com/", "example.com"],
    ["HTTP://Example.COM:8080/x", "example.com:8080"],
    ["https://api.example.com.:8443/x", "api.example.com:8443"],
    ["https://example.com./", "example.com"],
    ["https://example.com:8443/", "example.com:8443"],
    ["https://example.com:443/", "example.com"],
    ["http://example.com:80/", "example.com"],
    ["http://example.com:443/", "example.com:443"],
    ["https://example.com:80/", "example.com:80"],
    ["https://[::1]/", "[::1]"],
    ["https://[::1]:8443/x", "[::1]:8443"],
    ["http://[2001:DB8::1]/", "[2001:db8::1]"],
    ["http://127.0.0.1:3000/a", "127.0.0.1:3000"],
  ];
  for (const [input, want] of ok) {
    it(`${input} -> ${want}`, () => assert.equal(hostOf(input), want));
  }
  const bad: [string, string][] = [
    ["javascript:alert(1)", "javascript scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["ftp://example.com/", "ftp scheme"],
    ["data:text/plain,hi", "data scheme"],
    ["ws://example.com/", "ws scheme"],
    ["https://user@example.com/", "username"],
    ["https://user:pw@example.com/", "username and password"],
    ["https://:pw@example.com/", "password only"],
    ["", "empty string"],
    ["not a url", "garbage"],
    ["//example.com/path", "scheme-relative"],
    ["example.com", "no scheme"],
    ["https://", "no host"],
  ];
  for (const [input, why] of bad) {
    it(`null for ${why}: ${JSON.stringify(input)}`, () => assert.equal(hostOf(input), null));
  }
});

describe("toAtoms", () => {
  const good: [string, number, bigint][] = [
    ["0.10", 6, 100000n],
    ["1", 6, 1000000n],
    ["0", 6, 0n],
    ["0.000001", 6, 1n],
    ["1.5", 1, 15n],
    ["12", 0, 12n],
    ["00.1", 6, 100000n],
    ["1.000000", 6, 1000000n],
    ["0.000000000000000001", 18, 1n],
    ["123456789012345678901234567890.123456789012345678", 18, 123456789012345678901234567890123456789012345678n],
  ];
  for (const [s, d, want] of good) {
    it(`${s} @${d} -> ${want}`, () => assert.equal(toAtoms(s, d), want));
  }
  const bad: [string, number][] = [
    ["0.1234567", 6], ["1.5", 0], ["1.0", 0], ["", 6], ["-1", 6], ["+1", 6], ["1e3", 6], [".5", 6], ["1.", 6],
    [" 1", 6], ["1 ", 6], ["1,5", 6], ["0x10", 6], ["abc", 6], ["1.2.3", 6], ["１", 6], ["Infinity", 6], ["NaN", 6],
  ];
  for (const [s, d] of bad) {
    it(`throws on ${JSON.stringify(s)} @${d}`, () => assert.throws(() => toAtoms(s, d)));
  }
});

describe("usd6Of", () => {
  const rule = (decimals: number, price: string): AssetRule => ({ network: EVM_NET, asset: EVM_USDC, decimals, usd_per_unit: price });
  const intent = (amount: bigint): PaymentIntent => ({ ...baseIntent(), amount });
  it("price 1, 6 decimals is the identity", () => assert.equal(usd6Of(intent(123456n), rule(6, "1")), 123456n));
  it("rounds up with price 0.5", () => {
    assert.equal(usd6Of(intent(3n), rule(6, "0.5")), 2n);
    assert.equal(usd6Of(intent(4n), rule(6, "0.5")), 2n);
    assert.equal(usd6Of(intent(1n), rule(6, "0.5")), 1n);
  });
  it("rounds up for 18 decimals", () => {
    assert.equal(usd6Of(intent(1n), rule(18, "1")), 1n);
    assert.equal(usd6Of(intent(10n ** 12n), rule(18, "1")), 1n);
    assert.equal(usd6Of(intent(10n ** 12n + 1n), rule(18, "1")), 2n);
    assert.equal(usd6Of(intent(10n ** 18n), rule(18, "1")), 1_000_000n);
  });
  it("uses the price for non-1 values", () => {
    assert.equal(usd6Of(intent(1_000_000n), rule(6, "1.5")), 1_500_000n);
    assert.equal(usd6Of(intent(1n), rule(6, "0.999999")), 1n);
  });
  it("zero amount is zero", () => assert.equal(usd6Of(intent(0n), rule(6, "1")), 0n));
  it("is exact for huge values (no floating point)", () => {
    const big = 10n ** 30n + 7n;
    assert.equal(usd6Of(intent(big), rule(18, "1")), 10n ** 18n + 1n);
  });
});

describe("findAsset", () => {
  const assets: AssetRule[] = [
    { network: EVM_NET, asset: EVM_USDC, decimals: 6, usd_per_unit: "1" },
    { network: SVM_NET, asset: SVM_MINT, decimals: 6, usd_per_unit: "1" },
  ];
  it("EVM match is case-insensitive in both directions", () => {
    assert.equal(findAsset(assets, EVM_NET, EVM_USDC.toLowerCase()), assets[0]);
    assert.equal(findAsset(assets, EVM_NET, EVM_USDC), assets[0]);
    assert.equal(findAsset(assets, EVM_NET, "0xABCDEF0000000000000000000000000000000001"), assets[0]);
  });
  it("Solana match is exact", () => {
    assert.equal(findAsset(assets, SVM_NET, SVM_MINT), assets[1]);
    assert.equal(findAsset(assets, SVM_NET, SVM_MINT.toLowerCase()), null);
  });
  it("network must match exactly", () => {
    assert.equal(findAsset(assets, "eip155:1", EVM_USDC), null);
    assert.equal(findAsset(assets, EVM_NET, SVM_MINT), null);
    assert.equal(findAsset(assets, SVM_NET, EVM_USDC), null);
  });
  it("returns null for an unknown asset or empty list", () => {
    assert.equal(findAsset(assets, EVM_NET, "0x2222222222222222222222222222222222222222"), null);
    assert.equal(findAsset([], EVM_NET, EVM_USDC), null);
  });
});
