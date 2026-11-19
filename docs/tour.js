(function () {
  "use strict";
  var tour = document.getElementById("tour"), img = document.getElementById("timg");
  if (!tour || !img) return;
  var btns = Array.prototype.slice.call(tour.querySelectorAll(".tnav button")), i = 0, touched = false;
  function show(n) {
    i = n;
    btns.forEach(function (b, k) { b.classList.toggle("on", k === n); b.setAttribute("aria-pressed", k === n ? "true" : "false"); });
    img.src = "shots/" + btns[n].dataset.shot + ".jpg"; img.alt = btns[n].dataset.alt;
  }
  btns.forEach(function (b, k) { b.addEventListener("click", function () { touched = true; show(k); }); });
  btns.forEach(function (b) { var p = new Image(); p.src = "shots/" + b.dataset.shot + ".jpg"; });
  if (!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches))
    setInterval(function () { if (!touched && !document.hidden) show((i + 1) % btns.length); }, 4500);
  window.__asfTour = { show: show };

  // Sections rise into place as they are scrolled to; big numbers count up once.
  var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || !("IntersectionObserver" in window)) return;
  var targets = Array.prototype.slice.call(document.querySelectorAll("section .thead, section .frame, section .tour, .tl, .num, .plan, .claim, .step, section table"));
  var vh = window.innerHeight;
  targets.forEach(function (el) { if (el.getBoundingClientRect().top > vh * 0.9) el.classList.add("rv"); });
  function count(el) {
    var m = /^(\D*)(\d[\d,]*)(.*)$/.exec(el.textContent); if (!m) return;
    var to = Number(m[2].replace(/,/g, "")), t0 = null; if (!(to > 0)) return;
    requestAnimationFrame(function f(ts) {
      if (t0 == null) t0 = ts; var k = Math.min(1, (ts - t0) / 900), e = 1 - Math.pow(1 - k, 3);
      el.textContent = m[1] + Math.round(to * e).toLocaleString("en-US") + m[3]; if (k < 1) requestAnimationFrame(f);
    });
  }
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in"); io.unobserve(e.target);
      if (e.target.classList.contains("num")) { var b = e.target.querySelector("b"); if (b) count(b); }
    });
  }, { rootMargin: "0px 0px -8% 0px" });
  targets.forEach(function (el) { io.observe(el); });
  // Belt and braces: content must never stay hidden if the observer does not fire.
  function sweep() {
    var hgt = window.innerHeight;
    targets.forEach(function (el) { if (el.classList.contains("rv") && !el.classList.contains("in") && el.getBoundingClientRect().top < hgt * 0.95) { el.classList.add("in"); if (el.classList.contains("num")) { var b = el.querySelector("b"); if (b) count(b); } } });
  }
  window.addEventListener("scroll", sweep, { passive: true }); window.addEventListener("resize", sweep);
})();
