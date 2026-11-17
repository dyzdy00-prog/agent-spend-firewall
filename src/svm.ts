// M3 Solana reader. Contract: contracts/M3-solana-reader.md. No network, no RPC.
import { createHash } from "node:crypto";
import { getCompiledTransactionMessageDecoder } from "@solana/kit";
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { ReadResult as RR, ReaderContext, RefusalCode } from "./types.ts";

type ReadResult = RR<Uint8Array>;

export const SVM_BLOCKHASH_TTL_S = 120;

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022: string = TOKEN_2022_PROGRAM_ADDRESS;
const MAX_MEMO = 256;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Ix {
  program: number;
  accounts: number[];
  data: Uint8Array;
}

function no(code: RefusalCode, reason: string): ReadResult {
  return { ok: false, code, reason };
}

export async function readSvm(input: Uint8Array, ctx: ReaderContext): Promise<ReadResult> {
  // Private copy: the caller cannot change the bytes between this check and the signature.
  if (!(input instanceof Uint8Array)) return no("FORMAT", "message is not bytes");
  const messageBytes = new Uint8Array(input);
  // --- decode ---
  let msg;
  try {
    const [value, offset] = getCompiledTransactionMessageDecoder().read(messageBytes, 0);
    if (offset !== messageBytes.length) return no("FORMAT", "trailing bytes after message");
    msg = value;
  } catch (e) {
    return no("FORMAT", `message does not decode: ${e instanceof Error ? e.message : String(e)}`);
  }

  const version = msg.version as unknown;
  if (version !== "legacy" && version !== 0 && version !== 1) return no("TYPE", "unsupported message version");
  if (version === 0) {
    const alts = (msg as { addressTableLookups?: readonly unknown[] }).addressTableLookups;
    if (alts && alts.length > 0) return no("TYPE", "address table lookups are not accepted");
  }

  const accounts: string[] = msg.staticAccounts.map((a) => String(a));
  const n = accounts.length;
  if (n === 0) return no("FORMAT", "no accounts");

  // --- normalize instructions across versions ---
  const ixs: Ix[] = [];
  if (msg.version === 1) {
    const heads = msg.instructionHeaders;
    const loads = msg.instructionPayloads;
    if (heads.length !== loads.length) return no("FORMAT", "instruction header/payload count mismatch");
    for (let i = 0; i < heads.length; i++) {
      ixs.push({
        program: heads[i]!.programAccountIndex,
        accounts: [...loads[i]!.instructionAccountIndices],
        data: Uint8Array.from(loads[i]!.instructionData),
      });
    }
  } else {
    for (const c of msg.instructions) {
      ixs.push({
        program: c.programAddressIndex,
        accounts: [...(c.accountIndices ?? [])],
        data: Uint8Array.from(c.data ?? []),
      });
    }
  }
  for (const ix of ixs) {
    if (ix.program >= n || ix.accounts.some((a) => a >= n)) return no("FORMAT", "account index out of range");
  }

  // --- roles ---
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = msg.header;
  const isSigner = (i: number) => i < numSignerAccounts;
  const isWritable = (i: number) =>
    i < numSignerAccounts ? i < numSignerAccounts - numReadonlySignerAccounts : i < n - numReadonlyNonSignerAccounts;

  // --- fee payer ---
  if (accounts[0] === ctx.payer) return no("MISMATCH", "the guarded wallet would pay the fees");

  // --- instruction allowlist ---
  let limit = 0;
  let price = 0;
  let memos = 0;
  const transfers: Ix[] = [];
  for (const ix of ixs) {
    const prog = accounts[ix.program]!;
    if (prog === COMPUTE_BUDGET) {
      if (ix.accounts.length !== 0) return no("INSTRUCTION", "compute budget instruction with accounts");
      const d = ix.data[0];
      if (d === 2 && ix.data.length === 5) limit++;
      else if (d === 3 && ix.data.length === 9) price++;
      else return no("INSTRUCTION", "compute budget instruction not allowed");
      if (limit > 1 || price > 1) return no("INSTRUCTION", "duplicate compute budget instruction");
    } else if (prog === MEMO) {
      if (ix.accounts.length !== 0) return no("INSTRUCTION", "memo with accounts");
      if (ix.data.length > MAX_MEMO) return no("INSTRUCTION", "memo too long");
      if (++memos > 1) return no("INSTRUCTION", "more than one memo");
    } else if (prog === TOKEN || prog === TOKEN_2022) {
      if (ix.data[0] !== 12) return no("INSTRUCTION", "token instruction is not TransferChecked");
      transfers.push(ix);
    } else if (prog === SYSTEM) {
      if (ix.data.length >= 4 && new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(0, true) === 4) {
        return no("LIFETIME", "durable nonce (AdvanceNonceAccount)");
      }
      return no("INSTRUCTION", "system program instruction not allowed");
    } else {
      return no("INSTRUCTION", `program not allowed: ${prog}`);
    }
  }
  if (transfers.length !== 1) return no("INSTRUCTION", `expected exactly one TransferChecked, got ${transfers.length}`);

  // --- TransferChecked ---
  const t = transfers[0]!;
  if (t.data.length !== 10) return no("FORMAT", "TransferChecked data length is not 10");
  if (t.accounts.length < 4) return no("FORMAT", "TransferChecked has too few accounts");
  if (t.accounts.length > 4) return no("INSTRUCTION", "TransferChecked has extra accounts");
  const amount = new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(1, true);
  const decimals = t.data[9]!;
  if (amount === 0n) return no("FORMAT", "amount is zero");
  const [srcI, mintI, dstI, authI] = t.accounts as [number, number, number, number];
  const tokenProgram = accounts[t.program]!;
  const source = accounts[srcI]!;
  const mint = accounts[mintI]!;
  const destination = accounts[dstI]!;
  const authority = accounts[authI]!;

  // --- ASSET ---
  const exp = ctx.expected;
  const asset = ctx.assets.find((a) => a.network === exp.network && a.asset === mint);
  if (!asset) return no("ASSET", "asset not allowed on this network");
  if (asset.svm_token_program !== undefined && asset.svm_token_program !== tokenProgram) {
    return no("ASSET", "token program differs from the registered one");
  }
  if (decimals !== asset.decimals) return no("ASSET", "decimals differ from the registered asset");

  // --- SENDER ---
  if (authority !== ctx.payer) return no("SENDER", "authority is not the guarded wallet");
  const ata = async (owner: string): Promise<string | null> => {
    try {
      return String((await findAssociatedTokenPda({ mint: mint as Address, owner: owner as Address, tokenProgram: tokenProgram as Address }))[0]);
    } catch {
      return null; // not a valid address: compared below, never equal to a real account
    }
  };
  if (!BASE58.test(exp.payTo)) return no("FORMAT", "payTo is not a Solana address");
  if (source !== (await ata(ctx.payer))) return no("SENDER", "source is not the payer's associated token account");

  // --- MISMATCH ---
  if (mint !== exp.asset) return no("MISMATCH", "mint differs from the requirements");
  if (amount !== exp.amount) return no("MISMATCH", "amount differs from the requirements");
  if (destination !== (await ata(exp.payTo))) return no("MISMATCH", "destination is not the payTo associated token account");

  // --- payer appears only as the TransferChecked authority signer, read-only ---
  const payerIdx = accounts.indexOf(ctx.payer);
  if (payerIdx !== authI || accounts.lastIndexOf(ctx.payer) !== payerIdx) {
    return no("INSTRUCTION", "guarded wallet appears in an unexpected account slot");
  }
  if (!isSigner(payerIdx)) return no("INSTRUCTION", "guarded wallet is not a signer");
  if (isWritable(payerIdx)) return no("INSTRUCTION", "guarded wallet is writable");
  for (const ix of ixs) {
    if (ix.program === payerIdx) return no("INSTRUCTION", "guarded wallet used as a program");
    if (ix !== t && ix.accounts.includes(payerIdx)) return no("INSTRUCTION", "guarded wallet in another instruction");
  }
  if (t.accounts.filter((a) => a === payerIdx).length !== 1) return no("INSTRUCTION", "guarded wallet in several transfer roles");

  return {
    ok: true,
    intent: {
      chain: "svm",
      network: exp.network,
      scheme: "exact",
      asset: mint,
      amount,
      payee: exp.payTo,
      payer: ctx.payer,
      validUntil: ctx.now + SVM_BLOCKHASH_TTL_S,
      replayKey: createHash("sha256").update(messageBytes).digest("hex"),
      host: ctx.host,
      agent: ctx.agent,
    },
    signable: messageBytes,
  };
}
