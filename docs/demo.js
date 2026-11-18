// Landing page demo. Decisions come from window.ASFPolicy (the real src/policy.ts, see scripts/build-site.mjs).
// The scene is drawn in grey on an offscreen canvas and printed in one ink colour through an ordered dither.
(function () {
  "use strict";
  var P = window.ASFPolicy;
  var $ = function (id) { return document.getElementById(id); };
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------------ policy and state
  var NET = "eip155:84532", USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
  var PAYEE = { seller: "0x5e11e40000000000000000000000000000a1c3aa", attacker: "0xbad0000000000000000000000000000000beef00", flaky: "0xf1a4000000000000000000000000000000000500", reports: "0x4e90000000000000000000000000000000007e57" };
  var policy = {
    networks: [NET], assets: [{ network: NET, asset: USDC, decimals: 6, usd_per_unit: "1" }],
    cap_usd: "0.05", budget_usd: "0.10", window_s: 3600, max_validity_s: 600, min_amount_usd: "0.001",
    max_signatures_per_window: 500, known_hosts_only: false, payees: {}, block_after_undelivered: 2,
    undelivered_window_s: 3600, agents: { agent: { budget_usd: "0.10" } }
  };
  P.checkPolicy(policy);
  var S;
  function fresh() { S = { now: 1800000000, start: 1800000000, nRef: 0, seq: 0, spends: [], pins: {}, und: {}, asked: 0n, signed: 0n }; }
  fresh();
  var view = {
    spentUsd6: function (since, f) { var t = 0n; S.spends.forEach(function (s) { if (s.ts > since && (!f || !f.host || f.host === s.host)) t += s.usd6; }); return t; },
    count: function (since) { return S.spends.filter(function (s) { return s.ts > since; }).length; },
    pinnedPayee: function (host) { return Object.prototype.hasOwnProperty.call(S.pins, host) ? S.pins[host] : null; },
    undeliveredCount: function (host, since) { return (S.und[host] || []).filter(function (t) { return t > since; }).length; },
    seenReplayKey: function () { return false; }
  };
  function decide(req) {
    S.now += 7;
    var res;
    if (req.kind === "probe") res = { allow: false, code: "HOST" };
    else {
      S.asked += BigInt(req.atoms);
      res = P.evaluate({ chain: "evm", network: NET, scheme: "exact", asset: USDC, amount: BigInt(req.atoms), payee: req.payee,
        payer: "0x00000000000000000000000000000000000a6e47", validUntil: S.now + 300, replayKey: "k" + (S.seq++), host: req.host, agent: "agent" },
        policy, view, S.now);
      if (res.allow) { S.spends.push({ ts: S.now, host: req.host, usd6: res.usd6 }); S.signed += res.usd6; if (!view.pinnedPayee(req.host)) S.pins[req.host] = req.payee; }
    }
    return res;
  }

  // ------------------------------------------------------------------ page updates
  var usd = function (u6) { return "$" + (Number(u6) / 1e6).toFixed(2); };
  var short = function (a) { return a.slice(0, 6) + "…" + a.slice(-4); };
  var WHY = {
    CAP: "Above your $0.05 per-payment cap. Nothing signed.",
    BUDGET: "The $0.10 hourly budget is used up. Nothing signed.",
    AGENT_BUDGET: "The $0.10 hourly budget is used up. Nothing signed.",
    PAYEE: "Payout address differs from the one first paid on this seller.",
    UNDELIVERED: "This seller took 2 payments without delivering. Blocked.",
    HOST: "An internal address. Never contacted."
  };
  var RULE = { CAP: "rCAP", BUDGET: "rBUDGET", AGENT_BUDGET: "rBUDGET", PAYEE: "rPAYEE", UNDELIVERED: "rUNDELIVERED", HOST: "rHOST" };
  function flash(id, cls) { var el = $(id); if (!el) return; el.classList.add(cls); setTimeout(function () { el.classList.remove(cls); }, 1700); }
  function clock() { var s = S.now - S.start; return ("0" + Math.floor(s / 60)).slice(-2) + ":" + ("0" + (s % 60)).slice(-2); }
  function ledgerRow(req, res) {
    var row = document.createElement("div"); row.className = "lr";
    var cell = function (cls, txt) { var e = document.createElement("span"); e.className = cls; e.textContent = txt; row.appendChild(e); return e; };
    cell("t", clock());
    cell(res.allow ? "ok" : "no", res.allow ? "PAID" : res.code === "AGENT_BUDGET" ? "BUDGET" : res.code);
    cell("host", req.host);
    cell("amt", req.kind === "probe" ? "—" : usd(req.atoms));
    var why = cell("why", res.allow ? "Within every limit. Signed once." : (WHY[res.code] || res.reason || ""));
    var box = $("ledger"); box.insertBefore(row, box.firstChild);
    while (box.children.length > 5) box.removeChild(box.lastChild);
    return why;
  }
  function refresh() {
    $("hAsk").textContent = usd(S.asked); $("hSign").textContent = usd(S.signed); $("hRef").textContent = S.nRef;
    var spent = view.spentUsd6(S.now - 3600);
    $("mTxt").textContent = usd(spent) + " used of $0.10";
    $("mBar").style.width = Math.min(100, Number(spent) / 1000) + "%";
    var pins = Object.keys(S.pins);
    $("pTxt").textContent = pins.length ? pins.slice(-2).map(function (h) { return h + " → " + short(S.pins[h]); }).join(" · ") : "No seller paid yet.";
    var strikes = Object.keys(S.und).filter(function (h) { return S.und[h].length; });
    $("uTxt").textContent = strikes.length ? strikes.map(function (h) { return h + ": " + S.und[h].length + (S.und[h].length > 1 ? " strikes" : " strike"); }).join(" · ") : "No strikes.";
  }
  function stamp(res, req) {
    var el = $("stamp");
    el.className = "stamp" + (res.allow ? "" : " no");
    el.textContent = res.allow ? "PAID " + usd(req.atoms) : "REFUSED · " + (res.code === "AGENT_BUDGET" ? "BUDGET" : res.code);
    void el.offsetWidth; el.classList.add("show");
  }
  function settle(req, res) {            // what happens once the decision is known
    var why = ledgerRow(req, res);
    if (!res.allow) S.nRef++;
    stamp(res, req);
    if (res.allow) flash("rBUDGET", "pass"); else flash(RULE[res.code] || "rCAP", "hit");
    refresh();
    return why;
  }
  function arrive(coin) {                // an allowed payment reached the seller
    if (coin.req.nodeliver) {
      (S.und[coin.req.host] = S.und[coin.req.host] || []).push(S.now);
      var n = S.und[coin.req.host].length;
      if (coin.why) coin.why.textContent = "Signed. The seller returned an error: strike " + n + " of 2.";
      flash("rUNDELIVERED", "hit"); refresh(); sellerFx = { t: last || performance.now(), bad: true };
    } else sellerFx = { t: last || performance.now(), bad: false };
  }

  // ------------------------------------------------------------------ requests
  var queue = [], coins = [], lastSpawn = 0, gap = 620, sellerFx = null, sellerName = "data.example";
  var mk = {
    buy: function () { return [{ host: "data.example", payee: PAYEE.seller, atoms: 10000 }]; },
    inject: function () { return [{ host: "reports.example", payee: PAYEE.reports, atoms: 5000000 }]; },
    swap: function () {
      var r = [];
      if (!view.pinnedPayee("data.example") && !queue.some(function (q) { return q.host === "data.example"; })) r.push(mk.buy()[0]);
      r.push({ host: "data.example", payee: PAYEE.attacker, atoms: 10000 });
      return r;
    },
    loop: function () { var r = []; for (var i = 0; i < 20; i++) { var q = mk.buy()[0]; q.fast = true; r.push(q); } return r; },
    flaky: function () { var r = []; for (var i = 0; i < 3; i++) r.push({ host: "flaky.example", payee: PAYEE.flaky, atoms: 10000, nodeliver: true }); return r; },
    probe: function () { return [{ kind: "probe", host: "169.254.169.254", atoms: 0 }]; }
  };
  function run(name) {
    if (queue.length > 45) return;
    var reqs = mk[name]();
    if (reduce) { reqs.forEach(function (q) { var res = decide(q); var why = settle(q, res); if (res.allow) arrive({ req: q, why: why }); }); draw(performance.now()); return; }
    queue.push.apply(queue, reqs);
  }
  function reset() { fresh(); queue.length = 0; coins.length = 0; $("ledger").textContent = ""; $("stamp").className = "stamp"; refresh(); }

  // ------------------------------------------------------------------ scene (docs/scene.js) and animation
  var cv = $("cv"), stage = $("stage"), scene = window.ASFScene.create(cv, stage);
  var arm = 0, shake = 0, TZ = 0.9, START = -6.6, STOP = -1.3, last = 0;
  var LABELS = [["lAgent", [-8.6, 7.0, TZ]], ["lFw", [-3.4, 8.6, -1.3]], ["lSeller", [8.7, 5.2, TZ]], ["cAsk", [-8.6, -2.6, 4]], ["cSign", [8.6, -2.6, 4]], ["stamp", [1.9, 8.4, -1.3]]];
  function place() {
    LABELS.forEach(function (l) { var e = $(l[0]); if (!e) return; var p = scene.project(l[1]); e.style.left = (p[0] * 100).toFixed(2) + "%"; e.style.top = (p[1] * 100).toFixed(2) + "%"; });
  }
  function draw(t) {
    scene.render(t, { arm: arm, shake: shake > 0 ? Math.sin(t / 24) * .09 * shake : 0, sellerFx: sellerFx && t - sellerFx.t < 560 ? sellerFx : null, coins: coins });
    place();
  }
  function step(t) {
    var dt = Math.min(48, t - last || 16); last = t;
    var fast = queue.length && queue[0].fast;
    if (queue.length && t - lastSpawn > (fast ? 190 : gap) && !coins.some(function (c) { return c.state === "roll" && c.x < START + 2.2; })) {
      var q = queue.shift();
      coins.push({ req: q, x: START, rz: 0, alpha: 1, state: "roll", t0: t, big: q.atoms > 50000, probe: q.kind === "probe" }); lastSpawn = t;
    }
    var passing = false;
    coins.forEach(function (c) {
      var v = (c.req.fast ? .0165 : .0092) * dt, r = c.big ? 1.45 : 1;
      var stop = STOP - (c.big ? .45 : 0);
      if (c.state === "roll") {
        var ahead = coins.some(function (o) { return o !== c && o.state === "wait"; });
        if (c.x < stop && !(ahead && c.x > stop - 2.3)) { var nx = Math.min(stop, c.x + v); c.rz -= (nx - c.x) / r; c.x = nx; }
        if (c.x >= stop) { c.state = "wait"; c.t0 = t; }
      } else if (c.state === "wait") {
        // the real firewall waits for the seller's answer before the next request to it
        var pending = c.req.nodeliver && coins.some(function (o) { return o !== c && o.state === "pass" && !o.done && o.req.host === c.req.host; });
        if (!pending && t - c.t0 > (c.req.fast ? 70 : 230)) {
          c.res = decide(c.req); c.why = settle(c.req, c.res);
          if (c.res.allow) c.state = "pass"; else { c.state = "bounce"; c.t0 = t; c.refused = true; c.x0 = c.x; shake = 1; }
        }
      } else if (c.state === "pass") {
        passing = passing || c.x < 1.4;
        if (arm > .6 || c.x > 0) { c.x += v * 1.25; c.rz -= v * 1.25 / r; }
        if (c.x > 6.6) { c.scale = Math.max(0, 1 - (c.x - 6.6) / 1.5); if (!c.done && c.x > 7.4) { c.done = true; arrive(c); } if (c.scale <= .05) c.alpha = 0; }
      } else if (c.state === "bounce") {
        var u = (t - c.t0) / 900;
        c.x = c.x0 - u * 3.4; c.z = TZ + u * 6.2; c.y = r + Math.sin(Math.min(1, u) * 3.1416) * 3.4 - Math.max(0, u - 1) * 16;
        c.rx = u * 5.2; c.ry = u * 2.6; c.alpha = u > 1.45 ? 0 : 1;
      }
    });
    for (var i = coins.length - 1; i >= 0; i--) if (coins[i].alpha <= 0) coins.splice(i, 1);
    arm += ((passing ? 1 : 0) - arm) * Math.min(1, dt / 70);
    if (shake > 0) shake -= dt / 420;
    draw(t);
  }
  var visible = true, running = false;
  function frame(t) { step(t); if (visible) requestAnimationFrame(frame); else running = false; }
  function start() { if (!running && !reduce) { running = true; last = 0; requestAnimationFrame(frame); } }
  if ("IntersectionObserver" in window) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) start(); }).observe(stage);
  window.addEventListener("resize", function () { scene.size(); if (reduce) draw(performance.now()); });
  stage.addEventListener("pointermove", function (e) { var b = stage.getBoundingClientRect(); scene.look((e.clientX - b.left) / b.width * 2 - 1, (e.clientY - b.top) / b.height * 2 - 1); });
  stage.addEventListener("pointerleave", function () { scene.look(0, 0); });

  // ------------------------------------------------------------------ controls and autoplay
  var touched = false, autoT = null;
  var SCRIPT = [["buy", 500], ["buy", 1500], ["inject", 1700], ["swap", 2300], ["flaky", 2400], ["probe", 4200], ["loop", 1900]];
  function auto(i) {
    if (touched) return;
    if (i >= SCRIPT.length) { autoT = setTimeout(function () { if (!touched) { reset(); auto(0); } }, 9500); return; }
    autoT = setTimeout(function () { if (!touched) { run(SCRIPT[i][0]); auto(i + 1); } }, SCRIPT[i][1]);
  }
  function take() { if (!touched) { touched = true; clearTimeout(autoT); } }
  $("acts").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button[data-a]") : null; if (!b) return;
    take(); run(b.getAttribute("data-a"));
  });
  $("reset").addEventListener("click", function () { take(); reset(); if (reduce) draw(performance.now()); });

  refresh();
  if (reduce) { ["buy", "buy", "inject", "swap", "flaky"].forEach(run); draw(0); }
  else { start(); auto(0); }
  // test hook: advance the animation by simulated time, independent of requestAnimationFrame
  var simT = 1e7;
  function advance(ms) { for (var e = simT + ms; simT < e; simT += 16) step(simT); }
  window.__asfDemo = { run: function (n) { take(); run(n); }, reset: reset, advance: advance, state: function () { return { asked: usd(S.asked), signed: usd(S.signed), queue: queue.length, coins: coins.length }; } };
})();
