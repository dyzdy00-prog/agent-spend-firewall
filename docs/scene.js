// A small software 3D renderer for the landing page: flat-shaded convex faces, painter's order,
// drawn in grey and printed in one ink colour through an ordered (Bayer) dither. No libraries, no models.
// World: x to the right (agent → seller), y up, z toward the viewer. The plinth top is y = 0.
window.ASFScene = (function () {
  "use strict";
  var TAU = 6.283185307, INK = [11, 93, 64];
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  var L = norm([-0.45, 0.8, 0.55]);
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

  // ---- geometry builders (faces wound counter-clockwise seen from outside)
  function box(x0, y0, z0, x1, y1, z1, tone, edge) {
    var f = [
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]];
    return f.map(function (v) { return { v: v, tone: tone, edge: edge !== false }; });
  }
  function disc(r, t, seg, tone) {         // coin-like cylinder around the z axis, centred on the origin
    var front = [], back = [], faces = [], i, a, b;
    for (i = 0; i < seg; i++) { a = i / seg * TAU; front.push([r * Math.cos(a), r * Math.sin(a), t / 2]); back.unshift([r * Math.cos(a), r * Math.sin(a), -t / 2]); }
    faces.push({ v: front, tone: tone, edge: true, cap: 1 }, { v: back, tone: tone, edge: true, cap: -1 });
    for (i = 0; i < seg; i++) {
      a = i / seg * TAU; b = (i + 1) / seg * TAU;
      faces.push({ v: [[r * Math.cos(a), r * Math.sin(a), t / 2], [r * Math.cos(a), r * Math.sin(a), -t / 2], [r * Math.cos(b), r * Math.sin(b), -t / 2], [r * Math.cos(b), r * Math.sin(b), t / 2]], tone: tone * .8, edge: false });
    }
    return faces;
  }
  function xf(faces, m, t) {               // rotate by 3x3 matrix m, translate by t
    return faces.map(function (f) {
      var o = { tone: f.tone, edge: f.edge, cap: f.cap, lines: null };
      o.v = f.v.map(function (p) { return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + t[0], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + t[1], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + t[2]]; });
      if (f.lines) o.lines = f.lines.map(function (s) { return s.map(function (p) { return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + t[0], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + t[1], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + t[2]]; }); });
      return o;
    });
  }
  function rot(ax, ay, az) {               // R = Ry * Rx * Rz
    var cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    return [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx, cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx];
  }
  var I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  // ---- static world
  var R = 10.5, TZ = 0.9;                  // plinth radius, track z
  var statics = [];
  function add(faces) { statics.push.apply(statics, faces); return faces; }
  // agent: a boxy robot holding a token card
  add(box(-9.6, 0, TZ - .9, -9.0, .5, TZ + .9, .35)); add(box(-8.2, 0, TZ - .9, -7.6, .5, TZ + .9, .35));
  var body = add(box(-9.8, .5, TZ - 1, -7.4, 3.1, TZ + 1, .95));
  body[0].lines = [[[-9.3, 2.5, TZ + 1.01], [-7.9, 2.5, TZ + 1.01]], [[-9.3, 2.5, TZ + 1.01], [-9.3, 1.5, TZ + 1.01]], [[-9.3, 1.5, TZ + 1.01], [-7.9, 1.5, TZ + 1.01]], [[-7.9, 1.5, TZ + 1.01], [-7.9, 2.5, TZ + 1.01]], [[-9.05, 2.15, TZ + 1.01], [-8.4, 2.15, TZ + 1.01]], [[-9.05, 1.85, TZ + 1.01], [-8.1, 1.85, TZ + 1.01]]];
  var head = add(box(-9.5, 3.3, TZ - .8, -7.7, 4.7, TZ + .8, 1));
  head[0].eyes = true;
  add(box(-8.7, 4.7, TZ - .1, -8.5, 5.6, TZ + .1, .3)); add(box(-8.85, 5.6, TZ - .25, -8.35, 6.1, TZ + .25, .3));
  // seller: a kiosk with an awning
  var kiosk = add(box(7.4, 0, TZ - 1.3, 10.0, 3.2, TZ + 1.3, .97));
  kiosk[0].win = true;
  add([{ v: [[7.1, 3.2, TZ + 1.9], [10.3, 3.2, TZ + 1.9], [10.1, 4.2, TZ + .4], [7.3, 4.2, TZ + .4]], tone: .55, edge: true },
    { v: [[7.3, 4.2, TZ + .4], [10.1, 4.2, TZ + .4], [10.1, 4.2, TZ - 1.4], [7.3, 4.2, TZ - 1.4]], tone: .7, edge: true },
    { v: [[10.3, 3.2, TZ + 1.9], [10.3, 3.2, TZ - 1.4], [10.1, 4.2, TZ - 1.4], [10.1, 4.2, TZ + .4]], tone: .5, edge: true },
    { v: [[7.1, 3.2, TZ - 1.4], [7.1, 3.2, TZ + 1.9], [7.3, 4.2, TZ + .4], [7.3, 4.2, TZ - 1.4]], tone: .5, edge: true }]);
  // firewall: post, shield sign, key box
  add(box(-.4, 0, -1.9, .4, 4.9, -1.1, .8));
  add(box(-.7, 0, -2.2, .7, .5, -.8, .45));
  var sh = [[0, 0], [1.25, .55], [1.25, 1.75], [0, 3.1], [-1.25, 1.75], [-1.25, .55]].map(function (p) { return [p[0], 8.1 - p[1], 0]; });  // drawn point-up, flipped below
  var shield = [[0, 4.9], [1.45, 5.9], [1.45, 7.5], [0, 8.2], [-1.45, 7.5], [-1.45, 5.9]];
  var zf = -1.1, zb = -1.6;
  var sFront = { v: shield.map(function (p) { return [p[0], p[1], zf]; }), tone: .32, edge: true, lines: [[[-.65, 6.6, zf + .02], [-.15, 6.05, zf + .02]], [[-.15, 6.05, zf + .02], [.75, 7.2, zf + .02]]], white: true };
  var sBack = { v: shield.slice().reverse().map(function (p) { return [p[0], p[1], zb]; }), tone: .3, edge: true };
  add([sFront, sBack]);
  shield.forEach(function (p, i) { var q = shield[(i + 1) % shield.length]; add([{ v: [[p[0], p[1], zf], [p[0], p[1], zb], [q[0], q[1], zb], [q[0], q[1], zf]], tone: .25, edge: true }]); });
  void sh;
  var keyBox = add(box(1.3, 0, -2.6, 3.7, 1.5, -1.2, .3));
  keyBox[0].lines = [[[2.2, .75, -1.19], [3.3, .75, -1.19]], [[3.0, .75, -1.19], [3.0, .45, -1.19]], [[3.3, .75, -1.19], [3.3, .5, -1.19]]];
  keyBox[0].ring = [1.95, .75, -1.19, .26]; keyBox[0].white = true;

  var COIN = disc(1.0, .3, 22, .92), COIN_BIG = disc(1.45, .34, 26, .92), PROBE = box(-.75, -.75, -.16, .75, .75, .16, 1);
  var PARCEL = box(-.62, -.42, -.34, .62, .42, .34, 1);
  PARCEL[0].lines = [[[-.4, .18, .35], [.4, .18, .35]], [[-.4, 0, .35], [.4, 0, .35]], [[-.4, -.18, .35], [.1, -.18, .35]]];
  var ARM = []; for (var s = 0; s < 6; s++) ARM.push.apply(ARM, box(-.24, -.24, s * .68, .24, .24, s * .68 + .68, s % 2 ? .2 : 1));

  // ---- renderer
  function create(canvas, host) {
    var out = canvas.getContext("2d"), off = document.createElement("canvas"), g = off.getContext("2d", { willReadFrequently: true });
    var W = 0, H = 0, f = 1, cx = 0, cy = 0, yaw = -.3, pitch = .34, tyaw = -.3, tpitch = .34, cam = { cy: 1, sy: 0, cp: 1, sp: 0 }, DIST = 34;
    function size() {
      var css = host.clientWidth || 800, ch = host.clientHeight || 420, dpr = window.devicePixelRatio || 1;
      var m = Math.max(1, Math.round((css >= 900 ? 2 : css >= 560 ? 1.5 : 1) * dpr));
      W = Math.max(240, Math.round(css * dpr / m)); H = Math.max(160, Math.round(ch * dpr / m));
      canvas.width = off.width = W; canvas.height = off.height = H;
      var wide = css >= 900; f = Math.min(W * (wide ? .7 : 1.0), H * 1.72); cx = W * (wide ? .68 : .5); cy = H * .54;
    }
    function toCam(p) {                    // world → camera space (z = depth)
      var x = p[0], y = p[1] - 2.4, z = p[2];
      var x1 = cam.cy * x + cam.sy * z, z1 = -cam.sy * x + cam.cy * z;
      var y2 = cam.cp * y - cam.sp * z1, z2 = cam.sp * y + cam.cp * z1;
      return [x1, y2, DIST - z2];
    }
    function scr(c) { var k = f / c[2]; return [cx + c[0] * k, cy - c[1] * k]; }
    function project(p) { var s = scr(toCam(p)); return [s[0] / W, s[1] / H]; }
    function poly(pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); }
    function grey(v) { v = Math.max(0, Math.min(255, Math.round(v))); return "rgb(" + v + "," + v + "," + v + ")"; }
    function drawFaces(faces, sort) {
      var list = [], i, j;
      for (i = 0; i < faces.length; i++) {
        var fc = faces[i], v = fc.v, c = [], s = [], zs = 0;
        for (j = 0; j < v.length; j++) { var q = toCam(v[j]); c.push(q); s.push(scr(q)); zs += q[2]; }
        var area = 0; for (j = 0; j < s.length; j++) { var n2 = s[(j + 1) % s.length]; area += s[j][0] * n2[1] - n2[0] * s[j][1]; }
        if (area >= 0) continue;           // back face
        var a = v[0], b = v[1], d = v[2], ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
        var n = norm([uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx]);
        var lum = .38 + .62 * Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
        list.push({ f: fc, s: s, z: zs / v.length, g: 255 * Math.min(1, fc.tone * lum * 1.12) * (fc.alpha == null ? 1 : fc.alpha) + 255 * (fc.alpha == null ? 0 : 1 - fc.alpha) });
      }
      if (sort) list.sort(function (p, q) { return q.z - p.z; });
      var lw = Math.max(1, W / 620);
      for (i = 0; i < list.length; i++) {
        var it = list[i]; poly(it.s); g.fillStyle = grey(it.g); g.fill();
        if (it.f.edge) { g.lineWidth = lw; g.strokeStyle = it.f.alpha == null ? "#000" : grey(255 * (1 - it.f.alpha)); g.stroke(); }
        var fl = it.f.lines;
        if (fl) { g.lineWidth = lw * (it.f.white ? 2.2 : 1.3); g.strokeStyle = it.f.white ? "#fff" : "#000"; g.beginPath(); for (j = 0; j < fl.length; j++) { var p0 = scr(toCam(fl[j][0])), p1 = scr(toCam(fl[j][1])); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); } g.stroke(); }
        if (it.f.ring) { var rc = it.f.ring, pts = []; for (j = 0; j < 14; j++) pts.push(scr(toCam([rc[0] + Math.cos(j / 14 * TAU) * rc[3], rc[1] + Math.sin(j / 14 * TAU) * rc[3], rc[2]]))); poly(pts); g.lineWidth = lw * 2.2; g.strokeStyle = "#fff"; g.stroke(); }
        if (it.f.extra) it.f.extra(it);
      }
    }
    function loop3(fn, n, close) { var pts = []; for (var i = 0; i <= n; i++) pts.push(scr(toCam(fn(i / n * TAU)))); g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); if (close) g.closePath(); g.stroke(); }

    function render(t, st) {
      yaw += (tyaw - yaw) * .06; pitch += (tpitch - pitch) * .06;
      var sway = Math.sin(t / 5200) * .05;
      cam.cy = Math.cos(yaw + sway); cam.sy = Math.sin(yaw + sway); cam.cp = Math.cos(pitch); cam.sp = Math.sin(pitch);
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
      g.lineJoin = "round"; g.lineCap = "round";
      // floor: a dotted field that fades away from the plinth
      var c0 = scr(toCam([0, -1.2, 0])), rx = f * 17 / DIST;
      g.save(); g.translate(c0[0], c0[1]); g.scale(1, Math.max(.2, cam.sp * 1.05));
      var fg = g.createRadialGradient(0, 0, rx * .25, 0, 0, rx); fg.addColorStop(0, "rgb(120,120,120)"); fg.addColorStop(.42, "rgb(196,196,196)"); fg.addColorStop(.75, "rgb(238,238,238)"); fg.addColorStop(1, "rgb(255,255,255)");
      g.fillStyle = fg; g.beginPath(); g.arc(0, 0, rx, 0, TAU); g.fill(); g.restore();
      // plinth: reeded edge and engraved top, like a large coin
      var SEG = 72, side = [], top = [], i, a, b;
      for (i = 0; i < SEG; i++) {
        a = i / SEG * TAU; b = (i + 1) / SEG * TAU; top.push([R * Math.cos(a), 0, -R * Math.sin(a)]);
        side.push({ v: [[R * Math.cos(a), 0, -R * Math.sin(a)], [R * Math.cos(a), -1.2, -R * Math.sin(a)], [R * Math.cos(b), -1.2, -R * Math.sin(b)], [R * Math.cos(b), 0, -R * Math.sin(b)]], tone: i % 2 ? .5 : .82, edge: false });
      }
      drawFaces(side, false); drawFaces([{ v: top, tone: 1.2, edge: true }], false);
      var lw = Math.max(1, W / 620), spin = t / 14000;
      g.strokeStyle = grey(70); g.lineWidth = lw;
      loop3(function (q) { return [9.7 * Math.cos(q), 0, 9.7 * Math.sin(q)]; }, 72, true);
      loop3(function (q) { return [9.2 * Math.cos(q), 0, 9.2 * Math.sin(q)]; }, 72, true);
      g.strokeStyle = grey(120); g.lineWidth = lw * .8;
      for (i = 0; i < 16; i++) (function (k) { var o = k / 16 * TAU + spin; loop3(function (q) { return [5.4 * Math.cos(o) + 3.3 * Math.cos(q), 0, 5.4 * Math.sin(o) + 3.3 * Math.sin(q)]; }, 28, true); })(i);
      for (i = 0; i < 48; i++) { a = i / 48 * TAU + spin * .5; var p0 = scr(toCam([9.2 * Math.cos(a), 0, 9.2 * Math.sin(a)])), p1 = scr(toCam([9.7 * Math.cos(a), 0, 9.7 * Math.sin(a)])); g.beginPath(); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.stroke(); }
      // track
      g.strokeStyle = "#000"; g.lineWidth = lw * 1.2; g.setLineDash([lw * 5, lw * 4]);
      var ta = scr(toCam([-7.2, 0, TZ])), tb = scr(toCam([7.3, 0, TZ])); g.beginPath(); g.moveTo(ta[0], ta[1]); g.lineTo(tb[0], tb[1]); g.stroke(); g.setLineDash([]);

      // everything standing on the plinth, sorted back to front
      var dyn = statics.slice();
      var blink = (t % 3400) < 140;
      head[0].extra = function () {
        g.fillStyle = "#000";
        [[-9.05, 4.15], [-8.2, 4.15]].forEach(function (e) { var p = [[e[0] - .17, e[1] - (blink ? .03 : .2)], [e[0] + .17, e[1] - (blink ? .03 : .2)], [e[0] + .17, e[1] + (blink ? .03 : .2)], [e[0] - .17, e[1] + (blink ? .03 : .2)]].map(function (q) { return scr(toCam([q[0], q[1], TZ + .81])); }); poly(p); g.fill(); });
      };
      kiosk[0].extra = function () {
        var fx = st.sellerFx, w = [[7.8, 1.5], [9.0, 1.5], [9.0, 2.6], [7.8, 2.6]].map(function (q) { return scr(toCam([q[0], q[1], TZ + 1.31])); });
        poly(w); g.fillStyle = fx ? "#fff" : grey(70); g.fill(); g.lineWidth = lw; g.strokeStyle = "#000"; g.stroke();
        var d = [[9.25, 0], [9.8, 0], [9.8, 2.3], [9.25, 2.3]].map(function (q) { return scr(toCam([q[0], q[1], TZ + 1.31])); }); poly(d); g.fillStyle = grey(190); g.fill(); g.stroke();
        if (fx) { var m = function (x, y) { return scr(toCam([x, y, TZ + 1.32])); }, segs = fx.bad ? [[m(7.95, 1.65), m(8.85, 2.45)], [m(8.85, 1.65), m(7.95, 2.45)]] : [[m(7.95, 2.05), m(8.3, 1.7)], [m(8.3, 1.7), m(8.85, 2.45)]];
          g.lineWidth = lw * 2.4; g.beginPath(); segs.forEach(function (sg) { g.moveTo(sg[0][0], sg[0][1]); g.lineTo(sg[1][0], sg[1][1]); }); g.stroke(); }
      };
      // barrier arm: pivots at the post, lies across the track when closed
      dyn.push.apply(dyn, xf(ARM, rot(-st.arm * 1.35 + st.shake, 0, 0), [0, 1.35, -1.0]));
      // coins
      st.coins.forEach(function (c) {
        var mesh = c.probe ? PROBE : c.big ? COIN_BIG : COIN, r = c.big ? 1.45 : 1.0;
        var faces = xf(mesh, rot(c.rx || 0, c.ry || 0, c.rz || 0), [c.x, (c.y == null ? r : c.y), c.z == null ? TZ : c.z]);
        var sc = c.scale == null ? 1 : c.scale;
        faces.forEach(function (fc) {
          if (sc !== 1) fc.v = fc.v.map(function (p) { return [c.x + (p[0] - c.x) * sc, (c.y == null ? r : c.y) + (p[1] - (c.y == null ? r : c.y)) * sc, p[2]]; });
          if (c.alpha != null && c.alpha < 1) fc.alpha = Math.max(0, c.alpha);
          if (fc.cap === 1 && !c.probe) {
            var m = rot(c.rx || 0, c.ry || 0, c.rz || 0), o = [c.x, (c.y == null ? r : c.y), c.z == null ? TZ : c.z], zz = (c.big ? .17 : .15) + .01, k = r * sc;
            var P = function (x, y) { return [m[0] * x * k + m[1] * y * k + m[2] * zz + o[0], m[3] * x * k + m[4] * y * k + m[5] * zz + o[1], m[6] * x * k + m[7] * y * k + m[8] * zz + o[2]]; };
            fc.lines = [[P(0, -.62), P(0, .62)], [P(-.3, .3), P(.3, .3)], [P(-.3, .3), P(-.3, 0)], [P(-.3, 0), P(.3, 0)], [P(.3, 0), P(.3, -.3)], [P(.3, -.3), P(-.3, -.3)]];
            if (c.refused) fc.lines.push([P(-.8, -.8), P(.8, .8)], [P(.8, -.8), P(-.8, .8)]);
            fc.extra = function () { var ring = []; for (var q = 0; q < 20; q++) ring.push(scr(toCam(P(.78 * Math.cos(q / 20 * TAU), .78 * Math.sin(q / 20 * TAU))))); poly(ring); g.lineWidth = lw * .9; g.strokeStyle = fc.alpha == null ? grey(60) : grey(255 - 195 * fc.alpha); g.stroke(); };
          }
        });
        dyn.push.apply(dyn, faces);
      });
      (st.parcels || []).forEach(function (p) {
        dyn.push.apply(dyn, xf(PARCEL, rot(0, 0, Math.sin(p.x * 1.7) * .08), [p.x, .62 + Math.abs(Math.sin(p.x * 2.4)) * .5, TZ + 2.1]));
      });
      drawFaces(dyn, true);

      // print: one ink through an ordered dither
      var src = g.getImageData(0, 0, W, H).data, img = out.createImageData(W, H), d = img.data;
      for (var y = 0, p = 0; y < H; y++) for (var x = 0; x < W; x++, p += 4) {
        if (src[p] < (BAYER[(y & 3) * 4 + (x & 3)] + .5) * 15.94) { d[p] = INK[0]; d[p + 1] = INK[1]; d[p + 2] = INK[2]; d[p + 3] = 255; }
      }
      out.putImageData(img, 0, 0);
    }
    function look(nx, ny) { tyaw = -.3 + nx * .32; tpitch = .34 - ny * .1; }
    size();
    return { size: size, render: render, project: project, look: look };
  }
  return { create: create };
})();
