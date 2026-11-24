// Runs inside the landing page (docs/index.html) in a headless browser: test/walk.test.ts.
// Presses what a visitor would press and collects what is broken: a link that leads nowhere, a picture that did not load,
// a script error, a programming slip in the text and, on a phone-sized screen, anything that reaches past the edge.
(async function () {
  var out = { findings: [], errors: [], repoPaths: [], pressed: 0, pictures: 0, links: 0 };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  window.addEventListener("error", function (e) { out.errors.push(String(e.message || (e.target && (e.target.src || e.target.href)) || "error").slice(0, 200)); }, true);
  window.addEventListener("unhandledrejection", function (e) { out.errors.push("rejection: " + String((e.reason && e.reason.message) || e.reason).slice(0, 200)); });
  // Waits for something to be there. The limit is a guard against hanging, not a statement about speed.
  var need = async function (what, get) { for (var i = 0; i < 600; i++) { var v = get(); if (v) return v; await sleep(50); } throw new Error("never appeared: " + what); };
  var SLIP = /[^\n]*(\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date|\bnull\b|\bInfinity\b)[^\n]*/gi;
  var slips = function (where) { var m = document.body.innerText.match(SLIP); if (m) m.slice(0, 5).forEach(function (line) { out.findings.push(where + ": " + line.trim().slice(0, 160)); }); };
  var wide = function (where) {
    if (!window.__PHONE) return;
    var w = window.innerWidth, page = document.documentElement.scrollWidth;
    out.width = w;
    if (page > w + 1) out.findings.push(where + ": the page scrolls sideways (" + page + " wide on a " + w + " screen)");
  };
  try {
    slips("as loaded"); wide("as loaded");
    // 1. links: a part of this page must exist, a page of this site must answer, a file in the repository is checked by the test
    var links = [].slice.call(document.querySelectorAll("a[href]"));
    out.links = links.length;
    for (var i = 0; i < links.length; i++) {
      var raw = links[i].getAttribute("href"), text = links[i].innerText.trim().slice(0, 40) || raw;
      if (raw === "#") continue;                                           // the name in the corner: back to the top
      if (raw.charAt(0) === "#") { if (!document.getElementById(raw.slice(1))) out.findings.push("link “" + text + "”: no part of the page is called " + raw); continue; }
      var repo = /^https:\/\/github\.com\/dyzdy00-prog\/agent-spend-firewall\/(?:blob|tree)\/main\/([^?#]+)/.exec(raw);
      if (repo) { out.repoPaths.push(repo[1]); continue; }
      if (/^https?:/.test(raw)) continue;                                  // other sites are not asked from a test
      var r = await fetch(raw.split("#")[0], { method: "GET" });
      if (!r.ok) out.findings.push("link “" + text + "”: " + raw + " answered " + r.status);
    }
    // 2. pictures
    var check = function (where) { [].slice.call(document.images).forEach(function (im) { if (im.complete && im.naturalWidth === 0) out.findings.push(where + ": the picture " + im.getAttribute("src") + " did not load"); }); };
    await need("the pictures", function () { return [].slice.call(document.images).every(function (im) { return im.complete; }); });
    out.pictures = document.images.length; check("as loaded");
    // 3. the scene at the top: every button, then a new hour
    var acts = [].slice.call(document.querySelectorAll("button.act[data-a]"));
    for (var a = 0; a < acts.length; a++) { acts[a].scrollIntoView({ block: "center" }); acts[a].click(); out.pressed++; await sleep(acts[a].getAttribute("data-a") === "loop" ? 2500 : 900); }
    slips("after the scene's buttons"); wide("after the scene's buttons");
    var reset = document.getElementById("reset"); if (reset) { reset.click(); out.pressed++; await sleep(300); }
    // 4. the tour: every picture
    var tour = [].slice.call(document.querySelectorAll(".tnav button"));
    for (var t = 0; t < tour.length; t++) {
      tour[t].scrollIntoView({ block: "center" }); tour[t].click(); out.pressed++;
      var want = "shots/" + tour[t].getAttribute("data-shot") + ".jpg";
      await need("the tour picture " + want, function () { var im = document.getElementById("timg"); return im && im.getAttribute("src") === want && im.complete; });
      if (document.getElementById("timg").naturalWidth === 0) out.findings.push("tour: the picture " + want + " did not load");
    }
    // 5. the recording of the live run
    var play = document.getElementById("recPlay"); if (play) { play.scrollIntoView({ block: "center" }); play.click(); out.pressed++; await sleep(1500); }
    // 6. every part of the page, top to bottom
    var parts = [].slice.call(document.querySelectorAll("section[id]"));
    out.parts = parts.length;
    for (var p = 0; p < parts.length; p++) { parts[p].scrollIntoView(); await sleep(120); }
    check("at the end"); slips("at the end"); wide("at the end");
    if (window.__PHONE) {
      [].slice.call(document.querySelectorAll("section *")).some(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right <= window.innerWidth + 2) return false;
        for (var q = el.parentElement; q && q !== document.body; q = q.parentElement) { var o = getComputedStyle(q).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return false; }
        out.findings.push("reaches past the screen: <" + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.split(" ")[0] : "") + "> to " + Math.round(r.right) + " of " + window.innerWidth + ", in #" + ((el.closest("section[id]") || {}).id || "?"));
        return out.findings.length > 8;
      });
    }
  } catch (e) { out.threw = String(e && e.message || e); }
  return JSON.stringify(out);
})()
