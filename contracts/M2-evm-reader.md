# M2 — EVM reader (FROZEN, week 1)

Types: `src/types.ts`. Implementation file: `src/evm.ts`. No network, no key.

## Export

```ts
export function readEvm(typedData: unknown, ctx: ReaderContext): ReadResult;
export const TRANSFER_WITH_AUTHORIZATION_TYPES: { TransferWithAuthorization: { name: string; type: string }[] };
```

`typedData` is what a viem account's `signTypedData` receives: `{ domain, types, primaryType, message }`, where numbers may be `bigint`, `number` or decimal strings.

## Accept only

`primaryType === "TransferWithAuthorization"`, scheme `exact`, transfer method EIP-3009. Everything else → `TYPE` (this includes Permit, Permit2 `PermitWitnessTransferFrom`, any `upto` or `batch-settlement` structure).

The caller-supplied `types` are **ignored**; the canonical types above are what will be signed. The firewall signs with canonical types, so a caller cannot change field meaning.

## Checks, in order

| Code | Refuse when |
|---|---|
| `FORMAT` | not an object; `domain.chainId` not a safe positive integer; `domain.verifyingContract`, `message.from`, `message.to` not `0x` + 40 hex; `value`, `validAfter`, `validBefore` not a non-negative integer below 2^256 (bigint, number with `Number.isSafeInteger`, or `^(0|[1-9][0-9]*)$` string); `nonce` not `0x` + 64 hex |
| `TYPE` | see above |
| `ASSET` | `eip155:<chainId>` + `verifyingContract` not in `ctx.assets`; or that asset has `evm_domain` and `domain.name` / `domain.version` differ (exact string compare) |
| `SENDER` | `message.from` (lowercase) ≠ `ctx.payer` (lowercase) |
| `MISMATCH` | `eip155:<chainId>` ≠ `ctx.expected.network`; asset ≠ `expected.asset` (lowercase); `value` ≠ `expected.amount`; `to` ≠ `expected.payTo` (lowercase); `validBefore - ctx.now > expected.maxTimeoutSeconds + 60` |
| `EARLY` | `validAfter > ctx.now + 60` |

Also `FORMAT` if `to` equals `from`, or `value` is `0`.

## Output intent

`chain: "evm"`, `network: "eip155:<chainId>"`, `scheme: "exact"`, `asset`/`payee`/`payer` lowercase, `amount = value`, `validUntil = Number(validBefore)` (if it exceeds `Number.MAX_SAFE_INTEGER`, return `FORMAT`), `replayKey = nonce` lowercase, `host` and `agent` from `ctx`.

The reader does not apply the policy (caps, validity limits); M1 does.

## Required test vectors (minimum)

Valid Base Sepolia USDC authorization (domain `USDC` / `2`, chainId 84532, contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`); each `FORMAT` field broken separately; Permit and Permit2 typed data; wrong domain name; mixed-case addresses; `value` as bigint, number, string; `validBefore` of 10 years (reader passes it on only if within `maxTimeoutSeconds + 60`, otherwise `MISMATCH`); hostile `types` that rename fields; extra unknown fields in `message` (ignored, not signed).
