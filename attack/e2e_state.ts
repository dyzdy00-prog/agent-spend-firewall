import { readEvm } from "../src/evm.ts";
import { evaluate } from "../src/policy.ts";
import { openStore } from "../src/store.ts";
import { policy, ctx, td, NOW, verdict, intent } from "./_h.ts";
const pol = policy({ budget_usd: "0.05", agents: { a1: { budget_usd: "0.05" } }, max_signatures_per_window: 1000 });
const s = openStore(":memory:");
const pay = (now: number, nonceN: number, over: any = {}, agent = "a1", host = "h.com") => {
  const r = readEvm(td({ message: { nonce: "0x" + nonceN.toString(16).padStart(64, "0"), validBefore: now + 60, ...over } }), ctx({ now, agent, host }));
  if (!r.ok) return `READER:${r.code}`;
  const d = s.decideAndRecord(r.intent, now, (v) => evaluate(r.intent, pol, v, now));
  return d.allow ? "ALLOW" : d.code;
};
// budget 0.05 USD = 5 payments of 0.01
let allowed = 0; for (let i = 1; i <= 20; i++) if (pay(NOW, i) === "ALLOW") allowed++;
verdict(allowed === 5, `budget: ${allowed} allowed of 20 (expect 5)`);
// replay: same nonce again
verdict(pay(NOW + 1, 1) !== "ALLOW", "replay same nonce -> " + pay(NOW + 1, 1));
// window boundary: exactly window_s later, old payments drop (exclusive) -> budget refills; one at T+window-1 must still count
verdict(pay(NOW + 3599, 100) !== "ALLOW", "just inside window still blocked: " + pay(NOW + 3599, 101));
console.log("at T+3600 (boundary, exclusive):", pay(NOW + 3600, 102));
// per-agent isolation: agent b not in policy
verdict(pay(NOW, 200, {}, "b") === "AGENT", "unknown agent");
// cross-agent nonce reuse: second agent same nonce
const pol2 = policy({ agents: { a1: { budget_usd: "5" }, a2: { budget_usd: "5" } }, budget_usd: "50" });
const s2 = openStore(":memory:");
const run2 = (agent: string, nonce: string) => { const r: any = readEvm(td({ message: { nonce } }), ctx({ agent })); return s2.decideAndRecord(r.intent, NOW, (v) => evaluate(r.intent, pol2, v, NOW)); };
const n = "0x" + "ee".repeat(32);
console.log("a1 first:", run2("a1", n).allow, " a2 same nonce:", (run2("a2", n) as any).code);
// nonce collision between networks (false-positive DoS only)
const i1 = intent({ replayKey: n.toLowerCase(), network: "eip155:1" });
console.log("same nonce on other chain refused (REPLAY-by-key, DoS-only):", (s2.decideAndRecord(i1, NOW, (v) => evaluate(i1, policy({ networks: ["eip155:1"] }), v, NOW)) as any).code);
// prune hazard
const s3 = openStore(":memory:");
const ii = intent();
s3.decideAndRecord(ii, NOW, () => ({ allow: true, usd6: 10_000n }));
console.log("spent before prune:", s3.spentUsd6(NOW - 3600));
s3.prune(NOW + 10, 5);
console.log("spent after prune(keepS=5 < window):", s3.spentUsd6(NOW - 3600), "(hazard only if the operator/M6 calls prune with keepS < window_s)");
// expired-but-unpruned replay key then reuse with new validBefore
const s4 = openStore(":memory:");
const a = intent({ replayKey: "0x" + "12".repeat(32), validUntil: NOW + 60 });
s4.decideAndRecord(a, NOW, () => ({ allow: true, usd6: 1n }));
console.log("seen at validUntil:", s4.seenReplayKey(a.replayKey, NOW + 60), " seen at validUntil+1:", s4.seenReplayKey(a.replayKey, NOW + 61));
