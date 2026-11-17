import { readEvm, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/evm.ts";
import { hashTypedData } from "viem";
import { td, ctx, USDC, NOW, PAYER, PAYTO, verdict } from "./_h.ts";
const run = (name: string, t: any, c: any = ctx()) => {
  let r; try { r = readEvm(t, c); } catch (e: any) { r = { ok: false, code: "THROW", reason: e.message }; }
  console.log(name.padEnd(48), r.ok ? "ALLOWED-BY-READER" : `${(r as any).code} ${(r as any).reason}`);
  return r;
};
// numeric forms
run("value '010000' leading zero", td({ message: { value: "010000" } }));
run("value '0x2710'", td({ message: { value: "0x2710" } }));
run("value 10000.0 number", td({ message: { value: 10000.0 } }));
run("value 1e4 number", td({ message: { value: 1e4 } }));
run("value ' 10000'", td({ message: { value: " 10000" } }));
run("value '10000\\n'", td({ message: { value: "10000\n" } }));   // regex $ allows trailing \n? no: ^$ without m: $ matches before final \n in JS? JS: no
run("value -0", td({ message: { value: -0 } }));
run("chainId '84532'", td({ domain: { chainId: "84532" } }));
run("chainId '84532\\n'", td({ domain: { chainId: "84532\n" } }));
run("nonce uppercase hex", td({ message: { nonce: "0x" + "AB".repeat(32) } }));
run("nonce '0x..\\n'", td({ message: { nonce: "0x" + "ab".repeat(32) + "\n" } }));
run("to '0x..\\n'", td({ message: { to: PAYTO + "\n" } }), ctx());
run("verifyingContract upper", td({ domain: { verifyingContract: USDC.toUpperCase().replace("0X", "0x") } }));
run("domain name differs case", td({ domain: { name: "usdc" } }));
// extra domain keys
const withSalt = td({ domain: { salt: "0x" + "11".repeat(32) } });
const r = run("domain extra salt", withSalt);
const canon = hashTypedData({ domain: td().domain as any, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: td().message as any });
const salted = hashTypedData({ domain: withSalt.domain as any, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: withSalt.message as any });
console.log("digest differs with salt (sig would not verify on USDC):", canon !== salted);
// extra domain keys that viem ignores?
run("domain extra junk key", td({ domain: { foo: 1 } }));
// getters / proxies: reader validates one value, signer would read another
let n = 0;
const evil: any = td();
Object.defineProperty(evil.message, "value", { enumerable: true, get() { return n++ === 0 ? 10000n : 10n ** 30n; } });
const rr = readEvm(evil, ctx());
console.log("getter: reader intent.amount =", rr.ok && rr.intent.amount, " | signer later reads value =", evil.message.value);
verdict(!(rr.ok && evil.message.value !== rr.intent.amount), "getter TOCTOU: object handed back to signer differs from what was read");
// frozen structuredClone? readEvm returns only intent => nothing canonical to sign
console.log("ReadResult keys:", rr.ok && Object.keys(rr));
// validBefore huge relative: maxTimeout huge from server
run("validBefore +10y w/ maxTimeout 1e9", td({ message: { validBefore: NOW + 3.15e8 } }), ctx({ expected: { ...ctx().expected, maxTimeoutSeconds: 1e9 } }));
run("validBefore in past", td({ message: { validBefore: NOW - 1 } }));
run("validAfter now+60", td({ message: { validAfter: NOW + 60 } }));
run("validAfter now+61", td({ message: { validAfter: NOW + 61 } }));
run("inherited props via prototype", Object.assign(Object.create(td()), {}));
