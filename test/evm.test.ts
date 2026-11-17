// Blind tests for M2 (EVM reader), written strictly from contracts/M2-evm-reader.md,
// src/types.ts and the 2026-11-18 M2 row of DECISIONS.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readEvm, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/evm.ts";
import type { AssetRule, ReaderContext, ReadResult, RefusalCode } from "../src/types.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const NONCE = "0x" + "ab".repeat(32);
const NOW = 1_800_000_000;
const MAXT = 300;

const usdcRule: AssetRule = {
  network: "eip155:84532", asset: USDC, decimals: 6, usd_per_unit: "1",
  evm_domain: { name: "USDC", version: "2" },
};
const otherChainRule: AssetRule = {
  network: "eip155:8453", asset: USDC, decimals: 6, usd_per_unit: "1",
  evm_domain: { name: "USDC", version: "2" },
};
const otherAssetAddr = "0x4444444444444444444444444444444444444444";
const otherAssetRule: AssetRule = {
  network: "eip155:84532", asset: otherAssetAddr, decimals: 6, usd_per_unit: "1",
  evm_domain: { name: "USDC", version: "2" },
};

function ctx(over: Partial<ReaderContext> = {}): ReaderContext {
  return {
    payer: PAYER, host: "api.example.com", agent: "agent-1", now: NOW,
    expected: { network: "eip155:84532", asset: USDC, amount: 10_000n, payTo: PAYEE, maxTimeoutSeconds: MAXT },
    assets: [usdcRule, otherChainRule, otherAssetRule],
    ...over,
  };
}

type Obj = Record<string, any>;
function td(over: { domain?: Obj; message?: Obj; [k: string]: any } = {}): Obj {
  const { domain, message, ...rest } = over;
  return {
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC, ...domain },
    types: {},
    primaryType: "TransferWithAuthorization",
    message: {
      from: PAYER, to: PAYEE, value: 10_000n, validAfter: 0, validBefore: NOW + 200, nonce: NONCE,
      ...message,
    },
    ...rest,
  };
}

function refused(r: ReadResult, code: RefusalCode): void {
  assert.equal(r.ok, false, "expected refusal " + code);
  if (!r.ok) {
    assert.equal(r.code, code, "reason: " + r.reason);
    assert.equal(typeof r.reason, "string");
  }
}

describe("valid authorization", () => {
  it("accepts Base Sepolia USDC and emits the exact intent", () => {
    const r = readEvm(td(), ctx());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.intent, {
        chain: "evm", network: "eip155:84532", scheme: "exact", asset: USDC.toLowerCase(),
        amount: 10_000n, payee: PAYEE, payer: PAYER, validUntil: NOW + 200,
        replayKey: NONCE, host: "api.example.com", agent: "agent-1",
      });
    }
  });

  it("lowercases asset, payee, payer and replayKey for mixed-case input", () => {
    const payer = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const payee = "0xFEDCBA9876543210fedcba9876543210FEDCBA98";
    const nonce = "0x" + "AB".repeat(16) + "cd".repeat(16);
    const r = readEvm(
      td({ message: { from: payer, to: payee, nonce } }),
      ctx({ payer: payer.toLowerCase(), expected: { network: "eip155:84532", asset: USDC.toUpperCase().replace("0X", "0x"), amount: 10_000n, payTo: payee.toLowerCase(), maxTimeoutSeconds: MAXT } }),
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.intent.asset, USDC.toLowerCase());
      assert.equal(r.intent.payee, payee.toLowerCase());
      assert.equal(r.intent.payer, payer.toLowerCase());
      assert.equal(r.intent.replayKey, nonce.toLowerCase());
    }
  });

  it("accepts a mixed-case ctx.payer against a lowercase from", () => {
    const r = readEvm(td(), ctx({ payer: "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x") }));
    assert.equal(r.ok, true);
  });

  it("accepts value as bigint, number and decimal string with the same intent", () => {
    for (const v of [10_000n, 10_000, "10000"]) {
      const r = readEvm(td({ message: { value: v } }), ctx());
      assert.equal(r.ok, true, String(v));
      if (r.ok) assert.equal(r.intent.amount, 10_000n);
    }
  });

  it("accepts validAfter / validBefore as bigint, number and string", () => {
    const r = readEvm(td({ message: { validAfter: "0", validBefore: BigInt(NOW + 100) } }), ctx());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.intent.validUntil, NOW + 100);
    const r2 = readEvm(td({ message: { validAfter: 5n, validBefore: String(NOW + 100) } }), ctx());
    assert.equal(r2.ok, true);
  });

  it("accepts chainId as bigint and decimal string", () => {
    assert.equal(readEvm(td({ domain: { chainId: 84532n } }), ctx()).ok, true);
    assert.equal(readEvm(td({ domain: { chainId: "84532" } }), ctx()).ok, true);
  });

  it("ignores hostile caller-supplied types that rename fields", () => {
    const hostile = {
      TransferWithAuthorization: [
        { name: "to", type: "address" }, { name: "from", type: "address" },
        { name: "value", type: "uint8" }, { name: "x", type: "bytes" },
      ],
    };
    const r = readEvm(td({ types: hostile }), ctx());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.intent.payee, PAYEE);
      assert.equal(r.intent.payer, PAYER);
      assert.equal(r.intent.amount, 10_000n);
    }
  });

  it("ignores extra unknown message fields", () => {
    const r = readEvm(td({ message: { extra: "0xdead", spender: OTHER, deadline: 1 } }), ctx());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.intent.payee, PAYEE);
  });
});

describe("TRANSFER_WITH_AUTHORIZATION_TYPES", () => {
  it("matches EIP-3009", () => {
    assert.deepEqual(TRANSFER_WITH_AUTHORIZATION_TYPES, {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    });
  });
});

describe("FORMAT", () => {
  const bad: [string, Obj][] = [
    ["chainId zero", { domain: { chainId: 0 } }],
    ["chainId negative", { domain: { chainId: -1 } }],
    ["chainId fractional", { domain: { chainId: 1.5 } }],
    ["chainId unsafe", { domain: { chainId: 2 ** 60 } }],
    ["chainId non-numeric string", { domain: { chainId: "abc" } }],
    ["chainId missing", { domain: { chainId: undefined } }],
    ["verifyingContract short", { domain: { verifyingContract: "0x1234" } }],
    ["verifyingContract no prefix", { domain: { verifyingContract: USDC.slice(2) } }],
    ["verifyingContract non-hex", { domain: { verifyingContract: "0x" + "g".repeat(40) } }],
    ["verifyingContract number", { domain: { verifyingContract: 5 } }],
    ["from short", { message: { from: "0xabc" } }],
    ["from non-hex", { message: { from: "0x" + "z".repeat(40) } }],
    ["from missing", { message: { from: undefined } }],
    ["to short", { message: { to: "0xabc" } }],
    ["to missing", { message: { to: undefined } }],
    ["value negative number", { message: { value: -1 } }],
    ["value negative bigint", { message: { value: -1n } }],
    ["value fractional", { message: { value: 1.5 } }],
    ["value unsafe number", { message: { value: 2 ** 60 } }],
    ["value leading zero string", { message: { value: "010" } }],
    ["value hex string", { message: { value: "0x10" } }],
    ["value decimal string with dot", { message: { value: "1.0" } }],
    ["value empty string", { message: { value: "" } }],
    ["value negative string", { message: { value: "-5" } }],
    ["value 2^256", { message: { value: 2n ** 256n } }],
    ["value 2^256 string", { message: { value: (2n ** 256n).toString() } }],
    ["value missing", { message: { value: undefined } }],
    ["value zero bigint", { message: { value: 0n } }],
    ["value zero number", { message: { value: 0 } }],
    ["value zero string", { message: { value: "0" } }],
    ["validAfter negative", { message: { validAfter: -1 } }],
    ["validAfter leading zero", { message: { validAfter: "01" } }],
    ["validAfter 2^256", { message: { validAfter: 2n ** 256n } }],
    ["validAfter missing", { message: { validAfter: undefined } }],
    ["validBefore negative", { message: { validBefore: -1n } }],
    ["validBefore fractional", { message: { validBefore: NOW + 0.5 } }],
    ["validBefore missing", { message: { validBefore: undefined } }],
    ["validBefore above MAX_SAFE_INTEGER", { message: { validBefore: BigInt(Number.MAX_SAFE_INTEGER) + 1n } }],
    ["validBefore above MAX_SAFE_INTEGER string", { message: { validBefore: "9007199254740992" } }],
    ["nonce short", { message: { nonce: "0x" + "ab".repeat(31) } }],
    ["nonce long", { message: { nonce: "0x" + "ab".repeat(33) } }],
    ["nonce no prefix", { message: { nonce: "ab".repeat(32) } }],
    ["nonce non-hex", { message: { nonce: "0x" + "zz".repeat(32) } }],
    ["nonce missing", { message: { nonce: undefined } }],
    ["from equals to", { message: { to: PAYER } }],
  ];
  for (const [name, over] of bad) {
    it(name, () => refused(readEvm(td(over), ctx()), "FORMAT"));
  }

  it("from equals to ignoring case", () => {
    refused(readEvm(td({ message: { to: PAYER.toUpperCase().replace("0X", "0x") } }), ctx()), "FORMAT");
  });

  for (const [name, v] of [["null", null], ["string", "x"], ["number", 5], ["undefined", undefined], ["array", []]] as [string, unknown][]) {
    it("typedData is " + name, () => refused(readEvm(v, ctx()), "FORMAT"));
  }

  it("domain missing", () => {
    const t = td(); delete t.domain;
    refused(readEvm(t, ctx()), "FORMAT");
  });

  it("message missing", () => {
    const t = td(); delete t.message;
    refused(readEvm(t, ctx()), "FORMAT");
  });

  it("FORMAT for a message problem wins over ASSET problem", () => {
    refused(readEvm(td({ domain: { name: "Wrong" }, message: { value: 0n } }), ctx()), "FORMAT");
    refused(readEvm(td({ domain: { name: "Wrong" }, message: { to: PAYER } }), ctx()), "FORMAT");
  });
});

describe("TYPE and check order", () => {
  it("rejects Permit", () => {
    const t = td({ primaryType: "Permit" });
    t.message = { owner: PAYER, spender: PAYEE, value: 10_000n, nonce: 0n, deadline: NOW + 100 };
    refused(readEvm(t, ctx()), "TYPE");
  });

  it("rejects Permit2 PermitWitnessTransferFrom", () => {
    const t = td({ primaryType: "PermitWitnessTransferFrom", domain: { name: "Permit2", version: undefined } });
    t.message = {
      permitted: { token: USDC, amount: "10000" }, spender: PAYEE, nonce: "1", deadline: String(NOW + 100),
      witness: { to: PAYEE, validAfter: "0" },
    };
    refused(readEvm(t, ctx()), "TYPE");
  });

  it("rejects an unknown primaryType and a missing one", () => {
    refused(readEvm(td({ primaryType: "ReceiveWithAuthorization" }), ctx()), "TYPE");
    refused(readEvm(td({ primaryType: "BatchSettlement" }), ctx()), "TYPE");
    const t = td(); delete t.primaryType;
    refused(readEvm(t, ctx()), "TYPE");
  });

  it("domain FORMAT runs before TYPE", () => {
    refused(readEvm(td({ primaryType: "Permit", domain: { chainId: 0 } }), ctx()), "FORMAT");
    refused(readEvm(td({ primaryType: "Permit", domain: { verifyingContract: "0x12" } }), ctx()), "FORMAT");
  });

  it("TYPE runs before message FORMAT", () => {
    const t = td({ primaryType: "Permit" });
    t.message = { owner: PAYER };
    refused(readEvm(t, ctx()), "TYPE");
  });
});

describe("ASSET", () => {
  it("wrong domain name", () => refused(readEvm(td({ domain: { name: "usdc" } }), ctx()), "ASSET"));
  it("wrong domain version", () => refused(readEvm(td({ domain: { version: "1" } }), ctx()), "ASSET"));
  // DECISIONS 2026-11-18 (#14): name and version must be strings, checked as FORMAT after TYPE.
  it("domain name missing", () => refused(readEvm(td({ domain: { name: undefined } }), ctx()), "FORMAT"));
  it("contract not in ctx.assets", () => {
    refused(readEvm(td({ domain: { verifyingContract: "0x5555555555555555555555555555555555555555" } }), ctx()), "ASSET");
  });
  it("chainId not in ctx.assets for that contract", () => {
    refused(readEvm(td({ domain: { chainId: 1 } }), ctx()), "ASSET");
  });
  it("empty ctx.assets", () => refused(readEvm(td(), ctx({ assets: [] })), "ASSET"));
  it("asset lookup is case-insensitive on the contract address", () => {
    const r = readEvm(td({ domain: { verifyingContract: USDC.toLowerCase() } }), ctx());
    assert.equal(r.ok, true);
  });
  it("ASSET runs before SENDER and MISMATCH", () => {
    refused(readEvm(td({ domain: { name: "X" }, message: { from: OTHER, to: OTHER.replace(/3/g, "6"), value: 1n } }), ctx()), "ASSET");
  });
});

describe("SENDER", () => {
  it("from differs from ctx.payer", () => {
    refused(readEvm(td({ message: { from: OTHER } }), ctx()), "SENDER");
  });
  it("SENDER runs before MISMATCH", () => {
    refused(readEvm(td({ message: { from: OTHER, value: 1n } }), ctx()), "SENDER");
  });
});

describe("MISMATCH", () => {
  it("network differs from expected", () => {
    const r = readEvm(td({ domain: { chainId: 8453 } }), ctx());
    refused(r, "MISMATCH");
  });
  it("asset differs from expected", () => {
    const r = readEvm(
      td({ domain: { verifyingContract: otherAssetAddr } }),
      ctx(),
    );
    refused(r, "MISMATCH");
  });
  it("value differs from expected (higher and lower)", () => {
    refused(readEvm(td({ message: { value: 10_001n } }), ctx()), "MISMATCH");
    refused(readEvm(td({ message: { value: 9_999n } }), ctx()), "MISMATCH");
  });
  it("payee differs from expected payTo", () => {
    refused(readEvm(td({ message: { to: OTHER } }), ctx()), "MISMATCH");
  });
  it("payTo comparison ignores case", () => {
    const r = readEvm(td(), ctx({ expected: { network: "eip155:84532", asset: USDC, amount: 10_000n, payTo: PAYEE.toUpperCase().replace("0X", "0x"), maxTimeoutSeconds: MAXT } }));
    assert.equal(r.ok, true);
  });
  it("10-year validBefore", () => {
    refused(readEvm(td({ message: { validBefore: NOW + 10 * 365 * 86400 } }), ctx()), "MISMATCH");
  });
  it("validBefore exactly now + maxTimeoutSeconds + 60 passes", () => {
    const r = readEvm(td({ message: { validBefore: NOW + MAXT + 60 } }), ctx());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.intent.validUntil, NOW + MAXT + 60);
  });
  it("validBefore one second past now + maxTimeoutSeconds + 60 is MISMATCH", () => {
    refused(readEvm(td({ message: { validBefore: NOW + MAXT + 61 } }), ctx()), "MISMATCH");
  });
  it("validBefore in the past is not a MISMATCH on its own", () => {
    const r = readEvm(td({ message: { validBefore: NOW - 10 } }), ctx());
    if (!r.ok) assert.notEqual(r.code, "MISMATCH");
  });
  it("MISMATCH runs before EARLY", () => {
    refused(readEvm(td({ message: { value: 1n, validAfter: NOW + 1000 } }), ctx()), "MISMATCH");
  });
});

describe("EARLY", () => {
  it("validAfter = now + 60 is accepted", () => {
    assert.equal(readEvm(td({ message: { validAfter: NOW + 60 } }), ctx()).ok, true);
  });
  it("validAfter = now + 61 is refused", () => {
    refused(readEvm(td({ message: { validAfter: NOW + 61 } }), ctx()), "EARLY");
  });
  it("validAfter far in the future is refused", () => {
    refused(readEvm(td({ message: { validAfter: BigInt(NOW) * 2n } }), ctx()), "EARLY");
  });
  it("validAfter in the past is accepted", () => {
    assert.equal(readEvm(td({ message: { validAfter: NOW - 1000 } }), ctx()).ok, true);
  });
});

// Regression tests for #14 and #15 (attack review). Written after the fix, with the code in view.
describe("M2 signable (#14, #15)", () => {
  it("signable carries the validated values, lowercase, chainId as bigint, frozen", () => {
    const r = readEvm(td({ domain: { chainId: "84532" } }), ctx());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.signable, {
      domain: { name: "USDC", version: "2", chainId: 84532n, verifyingContract: USDC.toLowerCase() },
      primaryType: "TransferWithAuthorization",
      message: { from: PAYER, to: PAYEE, value: 10_000n, validAfter: 0n, validBefore: BigInt(NOW + 200), nonce: NONCE },
    });
    assert.ok(Object.isFrozen(r.signable) && Object.isFrozen(r.signable.domain) && Object.isFrozen(r.signable.message));
  });

  it("a getter that changes between reads cannot change what is signed", () => {
    let reads = 0;
    const t = td();
    const msg = t.message;
    Object.defineProperty(msg, "to", { enumerable: true, get: () => (reads++ === 0 ? PAYEE : OTHER) });
    const r = readEvm(t, ctx());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.signable.message.to, PAYEE);
    assert.equal(r.intent.payee, PAYEE);
    assert.equal(reads, 1);
  });

  it("a Proxy message is refused as FORMAT", () => {
    const t = td();
    t.message = new Proxy(t.message, {});
    refused(readEvm(t, ctx()), "FORMAT");
  });

  it("inherited message fields are not read", () => {
    const t = td();
    t.message = Object.create(t.message);
    refused(readEvm(t, ctx()), "FORMAT");
  });

  it("unknown domain keys such as salt are FORMAT", () => {
    refused(readEvm(td({ domain: { salt: "0x" + "11".repeat(32) } }), ctx()), "FORMAT");
  });

  it("domain version missing is FORMAT", () => {
    refused(readEvm(td({ domain: { version: undefined } }), ctx()), "FORMAT");
  });
});
