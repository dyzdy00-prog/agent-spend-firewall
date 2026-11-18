# M5 — Key custody and guarded signers (FROZEN, MVP)

Files: `src/keys.ts`, `src/signers.ts`. Testnets only. No network calls.

## keys.ts

```ts
export function loadOrCreateKeys(dir: string): { evmAddress: `0x${string}`; svmAddress: string };
export function defaultKeyDir(): string; // process.env.ASF_KEY_DIR ?? ~/.agent-spend-firewall/keys
```

- `dir` is created with mode `0700` if missing. Files: `evm.key` (0x + 64 hex, viem `generatePrivateKey`) and `svm.key` (JSON array of 64 bytes, Solana keypair layout: 32-byte secret + 32-byte public). Created with mode `0600` only if missing, never overwritten.
- **Fail closed:** if `dir` mode allows group/other access, or any key file mode is not `0600`, or a file is malformed → throw. Never chmod existing files silently.
- Key material never leaves this module except to the signer factories below (module-private loader `readKeyMaterial(dir)` used only by `signers.ts`). Never logged, never in an error message, never returned by an exported function.

## signers.ts

```ts
export class RefusedError extends Error { code: RefusalCode; reason: string }
export type Gate<S> = (raw: unknown) => Promise<{ ok: true; signable: S } | { ok: false; code: RefusalCode; reason: string }>;
export function guardedEvmSigner(dir: string, gate: Gate<EvmSignable>): ClientEvmSigner;   // @x402/evm type
export async function guardedSvmSigner(dir: string, gate: Gate<Uint8Array>): Promise<TransactionPartialSigner>; // @solana/kit type
```

- EVM: `address` = key address. `signTypedData(td)` → `gate(td)`; on refusal throw `RefusedError`; on ok sign **only** `signable` with `TRANSFER_WITH_AUTHORIZATION_TYPES` (from `src/evm.ts`), primaryType `TransferWithAuthorization`, via viem `privateKeyToAccount(...).signTypedData`. The caller's object is never passed to viem. No `signTransaction`, `readContract` or other optional methods (so Permit2 / approval paths are unavailable).
- Solana: `address` = keypair address. `signTransactions(txs)` → exactly one transaction, else `RefusedError("INSTRUCTION")`; `gate(tx.messageBytes)`; on ok sign `signable` bytes with the ed25519 key (`createKeyPairFromBytes` + `signBytes` from `@solana/kit`) and return `[{ [address]: signature }]`.
- A signer never signs twice for one `gate` approval; every call goes through `gate`.

## Required tests
Key files created with 0600 / dir 0700; loose permissions → throw; existing key reused (same address after reload); malformed file → throw; EVM signer refuses when gate refuses (no signature produced) and signs exactly `signable` (recover with viem `recoverTypedDataAddress` using signable values = key address); a getter-based typed data object is never read by the signer after gate; Solana signer signs the gate's bytes (verify with `verifySignature`), refuses 0 or 2 transactions; no exported value or error message contains key material (scan `JSON.stringify` and `String(err)` for the hex/base58 secret).
