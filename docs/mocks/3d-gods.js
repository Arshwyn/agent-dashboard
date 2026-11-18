// 3D prototype for the agent hub bodies: a soft glass orb that expands into a hologram bust on click.
// Classic script: uses the global THREE from vendor/three.min.js (a subset bundle), so the page needs no build.
// Everything except the optional scanned heads (models/*.glb, sampled into points) is generated here.
// There is deliberately no flat fallback: without WebGL 2 the stage shows a text message.
(function () {
  'use strict';

  var stage = document.getElementById('stage3d');
  var canvas = stage.querySelector('canvas');
  var perfEl = document.getElementById('perf');
  var hintEl = document.getElementById('hint');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var params = new URLSearchParams(window.location.search);

  var CFG = {
    particles: 7000,
    fov: 40,
    morphSpeed: 0.55, // full expand in about 1.8 s
    dprCap: window.innerWidth < 700 ? 1.5 : 2,
    slowMs: 34, // average frame interval that triggers a step down
    scanPoints: 3000, // points sampled per scanned model
  };

  // ---------- the eight gods: palette, scan, attributes, sample chat ----------
  // Palette tones feed the shaders (a: main, b: second, c: highlight). Attributes are built in code below.
  var GODS = [
    {
      id: 'hephaestus',
      name: 'Hephaestus',
      role: 'Builder',
      pal: ['#ff9a1f', '#ff5a1f', '#ffd08a'],
      attrs: [],
      fallback: ['cap', 'beard', 'anvil', 'hammer'], // only while no scan is loaded: the Vulcan statue carries its own
      you: 'Is the dashboard change ready for review?',
      reply:
        'Built and pushed on its own branch. Tests green, lint clean, three small commits. Passing it to the gate now.',
    },
    {
      id: 'themis',
      name: 'Themis',
      role: 'Quality gate',
      pal: ['#9bb8ff', '#e9c46a', '#f2f6ff'],
      attrs: ['band', 'scales'],
      you: 'Did the checks pass?',
      reply: 'Every check ran and held. One naming note is logged for later; nothing blocks the merge.',
    },
    {
      id: 'janus',
      name: 'Janus',
      role: 'Gatekeeper',
      pal: ['#5ad1d6', '#c27bf0', '#e8eef7'],
      attrs: ['door', 'key'],
      you: 'Anything blocking the merge?',
      reply:
        'Both doors checked. No critical findings; one medium goes to the backlog. The gate cleared this same commit, so I may open the way.',
    },
    {
      id: 'atlas',
      name: 'Atlas',
      role: 'Operator',
      pal: ['#6aa0ff', '#3b5bd6', '#e0ecff'],
      attrs: [],
      fallback: ['sky'], // the Atlas scan carries its own globe
      you: 'Is the new version running?',
      reply: 'It is. Deployed, the health check is green, and the previous version is kept in reserve.',
    },
    {
      id: 'plutus',
      name: 'Plutus',
      role: 'Finance',
      pal: ['#3fbf7a', '#d6a82a', '#eaffd8'],
      attrs: ['crown', 'coin'],
      you: 'How are the savings tracking this month?',
      reply:
        'Steady. Spending stayed under plan and nothing needs moving today. I would not trade on a hunch.',
    },
    {
      id: 'apollo',
      name: 'Apollo',
      role: 'Coach',
      pal: ['#ffd24a', '#8fbf6a', '#fff3bd'],
      attrs: ['laurel', 'lyre'],
      you: 'How did recovery look this week?',
      reply:
        'A calm week. Rest held steady and effort stayed in range. Keep tomorrow easy and let the daylight do some of the work.',
    },
    {
      id: 'iris',
      name: 'Iris',
      role: 'Mail and calendar',
      pal: ['#ff7ac8', '#5ad1ff', '#ffe27a'],
      attrs: ['veil', 'rainbow'],
      you: 'What is on tomorrow?',
      reply:
        'A light day: two meetings and one draft reply waiting for your approval. Nothing is sent until you say so.',
    },
    {
      id: 'dionysus',
      name: 'Dionysus',
      role: 'Travel and food',
      pal: ['#b04ad6', '#e0456a', '#f0d0ff'],
      attrs: [],
      fallback: ['ivy'], // the Bacchus scan carries its own vine
      you: 'Where should we eat on Friday?',
      reply:
        'A small place with a long table and a short menu. I have two to choose from; nothing is booked.',
    },
  ];
  // One scan per god, models/<god id>.glb (geometry only: positions and indices, textures stripped).
  // kind: head = a head only (a procedural body is added); bust = the file already holds head and shoulders
  // (statues were cropped to a bust when the file was made). yaw turns the model about Y so it faces the camera;
  // scale and dy nudge the fit; eyes are optional glow positions in bust space; orient 'winding' trusts the
  // triangle winding for normals instead of pointing them away from the middle of the model.
  // For tuning, ?yaw=, ?scale= and ?dy= override the values for the god being viewed.
  var SCANS = {
    apollo: { kind: 'bust', yaw: 0, scale: 1, dy: 0 },
    dionysus: { kind: 'bust', yaw: -Math.PI / 2, scale: 1, dy: 0 },
    janus: { kind: 'head', yaw: 0, scale: 1, dy: 0 }, // one head with two faces: no duplicate
    hephaestus: { kind: 'bust', yaw: -Math.PI / 2, scale: 1, dy: 0 },
    atlas: { kind: 'bust', yaw: 0, scale: 1, dy: 0 },
    themis: { kind: 'bust', yaw: 0, scale: 1, dy: 0 },
    iris: { kind: 'head', yaw: 0, scale: 1.45, dy: -0.12 },
    plutus: { kind: 'bust', yaw: 0, scale: 1, dy: 0 },
  };
  ['yaw', 'scale', 'dy'].forEach(function (k) {
    var v = parseFloat(new URLSearchParams(window.location.search).get(k));
    if (isFinite(v)) {
      var gid = new URLSearchParams(window.location.search).get('god') || 'hephaestus';
      if (SCANS[gid]) SCANS[gid][k] = v;
    }
  });
  // ?crop=y0,y1,x0,x1,z0,z1 (fractions 0..1 of the model's box) overrides the crop box while tuning
  (function () {
    var q = new URLSearchParams(window.location.search).get('crop');
    var gid = new URLSearchParams(window.location.search).get('god') || 'hephaestus';
    if (q && SCANS[gid]) {
      var n = q.split(',').map(parseFloat);
      if (n.length === 6 && n.every(isFinite))
        SCANS[gid].crop = { y: [n[0], n[1]], x: [n[2], n[3]], z: [n[4], n[5]] };
    }
  })();
  var godIdx = 0;
  var god = GODS[0];

  // ---------- helpers ----------
  var seed = 7;
  function rnd() {
    // mulberry32: deterministic so the shapes are the same on every load
    seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function gauss() {
    return ((rnd() + rnd() + rnd()) / 3) * 2 - 1;
  }
  function hexRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function unitVec() {
    var u = rnd() * 2 - 1;
    var t = rnd() * Math.PI * 2;
    var s = Math.sqrt(1 - u * u);
    return [s * Math.cos(t), u, s * Math.sin(t)];
  }

  // samples return [x, y, z, nx, ny, nz] in the shared array O (position plus surface normal for the rim light)
  var O = [0, 0, 0, 0, 0, 0];
  function setN(nx, ny, nz) {
    var l = Math.hypot(nx, ny, nz) || 1;
    O[3] = nx / l;
    O[4] = ny / l;
    O[5] = nz / l;
  }
  function ellip(c, r) {
    var v = unitVec();
    O[0] = c[0] + v[0] * r[0];
    O[1] = c[1] + v[1] * r[1];
    O[2] = c[2] + v[2] * r[2];
    setN(v[0] / r[0], v[1] / r[1], v[2] / r[2]);
    return O;
  }
  function radial(x, y, z, c) {
    O[0] = x;
    O[1] = y;
    O[2] = z;
    setN(x - c[0], y - c[1], z - c[2]);
    return O;
  }
  function boxSurface(c, h) {
    var f = Math.floor(rnd() * 6);
    var ax = f >> 1;
    var p = [0, 0, 0];
    p[ax] = f & 1 ? 1 : -1;
    p[(ax + 1) % 3] = rnd() * 2 - 1;
    p[(ax + 2) % 3] = rnd() * 2 - 1;
    O[0] = c[0] + p[0] * h[0];
    O[1] = c[1] + p[1] * h[1];
    O[2] = c[2] + p[2] * h[2];
    var n = [0, 0, 0];
    n[ax] = p[ax];
    setN(n[0], n[1], n[2]);
    return O;
  }
  var HEAD_C = [0, 0.64, -0.02];

  // ---------- orb: soft glass sphere. Sparkle shell, luminous interior, a little dust. ----------
  function orbPoint() {
    var r = rnd();
    var p = unitVec();
    if (r < 0.38) return [p[0] * 1.02, p[1] * 1.02, p[2] * 1.02];
    if (r < 0.8) {
      var d = Math.pow(rnd(), 0.5) * 0.9;
      return [p[0] * d, p[1] * d, p[2] * d];
    }
    var q = 1.15 + rnd() * 0.7;
    return [p[0] * q, p[1] * q * 0.8, p[2] * q];
  }

  // ---------- procedural bust parts ----------
  function headProc() {
    var r = rnd();
    var p;
    var k;
    if (r < 0.8) {
      p = ellip(HEAD_C, [0.4, 0.5, 0.45]);
      if (p[1] < 0.64) {
        k = (0.64 - p[1]) / 0.5;
        p[0] *= 1 - 0.3 * k * k;
        if (p[2] > 0) p[2] *= 1 - 0.2 * k;
      }
      return p;
    }
    if (r < 0.88) return ellip([0, 0.57, 0.45], [0.05, 0.12, 0.07]); // nose
    if (r < 0.94) return ellip([0, 0.2, 0.34], [0.11, 0.06, 0.08]); // chin
    return ellip([0, 0.76, 0.38], [0.29, 0.04, 0.07]); // brow
  }

  function bodyProc() {
    var r = rnd();
    var a;
    var y;
    var p;
    if (r < 0.14) {
      a = rnd() * Math.PI * 2;
      y = -0.42 + rnd() * 0.62;
      var rad = 0.16 + (0.13 * Math.max(0, -0.05 - y)) / 0.37;
      O[0] = Math.cos(a) * rad;
      O[1] = y;
      O[2] = Math.sin(a) * rad * 0.95;
      setN(Math.cos(a), 0, Math.sin(a));
      return O;
    }
    if (r < 0.34) {
      var s = rnd() < 0.5 ? -1 : 1;
      var t = rnd();
      var v = unitVec();
      var tube = 0.11 * (1 - 0.5 * t);
      O[0] = s * (0.17 + t * 0.7) + v[0] * tube;
      O[1] = -0.3 - t * 0.38 + v[1] * tube;
      O[2] = v[2] * tube * 1.2;
      setN(v[0], v[1], v[2]);
      return O;
    }
    if (r < 0.88) {
      p = ellip([0, -1.1, 0], [0.88, 0.72, 0.42]);
      if (p[1] < -1.1) {
        p[1] = -1.1 + Math.abs(p[1] + 1.1);
        O[4] = Math.abs(O[4]);
      }
      return p;
    }
    return ellip([rnd() < 0.5 ? -0.84 : 0.84, -0.76, 0], [0.17, 0.2, 0.2]);
  }

  // ---------- attributes (built in code) ----------
  function zig(a, n) {
    var f = (a / (Math.PI * 2)) * n;
    return Math.abs(f - Math.floor(f) - 0.5) * 2;
  }
  function circlePts(cx, cy, cz, r, n) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz]);
    }
    return pts;
  }
  function arcPts(cx, cy, r, a0, a1, n) {
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0]);
    }
    return pts;
  }
  function wreathPoint() {
    var a = rnd() * Math.PI * 2;
    return radial(
      Math.cos(a) * 0.45 + gauss() * 0.03,
      0.98 + gauss() * 0.03,
      Math.sin(a) * 0.48 - 0.02 + gauss() * 0.03,
      [0, 0.5, -0.02],
    );
  }

  // pt() returns extra surface points; wire(group) adds line work. edgeObj and lineObj are defined with the scene.
  var ATTRS = {
    cap: {
      pt: function () {
        for (var i = 0; i < 8; i++) {
          var p = ellip(HEAD_C, [0.45, 0.55, 0.49]);
          if (p[1] > 0.95) return p;
        }
        return radial(0, 1.2, 0, HEAD_C);
      },
    },
    beard: {
      pt: function () {
        for (var i = 0; i < 12; i++) {
          var p = ellip(HEAD_C, [0.44, 0.54, 0.47]);
          if (p[2] > 0.08 && p[1] < 0.42 && p[1] > 0.0) return p;
        }
        return radial(0, 0.3, 0.4, HEAD_C);
      },
    },
    anvil: {
      pt: function () {
        var b = [
          [
            [0, -0.97, 0.4],
            [0.46, 0.06, 0.2],
          ],
          [
            [0, -0.86, 0.4],
            [0.14, 0.07, 0.15],
          ],
          [
            [0, -0.72, 0.4],
            [0.58, 0.08, 0.18],
          ],
        ][Math.floor(rnd() * 3)];
        return boxSurface(b[0], b[1]);
      },
      wire: function (g) {
        [
          [0.46, 0.06, 0.2, -0.97],
          [0.14, 0.07, 0.15, -0.86],
          [0.58, 0.08, 0.18, -0.72],
        ].forEach(function (s) {
          var w = edgeObj(new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2), 'c', 0.7);
          w.position.set(0, s[3], 0.4);
          g.add(w);
        });
      },
    },
    hammer: {
      wire: function (g) {
        var h = new THREE.Group();
        var handle = edgeObj(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8), 'b', 0.55);
        var head = edgeObj(new THREE.BoxGeometry(0.42, 0.2, 0.2), 'b', 0.55);
        head.position.y = 0.5;
        h.add(handle);
        h.add(head);
        h.position.set(1.3, 0.1, 0.2);
        h.rotation.z = -0.5;
        h.userData.anim = 'hammer';
        g.add(h);
      },
    },
    laurel: { pt: wreathPoint },
    ivy: {
      pt: function () {
        if (rnd() < 0.6) return wreathPoint();
        var s = rnd() < 0.5 ? -1 : 1; // a vine hanging at each side
        var t = rnd();
        return radial(
          s * (0.47 + 0.06 * Math.sin(t * 9)),
          0.95 - t * 0.9 + gauss() * 0.02,
          -0.08 + gauss() * 0.04,
          [0, 0.5, 0],
        );
      },
    },
    lyre: {
      wire: function (g) {
        var l = new THREE.Group();
        l.add(
          lineObj(
            [
              [-1.5, 0.05, 0.1],
              [-1.62, -0.25, 0.1],
              [-1.5, -0.55, 0.1],
              [-1.35, -0.62, 0.1],
            ],
            false,
            'a',
            0.8,
          ),
        );
        l.add(
          lineObj(
            [
              [-1.0, 0.05, 0.1],
              [-0.88, -0.25, 0.1],
              [-1.0, -0.55, 0.1],
              [-1.15, -0.62, 0.1],
            ],
            false,
            'a',
            0.8,
          ),
        );
        l.add(
          lineObj(
            [
              [-1.52, 0.05, 0.1],
              [-0.98, 0.05, 0.1],
            ],
            false,
            'a',
            0.8,
          ),
        );
        for (var i = 0; i < 4; i++)
          l.add(
            lineObj(
              [
                [-1.4 + i * 0.1, 0.05, 0.1],
                [-1.4 + i * 0.1, -0.55, 0.1],
              ],
              false,
              'c',
              0.5,
            ),
          );
        g.add(l);
      },
    },
    door: {
      wire: function (g) {
        var pts = [
          [-0.98, -1.0, -0.1],
          [-0.98, 0.7, -0.1],
        ];
        for (var i = 0; i <= 24; i++) {
          var a = Math.PI - (i / 24) * Math.PI;
          pts.push([Math.cos(a) * 0.98, 0.7 + Math.sin(a) * 0.55, -0.1]);
        }
        pts.push([0.98, -1.0, -0.1]);
        g.add(lineObj(pts, false, 'a', 0.55));
      },
    },
    key: {
      wire: function (g) {
        var k = new THREE.Group();
        k.add(lineObj(circlePts(-0.18, -0.96, 0.46, 0.1, 18), true, 'a', 0.8));
        k.add(
          lineObj(
            [
              [-0.08, -0.96, 0.46],
              [0.34, -0.96, 0.46],
            ],
            false,
            'b',
            0.8,
          ),
        );
        k.add(
          lineObj(
            [
              [0.26, -0.96, 0.46],
              [0.26, -1.08, 0.46],
            ],
            false,
            'b',
            0.8,
          ),
        );
        k.add(
          lineObj(
            [
              [0.33, -0.96, 0.46],
              [0.33, -1.04, 0.46],
            ],
            false,
            'b',
            0.8,
          ),
        );
        g.add(k);
      },
    },
    sky: {
      pt: function () {
        var a = Math.PI * (0.05 + 0.9 * rnd());
        var r = 1.35 + gauss() * 0.04;
        return radial(Math.cos(a) * r, Math.sin(a) * r * 0.9 + gauss() * 0.04, gauss() * 0.06, [0, 0, 0]);
      },
      wire: function (g) {
        var pts = [];
        for (var i = 0; i <= 40; i++) {
          var a = Math.PI * (0.03 + 0.94 * (i / 40));
          pts.push([Math.cos(a) * 1.42, Math.sin(a) * 1.28, 0]);
        }
        g.add(lineObj(pts, false, 'a', 0.4));
      },
    },
    crown: {
      pt: function () {
        var a = rnd() * Math.PI * 2;
        return radial(
          Math.cos(a) * 0.43,
          1.06 + 0.16 * zig(a, 5) + gauss() * 0.01,
          Math.sin(a) * 0.47 - 0.02,
          [0, 0.9, 0],
        );
      },
      wire: function (g) {
        var pts = [];
        for (var i = 0; i <= 60; i++) {
          var a = (i / 60) * Math.PI * 2;
          pts.push([Math.cos(a) * 0.43, 1.06 + 0.16 * zig(a, 5), Math.sin(a) * 0.47 - 0.02]);
        }
        g.add(lineObj(pts, true, 'b', 0.8));
      },
    },
    coin: {
      pt: function () {
        var a = rnd() * Math.PI * 2;
        return radial(1.2 + Math.cos(a) * 0.3, 0.1 + Math.sin(a) * 0.3, 0.2, [1.2, 0.1, 0.2]);
      },
      wire: function (g) {
        var c = new THREE.Group();
        c.add(lineObj(circlePts(0, 0, 0, 0.3, 36), true, 'b', 0.8));
        c.add(lineObj(circlePts(0, 0, 0, 0.22, 36), true, 'b', 0.4));
        c.position.set(1.2, 0.1, 0.2);
        c.userData.anim = 'coin';
        g.add(c);
      },
    },
    band: {
      pt: function () {
        var a = rnd() * Math.PI * 2;
        return radial(
          Math.cos(a) * 0.435,
          0.69 + gauss() * 0.045,
          Math.sin(a) * 0.48 - 0.02,
          [0, 0.69, -0.02],
        );
      },
    },
    scales: {
      wire: function (g) {
        var s = new THREE.Group();
        s.add(
          lineObj(
            [
              [0, -0.9, 0],
              [0, 0.2, 0],
            ],
            false,
            'b',
            0.6,
          ),
        );
        var beam = new THREE.Group();
        beam.add(
          lineObj(
            [
              [-0.45, 0.2, 0],
              [0.45, 0.2, 0],
            ],
            false,
            'b',
            0.8,
          ),
        );
        [-0.45, 0.45].forEach(function (x) {
          beam.add(
            lineObj(
              [
                [x, 0.2, 0],
                [x - 0.18, -0.15, 0],
              ],
              false,
              'a',
              0.5,
            ),
          );
          beam.add(
            lineObj(
              [
                [x, 0.2, 0],
                [x + 0.18, -0.15, 0],
              ],
              false,
              'a',
              0.5,
            ),
          );
          beam.add(lineObj(arcPts(x, -0.15, 0.18, Math.PI, Math.PI * 2, 14), false, 'a', 0.8));
        });
        beam.userData.anim = 'sway';
        s.add(beam);
        s.position.set(1.25, 0, 0.15);
        g.add(s);
      },
    },
    veil: {
      pt: function () {
        var x = gauss() * 0.6;
        var t = rnd();
        return radial(
          x,
          1.05 - t * 1.5,
          -0.3 - 0.12 * (1 - Math.abs(x) / 0.6) - 0.03 * Math.sin(t * 9 + x * 6),
          [0, 0.5, 0.2],
        );
      },
    },
    rainbow: {
      wire: function (g) {
        [
          ['a', 1.25],
          ['b', 1.35],
          ['c', 1.45],
        ].forEach(function (s) {
          var pts = [];
          for (var i = 0; i <= 40; i++) {
            var a = Math.PI * (i / 40);
            pts.push([Math.cos(a) * s[1], -0.45 + Math.sin(a) * s[1], -0.25]);
          }
          g.add(lineObj(pts, false, s[0], 0.7));
        });
      },
    },
  };

  // ---------- capability check: no flat fallback, just a message ----------
  function webglOk() {
    try {
      var c = document.createElement('canvas');
      var gl = window.WebGL2RenderingContext ? c.getContext('webgl2') : null;
      if (gl) {
        var lose = gl.getExtension('WEBGL_lose_context'); // release the probe context straight away
        if (lose) lose.loseContext();
      }
      return !!gl;
    } catch {
      return false;
    }
  }

  // chrome (rail, labels, chat, theme) works with or without WebGL
  var rootEl = document.documentElement;
  function setText(sel, text) {
    document.querySelectorAll(sel).forEach(function (el) {
      el.textContent = text;
    });
  }
  var STATE_LABEL = { idle: 'Idle', thinking: 'Thinking', speaking: 'Speaking' };
  function stateOk(st) {
    return typeof st === 'string' && Object.prototype.hasOwnProperty.call(STATE_LABEL, st); // not 'constructor' and friends
  }
  function setStateLabel(st) {
    document.querySelectorAll('[data-status]').forEach(function (el) {
      el.setAttribute('data-now', st);
      el.textContent = stateOk(st) ? STATE_LABEL[st] : 'Idle';
    });
    document.querySelectorAll('[data-state-set]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-state-set') === st ? 'true' : 'false');
    });
  }
  function bindChrome(onGod, onState) {
    document.querySelectorAll('[data-god]').forEach(function (b) {
      b.addEventListener('click', function () {
        onGod(b.getAttribute('data-god'));
      });
    });
    document.querySelectorAll('[data-state-set]').forEach(function (b) {
      b.addEventListener('click', function () {
        onState(b.getAttribute('data-state-set'));
      });
    });
    document.querySelectorAll('[data-theme-set]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-theme-set');
        if (v === 'auto') rootEl.removeAttribute('data-theme');
        else rootEl.setAttribute('data-theme', v);
        b.parentNode.querySelectorAll('button').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
      });
    });
  }
  function chrome() {
    setText('[data-god-name]', god.name);
    setText('[data-god-role]', god.role);
    setText('[data-god-you]', god.you);
    setText('[data-god-reply]', god.reply);
    document.title = god.name + ' 3D prototype (layout B)';
    document.querySelectorAll('[data-god]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-god') === god.id ? 'true' : 'false');
    });
  }

  // No WebGL 2, or the context was lost: a text message and a stage that is no longer a button.
  function noGl() {
    stage.setAttribute('data-gl', 'none');
    ['role', 'tabindex', 'aria-expanded', 'aria-label', 'aria-describedby'].forEach(function (a) {
      stage.removeAttribute(a);
    });
    stage.blur();
  }

  if (typeof THREE === 'undefined' || !webglOk() || params.has('nogl')) {
    noGl();
    var pick = function (id) {
      god = GODS.filter(function (g) {
        return g.id === id;
      })[0];
      chrome();
    };
    bindChrome(pick, setStateLabel);
    chrome();
    return;
  }
  stage.setAttribute('data-gl', 'ok');

  // ---------- scene ----------
  var renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // palette values are sRGB; keep them as written
  renderer.setClearColor(0x000000, 0);
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(CFG.fov, 1, 0.1, 50);
  var world = new THREE.Group();
  scene.add(world);

  function color(t) {
    return new THREE.Color().setRGB(t[0], t[1], t[2]);
  }
  var tones = { a: hexRgb(GODS[0].pal[0]), b: hexRgb(GODS[0].pal[1]), c: hexRgb(GODS[0].pal[2]) };

  var U = {
    uTime: { value: 0 },
    uOrb: { value: 1 }, // 1 = full orb, falls when the bust takes over
    uThink: { value: 0 },
    uA: { value: new THREE.Vector3() },
    uB: { value: new THREE.Vector3() },
    uC: { value: new THREE.Vector3() },
  };

  // One Points object carries the whole body: each particle knows its orb and its bust position and normal.
  var N = CFG.particles;
  var orbPos = new Float32Array(N * 3);
  var posBust = new Float32Array(N * 3);
  var nrmBust = new Float32Array(N * 3);
  var rndAttr = new Float32Array(N * 4);
  for (var i = 0; i < N; i++) {
    orbPos.set(orbPoint(), i * 3);
    rndAttr[i * 4] = rnd();
    rndAttr[i * 4 + 1] = 0.045 + rnd() * rnd() * 0.1;
    rndAttr[i * 4 + 2] = rnd();
    rndAttr[i * 4 + 3] = rnd();
  }
  var pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(orbPos, 3));
  pg.setAttribute('aBust', new THREE.BufferAttribute(posBust, 3));
  pg.setAttribute('aNorm', new THREE.BufferAttribute(nrmBust, 3));
  pg.setAttribute('aRnd', new THREE.BufferAttribute(rndAttr, 4));

  var pu = {
    uMorph: { value: 0 },
    uTime: U.uTime,
    uThink: U.uThink,
    uPx: { value: 600 },
    uA: U.uA,
    uB: U.uB,
    uC: U.uC,
    uSpeak: { value: 0 },
  };
  var pm = new THREE.ShaderMaterial({
    uniforms: pu,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: [
      'attribute vec3 aBust;',
      'attribute vec3 aNorm;',
      'attribute vec4 aRnd;',
      'uniform float uMorph, uTime, uPx, uThink, uSpeak;',
      'varying float vMix, vT, vY, vDepth, vRim, vFace;',
      'void main() {',
      '  float t = clamp((uMorph - aRnd.x * 0.45) / 0.55, 0.0, 1.0);',
      '  t = t * t * (3.0 - 2.0 * t);',
      '  float ang = uTime * 0.12 * (0.4 + aRnd.w) * (1.0 + uThink * 3.0) * (1.0 - t);',
      '  vec3 a = position;',
      '  a.xz = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * a.xz;',
      '  a *= 1.0 - 0.14 * uThink;',
      '  vec3 p = mix(a, aBust, t);',
      '  float mid = sin(t * 3.14159);',
      '  p += normalize(a + 1e-3) * mid * 0.55 * aRnd.w;',
      '  p.xz += vec2(-p.z, p.x) * mid * 0.9 * (aRnd.w - 0.5);',
      '  p *= 1.0 + (0.018 + 0.03 * uSpeak) * sin(uTime * (1.4 + uSpeak * 6.0) + aRnd.w * 6.28) * (1.0 - t);',
      '  float g = step(0.975, fract(sin(floor(p.y * 14.0) * 12.9898 + floor(uTime * 6.0) * 78.233) * 43758.5));',
      '  p.x += g * 0.05 * t;',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  vec3 n = normalize(normalMatrix * aNorm);',
      '  float nd = dot(n, normalize(-mv.xyz));',
      '  vRim = pow(1.0 - abs(nd), 2.2);',
      '  vFace = nd > 0.0 ? 1.0 : 0.35;',
      '  gl_PointSize = aRnd.y * uPx / -mv.z * (1.0 + mid * 0.5) * (1.0 - 0.15 * t);',
      '  gl_Position = projectionMatrix * mv;',
      '  vMix = aRnd.z; vT = t; vY = p.y; vDepth = clamp(1.25 - (-mv.z - 3.0) * 0.28, 0.35, 1.3);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uA, uB, uC;',
      'uniform float uTime, uSpeak, uThink;',
      'varying float vMix, vT, vY, vDepth, vRim, vFace;',
      'void main() {',
      '  float d = length(gl_PointCoord - 0.5);',
      '  if (d > 0.5) discard;',
      '  float soft = pow(1.0 - d * 2.0, 2.0);',
      '  vec3 col = mix(uA, uB, vMix);',
      '  float scan = 0.7 + 0.3 * sin(vY * 70.0 - uTime * (2.5 + uThink * 4.0));',
      '  float sweep = exp(-pow(fract(uTime * (0.22 + uThink * 0.5)) * 2.8 - 1.4 - vY, 2.0) * 30.0);',
      '  col = mix(col, uC, 0.25 + sweep * 0.7);',
      '  col = mix(col, uC, vRim * vT * 0.7);',
      '  float k = mix(1.0 + uThink * 0.5, scan + sweep * 1.5 + uSpeak * 0.25 + vRim * 0.9 + 0.25, vT);',
      '  float alpha = soft * vDepth * (0.9 - 0.15 * vT) * k * mix(1.0, vFace, vT);',
      '  gl_FragColor = vec4(col * alpha, alpha);',
      '}',
    ].join('\n'),
  });
  var points = new THREE.Points(pg, pm);
  points.frustumCulled = false;
  world.add(points);

  // soft glow sprite texture, drawn once on a small canvas
  var gc = document.createElement('canvas');
  gc.width = gc.height = 64;
  var gx = gc.getContext('2d');
  var grad = gx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  gx.fillStyle = grad;
  gx.fillRect(0, 0, 64, 64);
  var glowTex = new THREE.CanvasTexture(gc);

  var sprites = []; // [sprite, tone slot]
  function glowSprite(slot, size, opacity) {
    var s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: color(tones[slot]),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: opacity,
      }),
    );
    s.scale.setScalar(size);
    sprites.push([s, slot]);
    return s;
  }

  // glass sphere: fresnel rim at low alpha, a luminous interior, no outline anywhere
  function orbMaterial(frag) {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uOrb: U.uOrb, uThink: U.uThink, uA: U.uA, uB: U.uB, uC: U.uC },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: [
        'varying vec3 vN; varying vec3 vV; varying vec3 vObj;',
        'void main() {',
        '  vObj = position;',
        '  vN = normalize(normalMatrix * normal);',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vV = -mv.xyz;',
        '  gl_Position = projectionMatrix * mv;',
        '}',
      ].join('\n'),
      fragmentShader: frag,
    });
  }
  var glassMat = orbMaterial(
    [
      'uniform float uTime, uOrb, uThink;',
      'uniform vec3 uA, uB, uC;',
      'varying vec3 vN; varying vec3 vV; varying vec3 vObj;',
      'void main() {',
      '  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.4);',
      '  float shimmer = 0.85 + 0.15 * sin(vObj.y * 6.0 + uTime * 1.2);',
      '  vec3 col = mix(uB, uA, f) + uC * 0.15;',
      '  float alpha = (0.08 + f * 0.42) * shimmer * (1.0 + uThink * 0.5) * uOrb;',
      '  gl_FragColor = vec4(col * alpha, alpha);',
      '}',
    ].join('\n'),
  );
  var hazeBandMat = orbMaterial(
    [
      'uniform float uOrb;',
      'uniform vec3 uA;',
      'varying vec3 vObj;',
      'void main() {',
      '  float r = length(vObj.xy);',
      '  float a = exp(-pow((r - 1.2) / 0.32, 2.0)) * 0.2 * uOrb;',
      '  gl_FragColor = vec4(uA * a, a);',
      '}',
    ].join('\n'),
  );
  var orbGroup = new THREE.Group();
  orbGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1.08, 48, 32), glassMat));
  var band = new THREE.Mesh(new THREE.RingGeometry(0.4, 1.9, 96, 1), hazeBandMat);
  band.rotation.set(Math.PI / 2 + 0.45, 0, 0.2);
  orbGroup.add(band);
  world.add(orbGroup);

  var haze = glowSprite('b', 3.6, 0.14);
  world.add(haze);
  var mote = glowSprite('c', 0.3, 0.9);
  world.add(mote);
  var coreGlow = glowSprite('b', 1.0, 0.9);
  world.add(coreGlow);

  // ---------- wire helpers (colour comes from the tone slot, so a palette change recolours them) ----------
  var wireObjs = [];
  function wireMat(slot) {
    var m = new THREE.LineBasicMaterial({
      color: color(tones[slot]),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    wireObjs.push([m, slot]);
    return m;
  }
  function edgeObj(geom, slot, base) {
    var m = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 1), wireMat(slot));
    geom.dispose();
    m.userData.base = base;
    return m;
  }
  function lineObj(pts, closed, slot, base) {
    var arr = [];
    for (var i = 0; i < pts.length - 1; i++)
      arr.push(pts[i][0], pts[i][1], pts[i][2], pts[i + 1][0], pts[i + 1][1], pts[i + 1][2]);
    if (closed) {
      var l = pts[pts.length - 1];
      arr.push(l[0], l[1], l[2], pts[0][0], pts[0][1], pts[0][2]);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    var m = new THREE.LineSegments(g, wireMat(slot));
    m.userData.base = base;
    return m;
  }

  // procedural head and shoulder wire shells (hidden when a scanned head or bust is in use)
  var headWire = edgeObj(new THREE.SphereGeometry(1, 20, 14), 'a', 0.16);
  headWire.scale.set(0.4, 0.5, 0.45);
  headWire.position.set(HEAD_C[0], HEAD_C[1], HEAD_C[2]);
  world.add(headWire);
  var shoulderWire = edgeObj(new THREE.SphereGeometry(1, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2), 'a', 0.22);
  shoulderWire.scale.set(0.88, 0.72, 0.42);
  shoulderWire.position.set(0, -1.1, 0);
  world.add(shoulderWire);

  var attrGroup = new THREE.Group();
  world.add(attrGroup);

  // eyes (procedural head only) and the speaking glow
  var eyeL = glowSprite('c', 0.16, 0);
  var eyeR = glowSprite('c', 0.16, 0);
  eyeL.position.set(-0.15, 0.68, 0.42);
  eyeR.position.set(0.15, 0.68, 0.42);
  world.add(eyeL);
  world.add(eyeR);
  var pulse = glowSprite('a', 1.3, 0);
  pulse.position.set(0, 0.64, 0);
  world.add(pulse);

  // ---------- scanned models: lazy GLB load, sampled into surface points with normals ----------
  var scans = {}; // id -> { pts: Float32Array(M*6) } | { failed: true } | { loading: true }

  function sampleScene(gltfScene, cfg) {
    var kind = cfg.kind;
    var yaw = cfg.yaw;
    var tris = [];
    var minY = Infinity;
    var maxY = -Infinity;
    var minX = Infinity;
    var maxX = -Infinity;
    var minZ = Infinity;
    var maxZ = -Infinity;
    gltfScene.updateMatrixWorld(true);
    gltfScene.traverse(function (o) {
      if (!o.isMesh || !o.geometry.attributes.position) return;
      var pos = o.geometry.attributes.position;
      var idx = o.geometry.index;
      var count = idx ? idx.count : pos.count;
      var v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      for (var f = 0; f + 2 < count; f += 3) {
        var ok = true;
        for (var k = 0; k < 3; k++) {
          v[k].fromBufferAttribute(pos, idx ? idx.getX(f + k) : f + k).applyMatrix4(o.matrixWorld);
          if (cfg.up === 'z') v[k].set(v[k].x, v[k].z, -v[k].y); // Z-up export: turn it upright
          ok = ok && isFinite(v[k].x + v[k].y + v[k].z); // skip NaN or infinite vertices
        }
        if (!ok) continue;
        for (k = 0; k < 3; k++) {
          minX = Math.min(minX, v[k].x);
          maxX = Math.max(maxX, v[k].x);
          minY = Math.min(minY, v[k].y);
          maxY = Math.max(maxY, v[k].y);
          minZ = Math.min(minZ, v[k].z);
          maxZ = Math.max(maxZ, v[k].z);
        }
        tris.push([v[0].x, v[0].y, v[0].z, v[1].x, v[1].y, v[1].z, v[2].x, v[2].y, v[2].z]);
      }
    });
    if (!tris.length) return null;
    if (cfg.crop) {
      // keep the triangles whose centre lies in a box given as fractions of the model's own extent
      var bx = [minX, maxX];
      var by = [minY, maxY];
      var bz = [minZ, maxZ];
      var cr = cfg.crop;
      var lim = function (b, r) {
        return [b[0] + (r ? r[0] : 0) * (b[1] - b[0]), b[0] + (r ? r[1] : 1) * (b[1] - b[0])];
      };
      var lx = lim(bx, cr.x);
      var ly = lim(by, cr.y);
      var lz = lim(bz, cr.z);
      tris = tris.filter(function (t) {
        var cx2 = (t[0] + t[3] + t[6]) / 3;
        var cy2 = (t[1] + t[4] + t[7]) / 3;
        var cz2 = (t[2] + t[5] + t[8]) / 3;
        return cx2 >= lx[0] && cx2 <= lx[1] && cy2 >= ly[0] && cy2 <= ly[1] && cz2 >= lz[0] && cz2 <= lz[1];
      });
      if (!tris.length) return null;
      minX = minY = minZ = Infinity;
      maxX = maxY = maxZ = -Infinity;
      tris.forEach(function (t) {
        for (var q = 0; q < 9; q += 3) {
          minX = Math.min(minX, t[q]);
          maxX = Math.max(maxX, t[q]);
          minY = Math.min(minY, t[q + 1]);
          maxY = Math.max(maxY, t[q + 1]);
          minZ = Math.min(minZ, t[q + 2]);
          maxZ = Math.max(maxZ, t[q + 2]);
        }
      });
    }
    var full = kind !== 'head'; // a bust fills the whole figure; a head gets a procedural body
    var s = ((full ? 2.3 : 1.08) / (maxY - minY || 1)) * (cfg.scale || 1);
    var cx = (minX + maxX) / 2;
    var cz = (minZ + maxZ) / 2;
    var oy = (minY + maxY) / 2;
    var cy = (full ? 0 : HEAD_C[1]) + (cfg.dy || 0);
    var cum = new Float32Array(tris.length);
    var total = 0;
    var cos = Math.cos(yaw);
    var sin = Math.sin(yaw);
    tris.forEach(function (t, i) {
      var ux = t[3] - t[0];
      var uy = t[4] - t[1];
      var uz = t[5] - t[2];
      var wx = t[6] - t[0];
      var wy = t[7] - t[1];
      var wz = t[8] - t[2];
      total += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
      cum[i] = total;
    });
    if (!(total > 0) || !isFinite(total)) return null; // all triangles degenerate
    var M = CFG.scanPoints;
    var out = new Float32Array(M * 6);
    for (var i = 0; i < M; i++) {
      var r = ((i + 0.5) / M + (rnd() - 0.5) / M) * total;
      var lo = 0;
      var hi = tris.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      var t = tris[lo];
      var a = rnd();
      var b = rnd();
      if (a + b > 1) {
        a = 1 - a;
        b = 1 - b;
      }
      var px = t[0] + a * (t[3] - t[0]) + b * (t[6] - t[0]);
      var py = t[1] + a * (t[4] - t[1]) + b * (t[7] - t[1]);
      var pz = t[2] + a * (t[5] - t[2]) + b * (t[8] - t[2]);
      var nx = (t[4] - t[1]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[7] - t[1]);
      var ny = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2]);
      var nz = (t[3] - t[0]) * (t[7] - t[1]) - (t[4] - t[1]) * (t[6] - t[0]);
      // scans can have either winding: point every normal away from the middle of the model
      if (cfg.orient !== 'winding' && nx * (px - cx) + ny * (py - oy) + nz * (pz - cz) < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      var nl = Math.hypot(nx, ny, nz) || 1;
      var x = (px - cx) * s;
      var z = (pz - cz) * s;
      var mx = nx / nl;
      var mz = nz / nl;
      out[i * 6] = x * cos + z * sin;
      out[i * 6 + 1] = (py - oy) * s + cy;
      out[i * 6 + 2] = -x * sin + z * cos;
      out[i * 6 + 3] = mx * cos + mz * sin;
      out[i * 6 + 4] = ny / nl;
      out[i * 6 + 5] = -mx * sin + mz * cos;
    }
    return out;
  }

  // status text per scan id; the readout shows the entry for the current god only (no cross-god races)
  var scanNote = {};
  function loadScan(id) {
    if (scans[id]) return;
    scans[id] = { loading: true };
    scanNote[id] = 'loading models/' + id + '.glb';
    new THREE.GLTFLoader().load(
      'models/' + id + '.glb',
      function (gltf) {
        var pts = sampleScene(gltf.scene, SCANS[id]);
        scans[id] = pts ? { pts: pts } : { failed: true };
        scanNote[id] = pts ? 'mesh ' + id : 'empty model ' + id + ', procedural bust';
        if (god.id === id) swapIn();
      },
      undefined,
      function () {
        scans[id] = { failed: true };
        scanNote[id] = 'procedural bust (models/' + id + '.glb not available)';
      },
    );
  }

  // When a model arrives while the bust is showing, dissolve to the orb, rebuild, then re-form (no pop).
  var swapPending = false;
  function swapIn() {
    if (morph > 0.01 && !reduce.matches) {
      swapPending = true;
      target = 0;
      return;
    }
    rebuildBust();
  }

  // ---------- build the bust targets for the current god ----------
  var usingMesh = false;
  var eyesShown = true;
  var usingBustMesh = false;
  function meshPoint(scan) {
    var k = Math.floor(rnd() * CFG.scanPoints) * 6;
    for (var j = 0; j < 6; j++) O[j] = scan.pts[k + j];
    return O;
  }
  function rebuildBust() {
    var scan = scans[god.id] && scans[god.id].pts ? scans[god.id] : null;
    var kind = SCANS[god.id].kind;
    var defs = god.attrs.concat(scan ? [] : god.fallback || []).filter(function (n) {
      return ATTRS[n] && ATTRS[n].pt;
    });
    var ashare = defs.length ? 0.2 : 0;
    seed = 1234 + godIdx * 77;
    var src;
    for (var i = 0; i < N; i++) {
      if (rnd() < ashare) {
        src = ATTRS[defs[Math.floor(rnd() * defs.length)]].pt();
      } else if (scan && kind !== 'head') {
        src = meshPoint(scan);
      } else if (rnd() < 0.5) {
        src = scan ? meshPoint(scan) : headProc();
      } else {
        src = bodyProc();
      }
      posBust[i * 3] = src[0];
      posBust[i * 3 + 1] = src[1];
      posBust[i * 3 + 2] = src[2];
      nrmBust[i * 3] = src[3];
      nrmBust[i * 3 + 1] = src[4];
      nrmBust[i * 3 + 2] = src[5];
    }
    pg.attributes.aBust.needsUpdate = true;
    pg.attributes.aNorm.needsUpdate = true;
    usingMesh = !!scan;
    var cfg = SCANS[god.id];
    eyesShown = !scan || !!cfg.eyes;
    if (!scan) {
      eyeL.position.set(-0.15, 0.68, 0.42);
      eyeR.position.set(0.15, 0.68, 0.42);
    } else if (cfg.eyes) {
      eyeL.position.set(cfg.eyes[0][0], cfg.eyes[0][1], cfg.eyes[0][2]);
      eyeR.position.set(cfg.eyes[1][0], cfg.eyes[1][1], cfg.eyes[1][2]);
    }
    usingBustMesh = !!scan && kind !== 'head';
    rebuildAttrs();
    requestStatic();
  }

  function rebuildAttrs() {
    disposeGroup(attrGroup);
    var list = god.attrs.concat(usingMesh ? [] : god.fallback || []);
    list.forEach(function (n) {
      if (ATTRS[n] && ATTRS[n].wire) ATTRS[n].wire(attrGroup);
    });
    applyPalette();
  }

  function disposeGroup(grp) {
    while (grp.children.length) {
      var c = grp.children[0];
      grp.remove(c);
      if (c.children && c.children.length) disposeGroup(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        var idx = wireObjs.findIndex(function (w) {
          return w[0] === c.material;
        });
        if (idx >= 0) wireObjs.splice(idx, 1);
        c.material.dispose();
      }
    }
  }

  function applyPalette() {
    var p = god.pal;
    tones.a = hexRgb(p[0]);
    tones.b = hexRgb(p[1]);
    tones.c = hexRgb(p[2]);
    U.uA.value.set(tones.a[0], tones.a[1], tones.a[2]);
    U.uB.value.set(tones.b[0], tones.b[1], tones.b[2]);
    U.uC.value.set(tones.c[0], tones.c[1], tones.c[2]);
    sprites.forEach(function (s) {
      s[0].material.color.setRGB(tones[s[1]][0], tones[s[1]][1], tones[s[1]][2]);
    });
    wireObjs.forEach(function (w) {
      w[0].color.setRGB(tones[w[1]][0], tones[w[1]][1], tones[w[1]][2]);
    });
    stage.style.setProperty('--stage-a', p[0]);
    stage.style.setProperty('--stage-b', p[1]);
    stage.style.setProperty('--stage-c', p[2]);
  }

  // Selecting a god collapses to the orb: a new god always starts as the orb.
  function selectGod(id) {
    var idx = GODS.findIndex(function (g) {
      return g.id === id;
    });
    if (idx < 0) return;
    godIdx = idx;
    god = GODS[idx];
    swapPending = false;
    setExpanded(false, true);
    morph = 0; // a new god always starts as the orb
    applyPalette();
    rebuildBust(); // procedural first if the scan is not loaded yet; it swaps in when it arrives
    if (!scans[god.id]) loadScan(god.id);
    chrome();
    syncAria();
    requestStatic();
  }

  function syncAria() {
    stage.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    stage.setAttribute('aria-label', god.name + ' body');
    stage.setAttribute('data-open', expanded ? 'true' : 'false');
    if (hintEl) hintEl.textContent = expanded ? 'Click or press Esc to collapse' : 'Click the orb to expand';
  }

  // ---------- state, resize, loop ----------
  var expanded = false; // set by click; picks orb or bust
  var target = 0;
  var thinkTarget = 0;
  var speakTarget = 0;
  var think = 0;
  var morph = 0;
  var speak = 0;
  var hover = 0;
  var hoverTarget = 0;
  var time = 0;
  var pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  var running = false;
  var ready = false;
  var raf = 0;
  var last = 0;
  var slowFrames = 0;
  var frames = 0;
  var accum = 0;
  var cpuAccum = 0;
  var level = 0; // 0 full; 1 fewer particles and pixel ratio 1; 2 fewer again and the extra glow off. Always 3D.
  var dpr = Math.min(window.devicePixelRatio || 1, CFG.dprCap);
  var visible = true;

  function ss(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function setExpanded(v, silent) {
    expanded = v;
    target = v && !swapPending ? 1 : 0; // while a model swaps in, the bust stays dissolved until it re-forms
    if (!silent) stage.setAttribute('data-hinted', 'true');
    if (reduce.matches) morph = target;
    syncAria();
    requestStatic();
  }

  // The activity comes from data-state (the chat stream will drive it later): idle, thinking or speaking.
  function setActivity(st) {
    stage.setAttribute('data-state', st);
    thinkTarget = st === 'thinking' ? 1 : 0;
    speakTarget = st === 'speaking' ? 1 : 0;
    if (reduce.matches) {
      think = thinkTarget;
      speak = speakTarget;
    }
    setStateLabel(st);
    requestStatic();
  }
  new MutationObserver(function () {
    var st = stage.getAttribute('data-state');
    if (stateOk(st)) {
      thinkTarget = st === 'thinking' ? 1 : 0;
      speakTarget = st === 'speaking' ? 1 : 0;
      if (reduce.matches) {
        think = thinkTarget;
        speak = speakTarget;
      }
      setStateLabel(st);
      requestStatic();
    }
  }).observe(stage, { attributes: true, attributeFilter: ['data-state'] });

  function resize() {
    var w = stage.clientWidth;
    var h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.userData.dist = Math.max(4.3, 2.3 / (camera.aspect * Math.tan((CFG.fov * Math.PI) / 360)));
    camera.updateProjectionMatrix();
    // small stages get bigger points so a bust stays readable (the camera also sits further back there)
    pu.uPx.value = ((h * dpr) / (2 * Math.tan((CFG.fov * Math.PI) / 360))) * (w < 600 ? 1.4 : 1);
    requestStatic();
  }

  function update(dt) {
    var anim = !reduce.matches;
    if (anim) {
      time += dt;
      var step = CFG.morphSpeed * dt;
      morph += Math.max(-step, Math.min(step, target - morph));
      if (swapPending && morph <= 0.001) {
        // the model arrived while the bust was up: it has dissolved, so rebuild and re-form
        swapPending = false;
        rebuildBust();
        target = expanded ? 1 : 0;
      }
      think += (thinkTarget - think) * Math.min(1, dt * 3);
      speak += (speakTarget * (0.6 + 0.4 * Math.sin(time * 9)) - speak) * Math.min(1, dt * 12);
      hover += (hoverTarget - hover) * Math.min(1, dt * 6);
    }
    var m = morph;
    var e = m * m * (3 - 2 * m);

    pu.uMorph.value = m;
    pu.uSpeak.value = speak;
    U.uTime.value = time;
    U.uThink.value = think;
    U.uOrb.value = 1 - 0.78 * e;

    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 4);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 4);
    var px = anim ? pointer.sx : 0;
    var py = anim ? pointer.sy : 0;
    camera.position.set(px * 0.55, py * 0.35 + 0.08, camera.userData.dist);
    camera.lookAt(0, 0.05 * e, 0);
    world.rotation.y = anim ? Math.sin(time * 0.35) * 0.22 * e + time * 0.05 * (1 - e) : 0;

    orbGroup.position.set(0, e * 0.15, -e * 0.25);
    haze.visible = level < 2;
    band.visible = level < 2;
    haze.material.opacity = 0.14 * (1 - 0.5 * e) * (1 + think * 0.6 + hover * 0.5 + speak * 0.3);

    var ma = anim ? time * (0.9 + think * 1.5) : 0.8;
    var mr = 1.55 - 0.15 * e;
    mote.position.set(
      Math.cos(ma) * mr,
      Math.sin(ma) * mr * Math.sin(0.5),
      Math.sin(ma) * mr * Math.cos(0.5),
    );

    coreGlow.position.set(0, -0.72 * e, 0.45 * e);
    var cs =
      (1 - e * 0.55) *
      (1 + 0.12 * Math.sin(time * 2.2) + speak * 0.35 + think * 0.25 * Math.sin(time * 6) + hover * 0.18);
    coreGlow.scale.setScalar(Math.max(0.2, cs) * (2.1 * (1 - e) + 0.95 * e));

    var wireOp = ss(0.35, 1, m);
    headWire.material.opacity = usingMesh ? 0 : wireOp * 0.16;
    shoulderWire.material.opacity = usingBustMesh ? 0 : wireOp * 0.22;
    attrGroup.traverse(function (c) {
      if (c.material && c.userData.base) c.material.opacity = wireOp * c.userData.base;
    });
    attrGroup.traverse(function (c) {
      var an = c.userData.anim;
      if (an === 'hammer') {
        c.rotation.z = -0.5 + (anim ? Math.sin(time * 1.3) * 0.12 : 0) - speak * 0.15;
        c.position.y = 0.1 + (anim ? Math.sin(time * 1.1) * 0.05 : 0);
      } else if (an === 'coin') {
        c.rotation.y = anim ? time * 1.2 : 0.5;
      } else if (an === 'sway') {
        c.rotation.z = anim ? Math.sin(time * 1.1) * 0.07 : 0;
      }
    });

    var eyeOn = eyesShown ? ss(0.7, 1, m) : 0;
    eyeL.material.opacity = eyeR.material.opacity = eyeOn * (0.8 + 0.2 * speak);
    eyeL.scale.setScalar(0.14 + 0.05 * speak);
    eyeR.scale.setScalar(0.14 + 0.05 * speak);

    var pp = anim && speakTarget ? (time * 0.55) % 1 : 0;
    pulse.scale.setScalar(1.3 + pp * 1.3);
    pulse.material.opacity = anim && speakTarget && m > 0.95 ? (1 - pp) * 0.35 : 0;
  }

  function draw(dt) {
    var t0 = performance.now();
    update(dt);
    renderer.render(scene, camera);
    return performance.now() - t0;
  }

  function loop(now) {
    raf = window.requestAnimationFrame(loop);
    var dt = Math.min(0.1, (now - last) / 1000);
    var interval = now - last;
    last = now;
    if (reduce.matches) {
      window.cancelAnimationFrame(raf);
      running = false;
      draw(0);
      return;
    }
    var cpu = draw(dt);
    frames++;
    accum += interval;
    cpuAccum += cpu;
    if (frames >= 90) {
      var avg = accum / frames;
      if (avg > CFG.slowMs) slowFrames++;
      else slowFrames = 0;
      if (slowFrames >= 2 && !params.has('nodegrade')) stepDown();
      stats(avg, cpuAccum / frames);
      frames = 0;
      accum = 0;
      cpuAccum = 0;
    }
  }

  function stats(avg, cpu) {
    var info = renderer.info.render;
    var pts = pg.drawRange.count === Infinity ? N : pg.drawRange.count;
    perfEl.textContent =
      'frame ' +
      avg.toFixed(1) +
      ' ms, cpu ' +
      cpu.toFixed(1) +
      ' ms, ' +
      info.calls +
      ' draws, ' +
      pts +
      ' points, dpr ' +
      dpr.toFixed(2) +
      (level ? ', step ' + level : '') +
      (scanNote[god.id] ? ', ' + scanNote[god.id] : '');
  }

  // Step down stays 3D: fewer particles and a lower pixel ratio, then the extra glow off. Never a flat look.
  function stepDown() {
    slowFrames = 0;
    if (level >= 2) return;
    level++;
    dpr = 1;
    pg.setDrawRange(0, Math.floor(N * (level === 1 ? 0.4 : 0.25)));
    resize();
  }

  var requestedStatic = false;
  function requestStatic() {
    if (!ready || running || requestedStatic) return;
    requestedStatic = true;
    window.requestAnimationFrame(function () {
      requestedStatic = false;
      if (!running) {
        draw(0);
        stats(0, 0);
      }
    });
  }
  function startLoop() {
    if (running || reduce.matches || !visible || document.hidden) {
      requestStatic();
      return;
    }
    running = true;
    last = performance.now();
    raf = window.requestAnimationFrame(loop);
  }
  function stopLoop() {
    running = false;
    window.cancelAnimationFrame(raf);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop();
    else startLoop();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (!visible) stopLoop();
      else startLoop();
    }).observe(stage);
  }

  // ---------- interaction: click, Enter/Space, Esc, hover, parallax ----------
  stage.addEventListener('pointermove', function (ev) {
    var r = stage.getBoundingClientRect();
    pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -(((ev.clientY - r.top) / r.height) * 2 - 1);
  });
  stage.addEventListener('pointerenter', function () {
    hoverTarget = 1;
  });
  stage.addEventListener('pointerleave', function () {
    pointer.x = 0;
    pointer.y = 0;
    hoverTarget = 0;
  });
  stage.addEventListener('focus', function () {
    hoverTarget = 1;
  });
  stage.addEventListener('blur', function () {
    hoverTarget = 0;
  });
  stage.addEventListener('click', function () {
    setExpanded(!expanded);
  });
  stage.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      setExpanded(!expanded);
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && expanded) setExpanded(false);
  });

  reduce.addEventListener('change', function () {
    if (reduce.matches) {
      morph = target;
      think = thinkTarget;
      speak = speakTarget;
      stopLoop();
      requestStatic();
    } else startLoop();
  });
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);

  canvas.addEventListener('webglcontextlost', function (ev) {
    ev.preventDefault();
    stopLoop();
    noGl();
  });

  function dispose() {
    stopLoop();
    disposeGroup(attrGroup);
    [pg, headWire.geometry, shoulderWire.geometry, band.geometry].forEach(function (g) {
      g.dispose();
    });
    [pm, glassMat, hazeBandMat].forEach(function (m) {
      m.dispose();
    });
    sprites.forEach(function (s) {
      s[0].material.dispose();
    });
    glowTex.dispose();
    renderer.dispose();
  }
  window.addEventListener('pagehide', dispose);

  bindChrome(selectGod, function (st) {
    stage.setAttribute('data-state', st);
  });
  ready = true;
  var startGod = params.get('god');
  selectGod(
    GODS.some(function (g) {
      return g.id === startGod;
    })
      ? startGod
      : 'hephaestus',
  );
  var startState = params.get('state');
  setActivity(stateOk(startState) ? startState : 'idle');
  if (params.get('open') === '1') setExpanded(true);
  resize();
  startLoop();
})();
