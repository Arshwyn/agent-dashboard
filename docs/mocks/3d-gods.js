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
      you: 'Is the dashboard change ready for review?',
      reply:
        'Built and pushed on its own branch. Tests green, lint clean, three small commits. Passing it to the gate now.',
    },
    {
      id: 'themis',
      name: 'Themis',
      role: 'Quality gate',
      pal: ['#9bb8ff', '#e9c46a', '#f2f6ff'],
      you: 'Did the checks pass?',
      reply: 'Every check ran and held. One naming note is logged for later; nothing blocks the merge.',
    },
    {
      id: 'janus',
      name: 'Janus',
      role: 'Gatekeeper',
      pal: ['#5ad1d6', '#c27bf0', '#e8eef7'],
      you: 'Anything blocking the merge?',
      reply:
        'Both doors checked. No critical findings; one medium goes to the backlog. The gate cleared this same commit, so I may open the way.',
    },
    {
      id: 'atlas',
      name: 'Atlas',
      role: 'Operator',
      pal: ['#6aa0ff', '#3b5bd6', '#e0ecff'],
      you: 'Is the new version running?',
      reply: 'It is. Deployed, the health check is green, and the previous version is kept in reserve.',
    },
    {
      id: 'plutus',
      name: 'Plutus',
      role: 'Finance',
      pal: ['#3fbf7a', '#d6a82a', '#eaffd8'],
      you: 'How are the savings tracking this month?',
      reply:
        'Steady. Spending stayed under plan and nothing needs moving today. I would not trade on a hunch.',
    },
    {
      id: 'apollo',
      name: 'Apollo',
      role: 'Coach',
      pal: ['#ffd24a', '#8fbf6a', '#fff3bd'],
      you: 'How did recovery look this week?',
      reply:
        'A calm week. Rest held steady and effort stayed in range. Keep tomorrow easy and let the daylight do some of the work.',
    },
    {
      id: 'iris',
      name: 'Iris',
      role: 'Mail and calendar',
      pal: ['#ff7ac8', '#5ad1ff', '#ffe27a'],
      you: 'What is on tomorrow?',
      reply:
        'A light day: two meetings and one draft reply waiting for your approval. Nothing is sent until you say so.',
    },
    {
      id: 'dionysus',
      name: 'Dionysus',
      role: 'Travel and food',
      pal: ['#b04ad6', '#e0456a', '#f0d0ff'],
      you: 'Where should we eat on Friday?',
      reply:
        'A small place with a long table and a short menu. I have two to choose from; nothing is booked.',
    },
  ];
  // One model per god, models/<god id>.glb: geometry only (positions and indices), about 15k triangles, generated
  // from a photograph of a real sculpture (see ASSET-LICENSE). Every model is a head or bust and fills the stage by
  // itself (kind 'bust'). yaw turns it about Y to face the camera; scale and dy nudge the fit; crop is an optional
  // box in fractions of the model's own extent; eyes are optional glow positions; orient 'winding' trusts the
  // triangle winding for normals. For tuning, ?yaw=, ?scale=, ?dy= and ?crop= override these for the god being viewed.
  var SCANS = {
    apollo: { kind: 'bust', yaw: 0, scale: 1, dy: 0 }, // laurel and cloak are in the model; the lyre is a prop
    dionysus: { kind: 'bust', yaw: 0, scale: 1, dy: 0, crop: { y: [0.04, 1] } }, // drops the thin base disc
    janus: { kind: 'bust', yaw: 0, scale: 1, dy: 0 }, // two profile faces back to back, seen from the side
    hephaestus: { kind: 'bust', yaw: 0, scale: 1, dy: 0 },
    atlas: { kind: 'bust', yaw: 0, scale: 0.78, dy: -0.12 }, // raised arms: leave room above them for the globe
    themis: { kind: 'bust', yaw: 0, scale: 1, dy: 0 },
    iris: { kind: 'bust', yaw: 0, scale: 1, dy: 0, anchors: { rainbow: [0, -1.2, -0.6] } },
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
    uSurf: { value: 0 },
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
      'varying float vMix, vT, vY, vDepth, vRim, vFace, vLit;',
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
      '  vLit = max(dot(n, normalize(vec3(-0.35, 0.5, 0.8))), 0.0);',
      '  gl_PointSize = aRnd.y * uPx / -mv.z * (1.0 + mid * 0.5) * (1.0 - 0.15 * t);',
      '  gl_Position = projectionMatrix * mv;',
      '  vMix = aRnd.z; vT = t; vY = p.y; vDepth = clamp(1.25 - (-mv.z - 3.0) * 0.28, 0.35, 1.3);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uA, uB, uC;',
      'uniform float uTime, uSpeak, uThink, uSurf;',
      'varying float vMix, vT, vY, vDepth, vRim, vFace, vLit;',
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
      '  float alpha = soft * vDepth * (0.9 - 0.15 * vT) * k * mix(1.0, vFace * (0.55 + 1.1 * vLit) * (1.0 - 0.6 * uSurf), vT);',
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
  // procedural head and shoulder wire shells (hidden when a scanned head or bust is in use)
  var headWire = edgeObj(new THREE.SphereGeometry(1, 20, 14), 'a', 0.16);
  headWire.scale.set(0.4, 0.5, 0.45);
  headWire.position.set(HEAD_C[0], HEAD_C[1], HEAD_C[2]);
  world.add(headWire);
  var shoulderWire = edgeObj(new THREE.SphereGeometry(1, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2), 'a', 0.22);
  shoulderWire.scale.set(0.88, 0.72, 0.42);
  shoulderWire.position.set(0, -1.1, 0);
  world.add(shoulderWire);

  // shaded hologram surface of the loaded model (fresnel rim, key light, soft scanlines); fades in with the morph
  var surfMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uA: U.uA, uB: U.uB, uC: U.uC, uShow: { value: 0 }, uSpeak: pu.uSpeak },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: [
      'varying vec3 vN; varying vec3 vV; varying float vY;',
      'void main() {',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  vN = normalize(normalMatrix * normal);',
      '  vV = -mv.xyz;',
      '  vY = position.y;',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uA, uB, uC;',
      'uniform float uTime, uShow, uSpeak;',
      'varying vec3 vN; varying vec3 vV; varying float vY;',
      'void main() {',
      '  vec3 n = normalize(vN);',
      '  vec3 v = normalize(vV);',
      '  float nd = dot(n, v);',
      '  float front = step(0.0, nd);',
      '  float rim = pow(1.0 - abs(nd), 2.5);',
      '  float lit = max(dot(n, normalize(vec3(-0.35, 0.5, 0.8))), 0.0);',
      '  float scan = 0.88 + 0.12 * sin(vY * 90.0 - uTime * 2.5);',
      '  float sweep = exp(-pow(fract(uTime * 0.22) * 2.8 - 1.4 - vY, 2.0) * 30.0);',
      '  vec3 col = mix(uA, uC, rim * 0.8 + sweep * 0.6);',
      '  float a = (0.08 + 0.7 * lit * front + 0.7 * rim) * scan + sweep * 0.5 + uSpeak * 0.08;',
      '  gl_FragColor = vec4(col * a * uShow, a * uShow);',
      '}',
    ].join('\n'),
  });
  var surfMesh = new THREE.Mesh(new THREE.BufferGeometry(), surfMat);
  surfMesh.frustumCulled = false;
  surfMesh.visible = false;
  world.add(surfMesh);

  var attrGroup = new THREE.Group();
  world.add(attrGroup);

  // ---------- props: volumetric 3D objects that share the hologram surface look ----------
  // Built from three.js primitives, one merged mesh per tone slot, anchored in bust space (the figure is about 2.3
  // tall, centred on the origin). Anchors come from SCANS[god].anchors, so a new mesh only needs new numbers.
  var PI = Math.PI;
  var propMats = {};
  var propMatList = [];
  var slotUniform = { a: U.uA, b: U.uB, c: U.uC };
  function propMat(slot, alpha, uniq) {
    var key = slot + (alpha || 1) + (uniq || '');
    if (propMats[key]) return propMats[key];
    var m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uCol: slotUniform[slot],
        uShow: { value: 0 },
        uAlpha: { value: alpha || 1 },
        uSpeak: pu.uSpeak,
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: [
        'varying vec3 vN; varying vec3 vV; varying float vWY;',
        'void main() {',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vN = normalize(normalMatrix * normal);',
        '  vV = -mv.xyz;',
        '  vWY = (modelMatrix * vec4(position, 1.0)).y;',
        '  gl_Position = projectionMatrix * mv;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uCol;',
        'uniform float uTime, uShow, uAlpha, uSpeak;',
        'varying vec3 vN; varying vec3 vV; varying float vWY;',
        'void main() {',
        '  vec3 n = normalize(vN);',
        '  float nd = dot(n, normalize(vV));',
        '  float rim = pow(1.0 - abs(nd), 2.2);',
        '  float lit = max(dot(n * sign(nd), normalize(vec3(-0.35, 0.5, 0.8))), 0.0);',
        '  float scan = 0.9 + 0.1 * sin(vWY * 80.0 - uTime * 2.2);',
        '  float a = (0.1 + 0.42 * lit + 0.75 * rim + uSpeak * 0.08) * scan * uAlpha;',
        '  vec3 col = mix(uCol, vec3(1.0), rim * 0.35);',
        '  gl_FragColor = vec4(col * a * uShow, a * uShow);',
        '}',
      ].join('\n'),
    });
    propMats[key] = m;
    propMatList.push(m);
    return m;
  }

  function xf(geom, p, r, s) {
    var m = new THREE.Matrix4().compose(
      new THREE.Vector3(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0)),
      new THREE.Vector3(s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1),
    );
    geom.applyMatrix4(m);
    return geom;
  }
  function mergeGeoms(list) {
    var P = [];
    var Nn = [];
    list.forEach(function (g) {
      var ng = g.index ? g.toNonIndexed() : g;
      P.push(ng.attributes.position.array);
      Nn.push(ng.attributes.normal.array);
      if (ng !== g) ng.dispose();
      g.dispose();
    });
    var cat = function (arrs) {
      var len = arrs.reduce(function (t, a) {
        return t + a.length;
      }, 0);
      var out = new Float32Array(len);
      var o = 0;
      arrs.forEach(function (a) {
        out.set(a, o);
        o += a.length;
      });
      return out;
    };
    var g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.BufferAttribute(cat(P), 3));
    g2.setAttribute('normal', new THREE.BufferAttribute(cat(Nn), 3));
    return g2;
  }
  function part(parent, slot, geoms, alpha, uniq) {
    var m = new THREE.Mesh(mergeGeoms(geoms), propMat(slot, alpha, uniq));
    m.frustumCulled = false;
    m.userData.shared = true;
    if (uniq === 'strings') m.material.userData.shimmer = true;
    parent.add(m);
    return m;
  }
  function grp(parent, anim, pos) {
    var g = new THREE.Group();
    if (pos) g.position.set(pos[0], pos[1], pos[2]);
    if (pos && pos[3]) g.scale.setScalar(pos[3]); // optional fourth number: scale
    g.userData.anim = anim || '';
    parent.add(g);
    return g;
  }
  // a thick bevelled box, centred
  function bevBox(w, h, d, b) {
    var sh = new THREE.Shape();
    sh.moveTo(-w / 2 + b, -h / 2 + b);
    sh.lineTo(w / 2 - b, -h / 2 + b);
    sh.lineTo(w / 2 - b, h / 2 - b);
    sh.lineTo(-w / 2 + b, h / 2 - b);
    sh.closePath();
    var g = new THREE.ExtrudeGeometry(sh, {
      depth: d - 2 * b,
      bevelEnabled: true,
      bevelSize: b,
      bevelThickness: b,
      bevelSegments: 2,
      curveSegments: 4,
    });
    g.translate(0, 0, -(d - 2 * b) / 2);
    return g;
  }
  // a tube along a curve with a radius that changes along its length
  function sweep(pts, rad, segs, radial) {
    var curve = new THREE.CatmullRomCurve3(
      pts.map(function (p) {
        return new THREE.Vector3(p[0], p[1], p[2]);
      }),
    );
    var fr = curve.computeFrenetFrames(segs, false);
    var pos = [];
    var nor = [];
    var idx = [];
    for (var i = 0; i <= segs; i++) {
      var c = curve.getPointAt(i / segs);
      var r = rad(i / segs);
      for (var j = 0; j < radial; j++) {
        var a = (j / radial) * PI * 2;
        var nx = fr.normals[i].x * Math.cos(a) + fr.binormals[i].x * Math.sin(a);
        var ny = fr.normals[i].y * Math.cos(a) + fr.binormals[i].y * Math.sin(a);
        var nz = fr.normals[i].z * Math.cos(a) + fr.binormals[i].z * Math.sin(a);
        pos.push(c.x + nx * r, c.y + ny * r, c.z + nz * r);
        nor.push(nx, ny, nz);
      }
    }
    for (var s = 0; s < segs; s++) {
      for (var k = 0; k < radial; k++) {
        var a0 = s * radial + k;
        var b0 = s * radial + ((k + 1) % radial);
        idx.push(a0, a0 + radial, b0, b0, a0 + radial, b0 + radial);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
  }
  function cylBetween(a, b, r, seg) {
    var d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    var len = d.length();
    var g = new THREE.CylinderGeometry(r, r, len, seg || 6, 1);
    var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
        q,
        new THREE.Vector3(1, 1, 1),
      ),
    );
    return g;
  }
  function anchor(name, def) {
    var a = SCANS[god.id].anchors;
    return a && a[name] ? a[name] : def;
  }

  var PROPS = {
    // anvil with a horn, a hammer drifting beside it, sparks rising
    hephaestus: function (root) {
      var an = grp(root, '', anchor('anvil', [1.0, -0.85, 0.35, 0.5]));
      var s = [
        xf(bevBox(0.95, 0.16, 0.5, 0.03), [0, 0, 0]),
        xf(bevBox(0.42, 0.3, 0.34, 0.03), [0, 0.22, 0]),
        xf(bevBox(1.05, 0.17, 0.46, 0.04), [0, 0.45, 0]),
        xf(new THREE.ConeGeometry(0.2, 0.5, 8), [0.77, 0.45, 0], [0, 0, -PI / 2]),
      ];
      part(an, 'c', s, 1);
      part(an, 'b', [xf(new THREE.SphereGeometry(0.1, 8, 6), [0, 0.6, 0], 0, [1.6, 0.5, 1])], 0.8);
      var sp = grp(an, 'sparks', [0, 0.6, 0]);
      var dots = [];
      for (var i = 0; i < 9; i++)
        dots.push(
          xf(new THREE.SphereGeometry(0.022, 5, 4), [
            Math.sin(i * 2.4) * 0.28,
            (i % 3) * 0.14,
            Math.cos(i * 1.7) * 0.15,
          ]),
        );
      part(sp, 'b', dots, 1);
      var hm = grp(root, 'drift', anchor('hammer', [-1.0, 0.1, 0.35, 0.65]));
      part(
        hm,
        'b',
        [new THREE.CylinderGeometry(0.036, 0.04, 0.95, 8), xf(bevBox(0.46, 0.22, 0.22, 0.04), [0, 0.5, 0])],
        1,
      );
      part(hm, 'c', [xf(new THREE.TorusGeometry(0.045, 0.012, 5, 10), [0, -0.4, 0], [PI / 2, 0, 0])], 1);
    },
    // scales on a post with two pans on chains, and a blindfold ring
    themis: function (root) {
      var sc = grp(root, '', anchor('scales', [1.2, -0.2, 0.25, 0.7]));
      part(
        sc,
        'c',
        [
          xf(new THREE.CylinderGeometry(0.026, 0.034, 1.05, 8), [0, -0.05, 0]),
          xf(new THREE.CylinderGeometry(0.2, 0.24, 0.06, 12), [0, -0.58, 0]),
          xf(new THREE.SphereGeometry(0.06, 8, 6), [0, 0.5, 0]),
        ],
        1,
      );
      var beam = grp(sc, 'sway', [0, 0.45, 0]);
      var bg = [xf(new THREE.CylinderGeometry(0.02, 0.02, 0.98, 6), [0, 0, 0], [0, 0, PI / 2])];
      var pans = [];
      [-0.49, 0.49].forEach(function (x) {
        bg.push(
          cylBetween([x, 0, 0], [x - 0.19, -0.42, 0], 0.008, 4),
          cylBetween([x, 0, 0], [x + 0.19, -0.42, 0], 0.008, 4),
          cylBetween([x, 0, 0], [x, -0.42, 0.18], 0.008, 4),
        );
        pans.push(
          xf(new THREE.SphereGeometry(0.2, 12, 5, 0, PI * 2, PI / 2, PI / 2), [x, -0.42, 0], 0, [1, 0.45, 1]),
        );
      });
      part(beam, 'b', bg, 1);
      part(beam, 'a', pans, 1);
    },
    // a doorway arch with depth and a key
    janus: function (root) {
      var ar = grp(root, '', anchor('arch', [0, -0.2, -0.6]));
      var w = 1.05;
      var sh = new THREE.Shape();
      sh.moveTo(-w, -1.0);
      sh.lineTo(-w, 0.55);
      sh.absarc(0, 0.55, w, PI, 0, true);
      sh.lineTo(w, -1.0);
      sh.lineTo(w - 0.13, -1.0);
      sh.lineTo(w - 0.13, 0.55);
      sh.absarc(0, 0.55, w - 0.13, 0, PI, false);
      sh.lineTo(-w + 0.13, -1.0);
      sh.closePath();
      part(
        ar,
        'a',
        [
          new THREE.ExtrudeGeometry(sh, {
            depth: 0.1,
            bevelEnabled: true,
            bevelSize: 0.025,
            bevelThickness: 0.025,
            bevelSegments: 2,
            curveSegments: 20,
          }),
        ],
        1.2,
      );
      var ky = grp(root, 'spin', anchor('key', [1.15, -0.3, 0.3, 0.6]));
      part(ky, 'a', [xf(new THREE.TorusGeometry(0.14, 0.036, 8, 18), [0, 0.38, 0])], 1);
      part(
        ky,
        'b',
        [
          new THREE.CylinderGeometry(0.03, 0.03, 0.72, 8),
          xf(bevBox(0.16, 0.07, 0.05, 0.015), [0.09, -0.3, 0]),
          xf(bevBox(0.12, 0.07, 0.05, 0.015), [0.07, -0.18, 0]),
        ],
        1,
      );
    },
    // glowing constellation rings around the globe of the mesh
    atlas: function (root) {
      var gl = grp(root, 'spin', anchor('globe', [0, 0.92, 0]));
      part(gl, 'a', [new THREE.SphereGeometry(anchor('globeR', [0.5])[0], 24, 16)], 1.1);
      var R = anchor('globeR', [0.5])[0] * 1.2;
      var tilt = grp(gl, '');
      tilt.rotation.x = 1.15;
      part(tilt, 'a', [new THREE.TorusGeometry(R, 0.03, 6, 56)], 1);
      var stars = [];
      for (var i = 0; i < 14; i++)
        stars.push(
          xf(new THREE.SphereGeometry(0.035, 6, 4), [
            Math.cos((i / 14) * PI * 2) * R,
            Math.sin((i / 14) * PI * 2) * R,
            0,
          ]),
        );
      part(tilt, 'c', stars, 1);
      var t2 = grp(gl, '');
      t2.rotation.set(-0.5, 0, 0.9);
      part(t2, 'b', [new THREE.TorusGeometry(R * 1.12, 0.022, 6, 56)], 1);
    },
    // a cornucopia spilling coins, and a spinning coin
    plutus: function (root) {
      var hn = grp(root, '', anchor('horn', [0.9, -0.7, 0.3, 0.6]));
      part(
        hn,
        'b',
        [
          sweep(
            [
              [0, 0, 0],
              [0.28, 0.12, 0],
              [0.5, 0.5, 0.05],
              [0.42, 0.95, 0.1],
            ],
            function (t) {
              return 0.03 + 0.17 * t * t;
            },
            14,
            10,
          ),
        ],
        1,
      );
      part(
        hn,
        'a',
        [xf(new THREE.TorusGeometry(0.18, 0.025, 6, 16), [0.42, 0.97, 0.1], [PI / 2 - 0.2, 0, 0])],
        1,
      );
      var cs = [];
      for (var i = 0; i < 6; i++)
        cs.push(
          xf(
            new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12),
            [0.42 + Math.sin(i * 2) * 0.16, 1.1 + (i % 3) * 0.08, 0.1 + Math.cos(i * 2) * 0.1],
            [i, 0.3, i * 0.5],
          ),
        );
      part(hn, 'b', cs, 1);
      var co = grp(root, 'spin', anchor('coin', [-1.05, 0.1, 0.3, 0.8]));
      part(
        co,
        'a',
        [
          xf(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 20), 0, [PI / 2, 0, 0]),
          xf(new THREE.TorusGeometry(0.22, 0.018, 6, 24), [0, 0, 0]),
        ],
        1,
      );
      part(co, 'b', [xf(new THREE.CylinderGeometry(0.12, 0.12, 0.05, 14), 0, [PI / 2, 0, 0])], 0.6);
    },
    // a lyre with arms, a yoke, a sound box and shimmering strings; a laurel ring of leaves
    apollo: function (root) {
      var ly = grp(root, '', anchor('lyre', [-1.1, -0.2, 0.3, 0.7]));
      var arm = function (sx) {
        return sweep(
          [
            [sx * 0.12, -0.45, 0],
            [sx * 0.3, -0.12, 0],
            [sx * 0.26, 0.32, 0],
            [sx * 0.13, 0.5, 0],
          ],
          function () {
            return 0.03;
          },
          12,
          6,
        );
      };
      part(
        ly,
        'a',
        [
          arm(-1),
          arm(1),
          xf(new THREE.CylinderGeometry(0.025, 0.025, 0.36, 6), [0, 0.5, 0], [0, 0, PI / 2]),
          xf(new THREE.SphereGeometry(1, 10, 8), [0, -0.5, 0], 0, [0.2, 0.15, 0.09]),
        ],
        1,
      );
      var st = [];
      for (var i = 0; i < 5; i++)
        st.push(new THREE.CylinderGeometry(0.006, 0.006, 0.9, 4).translate(-0.12 + i * 0.06, 0.02, 0));
      part(ly, 'c', st, 0.9, 'strings');
    },
    // a banded rainbow of thick translucent tubes, and a flowing veil
    iris: function (root) {
      var rb = grp(root, '', anchor('rainbow', [0, -1.0, -0.5]));
      [
        ['a', 1.3],
        ['b', 1.43],
        ['c', 1.56],
      ].forEach(function (b) {
        part(rb, b[0], [new THREE.TorusGeometry(b[1], 0.06, 8, 48, PI)], 0.75);
      });
    },
    // a thyrsus with a pine cone and ribbons, ivy vines with leaves, a cluster of grapes
    dionysus: function (root) {
      var th = grp(root, '', anchor('thyrsus', [1.15, -0.1, 0.3, 0.75]));
      part(th, 'c', [new THREE.CylinderGeometry(0.028, 0.034, 2.0, 8).translate(0, 0.05, 0)], 1);
      var cone = new THREE.LatheGeometry(
        [
          [0.001, 0],
          [0.09, 0.05],
          [0.15, 0.2],
          [0.09, 0.36],
          [0.001, 0.42],
        ].map(function (q) {
          return new THREE.Vector2(q[0], q[1]);
        }),
        10,
      ).translate(0, 1.05, 0);
      part(th, 'b', [cone], 1);
      var rib = [];
      for (var s = 0; s < 2; s++) {
        var pts = [];
        for (var i = 0; i <= 16; i++)
          pts.push([Math.cos(i * 0.9 + s * PI) * 0.07, 0.2 + i * 0.05, Math.sin(i * 0.9 + s * PI) * 0.07]);
        rib.push(
          sweep(
            pts,
            function () {
              return 0.012;
            },
            24,
            5,
          ),
        );
      }
      part(th, 'a', rib, 1);
      var gr = grp(root, 'bob', anchor('grapes', [-1.05, -0.4, 0.3, 0.8]));
      var gs = [];
      for (var g = 0; g < 16; g++) {
        var row = Math.floor(Math.sqrt(g));
        gs.push(
          xf(new THREE.SphereGeometry(0.065, 8, 6), [
            Math.sin(g * 2.4) * (0.17 - row * 0.03),
            -row * 0.1,
            Math.cos(g * 2.4) * (0.12 - row * 0.02),
          ]),
        );
      }
      part(gr, 'b', gs, 1);
      part(
        gr,
        'a',
        [
          sweep(
            [
              [0, 0.05, 0],
              [0.05, 0.18, 0],
              [0.12, 0.3, 0],
            ],
            function () {
              return 0.014;
            },
            6,
            5,
          ),
        ],
        1,
      );
    },
  };

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
    var s = ((full ? 2.3 : 1.4) / (maxY - minY || 1)) * (cfg.scale || 1);
    var cx = (minX + maxX) / 2;
    var cz = (minZ + maxZ) / 2;
    var oy = (minY + maxY) / 2;
    var cy = (full ? 0 : 0.5) + (cfg.dy || 0);
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
    // the same normalised triangles, kept as a shaded hologram surface (positions and outward face normals)
    var sp = new Float32Array(tris.length * 9);
    var sn = new Float32Array(tris.length * 9);
    var ccos = Math.cos(yaw);
    var csin = Math.sin(yaw);
    tris.forEach(function (t, i) {
      var q = [];
      for (var k = 0; k < 9; k += 3) {
        var x0 = (t[k] - cx) * s;
        var z0 = (t[k + 2] - cz) * s;
        q.push(x0 * ccos + z0 * csin, (t[k + 1] - oy) * s + cy, -x0 * csin + z0 * ccos);
      }
      var ux = q[3] - q[0];
      var uy = q[4] - q[1];
      var uz = q[5] - q[2];
      var wx = q[6] - q[0];
      var wy = q[7] - q[1];
      var wz = q[8] - q[2];
      var fx = uy * wz - uz * wy;
      var fy = uz * wx - ux * wz;
      var fz = ux * wy - uy * wx;
      var fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl;
      fy /= fl;
      fz /= fl;
      // outward: away from the middle of the model
      var mxc = (q[0] + q[3] + q[6]) / 3;
      var myc = (q[1] + q[4] + q[7]) / 3 - cy;
      var mzc = (q[2] + q[5] + q[8]) / 3;
      if (cfg.orient !== 'winding' && fx * mxc + fy * myc + fz * mzc < 0) {
        fx = -fx;
        fy = -fy;
        fz = -fz;
      }
      for (var j = 0; j < 9; j += 3) {
        sp[i * 9 + j] = q[j];
        sp[i * 9 + j + 1] = q[j + 1];
        sp[i * 9 + j + 2] = q[j + 2];
        sn[i * 9 + j] = fx;
        sn[i * 9 + j + 1] = fy;
        sn[i * 9 + j + 2] = fz;
      }
    });
    var M = CFG.scanPoints;
    var out = new Float32Array(M * 6);
    out.surf = { p: sp, n: sn };
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
        scans[id] = pts ? { pts: pts, surf: pts.surf } : { failed: true };
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
    seed = 1234 + godIdx * 77;
    var src;
    for (var i = 0; i < N; i++) {
      if (scan && kind !== 'head') {
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
    surfMesh.geometry.dispose();
    surfMesh.geometry = new THREE.BufferGeometry();
    surfMesh.visible = !!(scan && scan.surf);
    if (scan && scan.surf) {
      surfMesh.geometry.setAttribute('position', new THREE.BufferAttribute(scan.surf.p, 3));
      surfMesh.geometry.setAttribute('normal', new THREE.BufferAttribute(scan.surf.n, 3));
    }
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
    if (PROPS[god.id] && !params.has('noprops')) PROPS[god.id](attrGroup);
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
        if (!c.userData.shared) c.material.dispose();
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
    pu.uPx.value = ((h * dpr) / (2 * Math.tan((CFG.fov * Math.PI) / 360))) * (w < 600 ? 2.1 : 1);
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
    surfMat.uniforms.uShow.value = ss(0.55, 1, m);
    pu.uSurf.value = surfMesh.visible ? 1 : 0;
    headWire.material.opacity = usingMesh ? 0 : wireOp * 0.16;
    shoulderWire.material.opacity = usingBustMesh ? 0 : wireOp * 0.22;
    propMatList.forEach(function (pm2) {
      pm2.uniforms.uShow.value = wireOp;
      if (pm2.uniforms.uAlpha.value !== undefined && pm2.userData.shimmer)
        pm2.uniforms.uAlpha.value = 0.65 + 0.3 * Math.sin(time * 5) + speak * 0.2;
    });
    attrGroup.scale.setScalar(0.7 + 0.3 * e);
    attrGroup.traverse(function (c) {
      var an = c.userData.anim;
      if (!an) return;
      if (an === 'sway') c.rotation.z = anim ? Math.sin(time * 1.1) * 0.08 : 0;
      else if (an === 'spin') c.rotation.y = anim ? time * 0.9 : 0.5;
      else if (an === 'drift') {
        c.rotation.z = (anim ? Math.sin(time * 1.3) * 0.12 : 0) - 0.5 - speak * 0.15;
        c.position.y =
          (c.userData.y0 === undefined ? (c.userData.y0 = c.position.y) : c.userData.y0) +
          (anim ? Math.sin(time * 1.1) * 0.05 : 0);
      } else if (an === 'bob') {
        c.rotation.z = anim ? Math.sin(time * 1.4) * 0.06 : 0;
      } else if (an === 'sparks') {
        var f = anim ? (time * 0.5) % 1 : 0.4;
        c.position.y = 0.6 + f * 0.5;
        c.scale.setScalar(1 - f * 0.8);
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
    surfMesh.geometry.dispose();
    [pm, glassMat, hazeBandMat, surfMat].forEach(function (m) {
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
