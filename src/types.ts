// FROZEN CONTRACT (week 1). Changes only through DECISIONS.md.
// Shared types for M1 (policy), M2 (EVM reader), M3 (Solana reader), M4 (state).

export type Chain = "evm" | "svm";

/** What is about to be signed, in chain-agnostic form. Built only by a reader (M2/M3) from the exact bytes to be signed. */
export interface PaymentIntent {
  chain: Chain;
  /** CAIP-2, e.g. "eip155:84532" or "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1". */
  network: string;
  scheme: "exact";
  /** EVM: lowercase 0x address of the token contract. Solana: base58 mint address. */
  asset: string;
  /** Atomic units. Always > 0n when produced by a reader. */
  amount: bigint;
  /** Who receives the money. EVM: lowercase 0x address. Solana: base58 OWNER of the destination token account (not the token account). */
  payee: string;
  /** The guarded wallet. EVM: lowercase 0x. Solana: base58. */
  payer: string;
  /** Unix seconds: the last moment the signed object can still be settled. */
  validUntil: number;
  /** Unique per signed object. EVM: lowercase 0x nonce (32 bytes). Solana: lowercase hex SHA-256 of the message bytes. */
  replayKey: string;
  /** Normalized host[:port] of the page the firewall itself requested (see hostOf in M1). */
  host: string;
  /** Agent id, authenticated by the firewall. */
  agent: string;
}

export type RefusalCode =
  // reader codes (M2, M3)
  | "FORMAT"       // malformed input
  | "TYPE"         // unsupported signature/transaction type
  | "SENDER"       // not from the guarded wallet
  | "MISMATCH"     // signed bytes differ from the payment requirements they claim to satisfy
  | "INSTRUCTION"  // Solana: an instruction outside the allowlist
  | "LIFETIME"     // Solana: durable nonce or other non-blockhash lifetime
  | "EARLY"        // EVM: validAfter in the future
  // policy codes (M1)
  | "AGENT" | "NETWORK" | "ASSET" | "AMOUNT" | "CAP" | "VALIDITY" | "REPLAY" | "HOST"
  | "UNDELIVERED" | "PAYEE" | "COUNT" | "BUDGET" | "AGENT_BUDGET" | "HOST_BUDGET"
  // firewall code (M6, catalog price check)
  | "OVERPRICED";

export type Refusal = { allow: false; code: RefusalCode; reason: string };
export type Decision = { allow: true; usd6: bigint } | Refusal;

/** One accepted stablecoin on one network. Only USD-pegged assets are supported in week 1. */
export interface AssetRule {
  network: string;
  /** EVM: 0x address (any case). Solana: base58 mint. */
  asset: string;
  decimals: number;
  /** USD value of one whole token as a decimal string, e.g. "1". */
  usd_per_unit: string;
  /** EVM only: EIP-712 domain that the token uses. */
  evm_domain?: { name: string; version: string };
  /** Solana only: owning token program (Token or Token-2022). */
  svm_token_program?: string;
}

export interface AgentRule {
  /** Rolling-window budget for this agent. */
  budget_usd: string;
  /** Optional per-payment cap for this agent; the lower of this and Policy.cap_usd applies. */
  cap_usd?: string;
  /** Optional host allowlist for this agent (normalized host[:port]). */
  hosts?: string[];
}

export interface Policy {
  /** Allowed CAIP-2 networks. Anything else is refused. */
  networks: string[];
  assets: AssetRule[];
  /** Global per-payment cap. */
  cap_usd: string;
  /** Global rolling-window budget across all agents. */
  budget_usd: string;
  window_s: number;
  max_validity_s: number;
  min_amount_usd: string;
  max_signatures_per_window: number;
  /** Optional per-host budget across all agents. */
  host_budget_usd?: string;
  known_hosts_only: boolean;
  /** Explicit payee allowlists per host and chain: payees[host][chain] = [addresses]. */
  payees: Record<string, Partial<Record<Chain, string[]>>>;
  /** Refuse a host after this many undelivered paid requests inside undelivered_window_s. 0 disables. */
  block_after_undelivered: number;
  undelivered_window_s: number;
  /** Unknown agent ids are refused. */
  agents: Record<string, AgentRule>;
}

/** Read-only view of past decisions (M4). All "since" arguments are unix seconds, exclusive. */
export interface StateView {
  spentUsd6(since: number, filter?: { agent?: string; host?: string }): bigint;
  count(since: number, filter?: { agent?: string }): number;
  /** First payee ever paid on this host and chain, or null. */
  pinnedPayee(host: string, chain: Chain): string | null;
  undeliveredCount(host: string, since: number): number;
  /** True if this replay key was recorded and its validUntil is still >= now. */
  seenReplayKey(key: string, now: number): boolean;
}

export interface Store extends StateView {
  /**
   * Runs `decide` against a consistent view and, if it allows, records the payment
   * (spend row, replay key until intent.validUntil, payee pin if none) in the same transaction.
   * Two concurrent callers (also across processes) can never both pass the same budget.
   */
  decideAndRecord(intent: PaymentIntent, now: number, decide: (view: StateView) => Decision): Decision;
  markUndelivered(host: string, now: number): void;
  /** Deletes spend rows older than now - keepS and expired replay keys. Never deletes payee pins. */
  prune(now: number, keepS: number): void;
  close(): void;
}

/** What the payment requirements (402 response) claim; readers check the signed bytes against it. */
export interface Expected {
  network: string;
  asset: string;
  amount: bigint;
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface ReaderContext {
  payer: string;
  host: string;
  agent: string;
  now: number;
  expected: Expected;
  assets: AssetRule[];
}

/** Exactly what the firewall signs for EVM, built from the validated values (never the caller's object). */
export type EvmSignable = Readonly<{
  domain: Readonly<{ name: string; version: string; chainId: bigint; verifyingContract: string }>;
  primaryType: "TransferWithAuthorization";
  message: Readonly<{ from: string; to: string; value: bigint; validAfter: bigint; validBefore: bigint; nonce: string }>;
}>;

/** `signable` is the only thing a signer may sign: EVM → EvmSignable, Solana → a private copy of the message bytes. */
export type ReadResult<S = unknown> =
  | { ok: true; intent: PaymentIntent; signable: S }
  | { ok: false; code: RefusalCode; reason: string };
