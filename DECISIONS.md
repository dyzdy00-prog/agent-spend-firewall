# Decisions

| Date | Decision | Why | By |
|---|---|---|---|
| 2026-11-17 | First month: `exact` scheme on EVM (EIP-3009) and Solana; HTTP and MCP transports; x402 v1 and v2. Everything else refused. | Depth before breadth; each branch is a new way to sign money away. | owner |
| 2026-11-17 | At most 4 agents at a time; pipeline runs as a scripted workflow. | Cost and machine load; steps cannot be skipped. | owner |
| 2026-11-17 | Developed in public on GitHub. | Owner's choice. | owner |
| 2026-11-17 | Week 1 contracts M1–M4 frozen (`contracts/`, `src/types.ts`). | Builders and testers must work from the same fixed text. | dispatcher |
| 2026-11-17 | Solana `validUntil` = now + 120 s (blockhash lifetime, conservative); durable nonces refused. | The message has no explicit expiry; a durable nonce would make a payment valid indefinitely. | dispatcher |
| 2026-11-17 | Stablecoins only (`usd_per_unit`), USD in millionths, rounded up. | No price oracle in week 1; rounding up never lets a budget be exceeded. | dispatcher |
