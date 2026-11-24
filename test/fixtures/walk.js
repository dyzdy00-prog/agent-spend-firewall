// Runs inside the console in a headless browser (test/walk.test.ts): the demo console (docs/console/index.html?still),
// and the real console of a practice firewall started for the test.
// Presses every practice button as each agent, opens every screen, performs the owner's actions,
// and collects any text that is plainly a programming slip shown to the owner.
(async function () {
  var out = { screens: [], findings: [], errors: [] };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  window.addEventListener("error", function (e) { out.errors.push(String(e.message).slice(0, 200)); });
  window.addEventListener("unhandledrejection", function (e) { out.errors.push("rejection: " + String((e.reason && e.reason.message) || e.reason).slice(0, 200)); });
  // Waits for something to be there. The limit is a guard against hanging, not a statement about speed.
  var need = async function (what, get) { for (var i = 0; i < 600; i++) { var v = get(); if (v) return v; await sleep(50); } throw new Error("never appeared: " + what); };
  // Any letter case: a card's small heading is drawn in capitals, and innerText gives "2 UNDEFINED".
  var SLIP = /[^\n]*(\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date|\bnull\b|\bInfinity\b)[^\n]*/gi;
  var look = function (name) {
    var t = document.body.innerText, m = t.match(SLIP);
    out.screens.push(name);
    if (m) m.slice(0, 5).forEach(function (line) { out.findings.push(name + ": " + line.trim().slice(0, 160)); });
    if (window.__PHONE) { out.width = window.innerWidth; wide(name); }
  };
  // On a phone-sized screen nothing may reach past the right edge unless it sits in a box that scrolls sideways by itself.
  var wide = function (name) {
    var w = window.innerWidth, page = document.documentElement.scrollWidth;
    if (page > w + 1) out.findings.push(name + ": the page scrolls sideways (" + page + " wide on a " + w + " screen)");
    var seen = 0;
    [].slice.call(document.querySelectorAll("main *, header *, nav")).forEach(function (el) {
      if (seen >= 3) return;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= w + 2) return;
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) { var o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return; }
      if (getComputedStyle(el).position === "fixed") return;
      seen++; out.findings.push(name + ": reaches past the screen: <" + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "") + "> to " + Math.round(r.right) + " of " + w);
    });
  };
  var buttons = function (root) { return [].slice.call((root || document).querySelectorAll("button")); };
  // `within` is a selector, looked up afresh on every try: the console redraws the page and an element kept from before is no longer on it.
  var btn = function (re, within) { return need("button " + re, function () { return buttons(within ? document.querySelector(within) : null).filter(function (x) { return re.test(x.innerText.trim()); })[0]; }); };
  var nav = async function (label) { (await need("page " + label, function () { return buttons(document.querySelector("nav")).filter(function (x) { return x.innerText.trim().indexOf(label) === 0; })[0]; })).click(); await sleep(150); };
  var type = function (el, v) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  var said = function () { return need("the agent's answer", function () { var s = document.querySelector(".say"); return s && !/waiting for the firewall/.test(s.innerText) && s.innerText; }); };
  var DEMO = !!window.ASF_DEMO;
  out.demo = DEMO;
  // Presses a button if it is there: in the real console some steps depend on the owner's rules.
  var maybe = function (re, within) { var b = buttons(within ? document.querySelector(within) : null).filter(function (x) { return re.test(x.innerText.trim()); })[0]; if (b) b.click(); return !!b; };
  try {
    if (DEMO) { var auto = await need("the autopilot switch", function () { return document.querySelector(".autob"); }); if (!/off/.test(auto.className)) auto.click(); }
    else await need("the practice panel", function () { return document.querySelector("aside .act"); });
    // 1. every practice button, as each agent
    var acts = DEMO ? [/Buy weather/, /same data again/, /Buy a dataset/, /Poisoned/, /swaps its wallet/, /takes money/, /takes money/, /raises its price/, /internal address/, /Runaway/]
      : [/^Buy data/, /same data again/, /Buy a dataset/, /\$5 report/, /swaps its wallet/, /takes money/, /takes money/, /raises its price/, /internal address/, /Runaway/];
    var people = (await need("the agent picker", function () { return document.querySelector("aside select"); })).options.length;
    for (var a = 0; a < Math.min(2, people); a++) {
      var who = await need("the agent picker", function () { return document.querySelector("aside select"); });
      who.selectedIndex = a; who.dispatchEvent(new Event("change"));
      for (var i = 0; i < acts.length; i++) {
        (await btn(acts[i], "aside")).click();
        if (/dataset/.test(acts[i].source)) await sleep(300); else { await sleep(/Runaway/.test(acts[i].source) ? 3200 : 150); await said(); }
      }
    }
    look("after the practice buttons");
    // 2. every page
    var pages = ["Overview", "Approvals", "Activity", "Agents", "Sellers", "Report", "Rules", "Connect"];
    for (var p = 0; p < pages.length; p++) {
      await nav(pages[p]);
      if (pages[p] === "Report") await need("the report", function () { return document.getElementById("repWhy"); });
      await need("the heading of " + pages[p], function () { return document.querySelector("main h1"); });
      look(pages[p]);
    }
    // 2b. the same money, read on different pages: what one page calls "spent this hour" the others must add up to.
    var usdIn = function (t) { var m = /\$([0-9]+(?:\.[0-9]+)?)/.exec(String(t)); return m ? Number(m[1]) : 0; };
    var cardOf = function (re) { return [].slice.call(document.querySelectorAll("main .card")).filter(function (c) { var h = c.querySelector("h2"); return h && re.test(h.innerText.trim()); })[0]; };
    var column = function (card, i, read) { return [].slice.call(card.querySelectorAll("tbody tr")).reduce(function (t, r) { return t + (r.cells[i] ? read(r.cells[i].innerText) : 0); }, 0); };
    var tile = function (re) { var x = [].slice.call(document.querySelectorAll("main .tile")).filter(function (q) { return re.test(q.innerText.trim()); })[0]; return x ? x.innerText : ""; };
    var sums = {};
    await nav("Overview"); await need("the tiles", function () { return tile(/^Spent/i); });
    sums.hourOverview = usdIn(tile(/^Spent/i)); sums.hourStoppedOverview = Number((/([0-9]+) payments? refused/.exec(tile(/^Stopped/i)) || [0, 0])[1]);
    await nav("Agents"); var ya = await need("the agents table", function () { return cardOf(/^Your agents/i); });
    sums.hourAgents = column(ya, 3, usdIn); sums.hourStoppedAgents = column(ya, 4, function (t) { return Number((/\/\s*([0-9]+)/.exec(t) || [0, 0])[1]); });
    await nav("Sellers"); var th = await need("the sellers table", function () { var c = cardOf(/^This hour/i); return c && c.querySelector("tbody tr") ? c : null; });
    sums.hourSellers = column(th, 2, usdIn); sums.hourStoppedSellers = column(th, 3, function (t) { return Number((/\u00b7\s*([0-9]+)/.exec(t) || [0, 0])[1]); });
    var sw = await need("the sellers' week", function () { return document.getElementById("slWeek"); }); sums.weekSellers = column(sw, 1, usdIn);
    await nav("Agents"); var aw = await need("the agents' week", function () { return document.getElementById("agWeek"); }); sums.weekAgents = column(aw, 1, usdIn);
    await nav("Report"); await need("the report", function () { return document.getElementById("repWhy"); });
    sums.weekReport = usdIn(tile(/^Paid\s/i)); sums.weekStoppedReport = Number((/^Stopped\s+([0-9]+)/i.exec(tile(/^Stopped/i).replace(/\n/g, " ")) || [0, 0])[1]);
    sums.weekReportAgents = column(cardOf(/^By agent/i), 2, usdIn); sums.weekReportSellers = column(cardOf(/^By seller/i), 2, usdIn);
    sums.weekStoppedWhy = column(document.getElementById("repWhy"), 1, function (t) { return Number((/^\s*([0-9]+)/.exec(t) || [0, 0])[1]); });
    sums.weekStoppedAgents = column(cardOf(/^By agent/i), 3, function (t) { return Number((/([0-9]+)\s*$/.exec(t.replace(/\$[0-9.]+/g, "").trim()) || /^\s*([0-9]+)/.exec(t) || [0, 0])[1]); });
    out.sums = sums;
    // 3. the report's three periods
    await nav("Report");
    for (var c = 0; c < 3; c++) {
      (await need("a period", function () { return document.querySelectorAll(".chips .chip")[c]; })).click();
      await sleep(200); await need("the report", function () { return document.getElementById("repWhy"); });
      look("Report, period " + (c + 1));
    }
    // 4. every agent's and every seller's page, and a watch
    var each = async function (tab, re) {
      await nav(tab);
      var links = await need("links on " + tab, function () { var l = [].slice.call(document.querySelectorAll("main a.lnk")).map(function (x) { return x.getAttribute("href"); }).filter(function (hh, k, all) { return re.test(hh) && all.indexOf(hh) === k; }); return l.length ? l : null; });
      for (var k = 0; k < links.length; k++) {
        await nav(tab);
        (await need(links[k], function () { return [].slice.call(document.querySelectorAll("main a.lnk")).filter(function (x) { return x.getAttribute("href") === links[k]; })[0]; })).click();
        await need("a crumb", function () { return document.querySelector("main .crumb"); });
        look(links[k]);
      }
      return links.length;
    };
    out.agents = await each("Agents", /^#agent\//);
    out.sellers = await each("Sellers", /^#seller\//);
    await nav("Agents"); await sleep(300);
    var watch = DEMO ? await need("a watch", function () { return document.querySelector("#watches tr.clk"); }) : document.querySelector("#watches tr.clk");
    if (watch) { watch.click(); await need("a crumb", function () { return document.querySelector("main .crumb"); }); look("a watch"); }
    // 5. what the owner does
    await nav("Approvals"); await sleep(300);
    if (DEMO) (await btn(/^Approve$/)).click(); else out.approved = maybe(/^Approve$/, "main");
    await sleep(DEMO ? 200 : 1500); look("approved");
    await nav("Approvals"); await sleep(300);
    if (DEMO) (await btn(/^Deny$/)).click(); else maybe(/^Deny$/, "main");
    await sleep(200); look("denied");
    (await btn(/^Pause all payments$/)).click(); await btn(/^Resume payments$/); look("everything paused");
    (await btn(/^Resume payments$/)).click(); await btn(/^Pause all payments$/);
    await nav("Agents"); (await btn(/^Pause$/, "main")).click(); await btn(/^Resume$/, "main"); look("one agent paused");
    (await btn(/^Resume$/, "main")).click(); await sleep(200);
    await nav("Rules");
    type(await need("the first amount", function () { return document.querySelector("main .money input"); }), "abc");
    (await btn(/^Save rules$/)).click();
    out.refusedValue = (await need("the refusal", function () { return document.querySelector("main .err") && document.querySelector("main .err").innerText; }));
    look("a refused value");
    await nav("Sellers"); await nav("Rules");
    type(await need("the first amount", function () { return document.querySelector("main .money input"); }), "0.08");
    (await btn(/^Save rules$/)).click(); await need("saved", function () { return document.querySelector("main .okmsg"); }); look("a saved rule");
    // The real console would send its messages: they go to a closed port on this machine, never to a real channel.
    if (!DEMO) type(await need("the kind of channel", function () { return document.getElementById("alKind"); }), "webhook");
    await sleep(200);
    type(await need("the alert address", function () { return document.getElementById("alUrl"); }), DEMO ? "https://discord.com/api/webhooks/123456789/abcDEF_ghi" : "http://127.0.0.1:9/walk");
    (await btn(/^Turn on alerts$/)).click();
    (await need("the kinds of message", function () { return document.getElementById("ev-rules"); })).click(); await sleep(200);
    out.changes = (await need("the list of changes", function () { return document.getElementById("ruleChg"); })).querySelectorAll("tbody tr").length;
    look("alerts on, a kind switched off");
    await nav("Sellers");
    type(await need("the seller box", function () { return document.getElementById("ownHost"); }), "shady.example");
    (await btn(/^Block$/)).click(); await need("the blocked seller", function () { return document.querySelector("#slOwn tbody tr"); });
    // Two of them: a count that is right for one item and wrong for two is the slip this walk exists for.
    type(await need("the seller box", function () { return document.getElementById("ownHost"); }), "other.example");
    (await btn(/^Block$/)).click(); await need("two blocked sellers", function () { return document.querySelectorAll("#slOwn tbody tr").length >= 2; }); look("two sellers blocked");
    await nav("Report"); await need("the report", function () { return document.getElementById("repChg"); }); look("the report after the changes");
    (await need("the theme button", function () { return buttons().filter(function (x) { return x.innerText.trim() === "Dark"; })[0]; })).click();
    await nav("Overview"); look("Overview, dark");
  } catch (e) {
    // What was on the screen when it stopped, for whoever reads the failure.
    out.threw = String(e && e.message || e) + " | buttons: " + buttons(document.querySelector("main")).map(function (x) { return x.innerText.trim().slice(0, 24); }).slice(0, 30).join(", ") + " | " + ((document.querySelector("main .err") || {}).innerText || "");
  }
  return JSON.stringify(out);
})()
