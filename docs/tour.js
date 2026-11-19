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
})();
