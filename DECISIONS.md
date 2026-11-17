# Decisions

| Date | Decision | Why | By |
|---|---|---|---|
| 2026-11-17 | First month: `exact` scheme on EVM (EIP-3009) and Solana; HTTP and MCP transports; x402 v1 and v2. Everything else refused. | Depth before breadth; each branch is a new way to sign money away. | owner |
| 2026-11-17 | At most 4 agents at a time; pipeline runs as a scripted workflow. | Cost and machine load; steps cannot be skipped. | owner |
| 2026-11-17 | Developed in public on GitHub. | Owner's choice. | owner |
| 2026-11-17 | Week 1 contracts M1–M4 frozen (`contracts/`, `src/types.ts`). | Builders and testers must work from the same fixed text. | dispatcher |
| 2026-11-17 | Solana `validUntil` = now + 120 s (blockhash lifetime, conservative); durable nonces refused. | The message has no explicit expiry; a durable nonce would make a payment valid indefinitely. | dispatcher |
| 2026-11-17 | Stablecoins only (`usd_per_unit`), USD in millionths, rounded up. | No price oracle in week 1; rounding up never lets a budget be exceeded. | dispatcher |
| 2026-11-18 | M2: domain FORMAT checks (chainId, verifyingContract) run first, then TYPE, then message FORMAT checks. `domain.chainId` may be number, bigint or decimal string if it is a safe positive integer. `from == to`, `value == 0` and `validBefore > MAX_SAFE_INTEGER` are FORMAT and run before ASSET. | The contract put FORMAT before TYPE, which would report a Permit as FORMAT instead of TYPE. Builder's reading accepted. | dispatcher |
| 2026-11-18 | M1: `AMOUNT` minimum in atoms = ceil(min_usd6 × 10^decimals / price_usd6); `usd_per_unit` of 0 → `AMOUNT`. A malformed decimal string in the policy throws (policy is validated at load, not per payment). Pin comparison uses the allowlist normalization (EVM lowercase, Solana exact). | Contract silent; fail-closed readings accepted. | dispatcher |
| 2026-11-18 | M3: System discriminator 4 (AdvanceNonceAccount) → `LIFETIME`, any other System instruction → `INSTRUCTION`; compute-budget with wrong data length or accounts → `INSTRUCTION`; 0 or ≥2 `TransferChecked` → `INSTRUCTION`; fewer than 4 transfer accounts or out-of-range indices → `FORMAT`; more than 4 → `INSTRUCTION`; trailing bytes → `FORMAT`; wrong authority → `SENDER` before the payer-elsewhere rule; payer not signer or writable → `INSTRUCTION`; v1 messages carry compute budget in config, so only transfer and memo instructions are allowed there. | Contract silent; fail-closed readings accepted. Testers must use these rules. | dispatcher |
| 2026-11-18 | M4: `markUndelivered` stores host and ts; an allow with negative usd6 throws and rolls back; any call on a closed store throws; PRAGMA user_version holds the schema version; synchronous=FULL. | Contract silent; fail-closed readings accepted. | dispatcher |
| 2026-11-18 | Build first, test in a separate later step (owner: save tokens). Builders ran on a cheaper model; code is unverified until the test step. | Owner's choice. | owner |
