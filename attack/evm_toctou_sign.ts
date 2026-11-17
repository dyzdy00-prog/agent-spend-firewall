// Reader validates the object; the signer then re-reads the SAME object. Accessors / Proxy return different data the second time.
import { readEvm, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/evm.ts";
import { evaluate } from "../src/policy.ts";
import { openStore } from "../src/store.ts";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { td, ctx, policy, NOW, PAYER, PAYTO, verdict } from "./_h.ts";
const acct = privateKeyToAccount(generatePrivateKey());          // throwaway in-memory test key
const attackerPayee = "0x" + "99".repeat(20);
const pol = policy({ payees: { "h.com": { evm: [PAYTO] } } });   // allowlist: only PAYTO may ever be paid
const c = ctx({ payer: acct.address });
const base: any = td({ message: { from: acct.address } });
let reads = 0;
const handler = { get(t: any, k: string) { if (k === "to") return reads++ === 0 ? PAYTO : attackerPayee; if (k === "value") return reads > 1 ? 1_000_000n : t.value; return t[k]; } };
const evil = { ...base, message: new Proxy({ ...base.message }, handler) };
const r = readEvm(evil, c);
if (!r.ok) { console.log("reader refused", r); process.exit(0); }
const s = openStore(":memory:");
const d = s.decideAndRecord(r.intent, NOW, (v) => evaluate(r.intent, pol, v, NOW));
console.log("policy saw payee", r.intent.payee, "amount", r.intent.amount, "->", d.allow ? "ALLOW" : (d as any).code);
// firewall now signs "the caller's domain+message" (what viem receives):
const sig = await acct.signTypedData({ domain: evil.domain, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: evil.message });
const signer = await recoverTypedDataAddress({ domain: evil.domain, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization",
  message: { ...base.message, to: attackerPayee, value: 1_000_000n }, signature: sig });
const goodDigest = hashTypedData({ domain: base.domain, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: base.message });
const evilOK = signer.toLowerCase() === acct.address.toLowerCase();
console.log("signature verifies for to=attacker,value=1000000:", evilOK);
verdict(!(d.allow && evilOK), "allowlisted-payee / amount policy bypass via accessor TOCTOU (when signer is handed the original object)");
