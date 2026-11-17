// Blind tests for M3 (Solana reader), written from contracts/M3-solana-reader.md,
// src/types.ts and the 2026-11-18 M3 row of DECISIONS.md. Offline: messages are built with @solana/kit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction,
  compressTransactionMessageUsingAddressLookupTables, createTransactionMessage, getAddressDecoder, pipe,
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

interface BuildOpts { version?: "legacy" | 0; feePayer?: string; lookup?: boolean }
function build(ixs: Ix[], o: BuildOpts = {}): Uint8Array {
  let msg: any = pipe(
    createTransactionMessage({ version: o.version ?? "legacy" }),
    (m: any) => setTransactionMessageFeePayer(address(o.feePayer ?? FEE_PAYER), m),
    (m: any) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as any, lastValidBlockHeight: 1n }, m),
    (m: any) => appendTransactionMessageInstructions(ixs as any, m),
  );
  if (o.lookup) {
    msg = compressTransactionMessageUsingAddressLookupTables(msg, { [fake(77)]: [address(MINT)] } as any);
  }
  return new Uint8Array(compileTransaction(msg).messageBytes);
}

const assets: AssetRule[] = [
  { network: NET, asset: MINT, decimals: 6, usd_per_unit: "1" },
  { network: NET, asset: OTHER_MINT, decimals: 6, usd_per_unit: "1" },
];
function ctx(over: Partial<ReaderContext> = {}): ReaderContext {
  return {
    payer: PAYER, host: "example.com", agent: "a1", now: NOW,
    expected: { network: NET, asset: MINT, amount: AMOUNT, payTo: PAY_TO, maxTimeoutSeconds: 60 },
    assets, ...over,
  };
}
async function official(version: "legacy" | 0 = "legacy"): Promise<Uint8Array> {
  return build([limitIx(), priceIx(), await transferIx(), memoIx()], { version });
}
async function refused(bytes_: Uint8Array, code: RefusalCode, c: ReaderContext = ctx()) {
  const r = await readSvm(bytes_, c);
  assert.equal(r.ok, false, "expected refusal");
  if (!r.ok) assert.equal(r.code, code, r.reason);
}

describe("M3 solana reader: accepted shapes", () => {
  for (const version of ["legacy", 0] as const) {
    it(`official client shape, version ${version}`, async () => {
      const mb = await official(version);
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
  }

  it("TTL constant is 120", () => assert.equal(SVM_BLOCKHASH_TTL_S, 120));

  it("transfer only, no compute budget, no memo", async () => {
    assert.equal((await readSvm(build([await transferIx()]), ctx())).ok, true);
  });

  it("instructions in any order", async () => {
    const mb = build([memoIx(), await transferIx(), priceIx(), limitIx()]);
    assert.equal((await readSvm(mb, ctx())).ok, true);
  });

  it("memo of exactly 256 bytes is allowed", async () => {
    assert.equal((await readSvm(build([await transferIx(), memoIx(256)]), ctx())).ok, true);
  });

  it("Token-2022 transfer allowed when asset has no svm_token_program", async () => {
    const t = await transferIx({ program: TOKEN_2022_PROGRAM_ADDRESS });
    const r = await readSvm(build([t]), ctx());
    assert.equal(r.ok, true);
  });

  it("Token-2022 transfer allowed when asset registered as Token-2022", async () => {
    const t = await transferIx({ program: TOKEN_2022_PROGRAM_ADDRESS });
    const a = assets.map((x) => (x.asset === MINT ? { ...x, svm_token_program: TOKEN_2022_PROGRAM_ADDRESS } : x));
    assert.equal((await readSvm(build([t]), ctx({ assets: a }))).ok, true);
  });
});

describe("M3 solana reader: refusals", () => {
  it("garbage bytes -> FORMAT", async () => {
    await refused(new Uint8Array([1, 2, 3, 4, 5]), "FORMAT");
    await refused(new Uint8Array(0), "FORMAT");
  });

  it("trailing bytes -> FORMAT", async () => {
    await refused(bytes(await official(), [0]), "FORMAT");
  });

  it("amount 0 -> FORMAT", async () => {
    await refused(build([await transferIx({ amount: 0n })]), "FORMAT", ctx({ expected: { ...ctx().expected, amount: 0n } }));
  });

  it("TransferChecked data length != 10 -> FORMAT", async () => {
    await refused(build([await transferIx({ dataLen: 9 })]), "FORMAT");
    await refused(build([await transferIx({ dataLen: 11 })]), "FORMAT");
  });

  it("TransferChecked with fewer than 4 accounts -> FORMAT", async () => {
    const t = await transferIx();
    t.accounts = t.accounts!.slice(0, 3);
    await refused(build([t]), "FORMAT");
  });

  it("TransferChecked with extra account -> INSTRUCTION", async () => {
    await refused(build([await transferIx({ extraAccount: true })]), "INSTRUCTION");
  });

  it("extra transfer -> INSTRUCTION", async () => {
    await refused(build([await transferIx(), await transferIx()]), "INSTRUCTION");
  });

  it("no transfer at all -> INSTRUCTION", async () => {
    await refused(build([limitIx(), memoIx()]), "INSTRUCTION");
  });

  it("SOL transfer -> INSTRUCTION", async () => {
    const sol: Ix = {
      programAddress: SYSTEM,
      accounts: [{ address: FEE_PAYER, role: AccountRole.WRITABLE_SIGNER }, { address: ATTACKER, role: AccountRole.WRITABLE }],
      data: bytes(u32(2), u64(1000n)),
    };
    await refused(build([await transferIx(), sol]), "INSTRUCTION");
  });

  it("Approve -> INSTRUCTION", async () => {
    const approve: Ix = {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: [
        { address: await ata(PAYER, MINT), role: AccountRole.WRITABLE },
        { address: ATTACKER, role: AccountRole.READONLY },
        { address: PAYER, role: AccountRole.READONLY_SIGNER },
      ],
      data: bytes([4], u64(1_000_000n)),
    };
    await refused(build([await transferIx(), approve]), "INSTRUCTION");
  });

  it("SetAuthority -> INSTRUCTION", async () => {
    const sa: Ix = {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: [
        { address: await ata(PAYER, MINT), role: AccountRole.WRITABLE },
        { address: PAYER, role: AccountRole.READONLY_SIGNER },
      ],
      data: bytes([6, 2, 1], Array.from(Buffer.from(new Uint8Array(32).fill(3)))),
    };
    await refused(build([await transferIx(), sa]), "INSTRUCTION");
  });

  it("CloseAccount -> INSTRUCTION", async () => {
    const ca: Ix = {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: [
        { address: await ata(PAYER, MINT), role: AccountRole.WRITABLE },
        { address: ATTACKER, role: AccountRole.WRITABLE },
        { address: PAYER, role: AccountRole.READONLY_SIGNER },
      ],
      data: new Uint8Array([9]),
    };
    await refused(build([await transferIx(), ca]), "INSTRUCTION");
  });

  it("other System instruction -> INSTRUCTION", async () => {
    const ix: Ix = { programAddress: SYSTEM, accounts: [], data: bytes(u32(8)) };
    await refused(build([await transferIx(), ix]), "INSTRUCTION");
  });

  it("durable nonce (AdvanceNonceAccount) -> LIFETIME", async () => {
    const adv: Ix = {
      programAddress: SYSTEM,
      accounts: [
        { address: fake(20), role: AccountRole.WRITABLE },
        { address: RECENT_BH_SYSVAR, role: AccountRole.READONLY },
        { address: fake(21), role: AccountRole.READONLY_SIGNER },
      ],
      data: bytes(u32(4)),
    };
    await refused(build([adv, await transferIx(), memoIx()]), "LIFETIME");
  });

  it("address-table lookup (v0) -> TYPE", async () => {
    const mb = build([await transferIx()], { version: 0, lookup: true });
    await refused(mb, "TYPE");
  });

  it("payer as fee payer -> MISMATCH", async () => {
    await refused(build([await transferIx()], { feePayer: PAYER }), "MISMATCH");
  });

  it("payer writable in TransferChecked -> INSTRUCTION", async () => {
    const t = await transferIx({ authorityRole: AccountRole.WRITABLE_SIGNER });
    await refused(build([t]), "INSTRUCTION");
  });

  it("payer not a signer in TransferChecked -> INSTRUCTION", async () => {
    const t = await transferIx({ authorityRole: AccountRole.READONLY });
    await refused(build([t]), "INSTRUCTION");
  });

  it("payer appears in memo accounts -> INSTRUCTION", async () => {
    const m: Ix = { programAddress: MEMO, accounts: [{ address: PAYER, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([0x61]) };
    await refused(build([await transferIx(), m]), "INSTRUCTION");
  });

  it("memo of 257 bytes -> INSTRUCTION", async () => {
    await refused(build([await transferIx(), memoIx(257)]), "INSTRUCTION");
  });

  it("duplicate SetComputeUnitLimit -> INSTRUCTION", async () => {
    await refused(build([limitIx(), limitIx(300_000), await transferIx()]), "INSTRUCTION");
  });

  it("duplicate SetComputeUnitPrice -> INSTRUCTION", async () => {
    await refused(build([priceIx(1n), priceIx(2n), await transferIx()]), "INSTRUCTION");
  });

  it("other compute-budget discriminator -> INSTRUCTION", async () => {
    const heap: Ix = { programAddress: COMPUTE, data: bytes([1], u32(65536)) };
    await refused(build([heap, await transferIx()]), "INSTRUCTION");
  });

  it("compute-budget with wrong data length -> INSTRUCTION", async () => {
    const bad: Ix = { programAddress: COMPUTE, data: bytes([2], [1, 2]) };
    await refused(build([bad, await transferIx()]), "INSTRUCTION");
  });

  it("unknown program -> INSTRUCTION", async () => {
    const x: Ix = { programAddress: fake(30), accounts: [], data: new Uint8Array([1]) };
    await refused(build([await transferIx(), x]), "INSTRUCTION");
  });

  it("wrong decimals -> ASSET", async () => {
    await refused(build([await transferIx({ decimals: 5 })]), "ASSET");
  });

  it("mint not registered for the network -> ASSET", async () => {
    await refused(build([await transferIx()]), "ASSET", ctx({ assets: [{ ...assets[0]!, network: "solana:other" }] }));
    await refused(build([await transferIx()]), "ASSET", ctx({ assets: [] }));
  });

  it("Token-2022 instruction for a mint registered as Token -> ASSET", async () => {
    const a = assets.map((x) => (x.asset === MINT ? { ...x, svm_token_program: TOKEN_PROGRAM_ADDRESS } : x));
    const t = await transferIx({ program: TOKEN_2022_PROGRAM_ADDRESS });
    await refused(build([t]), "ASSET", ctx({ assets: a }));
  });

  it("Token instruction for a mint registered as Token-2022 -> ASSET", async () => {
    const a = assets.map((x) => (x.asset === MINT ? { ...x, svm_token_program: TOKEN_2022_PROGRAM_ADDRESS } : x));
    await refused(build([await transferIx()]), "ASSET", ctx({ assets: a }));
  });

  it("wrong authority -> SENDER", async () => {
    await refused(build([await transferIx({ authority: OTHER })]), "SENDER");
  });

  it("wrong source ATA -> SENDER", async () => {
    await refused(build([await transferIx({ source: await ata(OTHER, MINT) })]), "SENDER");
  });

  it("destination = attacker ATA -> MISMATCH", async () => {
    await refused(build([await transferIx({ destination: await ata(ATTACKER, MINT) })]), "MISMATCH");
  });

  it("destination = payTo itself (not its ATA) -> MISMATCH", async () => {
    await refused(build([await transferIx({ destination: PAY_TO })]), "MISMATCH");
  });

  it("amount differs from expected -> MISMATCH", async () => {
    await refused(build([await transferIx({ amount: AMOUNT + 1n })]), "MISMATCH");
  });

  it("mint differs from expected.asset (but registered) -> MISMATCH", async () => {
    await refused(build([await transferIx({ mint: OTHER_MINT })]), "MISMATCH");
  });
});
