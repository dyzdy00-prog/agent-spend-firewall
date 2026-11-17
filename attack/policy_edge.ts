import { evaluate } from "../src/policy.ts";
import { openStore } from "../src/store.ts";
import { policy, intent, NOW, verdict } from "./_h.ts";
const s = openStore(":memory:");
// 1 prototype-named agents / hosts
for (const a of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
  const r = evaluate(intent({ agent: a }), policy(), s, NOW);
  verdict(!r.allow, `agent ${a}: ${JSON.stringify(r)}`);
}
// JSON.parse policy with own "__proto__" agent key is a legit own key -> allowed as intended
const p2 = JSON.parse('{"__proto__":{"budget_usd":"2"}}');
const pol = policy({ agents: p2 });
console.log("own __proto__ agent:", JSON.stringify(evaluate(intent({ agent: "__proto__" }), pol, s, NOW), (_, v) => typeof v === "bigint" ? v.toString() : v));
for (const h of ["__proto__", "constructor", "toString"]) {
  const r = evaluate(intent({ host: h }), policy({ known_hosts_only: true }), s, NOW);
  verdict(!r.allow, `known_hosts_only host ${h}: ${(r as any).code}`);
}
// 2 tiny amounts on 18 decimals: 1 atom spend must cost >= 1 usd6 (budget cannot be diluted)
const i18 = intent({ network: "eip155:1", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount: 1n });
const pol18 = policy({ networks: ["eip155:84532", "eip155:1"], min_amount_usd: "0" });
const r18 = evaluate(i18, pol18, s, NOW);
console.log("1 atom of 18dec:", JSON.stringify(r18, (_, v) => typeof v === "bigint" ? v.toString() : v));
verdict(r18.allow && r18.usd6 >= 1n, "tiny-amount rounds up");
// 3 min_amount 0 and amount 1 atom 6dec -> count limit only
// 4 cap boundary
console.log("cap exact:", evaluate(intent({ amount: 1_000_000n }), policy(), s, NOW).allow, "over:", evaluate(intent({ amount: 1_000_001n }), policy(), s, NOW).allow);
// 5 payee list with wrong-case solana-like on evm, list of host unnormalised
const pe = policy({ payees: { "h.com": { evm: [PAYTO_UP()] } } });
function PAYTO_UP() { return "0x" + "22".repeat(20); }
console.log("allowlist ok:", evaluate(intent(), pe, s, NOW).allow);
// 6 payee allowlist for host given in policy with uppercase / trailing dot keys never matches (config-only) 
const pe2 = policy({ payees: { "H.com": { evm: ["0x" + "99".repeat(20)] } } });
console.log("uppercase host key in policy ignored -> falls to TOFU:", evaluate(intent(), pe2, s, NOW).allow);
// 7 payee allowlist is per chain: svm list doesn't constrain evm
const pe3 = policy({ payees: { "h.com": { svm: ["x"] } } });
console.log("svm-only list doesn't restrict evm:", evaluate(intent({ payee: "0x" + "77".repeat(20) }), pe3, s, NOW).allow);
