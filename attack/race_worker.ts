import { openStore } from "../src/store.ts";
import { evaluate } from "../src/policy.ts";
import { policy, intent, NOW } from "./_h.ts";
const [path, id] = process.argv.slice(2); const s = openStore(path!); const pol = policy({ budget_usd: "0.10", agents: { a1: { budget_usd: "0.10" } }, max_signatures_per_window: 1000 });
let ok = 0;
for (let i = 0; i < 40; i++) { const it = intent({ replayKey: "0x" + id + String(i).padStart(4, "0") + "0".repeat(64 - 4 - String(id).length) }); const d = s.decideAndRecord(it, NOW, (v) => evaluate(it, pol, v, NOW)); if (d.allow) ok++; }
console.log(ok); s.close();
