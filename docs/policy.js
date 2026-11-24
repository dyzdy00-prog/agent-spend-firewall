// GENERATED from src/policy.ts by scripts/build-site.mjs — do not edit.
window.ASFPolicy = (function () {
                                                                                                            

function hostOf(url        )                {
  let u     ;
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

function toAtoms(decimal        , decimals        )         {
  if (typeof decimal !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(decimal)) {
    throw new Error("toAtoms: invalid decimal format");
  }
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("toAtoms: invalid decimals");
  const [whole, frac = ""] = decimal.split(".");
  if (frac.length > decimals) throw new Error("toAtoms: too many fraction digits");
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

function ceilDiv(a        , b        )         {
  return (a + b - 1n) / b;
}

function usd6Of(intent               , asset           )         {
  const price = toAtoms(asset.usd_per_unit, 6);
  return ceilDiv(intent.amount * price, 10n ** BigInt(asset.decimals));
}

function findAsset(assets             , network        , asset        )                   {
  const evm = network.startsWith("eip155:");
  for (const a of assets) {
    if (a.network !== network) continue;
    if (evm ? a.asset.toLowerCase() === asset.toLowerCase() : a.asset === asset) return a;
  }
  return null;
}

function refuse(code             , reason        )           {
  return { allow: false, code, reason };
}

function normPayee(chain       , p        )         {
  return chain === "evm" ? p.toLowerCase() : p;
}

function evaluate(intent               , policy        , view           , now        )           {
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
  const own = policy.sellers !== undefined && Object.hasOwn(policy.sellers, intent.host) ? policy.sellers[intent.host] : undefined;
  if (own?.blocked === true) return refuse("HOST", "seller blocked by the owner");

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

  const day = now - DAY_S;

  // 14b HOST_BUDGET over 24 hours: one seller cannot take budget after budget
  // A seller with a daily limit of its own is held to that one, higher or lower than the general limit.
  if (own?.daily_budget_usd !== undefined) {
    if (view.spentUsd6(day, { host: intent.host }) + usd6 > toAtoms(own.daily_budget_usd, 6)) {
      return refuse("HOST_BUDGET", "this seller's own daily limit reached");
    }
  } else if (
    policy.host_daily_budget_usd !== undefined &&
    view.spentUsd6(day, { host: intent.host }) + usd6 > toAtoms(policy.host_daily_budget_usd, 6)
  ) {
    return refuse("HOST_BUDGET", "seller daily limit reached");
  }

  // 15 DAILY_BUDGET: a ceiling over any 24 hours, so a short window cannot be refilled all day long
  if (policy.daily_budget_usd !== undefined && view.spentUsd6(day) + usd6 > toAtoms(policy.daily_budget_usd, 6)) {
    return refuse("DAILY_BUDGET", "daily limit reached");
  }
  if (
    agent.daily_budget_usd !== undefined &&
    view.spentUsd6(day, { agent: intent.agent }) + usd6 > toAtoms(agent.daily_budget_usd, 6)
  ) {
    return refuse("DAILY_BUDGET", "agent daily limit reached");
  }

  // 16 LONG_BUDGET: the same ceiling over 7 and over 30 days, for a bill the owner sees once a month
  if (policy.weekly_budget_usd !== undefined && view.spentUsd6(now - WEEK_S) + usd6 > toAtoms(policy.weekly_budget_usd, 6)) {
    return refuse("LONG_BUDGET", "weekly limit reached");
  }
  if (policy.monthly_budget_usd !== undefined && view.spentUsd6(now - MONTH_S) + usd6 > toAtoms(policy.monthly_budget_usd, 6)) {
    return refuse("LONG_BUDGET", "monthly limit reached");
  }
  if (agent.weekly_budget_usd !== undefined && view.spentUsd6(now - WEEK_S, { agent: intent.agent }) + usd6 > toAtoms(agent.weekly_budget_usd, 6)) {
    return refuse("LONG_BUDGET", "agent weekly limit reached");
  }
  if (agent.monthly_budget_usd !== undefined && view.spentUsd6(now - MONTH_S, { agent: intent.agent }) + usd6 > toAtoms(agent.monthly_budget_usd, 6)) {
    return refuse("LONG_BUDGET", "agent monthly limit reached");
  }

  return { allow: true, usd6 };
}

/** The period the daily limits count over, in seconds. */
const DAY_S = 86_400;
/** The periods the weekly and monthly limits count over. */
const WEEK_S = 7 * DAY_S;
const MONTH_S = 30 * DAY_S;

/** Earliest Solana expiry the readers produce (blockhash lifetime); see SVM_BLOCKHASH_TTL_S in svm.ts. */
const SVM_VALIDITY_S = 120;

/**
 * Load-time policy check (#17). Throws with a readable message on a policy that can never work
 * or that would silently weaken a limit. Call once when the policy is loaded, not per payment.
 */
function checkPolicy(policy        )       {
  const problems           = [];
  const positive = (name        , v        ) => {
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
  const daily = (name        , v                    ) => {
    if (v === undefined) return;
    let a = 0n;
    try { a = toAtoms(v, 6); } catch { problems.push(`${name} must be a decimal amount`); return; }
    if (a <= 0n) problems.push(`${name} must be greater than 0`);
  };
  daily("daily_budget_usd", policy.daily_budget_usd);
  daily("weekly_budget_usd", policy.weekly_budget_usd);
  daily("monthly_budget_usd", policy.monthly_budget_usd);
  daily("host_budget_usd", policy.host_budget_usd);
  daily("host_daily_budget_usd", policy.host_daily_budget_usd);
  for (const [hn, r] of Object.entries(policy.sellers ?? {})) daily(`sellers[${hn}].daily_budget_usd`, r.daily_budget_usd);
  for (const [id, r] of Object.entries(policy.agents)) {
    daily(`agents[${id}].daily_budget_usd`, r.daily_budget_usd);
    daily(`agents[${id}].weekly_budget_usd`, r.weekly_budget_usd);
    daily(`agents[${id}].monthly_budget_usd`, r.monthly_budget_usd);
  }
  if (policy.networks.some((n) => n.startsWith("solana:")) && policy.max_validity_s < SVM_VALIDITY_S) {
    problems.push(`max_validity_s must be at least ${SVM_VALIDITY_S} when a Solana network is enabled`);
  }
  if (problems.length) throw new Error(`invalid policy: ${problems.join("; ")}`);
}

/**
 * Smallest safe `keepS` for `Store.prune` (#17): pruning newer rows would drop spend that the
 * budget window or the non-delivery window still counts. Never less than a day, so a daily limit
 * is exact from the moment it is turned on.
 */
function minPruneKeepS(policy        )         {
  // A limit can only count what is still kept: spending is kept for as long as the longest limit looks back.
  const rules = Object.values(policy.agents);
  const long = policy.monthly_budget_usd !== undefined || rules.some((r) => r.monthly_budget_usd !== undefined) ? MONTH_S
    : policy.weekly_budget_usd !== undefined || rules.some((r) => r.weekly_budget_usd !== undefined) ? WEEK_S : DAY_S;
  return Math.max(long, policy.window_s, policy.block_after_undelivered > 0 ? policy.undelivered_window_s : 0);
}

return { hostOf, toAtoms, usd6Of, findAsset, evaluate, checkPolicy, minPruneKeepS };
})();
