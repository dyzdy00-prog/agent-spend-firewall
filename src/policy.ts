import type { AssetRule, Chain, Decision, PaymentIntent, Policy, RefusalCode, StateView } from "./types.ts";

export function hostOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  let host = u.host.toLowerCase();
  let name = u.hostname.toLowerCase();
  if (name === "") return null;
  if (name.endsWith(".")) {
    const stripped = name.slice(0, -1);
    if (stripped === "") return null;
    host = stripped + host.slice(name.length);
    name = stripped;
  }
  return host;
}

export function toAtoms(decimal: string, decimals: number): bigint {
  if (typeof decimal !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(decimal)) {
    throw new Error("toAtoms: invalid decimal format");
  }
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("toAtoms: invalid decimals");
  const [whole, frac = ""] = decimal.split(".");
  if (frac.length > decimals) throw new Error("toAtoms: too many fraction digits");
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function usd6Of(intent: PaymentIntent, asset: AssetRule): bigint {
  const price = toAtoms(asset.usd_per_unit, 6);
  return ceilDiv(intent.amount * price, 10n ** BigInt(asset.decimals));
}

export function findAsset(assets: AssetRule[], network: string, asset: string): AssetRule | null {
  const evm = network.startsWith("eip155:");
  for (const a of assets) {
    if (a.network !== network) continue;
    if (evm ? a.asset.toLowerCase() === asset.toLowerCase() : a.asset === asset) return a;
  }
  return null;
}

function refuse(code: RefusalCode, reason: string): Decision {
  return { allow: false, code, reason };
}

function normPayee(chain: Chain, p: string): string {
  return chain === "evm" ? p.toLowerCase() : p;
}

export function evaluate(intent: PaymentIntent, policy: Policy, view: StateView, now: number): Decision {
  // 1 AGENT
  if (!Object.hasOwn(policy.agents, intent.agent)) return refuse("AGENT", "unknown agent");
  const agent = policy.agents[intent.agent];

  // 2 NETWORK
  if (!policy.networks.includes(intent.network)) return refuse("NETWORK", "network not allowed");

  // 3 ASSET
  const asset = findAsset(policy.assets, intent.network, intent.asset);
  if (asset === null) return refuse("ASSET", "asset not accepted on this network");

  const usd6 = usd6Of(intent, asset);

  // 4 AMOUNT
  if (intent.amount <= 0n) return refuse("AMOUNT", "amount must be positive");
  const price = toAtoms(asset.usd_per_unit, 6);
  if (price === 0n) return refuse("AMOUNT", "asset has no usd value");
  const minUsd6 = toAtoms(policy.min_amount_usd, 6);
  const minAtoms = ceilDiv(minUsd6 * 10n ** BigInt(asset.decimals), price);
  if (intent.amount < minAtoms) return refuse("AMOUNT", "amount below minimum");

  // 5 CAP
  let cap = toAtoms(policy.cap_usd, 6);
  if (agent.cap_usd !== undefined) {
    const ac = toAtoms(agent.cap_usd, 6);
    if (ac < cap) cap = ac;
  }
  if (usd6 > cap) return refuse("CAP", "payment exceeds per-payment cap");

  // 6 VALIDITY
  if (intent.validUntil <= now) return refuse("VALIDITY", "payment already expired");
  if (intent.validUntil - now > policy.max_validity_s) return refuse("VALIDITY", "validity too long");

  // 7 REPLAY
  if (view.seenReplayKey(intent.replayKey, now)) return refuse("REPLAY", "replay key already used");

  // 8 HOST
  if (agent.hosts !== undefined && !agent.hosts.includes(intent.host)) {
    return refuse("HOST", "host not allowed for this agent");
  }

  // 9 UNDELIVERED
  if (
    policy.block_after_undelivered > 0 &&
    view.undeliveredCount(intent.host, now - policy.undelivered_window_s) >= policy.block_after_undelivered
  ) {
    return refuse("UNDELIVERED", "host blocked after undelivered paid requests");
  }

  // 10 PAYEE
  const hostEntry = Object.hasOwn(policy.payees, intent.host) ? policy.payees[intent.host] : undefined;
  const list =
    hostEntry !== undefined && Object.hasOwn(hostEntry, intent.chain) ? hostEntry[intent.chain] : undefined;
  if (Array.isArray(list)) {
    const want = normPayee(intent.chain, intent.payee);
    if (!list.some((p) => normPayee(intent.chain, p) === want)) {
      return refuse("PAYEE", "payee not in allowlist for host");
    }
  } else if (policy.known_hosts_only) {
    return refuse("PAYEE", "host has no payee allowlist");
  } else {
    const pinned = view.pinnedPayee(intent.host, intent.chain);
    if (pinned !== null && pinned !== undefined) {
      if (normPayee(intent.chain, pinned) !== normPayee(intent.chain, intent.payee)) {
        return refuse("PAYEE", "payee differs from the one first paid on this host");
      }
    }
  }

  // 10b NEW_SELLER: a seller earns the ordinary cap by delivering once
  if (
    policy.new_seller_cap_usd !== undefined &&
    usd6 > toAtoms(policy.new_seller_cap_usd, 6) &&
    !view.deliveredBefore(intent.host)
  ) {
    return refuse("NEW_SELLER", "seller has not delivered yet: first payments are limited");
  }

  const since = now - policy.window_s;

  // 11 COUNT
  if (view.count(since) >= policy.max_signatures_per_window) {
    return refuse("COUNT", "too many signatures in window");
  }

  // 12 BUDGET
  if (view.spentUsd6(since) + usd6 > toAtoms(policy.budget_usd, 6)) {
    return refuse("BUDGET", "global budget exceeded");
  }

  // 13 AGENT_BUDGET
  if (view.spentUsd6(since, { agent: intent.agent }) + usd6 > toAtoms(agent.budget_usd, 6)) {
    return refuse("AGENT_BUDGET", "agent budget exceeded");
  }

  // 14 HOST_BUDGET
  if (
    policy.host_budget_usd !== undefined &&
    view.spentUsd6(since, { host: intent.host }) + usd6 > toAtoms(policy.host_budget_usd, 6)
  ) {
    return refuse("HOST_BUDGET", "host budget exceeded");
  }

  return { allow: true, usd6 };
}

/** Earliest Solana expiry the readers produce (blockhash lifetime); see SVM_BLOCKHASH_TTL_S in svm.ts. */
const SVM_VALIDITY_S = 120;

/**
 * Load-time policy check (#17). Throws with a readable message on a policy that can never work
 * or that would silently weaken a limit. Call once when the policy is loaded, not per payment.
 */
export function checkPolicy(policy: Policy): void {
  const problems: string[] = [];
  const positive = (name: string, v: number) => {
    if (!Number.isSafeInteger(v) || v <= 0) problems.push(`${name} must be a positive integer`);
  };
  positive("window_s", policy.window_s);
  positive("max_validity_s", policy.max_validity_s);
  if (policy.block_after_undelivered > 0) positive("undelivered_window_s", policy.undelivered_window_s);
  if (policy.new_seller_cap_usd !== undefined) {
    let v = 0n, cap = 0n;
    try { v = toAtoms(policy.new_seller_cap_usd, 6); cap = toAtoms(policy.cap_usd, 6); } catch { problems.push("new_seller_cap_usd must be a decimal amount"); }
    if (v <= 0n) problems.push("new_seller_cap_usd must be greater than 0");
    else if (v >= cap) problems.push("new_seller_cap_usd must be below cap_usd");
  }
  if (policy.networks.some((n) => n.startsWith("solana:")) && policy.max_validity_s < SVM_VALIDITY_S) {
    problems.push(`max_validity_s must be at least ${SVM_VALIDITY_S} when a Solana network is enabled`);
  }
  if (problems.length) throw new Error(`invalid policy: ${problems.join("; ")}`);
}

/**
 * Smallest safe `keepS` for `Store.prune` (#17): pruning newer rows would drop spend that the
 * budget window or the non-delivery window still counts.
 */
export function minPruneKeepS(policy: Policy): number {
  return Math.max(policy.window_s, policy.block_after_undelivered > 0 ? policy.undelivered_window_s : 0);
}
