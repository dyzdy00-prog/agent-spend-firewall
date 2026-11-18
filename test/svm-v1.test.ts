// Blind tests for M3 v1 messages (issue #2), written from contracts/M3-solana-reader.md,
// src/types.ts and the 2026-11-18 M3 row of DECISIONS.md. Offline: messages are built with @solana/kit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction,
  setTransactionMessageConfig, createTransactionMessage, getAddressDecoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenPda as findAta2022, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { readSvm, SVM_BLOCKHASH_TTL_S } from "../src/svm.ts";
import type { AssetRule, ReaderContext, RefusalCode } from "../src/types.ts";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM = "11111111111111111111111111111111";
const RECENT_BH_SYSVAR = "SysvarRecentB1ockHashes11111111111111111111";
const NOW = 1_800_000_000;
const AMOUNT = 10_000n;

const dec = getAddressDecoder();
const fake = (n: number) => dec.decode(new Uint8Array(32).fill(n));
const PAYER = fake(1);
const PAY_TO = fake(2);
const ATTACKER = fake(3);
const OTHER = fake(4);
const OTHER_MINT = fake(5);
const BLOCKHASH = fake(9);

type Acct = { address: string; role: number };
type Ix = { programAddress: string; accounts?: Acct[]; data?: Uint8Array };

const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bytes = (...parts: (Buffer | Uint8Array | number[])[]) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

async function ata(owner: string, mint: string, program: string = TOKEN_PROGRAM_ADDRESS): Promise<string> {
  const f = program === TOKEN_2022_PROGRAM_ADDRESS ? findAta2022 : findAssociatedTokenPda;
  const [pda] = await f({ owner: address(owner), mint: address(mint), tokenProgram: address(program) });
  return pda;
}

const limitIx = (units = 200_000): Ix => ({ programAddress: COMPUTE, data: bytes([2], u32(units)) });
const priceIx = (p = 1n): Ix => ({ programAddress: COMPUTE, data: bytes([3], u64(p)) });
const memoIx = (len = 16): Ix => ({ programAddress: MEMO, data: new Uint8Array(len).fill(0x61) });

interface TcOpts {
  program?: string; amount?: bigint; decimals?: number; mint?: string; authority?: string;
  source?: string; destination?: string; authorityRole?: number; dataLen?: number; extraAccount?: boolean;
}
async function transferIx(o: TcOpts = {}): Promise<Ix> {
  const program = o.program ?? TOKEN_PROGRAM_ADDRESS;
  const mint = o.mint ?? MINT;
  const source = o.source ?? (await ata(PAYER, mint, program));
  const destination = o.destination ?? (await ata(PAY_TO, mint, program));
  let data = bytes([12], u64(o.amount ?? AMOUNT), [o.decimals ?? 6]);
  if (o.dataLen !== undefined) data = data.length > o.dataLen ? data.slice(0, o.dataLen) : bytes(data, new Array(o.dataLen - data.length).fill(0));
  const accounts: Acct[] = [
    { address: source, role: AccountRole.WRITABLE },
    { address: mint, role: AccountRole.READONLY },
    { address: destination, role: AccountRole.WRITABLE },
    { address: o.authority ?? PAYER, role: o.authorityRole ?? AccountRole.READONLY_SIGNER },
  ];
  if (o.extraAccount) accounts.push({ address: OTHER, role: AccountRole.READONLY });
  return { programAddress: program, accounts, data };
}

function buildV1(ixs: Ix[], o: { feePayer?: string; config?: { computeUnitLimit?: number; priorityFeeLamports?: bigint } } = {}): Uint8Array {
  let msg: any = pipe(
    createTransactionMessage({ version: 1 } as any),
    (m: any) => setTransactionMessageConfig(o.config ?? { computeUnitLimit: 200_000, priorityFeeLamports: 5n }, m),
    (m: any) => setTransactionMessageFeePayer(address(o.feePayer ?? FEE_PAYER), m),
    (m: any) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as any, lastValidBlockHeight: 1n }, m),
    (m: any) => appendTransactionMessageInstructions(ixs as any, m),
  );
  return new Uint8Array(compileTransaction(msg).messageBytes);
}

const assets: AssetRule[] = [
  { network: NET, asset: MINT, decimals: 6, usd_per_unit: "1" },
  { network: NET, asset: OTHER_MINT, decimals: 6, usd_per_unit: "1" },
];
function ctx(): ReaderContext {
  return {
    payer: PAYER, host: "example.com", agent: "a1", now: NOW,
    expected: { network: NET, asset: MINT, amount: AMOUNT, payTo: PAY_TO, maxTimeoutSeconds: 60 },
    assets,
  };
}
async function refused(b: Uint8Array, code: RefusalCode) {
  const r = await readSvm(b, ctx());
  assert.equal(r.ok, false, "expected refusal");
  if (!r.ok) assert.equal(r.code, code, r.reason);
}

describe("M3 solana reader: version 1 messages", () => {
  it("builder really produces version 1 (high bit set, 0x81)", async () => {
    const mb = buildV1([await transferIx()]);
    assert.equal(mb[0]! & 0x7f, 1);
  });

  it("transfer + memo, compute settings in message config -> allowed, intent as contract", async () => {
    const mb = buildV1([await transferIx(), memoIx()]);
    const r = await readSvm(mb, ctx());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const i = r.intent;
    assert.equal(i.chain, "svm");
    assert.equal(i.network, NET);
    assert.equal(i.scheme, "exact");
    assert.equal(i.asset, MINT);
    assert.equal(i.amount, AMOUNT);
    assert.equal(i.payee, PAY_TO);
    assert.equal(i.payer, PAYER);
    assert.equal(i.validUntil, NOW + SVM_BLOCKHASH_TTL_S);
    assert.equal(i.replayKey, createHash("sha256").update(mb).digest("hex"));
    assert.equal(i.host, "example.com");
    assert.equal(i.agent, "a1");
  });

  it("transfer only with empty config -> allowed", async () => {
    const r = await readSvm(buildV1([await transferIx()], { config: {} }), ctx());
    assert.equal(r.ok, true);
  });

  it("signable equals the input bytes and is a copy", async () => {
    const mb = buildV1([await transferIx(), memoIx()]);
    const orig = new Uint8Array(mb);
    const r = await readSvm(mb, ctx());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.signable, orig);
    mb[mb.length - 1] ^= 0xff;
    assert.deepEqual(r.signable, orig);
  });

  it("SetComputeUnitLimit instruction in v1 -> INSTRUCTION", async () => {
    await refused(buildV1([limitIx(), await transferIx()]), "INSTRUCTION");
  });

  it("SetComputeUnitPrice instruction in v1 -> INSTRUCTION", async () => {
    await refused(buildV1([priceIx(), await transferIx()]), "INSTRUCTION");
  });

  it("System transfer as extra instruction -> INSTRUCTION", async () => {
    const sol: Ix = {
      programAddress: SYSTEM,
      accounts: [{ address: FEE_PAYER, role: AccountRole.WRITABLE_SIGNER }, { address: ATTACKER, role: AccountRole.WRITABLE }],
      data: bytes(u32(2), u64(1000n)),
    };
    await refused(buildV1([await transferIx(), sol]), "INSTRUCTION");
  });

  it("SPL Approve as extra instruction -> INSTRUCTION", async () => {
    const approve: Ix = {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: [
        { address: await ata(PAYER, MINT), role: AccountRole.WRITABLE },
        { address: ATTACKER, role: AccountRole.READONLY },
        { address: PAYER, role: AccountRole.READONLY_SIGNER },
      ],
      data: bytes([4], u64(1_000_000n)),
    };
    await refused(buildV1([await transferIx(), approve]), "INSTRUCTION");
  });

  it("payer as fee payer -> MISMATCH", async () => {
    await refused(buildV1([await transferIx()], { feePayer: PAYER }), "MISMATCH");
  });

  it("wrong destination (attacker ATA) -> MISMATCH", async () => {
    await refused(buildV1([await transferIx({ destination: await ata(ATTACKER, MINT) })]), "MISMATCH");
  });

  it("wrong decimals -> ASSET", async () => {
    await refused(buildV1([await transferIx({ decimals: 5 })]), "ASSET");
  });
});
