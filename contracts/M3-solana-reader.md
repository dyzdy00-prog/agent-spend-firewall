# M3 — Solana reader (FROZEN, week 1)

Types: `src/types.ts`. Implementation file: `src/svm.ts`. No network, no key. Uses `@solana/kit` 8.6.0 codecs and `@solana-program/token(-2022)` helpers only.

## Export

```ts
export async function readSvm(messageBytes: Uint8Array, ctx: ReaderContext): Promise<ReadResult>;
export const SVM_BLOCKHASH_TTL_S = 120;
```

`messageBytes` is the compiled transaction message that `TransactionPartialSigner.signTransactions` receives (`transaction.messageBytes`). This is what the payer's signature covers; nothing else is trusted.

Reference: what the official client builds (`@x402/svm` 2.31.0, `ExactSvmScheme.createPaymentPayload`): compute-budget instructions, one `TransferChecked`, one Memo; fee payer = facilitator (`extra.feePayer`); blockhash lifetime.

## Accept only

- Message versions `legacy`, `0` and `1`. Version 0 with any address-table lookups → `TYPE` (accounts must be visible in the message).
- Fee payer (`staticAccounts[0]`) ≠ `ctx.payer`. If the payer would pay fees → `MISMATCH`.
- Instructions, in any order, exactly:
  - 0–2 Compute Budget program instructions (`ComputeBudget111111111111111111111111111111`), only `SetComputeUnitLimit` (discriminator 2) and `SetComputeUnitPrice` (discriminator 3), at most one of each;
  - exactly 1 `TransferChecked` (discriminator 12) on the Token program or Token-2022 program, with accounts `[source, mint, destination, authority]` and no extra accounts;
  - 0–1 Memo program instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`), data ≤ 256 bytes, no accounts.
  Any other program or discriminator → `INSTRUCTION`. A System program `AdvanceNonceAccount` → `LIFETIME`.
- `ctx.payer` appears in the message only as the `TransferChecked` authority and is a signer there. If `ctx.payer` is writable, or appears in any other instruction or account role → `INSTRUCTION`.

## Checks

| Code | Refuse when |
|---|---|
| `FORMAT` | bytes do not decode; `TransferChecked` data length ≠ 10; amount 0 |
| `TYPE` | see above |
| `INSTRUCTION`, `LIFETIME` | see above |
| `ASSET` | (`ctx.expected.network`, mint) not in `ctx.assets`; or asset has `svm_token_program` and the instruction's program differs; or `decimals` byte ≠ asset `decimals` |
| `SENDER` | authority ≠ `ctx.payer`, or `source` ≠ associated token address of (`ctx.payer`, mint, token program) |
| `MISMATCH` | mint ≠ `expected.asset`; amount ≠ `expected.amount`; `destination` ≠ associated token address of (`expected.payTo`, mint, token program) |

## Output intent

`chain: "svm"`, `network = ctx.expected.network`, `scheme: "exact"`, `asset = mint`, `amount`, `payee = expected.payTo` (proven by the ATA derivation), `payer = ctx.payer`, `validUntil = ctx.now + SVM_BLOCKHASH_TTL_S`, `replayKey = sha256(messageBytes)` lowercase hex.

## Required test vectors (minimum)

Build messages with `@solana/kit` in the test (no network): the official client's shape (legacy and v0); each forbidden variant: extra transfer, SOL transfer, `Approve`, `SetAuthority`, `CloseAccount`, durable nonce, address-table lookup, payer as fee payer, payer writable elsewhere, memo > 256 bytes, wrong decimals, destination = attacker ATA while `expected.payTo` is legit, Token-2022 mint registered as Token.
