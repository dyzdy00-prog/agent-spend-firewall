import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverTypedDataAddress } from "viem";
import { createKeyPairFromBytes, verifySignature, getAddressFromPublicKey } from "@solana/kit";
import { loadOrCreateKeys, readKeyMaterial } from "../src/keys.ts";
import { guardedEvmSigner, guardedSvmSigner, RefusedError } from "../src/signers.ts";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/evm.ts";
import type { EvmSignable } from "../src/types.ts";

function tmp(): { dir: string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asf-keys-"));
  const dir = path.join(root, "keys");
  return { dir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const mode = (p: string) => fs.statSync(p).mode & 0o777;

const signable: EvmSignable = {
  domain: { name: "USDC", version: "2", chainId: 84532n, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  primaryType: "TransferWithAuthorization",
  message: {
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: 1000n,
    validAfter: 0n,
    validBefore: 9999999999n,
    nonce: "0x" + "ab".repeat(32),
  },
};
const okGate = async () => ({ ok: true as const, signable });

test("keys created with 0600 / dir 0700, reused after reload", () => {
  const t = tmp();
  try {
    const a = loadOrCreateKeys(t.dir);
    assert.equal(mode(t.dir), 0o700);
    assert.equal(mode(path.join(t.dir, "evm.key")), 0o600);
    assert.equal(mode(path.join(t.dir, "svm.key")), 0o600);
    assert.match(a.evmAddress, /^0x[0-9a-fA-F]{40}$/);
    const b = loadOrCreateKeys(t.dir);
    assert.deepEqual(a, b);
  } finally { t.done(); }
});

test("loose permissions throw, files are not chmodded", () => {
  const t = tmp();
  try {
    loadOrCreateKeys(t.dir);
    fs.chmodSync(path.join(t.dir, "evm.key"), 0o644);
    assert.throws(() => loadOrCreateKeys(t.dir));
    assert.equal(mode(path.join(t.dir, "evm.key")), 0o644);
    fs.chmodSync(path.join(t.dir, "evm.key"), 0o600);
    fs.chmodSync(t.dir, 0o750);
    assert.throws(() => loadOrCreateKeys(t.dir));
    assert.equal(mode(t.dir), 0o750);
  } finally { t.done(); }
});

test("malformed files throw without leaking contents", () => {
  const t = tmp();
  try {
    loadOrCreateKeys(t.dir);
    const evm = path.join(t.dir, "evm.key");
    fs.writeFileSync(evm, "0xSECRETNOTHEX", { mode: 0o600 });
    assert.throws(() => loadOrCreateKeys(t.dir), (e: Error) => !String(e).includes("SECRETNOTHEX"));
    fs.rmSync(evm);
    loadOrCreateKeys(t.dir);
    fs.writeFileSync(path.join(t.dir, "svm.key"), "[1,2,3]", { mode: 0o600 });
    assert.throws(() => loadOrCreateKeys(t.dir));
  } finally { t.done(); }
});

test("EVM signer refuses when gate refuses", async () => {
  const t = tmp();
  try {
    loadOrCreateKeys(t.dir);
    const s = guardedEvmSigner(t.dir, async () => ({ ok: false, code: "AMOUNT", reason: "too big" }));
    await assert.rejects(s.signTypedData({ domain: {}, types: {}, primaryType: "X", message: {} }), (e: unknown) =>
      e instanceof RefusedError && e.code === "AMOUNT");
    assert.equal(Object.hasOwn(s, "signTransaction"), false);
    assert.equal(Object.hasOwn(s, "readContract"), false);
  } finally { t.done(); }
});

test("EVM signer signs exactly signable, never the caller's object", async () => {
  const t = tmp();
  try {
    const { evmAddress } = loadOrCreateKeys(t.dir);
    let reads = 0;
    let gated = false;
    const evil = {
      domain: { name: "EVIL" },
      types: {},
      primaryType: "Permit",
      get message() { if (gated) reads++; return { value: 1n << 200n }; },
    };
    const s = guardedEvmSigner(t.dir, async () => { gated = true; return { ok: true, signable }; });
    assert.equal(s.address, evmAddress);
    const sig = await s.signTypedData(evil as never);
    assert.equal(reads, 0);
    const rec = await recoverTypedDataAddress({
      domain: { ...signable.domain, verifyingContract: signable.domain.verifyingContract as `0x${string}` },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: signable.message as never,
      signature: sig,
    });
    assert.equal(rec, evmAddress);
  } finally { t.done(); }
});

test("Solana signer signs the gate's bytes, refuses 0 or 2 transactions", async () => {
  const t = tmp();
  try {
    const { svmAddress } = loadOrCreateKeys(t.dir);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    let calls = 0;
    const s = await guardedSvmSigner(t.dir, async () => { calls++; return { ok: true, signable: bytes }; });
    assert.equal(s.address, svmAddress);
    const tx = { messageBytes: new Uint8Array([9, 9, 9]), signatures: {} } as never;
    const [dict] = await s.signTransactions([tx]);
    const sig = (dict as Record<string, Uint8Array>)[svmAddress];
    const pair = await createKeyPairFromBytes(readKeyMaterial(t.dir).svmBytes);
    assert.equal(await getAddressFromPublicKey(pair.publicKey), svmAddress);
    assert.equal(await verifySignature(pair.publicKey, sig as never, bytes), true);
    assert.equal(await verifySignature(pair.publicKey, sig as never, new Uint8Array([9, 9, 9])), false);
    for (const n of [0, 2]) {
      await assert.rejects(s.signTransactions(Array(n).fill(tx)), (e: unknown) => e instanceof RefusedError && e.code === "INSTRUCTION");
    }
    assert.equal(calls, 1);
    const r = await guardedSvmSigner(t.dir, async () => ({ ok: false, code: "PAYEE", reason: "no" }));
    await assert.rejects(r.signTransactions([tx]), (e: unknown) => e instanceof RefusedError && e.code === "PAYEE");
  } finally { t.done(); }
});

test("no exported value or error message contains key material", async () => {
  const t = tmp();
  try {
    const addrs = loadOrCreateKeys(t.dir);
    const { evmKey, svmBytes } = readKeyMaterial(t.dir);
    const secrets = [evmKey, evmKey.slice(2), Buffer.from(svmBytes.subarray(0, 32)).toString("hex"), JSON.stringify(Array.from(svmBytes)), svmBytes.subarray(0, 32).join(",")];
    const evm = guardedEvmSigner(t.dir, async () => ({ ok: false, code: "HOST", reason: "x" }));
    const svm = await guardedSvmSigner(t.dir, async () => ({ ok: false, code: "HOST", reason: "x" }));
    let err = "";
    try { await evm.signTypedData({} as never); } catch (e) { err += String(e) + JSON.stringify(e); }
    try { await svm.signTransactions([]); } catch (e) { err += String(e); }
    fs.writeFileSync(path.join(t.dir, "evm.key"), "garbage", { mode: 0o600 });
    try { loadOrCreateKeys(t.dir); } catch (e) { err += String(e); }
    const dump = JSON.stringify(addrs) + JSON.stringify(Object.entries(evm)) + Object.keys(svm).join() + String(evm.signTypedData) + err;
    for (const s of secrets) assert.equal(dump.includes(s), false);
  } finally { t.done(); }
});
