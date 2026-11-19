// Practice facilitator: the chain-free checks (recipient, amount, window, signature, single use). No network.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkPayment, createPracticeFacilitator, PRACTICE_NETWORK } from "../bench/practice-facilitator.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000;
const account = privateKeyToAccount(generatePrivateKey());
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] } as const;

const requirements = (over: Record<string, unknown> = {}) =>
  ({ scheme: "exact", network: PRACTICE_NETWORK, asset: USDC, amount: "10000", payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...over });

async function payment(over: { to?: string; value?: string; validAfter?: string; validBefore?: string; nonce?: string } = {}) {
  const a = {
    from: account.address, to: over.to ?? PAYEE, value: over.value ?? "10000",
    validAfter: over.validAfter ?? String(NOW - 60), validBefore: over.validBefore ?? String(NOW + 60),
    nonce: over.nonce ?? ("0x" + "ab".repeat(32)),
  };
  const signature = await account.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC }, types: TYPES, primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` },
  });
  return { x402Version: 2, accepted: requirements(), payload: { signature, authorization: a } };
}
const reason = async (p: unknown, r: unknown) => { const c = await checkPayment(p, r, NOW); return c.ok ? "ok" : c.reason; };

describe("practice facilitator: checkPayment", () => {
  it("accepts a correctly signed authorization for the asked recipient and amount", async () => {
    const c = await checkPayment(await payment(), requirements(), NOW);
    assert.equal(c.ok, true);
    if (c.ok) assert.equal(c.payer, account.address);
  });
  it("rejects another recipient, another amount, and a window that is not open", async () => {
    assert.equal(await reason(await payment({ to: "0x3333333333333333333333333333333333333333" }), requirements()), "practice_recipient_mismatch");
    assert.equal(await reason(await payment({ value: "9999" }), requirements()), "practice_amount_mismatch");
    assert.equal(await reason(await payment({ value: "10001" }), requirements()), "practice_amount_mismatch");
    assert.equal(await reason(await payment({ validBefore: String(NOW) }), requirements()), "practice_expired");
    assert.equal(await reason(await payment({ validAfter: String(NOW + 1) }), requirements()), "practice_not_yet_valid");
  });
  it("rejects a signature that does not cover what is claimed", async () => {
    const p = await payment();
    const forged = structuredClone(p); forged.payload.authorization.nonce = "0x" + "cd".repeat(32);
    assert.equal(await reason(forged, requirements()), "practice_bad_signature");
    const other = structuredClone(p); other.payload.authorization.from = "0x4444444444444444444444444444444444444444";
    assert.equal(await reason(other, requirements()), "practice_bad_signature");
    // signed for USDC, presented against another token contract
    assert.equal(await reason(p, requirements({ asset: "0x5555555555555555555555555555555555555555" })), "practice_bad_signature");
  });
  it("rejects other networks, versions and malformed input without throwing", async () => {
    const p = await payment();
    assert.equal(await reason(p, requirements({ network: "eip155:8453" })), "practice_unsupported_scheme_or_network");
    assert.equal(await reason({ ...p, x402Version: 1 }, requirements()), "practice_unsupported_version");
    assert.equal(await reason({ ...p, accepted: requirements({ network: "eip155:8453" }) }, requirements()), "practice_accepted_mismatch");
    for (const bad of [null, 1, "x", [], {}, { x402Version: 2, accepted: requirements(), payload: {} }, { x402Version: 2, accepted: requirements(), payload: { signature: "0x12", authorization: {} } }]) {
      assert.notEqual(await reason(bad, requirements()), "ok");
    }
    assert.equal(await reason(p, null), "practice_bad_request");
  });
});

describe("practice facilitator: HTTP", () => {
  let server: http.Server, base = "";
  before(async () => {
    server = createPracticeFacilitator(() => NOW);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const post = async (p: string, body: unknown) => {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };

  it("lists one kind: x402 v2 exact on Base Sepolia", async () => {
    const j = await (await fetch(base + "/supported")).json() as any;
    assert.deepEqual(j.kinds, [{ x402Version: 2, scheme: "exact", network: PRACTICE_NETWORK }]);
  });
  it("verifies, settles once with no transaction, and refuses the same authorization again", async () => {
    const body = { paymentPayload: await payment({ nonce: "0x" + "01".repeat(32) }), paymentRequirements: requirements() };
    assert.deepEqual((await post("/verify", body)).json, { isValid: true, payer: account.address });
    const s = await post("/settle", body);
    assert.deepEqual(s.json, { success: true, transaction: "", network: PRACTICE_NETWORK, payer: account.address });
    assert.equal((await post("/verify", body)).json.invalidReason, "practice_nonce_used");
    const again = await post("/settle", body);
    assert.equal(again.json.success, false);
    assert.equal(again.json.errorReason, "practice_nonce_used");
  });
  it("answers a bad payment and a bad body with a reason, never a success", async () => {
    const bad = { paymentPayload: await payment({ value: "1" }), paymentRequirements: requirements() };
    assert.deepEqual([(await post("/verify", bad)).json.isValid, (await post("/settle", bad)).json.success], [false, false]);
    assert.equal((await post("/settle", "not json")).json.success, false);
    assert.equal((await post("/verify", "[]")).json.isValid, false);
    assert.equal((await fetch(base + "/nope")).status, 404);
  });
});
