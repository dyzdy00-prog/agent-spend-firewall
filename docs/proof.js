// Proof section: replays the recorded run (window.ASFRun + run/fNN.jpg) and, on request,
// reads the settled transactions from a public Base Sepolia RPC so the visitor can check them.
(function () {
  "use strict";
  var R = window.ASFRun; if (!R) return;
  var $ = function (id) { return document.getElementById(id); };
  var term = $("recTerm"), img = $("recImg"), bar = $("recBar"), play = $("recPlay"), cap = $("recCap");
  var N = R.lines.length, cur = N, timer = null;
  var short = function (h) { return h.slice(0, 6) + "…" + h.slice(-4); };
  var usd = function (u) { return "$" + (Number(u) / 1e6).toFixed(2); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function lineEl(l) {
    var d = el("div", "rl");
    d.appendChild(el("span", "c", "agent ▸ fetch_paid_resource(" + l.path + ")"));
    var r = el("span", l.kind === "no" ? "no" : "ok");
    if (l.kind === "no") r.textContent = "REFUSED " + l.code + " · " + l.reason;
    else if (l.tx) { r.textContent = "PAID " + usd(l.usd6) + " · settled "; var a = el("a", null, short(l.tx)); a.href = "https://sepolia.basescan.org/tx/" + l.tx; a.target = "_blank"; a.rel = "noopener"; r.appendChild(a); }
    else { r.className = "warn"; r.textContent = "SIGNED " + usd(l.usd6) + " · seller answered " + l.status + (l.status === 500 ? ", nothing delivered" : ", not settled"); }
    d.appendChild(r); return d;
  }
  function show(i) {                     // i = number of decisions already made (0..N)
    cur = i; bar.value = i;
    img.src = "run/f" + ("0" + i).slice(-2) + ".jpg";
    term.textContent = "";
    for (var k = Math.max(0, i - 7); k < i; k++) term.appendChild(lineEl(R.lines[k]));
    cap.textContent = i === 0 ? "Before the first call" : "After call " + i + " of " + N;
  }
  function stop() { clearInterval(timer); timer = null; play.textContent = "▶ Play the run"; }
  play.addEventListener("click", function () {
    if (timer) return stop();
    if (cur >= N) show(0);
    play.textContent = "❚❚ Pause";
    timer = setInterval(function () { if (cur >= N) return stop(); show(cur + 1); }, 1100);
  });
  bar.max = N; bar.addEventListener("input", function () { stop(); show(Number(bar.value)); });
  show(N);

  // ---- check on chain
  var txs = R.lines.filter(function (l) { return l.tx; }).map(function (l) { return l.tx; });
  var list = $("chain"), btn = $("chainBtn"), RPC = "https://sepolia.base.org", TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  var rows = txs.map(function (h) {
    var d = el("div", "cr"); var a = el("a", null, short(h)); a.href = "https://sepolia.basescan.org/tx/" + h; a.target = "_blank"; a.rel = "noopener";
    var st = el("span", "st", "not checked yet"); d.appendChild(a); d.appendChild(st); list.appendChild(d); return st;
  });
  function rpc(method, params) {
    return fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) })
      .then(function (r) { return r.json(); }).then(function (j) { if (j.error || !j.result) throw new Error("rpc"); return j.result; });
  }
  btn.addEventListener("click", function () {
    btn.disabled = true; btn.textContent = "Reading Base Sepolia…";
    var done = 0, okN = 0;
    txs.forEach(function (h, i) {
      rows[i].textContent = "reading…"; rows[i].className = "st";
      rpc("eth_getTransactionReceipt", [h]).then(function (rc) {
        var t = (rc.logs || []).filter(function (g) { return g.topics && g.topics[0] === TRANSFER && g.topics.length === 3; })[0];
        var ok = rc.status === "0x1" && t && ("0x" + t.topics[1].slice(26)).toLowerCase() === R.payer.toLowerCase() && ("0x" + t.topics[2].slice(26)).toLowerCase() === R.payee.toLowerCase();
        if (ok) { okN++; rows[i].className = "st good"; rows[i].textContent = "✓ block " + parseInt(rc.blockNumber, 16).toLocaleString("en-US") + " · " + (Number(BigInt(t.data)) / 1e6).toFixed(2) + " USDC from the firewall's wallet to the seller"; }
        else { rows[i].className = "st bad"; rows[i].textContent = "receipt does not match — open the link"; }
      }).catch(function () { rows[i].className = "st bad"; rows[i].textContent = "public RPC did not answer — open the link instead"; })
        .then(function () { if (++done === txs.length) { btn.disabled = false; btn.textContent = okN === txs.length ? "✓ " + okN + " of " + txs.length + " confirmed on chain just now · check again" : "Check again"; } });
    });
  });
})();
