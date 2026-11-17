// Worker for the M4 budget race: repeatedly tries to spend against a shared budget.
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "../src/store.ts";
import type { PaymentIntent } from "../src/types.ts";

const { path, budget, usd6, iterations, id } = workerData as {
  path: string; budget: string; usd6: string; iterations: number; id: number;
};
const store = openStore(path);
let allowed = 0;
for (let i = 0; i < iterations; i++) {
  const intent: PaymentIntent = {
    chain: "evm", network: "eip155:84532", scheme: "exact", asset: "0xaa", amount: 1n,
    payee: "0xbb", payer: "0xcc", validUntil: 5000, replayKey: `w${id}-${i}`,
    host: "example.com", agent: `agent${id}`,
  };
  const d = store.decideAndRecord(intent, 1000, (view) =>
    view.spentUsd6(0) + BigInt(usd6) <= BigInt(budget)
      ? { allow: true, usd6: BigInt(usd6) }
      : { allow: false, code: "BUDGET", reason: "over" });
  if (d.allow) allowed++;
}
store.close();
parentPort!.postMessage(allowed);
