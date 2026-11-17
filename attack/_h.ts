import type { Policy, PaymentIntent } from "../src/types.ts";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const NET = "eip155:84532";
export const PAYER = "0x1111111111111111111111111111111111111111";
export const PAYTO = "0x2222222222222222222222222222222222222222";
export const NOW = 1_800_000_000;
export const policy = (o: Partial<Policy> = {}): Policy => ({
  networks: [NET], assets: [{ network: NET, asset: USDC, decimals: 6, usd_per_unit: "1", evm_domain: { name: "USDC", version: "2" } },
    { network: "eip155:1", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 18, usd_per_unit: "1" }],
  cap_usd: "1", budget_usd: "2", window_s: 3600, max_validity_s: 120, min_amount_usd: "0.001",
  max_signatures_per_window: 100, known_hosts_only: false, payees: {}, block_after_undelivered: 0, undelivered_window_s: 600,
  agents: { a1: { budget_usd: "2" } }, ...o });
export const ctx = (o: any = {}) => ({ payer: PAYER, host: "h.com", agent: "a1", now: NOW,
  expected: { network: NET, asset: USDC, amount: 10000n, payTo: PAYTO, maxTimeoutSeconds: 60 }, assets: policy().assets, ...o });
export const td = (o: any = {}) => ({ domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC, ...(o.domain ?? {}) },
  types: {}, primaryType: "TransferWithAuthorization",
  message: { from: PAYER, to: PAYTO, value: 10000n, validAfter: 0, validBefore: NOW + 60, nonce: "0x" + "ab".repeat(32), ...(o.message ?? {}) } });
export const intent = (o: Partial<PaymentIntent> = {}): PaymentIntent => ({ chain: "evm", network: NET, scheme: "exact", asset: USDC.toLowerCase(),
  amount: 10000n, payee: PAYTO, payer: PAYER, validUntil: NOW + 60, replayKey: "0x" + "cd".repeat(32), host: "h.com", agent: "a1", ...o });
export const verdict = (blocked: boolean, msg: string) => console.log(blocked ? "PASS-BLOCKED" : "EXPLOIT", "-", msg);
