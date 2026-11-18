// "Work out your agent's allowance": turns four answers into a working firewall config
// and runs two runaway loops through the real policy engine (window.ASFPolicy) to show what it stops.
(function () {
  "use strict";
  var P = window.ASFPolicy, $ = function (id) { return document.getElementById(id); };
  if (!P || !$("gWhat")) return;
  var NET = "eip155:84532", USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  var money = function (n) { return "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n < 0.1 ? 3 : 2).replace(/0$/, n < 0.1 ? "" : "0")); };
  var dec = function (n) { return (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); };
  function num(id, lo, hi, dflt) { var v = parseFloat($(id).value); if (!isFinite(v)) v = dflt; return Math.min(hi, Math.max(lo, v)); }

  function build() {
    var price = num("gPrice", 0.001, 50, 0.01), calls = num("gCalls", 1, 100000, 60), lose = num("gLose", 0.01, 100000, 5);
    var normal = price * calls;
    var cap = Math.max(0.01, Math.ceil(price * 3 * 100) / 100);
    var want = Math.max(normal * 1.5, cap * 2), budget = Math.min(lose, want);
    budget = Math.max(cap, Math.round(budget * 100) / 100);
    var policy = {
      networks: [NET, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"], cap_usd: dec(cap), budget_usd: dec(budget), window_s: 3600, max_validity_s: 600,
      min_amount_usd: "0.001", max_signatures_per_window: Math.ceil(calls * 2) + 10, known_hosts_only: false, payees: {},
      block_after_undelivered: 2, undelivered_window_s: 3600, agents: { "my-agent": { budget_usd: dec(budget) } }
    };
    var config = {
      listen: { host: "127.0.0.1", port: 8402 }, keyDir: "~/.agent-spend-firewall/keys", storePath: "~/.agent-spend-firewall/state.db",
      logPath: "~/.agent-spend-firewall/decisions.jsonl", cache_ttl_s: 300, max_price_vs_catalog: 3, svmRpcUrl: "https://api.devnet.solana.com",
      agents: { REPLACE_WITH_SHA256_HEX_OF_THE_TOKEN: "my-agent" },
      assets: [
        { network: NET, asset: USDC, decimals: 6, usd_per_unit: "1", evm_domain: { name: "USDC", version: "2" } },
        { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, usd_per_unit: "1", svm_token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }
      ],
      policy: policy
    };
    return { price: price, calls: calls, lose: lose, normal: normal, cap: cap, budget: budget, policy: policy, config: config };
  }

  // a runaway loop of n identical calls through the real evaluate(); returns how many were signed and for how much
  function loop(policy, priceUsd, n) {
    var pol = JSON.parse(JSON.stringify(policy)); pol.assets = [{ network: NET, asset: USDC.toLowerCase(), decimals: 6, usd_per_unit: "1" }];
    var spends = [], now = 1800000000, signed = 0, total = 0n, first = null, atoms = BigInt(Math.round(priceUsd * 1e6));
    var view = {
      spentUsd6: function (since) { var t = 0n; for (var i = 0; i < spends.length; i++) if (spends[i].ts > since) t += spends[i].u; return t; },
      count: function (since) { var c = 0; for (var i = 0; i < spends.length; i++) if (spends[i].ts > since) c++; return c; },
      pinnedPayee: function () { return null; }, undeliveredCount: function () { return 0; }, seenReplayKey: function () { return false; }
    };
    for (var i = 0; i < n; i++) {
      now += 1;
      var r = P.evaluate({ chain: "evm", network: NET, scheme: "exact", asset: USDC.toLowerCase(), amount: atoms, payee: "0x5e11e40000000000000000000000000000a1c3aa",
        payer: "0x00000000000000000000000000000000000a6e47", validUntil: now + 300, replayKey: "g" + i, host: "loop.example", agent: "my-agent" }, pol, view, now);
      if (r.allow) { signed++; total += r.usd6; spends.push({ ts: now, u: r.usd6 }); } else if (!first) first = r.code;
    }
    return { signed: signed, usd: Number(total) / 1e6, code: first === "AGENT_BUDGET" ? "BUDGET" : first };
  }

  function render() {
    var b = build(), err = null;
    try { var chk = JSON.parse(JSON.stringify(b.policy)); chk.assets = b.config.assets; P.checkPolicy(chk); } catch (e) { err = String(e.message || e); }
    var a = loop(b.policy, b.price, 3600), big = loop(b.policy, 0.99, 3600);
    $("gCap").textContent = money(b.cap); $("gBudget").textContent = money(b.budget); $("gNormal").textContent = money(b.normal);
    $("gNo").textContent = money(0.99 * 3600);
    $("gYes").textContent = money(Math.max(a.usd, big.usd));
    $("gLoopA").textContent = "A loop at your usual price (" + money(b.price) + " a call, one a second for an hour): " + a.signed + " calls signed, " + money(a.usd) + ", then refused (" + (a.code || "—") + ").";
    $("gLoopB").textContent = "A loop at $0.99 a call, just under the standard client's $1 limit: " + big.signed + " signed" + (big.code ? ", refused (" + big.code + ")." : ".");
    $("gWarn").textContent = err ? "This policy would not load: " + err : b.lose < b.normal ? "Your usual hour (" + money(b.normal) + ") costs more than you said you can lose (" + money(b.lose) + "): the agent will be stopped part-way through a normal hour." : "";
    $("gOut").textContent = JSON.stringify(b.config, null, 2);
    return b;
  }
  $("gWhat").addEventListener("change", function () { var v = $("gWhat").value; if (v !== "custom") $("gPrice").value = v; render(); });
  ["gPrice", "gCalls", "gLose"].forEach(function (id) { $(id).addEventListener("input", function () { if (id === "gPrice") $("gWhat").value = "custom"; render(); }); });
  $("gDown").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(build().config, null, 2) + "\n"], { type: "application/json" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "config.json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  $("gCopy").addEventListener("click", function () {
    var t = JSON.stringify(build().config, null, 2), done = function () { $("gCopy").textContent = "Copied"; setTimeout(function () { $("gCopy").textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () {}); else { var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) {} ta.remove(); }
  });
  render();
})();
