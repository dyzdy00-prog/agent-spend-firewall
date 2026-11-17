import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressDecoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { readSvm } from "../src/svm.ts";
const dec = getAddressDecoder(); const fake = (n: number) => dec.decode(new Uint8Array(32).fill(n));
const PAYER = fake(1), PAY_TO = fake(2), FEE = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const ata = async (o: string) => (await findAssociatedTokenPda({ owner: address(o), mint: address(MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const data = Buffer.concat([Buffer.from([12]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(10000n); return b; })(), Buffer.from([6])]);
const ix = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [
  { address: await ata(PAYER), role: AccountRole.WRITABLE }, { address: address(MINT), role: AccountRole.READONLY },
  { address: await ata(PAY_TO), role: AccountRole.WRITABLE }, { address: PAYER, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array(data) };
const ctx: any = { payer: PAYER, host: "h", agent: "a", now: 1_800_000_000, expected: { network: NET, asset: MINT, amount: 10000n, payTo: PAY_TO, maxTimeoutSeconds: 60 },
  assets: [{ network: NET, asset: MINT, decimals: 6, usd_per_unit: "1" }] };
for (const [name, cfg, fee] of [["v1 plain", undefined, FEE], ["v1 payer is fee payer", undefined, PAYER], ["v1 big priority fee", { priorityFeeLamports: 10n ** 12n }, FEE]] as const) {
  let m: any = createTransactionMessage({ version: 1 } as any);
  m = pipe(m, (x: any) => setTransactionMessageFeePayer(address(fee), x), (x: any) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: fake(9) as any, lastValidBlockHeight: 1n }, x),
    (x: any) => appendTransactionMessageInstructions([ix] as any, x));
  if (cfg) m = { ...m, config: cfg };
  try {
    const mb = new Uint8Array(compileTransaction(m).messageBytes);
    const r = await readSvm(mb, ctx);
    console.log(name, r.ok ? "ALLOWED" : `${r.code} ${r.reason}`);
  } catch (e: any) { console.log(name, "THROW", e.message); }
}
