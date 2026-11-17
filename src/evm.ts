import type { PaymentIntent, ReadResult, ReaderContext, RefusalCode } from "./types.ts";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const MAX256 = 1n << 256n;

const fail = (code: RefusalCode, reason: string): ReadResult => ({ ok: false, code, reason });
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function uint(x: unknown): bigint | null {
  let v: bigint;
  if (typeof x === "bigint") v = x;
  else if (typeof x === "number") {
    if (!Number.isSafeInteger(x)) return null;
    v = BigInt(x);
  } else if (typeof x === "string") {
    if (!DEC.test(x)) return null;
    v = BigInt(x);
  } else return null;
  return v >= 0n && v < MAX256 ? v : null;
}

export function readEvm(typedData: unknown, ctx: ReaderContext): ReadResult {
  if (!isObj(typedData)) return fail("FORMAT", "typed data is not an object");
  const domain = typedData.domain;
  if (!isObj(domain)) return fail("FORMAT", "domain missing");
  const chainId = domain.chainId;
  let chainNum: number;
  if (typeof chainId === "bigint") {
    if (chainId <= 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) return fail("FORMAT", "domain.chainId invalid");
    chainNum = Number(chainId);
  } else if (typeof chainId === "number" && Number.isSafeInteger(chainId) && chainId > 0) {
    chainNum = chainId;
  } else if (typeof chainId === "string" && DEC.test(chainId) && Number.isSafeInteger(Number(chainId)) && Number(chainId) > 0) {
    chainNum = Number(chainId);
  } else return fail("FORMAT", "domain.chainId invalid");
  const vc = domain.verifyingContract;
  if (typeof vc !== "string" || !ADDR.test(vc)) return fail("FORMAT", "domain.verifyingContract invalid");

  // TYPE is decided before message fields are read: other structures have different fields.
  if (typedData.primaryType !== "TransferWithAuthorization") {
    return fail("TYPE", "only EIP-3009 TransferWithAuthorization is supported");
  }

  const msg = typedData.message;
  if (!isObj(msg)) return fail("FORMAT", "message missing");
  const { from, to, nonce } = msg;
  if (typeof from !== "string" || !ADDR.test(from)) return fail("FORMAT", "message.from invalid");
  if (typeof to !== "string" || !ADDR.test(to)) return fail("FORMAT", "message.to invalid");
  const value = uint(msg.value);
  if (value === null) return fail("FORMAT", "message.value invalid");
  const validAfter = uint(msg.validAfter);
  if (validAfter === null) return fail("FORMAT", "message.validAfter invalid");
  const validBefore = uint(msg.validBefore);
  if (validBefore === null) return fail("FORMAT", "message.validBefore invalid");
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return fail("FORMAT", "message.nonce invalid");
  if (from.toLowerCase() === to.toLowerCase()) return fail("FORMAT", "from equals to");
  if (value === 0n) return fail("FORMAT", "value is zero");
  if (validBefore > BigInt(Number.MAX_SAFE_INTEGER)) return fail("FORMAT", "validBefore too large");

  const network = `eip155:${chainNum}`;
  const asset = vc.toLowerCase();
  const rule = ctx.assets.find((a) => a.network === network && a.asset.toLowerCase() === asset);
  if (!rule) return fail("ASSET", `asset ${asset} on ${network} is not configured`);
  if (rule.evm_domain) {
    if (domain.name !== rule.evm_domain.name || domain.version !== rule.evm_domain.version) {
      return fail("ASSET", "EIP-712 domain name/version differ from the configured asset");
    }
  }

  const payer = from.toLowerCase();
  const payee = to.toLowerCase();
  if (payer !== ctx.payer.toLowerCase()) return fail("SENDER", "message.from is not the guarded wallet");

  const exp = ctx.expected;
  if (network !== exp.network) return fail("MISMATCH", "network differs from payment requirements");
  if (asset !== exp.asset.toLowerCase()) return fail("MISMATCH", "asset differs from payment requirements");
  if (value !== exp.amount) return fail("MISMATCH", "value differs from payment requirements");
  if (payee !== exp.payTo.toLowerCase()) return fail("MISMATCH", "payee differs from payment requirements");
  if (validBefore - BigInt(ctx.now) > BigInt(exp.maxTimeoutSeconds) + 60n) {
    return fail("MISMATCH", "validBefore exceeds maxTimeoutSeconds");
  }

  if (validAfter > BigInt(ctx.now) + 60n) return fail("EARLY", "validAfter is in the future");

  const intent: PaymentIntent = {
    chain: "evm",
    network,
    scheme: "exact",
    asset,
    amount: value,
    payee,
    payer,
    validUntil: Number(validBefore),
    replayKey: nonce.toLowerCase(),
    host: ctx.host,
    agent: ctx.agent,
  };
  return { ok: true, intent };
}
