import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressDecoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { readSvm } from "../src/svm.ts";
import { evaluate } from "../src/policy.ts";
import { openStore } from "../src/store.ts";
const dec = getAddressDecoder(); const fake = (n: number) => dec.decode(new Uint8Array(32).fill(n));
const PAYER = fake(1), PAY_TO = fake(2), FEE = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const ata = async (o: string, prog = TOKEN_PROGRAM_ADDRESS) => (await findAssociatedTokenPda({ owner: address(o), mint: address(MINT), tokenProgram: prog }))[0];
const mk = async (prog: any) => { const d = Buffer.concat([Buffer.from([12]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(10000n); return b; })(), Buffer.from([6])]);
  const ix = { programAddress: prog, accounts: [{ address: await ata(PAYER, prog), role: AccountRole.WRITABLE }, { address: address(MINT), role: AccountRole.READONLY },
    { address: await ata(PAY_TO, prog), role: AccountRole.WRITABLE }, { address: PAYER, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array(d) };
  const m: any = pipe(createTransactionMessage({ version: "legacy" }), (x: any) => setTransactionMessageFeePayer(address(FEE), x),
    (x: any) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: fake(9) as any, lastValidBlockHeight: 1n }, x), (x: any) => appendTransactionMessageInstructions([ix] as any, x));
  return new Uint8Array(compileTransaction(m).messageBytes); };
const ctx = (o: any = {}): any => ({ payer: PAYER, host: "h", agent: "a1", now: 1_800_000_000, expected: { network: NET, asset: MINT, amount: 10000n, payTo: PAY_TO, maxTimeoutSeconds: 60 },
  assets: [{ network: NET, asset: MINT, decimals: 6, usd_per_unit: "1" }], ...o });
const t = async (name: string, f: () => Promise<any>) => { try { const r = await f(); console.log(name.padEnd(46), r.ok ? "ALLOWED" : `${r.code} ${r.reason}`); } catch (e: any) { console.log(name.padEnd(46), "THROWS (not a refusal):", e.message.slice(0, 70)); } };
const tok = await mk(TOKEN_PROGRAM_ADDRESS), t22 = await mk(TOKEN_2022_PROGRAM_ADDRESS);
await t("payTo not base58", () => readSvm(tok, ctx({ expected: { ...ctx().expected, payTo: "not-base58!!" } })));
await t("payer not base58", () => readSvm(tok, ctx({ payer: "xx" })));
await t("Token-2022 ix, asset registered as Token", () => readSvm(t22, ctx({ assets: [{ ...ctx().assets[0], svm_token_program: TOKEN_PROGRAM_ADDRESS }] })));
await t("Token ix, asset registered as Token-2022", () => readSvm(tok, ctx({ assets: [{ ...ctx().assets[0], svm_token_program: TOKEN_2022_PROGRAM_ADDRESS }] })));
await t("wrong decimals", () => readSvm(tok, ctx({ assets: [{ ...ctx().assets[0], decimals: 9 }] })));
await t("claimed network differs (other net w/o asset)", () => readSvm(tok, ctx({ expected: { ...ctx().expected, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } })));
// same bytes accepted under any claimed network where the same mint is registered: network is not bound to the bytes
const both = [ctx().assets[0], { ...ctx().assets[0], network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }];
await t("same bytes, claimed mainnet (mint registered on both)", () => readSvm(tok, ctx({ assets: both, expected: { ...ctx().expected, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } })));
// svm validUntil 120 vs policy.max_validity_s 60
const r: any = await readSvm(tok, ctx());
const pol: any = { networks: [NET], assets: ctx().assets, cap_usd: "1", budget_usd: "5", window_s: 3600, max_validity_s: 60, min_amount_usd: "0", max_signatures_per_window: 10,
  known_hosts_only: false, payees: {}, block_after_undelivered: 0, undelivered_window_s: 1, agents: { a1: { budget_usd: "5" } } };
console.log("policy max_validity_s=60 on valid Solana payment:", JSON.stringify(evaluate(r.intent, pol, openStore(":memory:"), 1_800_000_000), (_, v) => typeof v === "bigint" ? v.toString() : v));
