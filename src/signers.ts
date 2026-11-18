// M5: guarded signers. Every signature goes through `gate`; only the gate's `signable` is ever signed.
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairFromBytes, getAddressFromPublicKey, signBytes } from "@solana/kit";
import type { TransactionPartialSigner } from "@solana/kit";
import type { ClientEvmSigner } from "@x402/evm";
import type { EvmSignable, RefusalCode } from "./types.ts";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "./evm.ts";
import { readKeyMaterial } from "./keys.ts";

export class RefusedError extends Error {
  code: RefusalCode;
  reason: string;
  constructor(code: RefusalCode, reason: string) {
    super(`refused (${code}): ${reason}`);
    this.name = "RefusedError";
    this.code = code;
    this.reason = reason;
  }
}

export type Gate<S> = (
  raw: unknown,
) => Promise<{ ok: true; signable: S } | { ok: false; code: RefusalCode; reason: string }>;

export function guardedEvmSigner(dir: string, gate: Gate<EvmSignable>): ClientEvmSigner {
  const { evmKey } = readKeyMaterial(dir);
  const account = privateKeyToAccount(evmKey);
  // Only address + signTypedData: no signTransaction / readContract, so approval and Permit2 paths are unavailable.
  return {
    address: account.address,
    async signTypedData(td) {
      const res = await gate(td);
      if (!res.ok) throw new RefusedError(res.code, res.reason);
      const s = res.signable;
      return account.signTypedData({
        domain: {
          name: s.domain.name,
          version: s.domain.version,
          chainId: s.domain.chainId,
          verifyingContract: s.domain.verifyingContract as `0x${string}`,
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: s.message.from as `0x${string}`,
          to: s.message.to as `0x${string}`,
          value: s.message.value,
          validAfter: s.message.validAfter,
          validBefore: s.message.validBefore,
          nonce: s.message.nonce as `0x${string}`,
        },
      });
    },
  };
}

export async function guardedSvmSigner(dir: string, gate: Gate<Uint8Array>): Promise<TransactionPartialSigner> {
  const { svmBytes } = readKeyMaterial(dir);
  const pair = await createKeyPairFromBytes(svmBytes);
  const address = await getAddressFromPublicKey(pair.publicKey);
  return {
    address,
    async signTransactions(txs) {
      if (txs.length !== 1) throw new RefusedError("INSTRUCTION", "exactly one transaction must be signed");
      const res = await gate(txs[0].messageBytes);
      if (!res.ok) throw new RefusedError(res.code, res.reason);
      const signature = await signBytes(pair.privateKey, res.signable);
      return [Object.freeze({ [address]: signature })] as never;
    },
  } as TransactionPartialSigner;
}
