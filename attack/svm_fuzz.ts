import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressDecoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { readSvm } from "../src/svm.ts";
const dec = getAddressDecoder(); const fake = (n: number) => dec.decode(new Uint8Array(32).fill(n));
const PAYER = fake(1), PAY_TO = fake(2), FEE = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const ata = async (o: string) => (await findAssociatedTokenPda({ owner: address(o), mint: address(MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const d = Buffer.concat([Buffer.from([12]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(10000n); return b; })(), Buffer.from([6])]);
const ix = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [
  { address: await ata(PAYER), role: AccountRole.WRITABLE }, { address: address(MINT), role: AccountRole.READONLY },
  { address: await ata(PAY_TO), role: AccountRole.WRITABLE }, { address: PAYER, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array(d) };
const ctx: any = { payer: PAYER, host: "h", agent: "a", now: 1_800_000_000, expected: { network: NET, asset: MINT, amount: 10000n, payTo: PAY_TO, maxTimeoutSeconds: 60 },
  assets: [{ network: NET, asset: MINT, decimals: 6, usd_per_unit: "1" }] };
let m: any = pipe(createTransactionMessage({ version: "legacy" }), (x: any) => setTransactionMessageFeePayer(address(FEE), x),
  (x: any) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: fake(9) as any, lastValidBlockHeight: 1n }, x), (x: any) => appendTransactionMessageInstructions([ix] as any, x));
const base = new Uint8Array(compileTransaction(m).messageBytes);
console.log("len", base.length, "base ok:", (await readSvm(base, ctx)).ok);
const accepted = new Map<number, number>(); let thrown = 0;
for (let i = 0; i < base.length; i++) for (let v = 0; v < 256; v++) {
  if (v === base[i]) continue;
  const b = base.slice(); b[i] = v;
  try { const r = await readSvm(b, ctx); if (r.ok) accepted.set(i, (accepted.get(i) ?? 0) + 1); } catch { thrown++; }
}
console.log("throws:", thrown);
console.log("accepted mutation positions (pos:count):", [...accepted].map(([k, c]) => `${k}:${c}`).join(" "));
console.log("base first bytes", [...base.slice(0, 6)]);
const show = (pos: number, v: number) => { const b = base.slice(); b[pos] = v; const [x] = getCompiledTransactionMessageDecoder().read(b, 0) as any; console.log(pos, v, JSON.stringify({ version: x.version, header: x.header, n: x.staticAccounts.length })); };
show(1, 0); show(1, 5); show(2, 0); show(2, 9);
for (const [p, v] of [[1, 0], [1, 5], [2, 0], [2, 9]] as const) { const b = base.slice(); b[p] = v; const r = await readSvm(b, ctx); console.log(p, v, r.ok ? "ALLOWED" : r.code + " " + r.reason); }
