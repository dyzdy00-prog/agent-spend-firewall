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
  function fresh() { S = { now: 1800000000, start: 1800000000, seq: 0, spends: [], pins: {}, und: {}, asked: 0n, signed: 0n }; }
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
    $("hAsk").textContent = usd(S.asked); $("hSign").textContent = usd(S.signed);
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
    $("sellerLab").textContent = req.host;
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
      flash("rUNDELIVERED", "hit"); refresh(); sellerFx = { t: performance.now(), bad: true };
    } else sellerFx = { t: performance.now(), bad: false };
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

  // ------------------------------------------------------------------ scene
  var cv = $("cv"), stage = $("stage"), out = cv.getContext("2d"), off = document.createElement("canvas"), g = off.getContext("2d", { willReadFrequently: true });
  var W = 520, H = 216, TOP = 84, k = 1, INK = [11, 93, 64];
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function size() {
    var css = stage.clientWidth || 520, dpr = window.devicePixelRatio || 1;
    var m = Math.max(1, Math.round((css >= 560 ? 1.5 : 1) * dpr));
    var bw = Math.max(200, Math.round(css * dpr / m));
    k = bw / W; cv.width = off.width = bw; cv.height = off.height = Math.round(H * k);
  }
  var grey = function (v) { return "rgb(" + v + "," + v + "," + v + ")"; };
  function box(x, y, w, h, fill, r) {
    g.beginPath(); if (g.roundRect && r) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
    if (fill !== null) { g.fillStyle = grey(fill); g.fill(); } g.stroke();
  }
  function ell(x, y, rx, ry, fill, stroke) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 6.2832); if (fill !== null) { g.fillStyle = grey(fill); g.fill(); } if (stroke) g.stroke(); }
  var arm = 0, armTarget = 0, shake = 0;

  function drawScene(t) {
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#fff"; g.fillRect(0, 0, off.width, off.height);
    g.setTransform(k, 0, 0, k, 0, -TOP * k); g.lineJoin = "round"; g.lineCap = "round";
    var lw = Math.max(1.4, 1.5 / k); g.lineWidth = lw; g.strokeStyle = "#000";
    // floor: a dotted field that thickens toward the viewer
    var fl = g.createLinearGradient(0, 168, 0, 300); fl.addColorStop(0, "#fff"); fl.addColorStop(.3, "#f0f0f0"); fl.addColorStop(1, "#b4b4b4");
    g.fillStyle = fl; g.fillRect(0, 168, W, 132);
    // plinth with a slowly turning rosette, as on a banknote
    ell(260, 244, 176, 42, 226, true); ell(260, 244, 150, 35, 240, true);
    g.save(); g.lineWidth = Math.max(.8, 1 / k); g.strokeStyle = grey(96);
    for (var i = 0; i < 14; i++) { var a = i / 14 * 6.2832 + t / 9000; g.beginPath(); g.ellipse(260 + Math.cos(a) * 58, 244 + Math.sin(a) * 13, 84, 20, 0, 0, 6.2832); g.stroke(); }
    g.restore();
    // road
    g.save(); g.setLineDash([7, 6]); g.lineWidth = lw; g.beginPath(); g.moveTo(96, 240); g.lineTo(424, 240); g.stroke(); g.restore();

    // agent
    var blink = (t % 3600) < 130;
    g.beginPath(); g.moveTo(70, 160); g.lineTo(70, 146); g.stroke(); ell(70, 143, 3.5, 3.5, (t % 1400) < 700 ? 60 : 255, true);
    box(53, 160, 34, 25, 250, 5); box(47, 187, 46, 44, 232, 6);
    g.fillStyle = "#000"; if (!blink) { g.fillRect(60, 169, 6, 6); g.fillRect(74, 169, 6, 6); } else { g.fillRect(60, 172, 6, 1.5); g.fillRect(74, 172, 6, 1.5); }
    box(55, 196, 30, 13, 255, 2); g.fillStyle = grey(70); g.fillRect(58, 199, 12, 2.5); g.fillRect(58, 204, 20, 2.5);   // the token it carries
    g.fillStyle = "#000"; g.fillRect(55, 231, 10, 6); g.fillRect(75, 231, 10, 6);
    g.beginPath(); g.moveTo(93, 206); g.lineTo(101, 214); g.stroke();

    // seller
    var fx = sellerFx && t - sellerFx.t < 520 ? sellerFx : null;
    box(424, 182, 62, 56, 240, 0);
    g.beginPath(); g.moveTo(418, 182); g.lineTo(492, 182); g.lineTo(485, 166); g.lineTo(425, 166); g.closePath(); g.fillStyle = grey(255); g.fill(); g.stroke();
    g.fillStyle = grey(70); for (var s = 0; s < 4; s++) { g.beginPath(); g.moveTo(427 + s * 16, 166); g.lineTo(435 + s * 16, 166); g.lineTo(433.5 + s * 16.800, 182); g.lineTo(424.500 + s * 16.800, 182); g.closePath(); g.fill(); }
    box(431, 192, 26, 20, fx ? (fx.bad ? 255 : 255) : 86, 0);
    if (fx) { g.save(); g.lineWidth = 2.6; g.beginPath(); if (fx.bad) { g.moveTo(436, 196); g.lineTo(452, 208); g.moveTo(452, 196); g.lineTo(436, 208); } else { g.moveTo(436, 202); g.lineTo(442, 208); g.lineTo(453, 195); } g.stroke(); g.restore(); }
    box(463, 198, 16, 40, 205, 0); ell(467, 219, 1.3, 1.3, 0, false);

    // gate: post with the shield, short rest post, vault with the key
    box(222, 238, 86, 9, 150, 2);
    box(227, 172, 13, 66, 214, 2);
    g.beginPath(); g.moveTo(233.5, 120); g.lineTo(254, 128); g.lineTo(254, 146); g.bezierCurveTo(254, 160, 244, 169, 233.500, 173); g.bezierCurveTo(223, 169, 213, 160, 213, 146); g.lineTo(213, 128); g.closePath();
    g.fillStyle = grey(74); g.fill(); g.stroke();
    g.save(); g.strokeStyle = "#fff"; g.lineWidth = 3.4; g.beginPath(); g.moveTo(224, 146); g.lineTo(231, 153); g.lineTo(244, 138); g.stroke(); g.restore();
    box(298, 228, 7, 10, 214, 1);
    box(243, 250, 50, 27, 66, 4);
    g.save(); g.strokeStyle = "#fff"; g.fillStyle = "#fff"; g.lineWidth = 2.4; g.beginPath(); g.arc(257, 263.500, 4.5, 0, 6.2832); g.stroke(); g.beginPath(); g.moveTo(261.500, 263.500); g.lineTo(281, 263.500); g.moveTo(275, 263.500); g.lineTo(275, 268.500); g.moveTo(280, 263.500); g.lineTo(280, 267.500); g.stroke(); g.restore();

    // coins behind the arm
    coins.forEach(function (c) { drawCoin(c, t); });

    // barrier arm
    arm += (armTarget - arm) * .22;
    var sh = shake > 0 ? Math.sin(t / 22) * .05 * shake : 0; if (shake > 0) shake -= .04;
    g.save(); g.translate(238, 226); g.rotate(-arm * 1.25 + sh);
    g.beginPath(); g.rect(0, -3.5, 64, 7); g.fillStyle = "#fff"; g.fill(); g.stroke();
    g.fillStyle = "#000"; for (var b = 0; b < 4; b++) g.fillRect(6 + b * 16, -3.5, 8, 7);
    g.restore(); ell(238, 226, 4, 4, 0, false);
  }
  function drawCoin(c, t) {
    g.save(); g.globalAlpha = c.alpha; g.translate(c.x, c.y);
    if (c.req.kind === "probe") { g.rotate(c.rot); g.beginPath(); g.rect(-7, -7, 14, 14); g.fillStyle = "#fff"; g.fill(); g.stroke(); g.beginPath(); g.moveTo(-3, 0); g.lineTo(3, 0); g.moveTo(0, -3); g.lineTo(0, 3); g.stroke(); }
    else {
      var big = c.req.atoms > 50000, r = big ? 13 : 9;
      if (big) g.translate(0, -4);
      ell(0, 0, r, r, 222, true); g.save(); g.lineWidth = Math.max(.9, 1 / k); ell(0, 0, r - 3, r - 3, null, true); g.restore();
      g.rotate(c.rot); g.beginPath(); g.moveTo(0, -r + 4); g.lineTo(0, r - 4); g.moveTo(-3, -2); g.lineTo(3, -2); g.moveTo(-3, 2); g.lineTo(3, 2); g.stroke();
      if (c.state === "bounce") { g.lineWidth = 3; g.beginPath(); g.moveTo(-r, -r); g.lineTo(r, r); g.moveTo(r, -r); g.lineTo(-r, r); g.stroke(); }
    }
    g.restore();
  }
  function print() {
    var w = off.width, h = off.height, src = g.getImageData(0, 0, w, h).data, img = out.createImageData(w, h), d = img.data;
    for (var y = 0, p = 0; y < h; y++) for (var x = 0; x < w; x++, p += 4) {
      if (src[p] < (BAYER[(y & 3) * 4 + (x & 3)] + .5) * 15.94) { d[p] = INK[0]; d[p + 1] = INK[1]; d[p + 2] = INK[2]; d[p + 3] = 255; }
    }
    out.putImageData(img, 0, 0);
  }
  function draw(t) { drawScene(t); print(); }

  // ------------------------------------------------------------------ animation
  var STOP = 229, last = 0;
  function step(t) {
    var dt = Math.min(48, t - last || 16); last = t;
    var fast = queue.length && queue[0].fast;
    if (queue.length && t - lastSpawn > (fast ? 190 : gap) && !coins.some(function (c) { return c.state === "roll" && c.x < 150; })) {
      coins.push({ req: queue.shift(), x: 106, y: 231, rot: 0, alpha: 1, state: "roll", t0: t }); lastSpawn = t;
    }
    var passing = false;
    coins.forEach(function (c) {
      var v = (c.req.fast ? .36 : .2) * dt;
      if (c.state === "roll") {
        var ahead = coins.some(function (o) { return o !== c && o.state === "wait"; });
        if (c.x < STOP && !(ahead && c.x > STOP - 26)) { c.x = Math.min(STOP, c.x + v); c.rot += v / 9; }
        if (c.x >= STOP) { c.state = "wait"; c.t0 = t; }
      } else if (c.state === "wait") {
        // the real firewall waits for the seller's answer before the next request to it
        var pending = c.req.nodeliver && coins.some(function (o) { return o !== c && o.state === "pass" && !o.done && o.req.host === c.req.host; });
        if (!pending && t - c.t0 > (c.req.fast ? 70 : 230)) {
          c.res = decide(c.req); c.why = settle(c.req, c.res);
          if (c.res.allow) { c.state = "pass"; } else { c.state = "bounce"; c.t0 = t; shake = 1; }
        }
      } else if (c.state === "pass") {
        passing = passing || c.x < 312;
        if (arm > .55 || c.x > 240) { c.x += v * 1.25; c.rot += v / 8; }
        if (c.x > 446) { c.alpha -= dt / 160; if (!c.done) { c.done = true; arrive(c); } }
      } else if (c.state === "bounce") {
        var u = (t - c.t0) / 720; c.x = STOP - u * 96; c.y = 231 - Math.sin(Math.min(1, u) * 3.1416) * 46; c.rot -= dt / 55; c.alpha = Math.max(0, 1 - u * 1.05);
      }
    });
    for (var i = coins.length - 1; i >= 0; i--) if (coins[i].alpha <= 0) coins.splice(i, 1);
    armTarget = passing ? 1 : 0;
    draw(t);
  }
  var visible = true, running = false;
  function frame(t) { step(t); if (visible) requestAnimationFrame(frame); else running = false; }
  function start() { if (!running && !reduce) { running = true; last = 0; requestAnimationFrame(frame); } }
  if ("IntersectionObserver" in window) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) start(); }).observe(stage);
  window.addEventListener("resize", function () { size(); if (reduce) draw(performance.now()); });

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

  size(); refresh();
  if (reduce) { ["buy", "buy", "inject", "swap", "flaky"].forEach(run); draw(0); }
  else { start(); auto(0); }
  // test hook: advance the animation by simulated time, independent of requestAnimationFrame
  var simT = 1e7;
  function advance(ms) { for (var e = simT + ms; simT < e; simT += 16) step(simT); }
  window.__asfDemo = { run: function (n) { take(); run(n); }, reset: reset, advance: advance, state: function () { return { asked: usd(S.asked), signed: usd(S.signed), queue: queue.length, coins: coins.length }; } };
})();
