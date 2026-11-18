// 3D prototype for the agent hub orb and bust (Hephaestus palette).
// Classic script: uses the global THREE from vendor/three.min.js, so it runs from the file system.
// Procedural only: every shape below is generated here, no meshes or textures are loaded.
(function () {
  'use strict';

  var stage = document.getElementById('stage3d');
  var canvas = stage.querySelector('canvas');
  var perfEl = document.getElementById('perf');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var params = new URLSearchParams(window.location.search);

  var CFG = {
    particles: 7000,
    fov: 40,
    morphSpeed: 0.55, // full morph in about 1.8 s
    dprCap: window.innerWidth < 700 ? 1.5 : 2,
    slowMs: 34, // average frame interval that triggers degrading
    tones: { a: '--stage-a', b: '--stage-b', c: '--stage-c' },
  };

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
    return ((rnd() + rnd() + rnd()) / 3) * 2 - 1; // bell-ish, -1..1
  }

  function cssColor(name) {
    var v = getComputedStyle(stage).getPropertyValue(name).trim();
    var m = /^#([0-9a-f]{6})$/i.exec(v);
    if (!m) return [1, 0.6, 0.1];
    var n = parseInt(m[1], 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function unitVec() {
    var u = rnd() * 2 - 1;
    var t = rnd() * Math.PI * 2;
    var s = Math.sqrt(1 - u * u);
    return [s * Math.cos(t), u, s * Math.sin(t)];
  }

  function ellipsoid(c, r) {
    var v = unitVec();
    return [c[0] + v[0] * r[0], c[1] + v[1] * r[1], c[2] + v[2] * r[2]];
  }

  function boxSurface(c, h) {
    var f = Math.floor(rnd() * 6);
    var a = rnd() * 2 - 1;
    var b = rnd() * 2 - 1;
    var ax = f >> 1;
    var p = [0, 0, 0];
    p[ax] = f & 1 ? 1 : -1;
    p[(ax + 1) % 3] = a;
    p[(ax + 2) % 3] = b;
    return [c[0] + p[0] * h[0], c[1] + p[1] * h[1], c[2] + p[2] * h[2]];
  }

  // a point on a tilted circle with soft thickness (gaussian), for particle bands
  function ringPoint(radius, tiltX, tiltZ, thick) {
    var a = rnd() * Math.PI * 2;
    var rr = radius + gauss() * thick;
    var x = Math.cos(a) * rr;
    var y = gauss() * thick;
    var z = Math.sin(a) * rr;
    var y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
    var z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
    return [x * Math.cos(tiltZ) - y1 * Math.sin(tiltZ), x * Math.sin(tiltZ) + y1 * Math.cos(tiltZ), z1];
  }

  var RINGS = [
    { r: 1.3, tx: 1.15, tz: 0.25, speed: 0.16 },
    { r: 0.95, tx: -0.7, tz: 0.6, speed: -0.24 },
    { r: 0.66, tx: 0.35, tz: -0.9, speed: 0.34 },
  ];

  // ---------- orb shapes, one per variant ----------
  // A: particle-band halo. A thin shell, three soft particle bands and a dense core.
  function orbA() {
    var r = rnd();
    var p;
    if (r < 0.18) {
      p = unitVec();
      return [p[0] * 1.05, p[1] * 1.05, p[2] * 1.05];
    }
    if (r < 0.76) {
      var ring = RINGS[Math.floor(rnd() * RINGS.length)];
      return ringPoint(ring.r, ring.tx, ring.tz, 0.045);
    }
    if (r < 0.9) {
      p = unitVec();
      var d = Math.pow(rnd(), 0.6) * 0.3;
      return [p[0] * d, p[1] * d, p[2] * d];
    }
    p = unitVec();
    var q = 1.4 + rnd() * 0.7;
    return [p[0] * q, p[1] * q * 0.7, p[2] * q];
  }

  // B: soft glass sphere. Sparkle shell, a luminous interior and a little dust.
  function orbB() {
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

  // C: nebula. Three spiral arms, a bright bulge and loose dust, tilted for depth.
  function orbC() {
    var r = rnd();
    var x;
    var y;
    var z;
    if (r < 0.66) {
      var arm = Math.floor(rnd() * 3);
      var rr = 0.12 + Math.pow(rnd(), 0.75) * 1.3;
      var ang = rr * 2.6 + arm * 2.094 + gauss() * 0.28;
      x = Math.cos(ang) * rr;
      z = Math.sin(ang) * rr;
      y = gauss() * 0.1 * (1.4 - rr);
    } else if (r < 0.9) {
      var v = unitVec();
      var d = Math.pow(rnd(), 0.7) * 0.42;
      x = v[0] * d;
      y = v[1] * d;
      z = v[2] * d;
    } else {
      var w = unitVec();
      var q = 1.2 + rnd() * 0.7;
      x = w[0] * q;
      y = w[1] * q * 0.6;
      z = w[2] * q;
    }
    var tilt = 0.55; // rotate about X
    return [x, y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)];
  }

  // ---------- bust shape (procedural stand-in for a scanned model) ----------
  // Round cranium, tapered jaw, brow, nose and chin, a flared neck, sloping trapezius lines,
  // deltoids, an upper chest, and an anvil plate on the chest (the Hephaestus attribute).
  function bustPoint() {
    var r = rnd();
    var p;
    var k;
    if (r < 0.4) {
      p = ellipsoid([0, 0.64, -0.02], [0.4, 0.5, 0.45]);
      if (p[1] < 0.64) {
        k = (0.64 - p[1]) / 0.5;
        p[0] *= 1 - 0.3 * k * k;
        if (p[2] > 0) p[2] *= 1 - 0.2 * k;
      }
      return p;
    }
    if (r < 0.42) return ellipsoid([0, 0.57, 0.45], [0.05, 0.12, 0.07]); // nose
    if (r < 0.44) return ellipsoid([0, 0.2, 0.34], [0.11, 0.06, 0.08]); // chin
    if (r < 0.47) return ellipsoid([0, 0.76, 0.38], [0.29, 0.04, 0.07]); // brow
    if (r < 0.56) {
      var a = rnd() * Math.PI * 2;
      var y = -0.42 + rnd() * 0.62;
      var rad = 0.16 + (0.13 * Math.max(0, -0.05 - y)) / 0.37;
      return [Math.cos(a) * rad, y, Math.sin(a) * rad * 0.95];
    }
    if (r < 0.64) {
      var s = rnd() < 0.5 ? -1 : 1;
      var t = rnd();
      var v = unitVec();
      var tube = 0.11 * (1 - 0.5 * t);
      return [s * (0.17 + t * 0.7) + v[0] * tube, -0.3 - t * 0.38 + v[1] * tube, v[2] * tube * 1.2];
    }
    if (r < 0.84) {
      p = ellipsoid([0, -1.1, 0], [0.88, 0.72, 0.42]);
      p[1] = -1.1 + Math.abs(p[1] + 1.1);
      return p;
    }
    if (r < 0.89) return ellipsoid([rnd() < 0.5 ? -0.84 : 0.84, -0.76, 0], [0.17, 0.2, 0.2]);
    if (r < 0.95) {
      var boxes = [
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
      ];
      var b = boxes[Math.floor(rnd() * boxes.length)];
      return boxSurface(b[0], b[1]);
    }
    return ringPoint(1.25, 1.45, 0.1, 0.03);
  }

  // ---------- capability checks ----------
  function webglOk() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
    } catch {
      return false;
    }
  }

  var flatBtns = document.querySelectorAll('[data-renderer-set]');
  var orbBtns = document.querySelectorAll('[data-orb-set]');
  function pressed(btns, attr, value) {
    btns.forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute(attr) === value ? 'true' : 'false');
    });
  }

  function setRenderer(kind, note) {
    stage.setAttribute('data-renderer', kind);
    pressed(flatBtns, 'data-renderer-set', kind);
    if (note) perfEl.textContent = note;
    else if (kind === 'flat') perfEl.textContent = 'flat renderer (SVG/CSS)';
    if (kind === 'flat') stopLoop();
    else if (ready) startLoop();
  }

  // the orb variant also tints the flat fallback (CSS reads data-orb)
  function setOrbAttr(k) {
    stage.setAttribute('data-orb', k);
    pressed(orbBtns, 'data-orb-set', k);
  }
  var variant = /^[abc]$/.test(params.get('orb') || '') ? params.get('orb') : 'a';
  setOrbAttr(variant);
  orbBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      variant = btn.getAttribute('data-orb-set');
      setOrbAttr(variant);
      if (ready) applyVariant();
    });
  });

  if (typeof THREE === 'undefined' || !webglOk() || params.has('flat')) {
    perfEl.textContent = params.has('flat') ? 'flat renderer (forced)' : 'flat renderer (no WebGL)';
    flatBtns.forEach(function (b) {
      if (b.getAttribute('data-renderer-set') === 'webgl') b.disabled = true;
    });
    return;
  }

  // ---------- scene ----------
  var renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // tokens are sRGB values; keep them as written
  renderer.setClearColor(0x000000, 0);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(CFG.fov, 1, 0.1, 50);
  var world = new THREE.Group();
  scene.add(world);

  var toneA = cssColor(CFG.tones.a);
  var toneB = cssColor(CFG.tones.b);
  var toneC = cssColor(CFG.tones.c);
  function color(t) {
    return new THREE.Color().setRGB(t[0], t[1], t[2]);
  }

  // uniforms shared by every orb shader
  var U = {
    uTime: { value: 0 },
    uOrb: { value: 1 }, // 1 = full orb, falls when the bust takes over
    uThink: { value: 0 },
    uA: { value: new THREE.Vector3(toneA[0], toneA[1], toneA[2]) },
    uB: { value: new THREE.Vector3(toneB[0], toneB[1], toneB[2]) },
    uC: { value: new THREE.Vector3(toneC[0], toneC[1], toneC[2]) },
  };

  // One Points object carries the whole body: each particle knows its orb and its bust position.
  var N = CFG.particles;
  var orbPos = { a: new Float32Array(N * 3), b: new Float32Array(N * 3), c: new Float32Array(N * 3) };
  var posBust = new Float32Array(N * 3);
  var rndAttr = new Float32Array(N * 4);
  for (var i = 0; i < N; i++) {
    orbPos.a.set(orbA(), i * 3);
    orbPos.b.set(orbB(), i * 3);
    orbPos.c.set(orbC(), i * 3);
    posBust.set(bustPoint(), i * 3);
    rndAttr[i * 4] = rnd();
    rndAttr[i * 4 + 1] = 0.045 + rnd() * rnd() * 0.1;
    rndAttr[i * 4 + 2] = rnd();
    rndAttr[i * 4 + 3] = rnd();
  }
  var pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(orbPos[variant].slice(), 3));
  pg.setAttribute('aBust', new THREE.BufferAttribute(posBust, 3));
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
      'attribute vec4 aRnd;',
      'uniform float uMorph, uTime, uPx, uThink;',
      'varying float vMix, vT, vY, vDepth;',
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
      '  p *= 1.0 + 0.018 * sin(uTime * 1.4 + aRnd.w * 6.28) * (1.0 - t);',
      '  float g = step(0.975, fract(sin(floor(p.y * 14.0) * 12.9898 + floor(uTime * 6.0) * 78.233) * 43758.5));',
      '  p.x += g * 0.05 * t;',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_PointSize = aRnd.y * uPx / -mv.z * (1.0 + mid * 0.5) * (1.0 - 0.15 * t);',
      '  gl_Position = projectionMatrix * mv;',
      '  vMix = aRnd.z; vT = t; vY = p.y; vDepth = clamp(1.25 - (-mv.z - 3.0) * 0.28, 0.35, 1.3);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uA, uB, uC;',
      'uniform float uTime, uSpeak, uThink;',
      'varying float vMix, vT, vY, vDepth;',
      'void main() {',
      '  float d = length(gl_PointCoord - 0.5);',
      '  if (d > 0.5) discard;',
      '  float soft = pow(1.0 - d * 2.0, 2.0);',
      '  vec3 col = mix(uA, uB, vMix);',
      '  float scan = 0.7 + 0.3 * sin(vY * 70.0 - uTime * 2.5);',
      '  float sweep = exp(-pow(fract(uTime * 0.22) * 2.8 - 1.4 - vY, 2.0) * 30.0);',
      '  col = mix(col, uC, 0.25 + sweep * 0.7);',
      '  float k = mix(1.0 + uThink * 0.5, scan + sweep * 1.5 + uSpeak * 0.25, vT);',
      '  float alpha = soft * vDepth * (0.9 - 0.15 * vT) * k;',
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

  function glowSprite(tone, size, opacity) {
    var s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: color(tone),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: opacity,
      }),
    );
    s.scale.setScalar(size);
    return s;
  }

  var GLSL_NOISE = [
    'float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
    'float noise(vec3 x) {',
    '  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),',
    '             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);',
    '}',
    'float fbm(vec3 p) { return 0.55 * noise(p) + 0.3 * noise(p * 2.1) + 0.15 * noise(p * 4.3); }',
  ].join('\n');

  function orbMaterial(frag, extra) {
    var u = { uTime: U.uTime, uOrb: U.uOrb, uThink: U.uThink, uA: U.uA, uB: U.uB, uC: U.uC };
    Object.keys(extra || {}).forEach(function (k) {
      u[k] = { value: extra[k] };
    });
    return new THREE.ShaderMaterial({
      uniforms: u,
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

  // A: thin comet arcs. Radial profile is a soft bell, the tail fades out, so nothing reads as a hard line.
  function cometMat(speed, useB, inner, outer) {
    return orbMaterial(
      [
        'uniform float uTime, uOrb, uThink, uSpeed, uInner, uOuter;',
        'uniform vec3 uA, uB;',
        'varying vec3 vObj;',
        'void main() {',
        '  float rad = length(vObj.xy);',
        '  float t = clamp((rad - uInner) / (uOuter - uInner), 0.0, 1.0);',
        '  float radial = pow(sin(t * 3.14159), 2.0);',
        '  float a = atan(vObj.y, vObj.x) / 6.28318 + 0.5;',
        '  float phase = fract(a - uTime * uSpeed * (1.0 + uThink * 3.0));',
        '  float tail = pow(phase, 2.2) * 0.9 + 0.05;',
        '  vec3 col = ' + (useB ? 'uB' : 'uA') + ' * (0.6 + 0.8 * pow(phase, 8.0));',
        '  float alpha = radial * tail * 0.55 * uOrb;',
        '  gl_FragColor = vec4(col * alpha, alpha);',
        '}',
      ].join('\n'),
      { uSpeed: speed, uInner: inner, uOuter: outer },
    );
  }

  // B: glass sphere. Fresnel rim plus a soft interior glow; no outline anywhere.
  var glassMat = orbMaterial(
    [
      'uniform float uTime, uOrb, uThink;',
      'uniform vec3 uA, uB, uC;',
      'varying vec3 vN; varying vec3 vV; varying vec3 vObj;',
      'void main() {',
      '  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);',
      '  float shimmer = 0.85 + 0.15 * sin(vObj.y * 6.0 + uTime * 1.2);',
      '  vec3 col = mix(uB, uA, f) + uC * 0.15;',
      '  float alpha = (0.08 + f * 0.42) * shimmer * (1.0 + uThink * 0.5) * uOrb;',
      '  gl_FragColor = vec4(col * alpha, alpha);',
      '}',
    ].join('\n'),
  );

  // C: plasma. Animated fbm noise on a sphere, thresholded into soft filaments, with a rim.
  var plasmaMat = orbMaterial(
    [
      'uniform float uTime, uOrb, uThink;',
      'uniform vec3 uA, uB, uC;',
      'varying vec3 vN; varying vec3 vV; varying vec3 vObj;',
      GLSL_NOISE,
      'void main() {',
      '  float flow = uTime * (0.22 + uThink * 0.6);',
      '  vec3 p = normalize(vObj) * 2.2 + vec3(flow, -flow * 0.6, flow * 0.4);',
      '  float n = fbm(p + fbm(p * 1.3 + flow) * 1.4);',
      '  float cloud = smoothstep(0.25, 0.7, n);',
      '  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);',
      '  vec3 col = mix(uB, uA, n) + uC * pow(cloud, 3.0) * 0.5;',
      '  float alpha = (cloud * 0.55 + f * 0.25) * (1.0 + uThink * 0.3) * uOrb;',
      '  gl_FragColor = vec4(col * alpha, alpha);',
      '}',
    ].join('\n'),
  );

  // soft equatorial haze band for B: a wide gaussian, not a ring
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

  var groups = { a: new THREE.Group(), b: new THREE.Group(), c: new THREE.Group() };
  RINGS.forEach(function (cfg, idx) {
    var inner = cfg.r - 0.06;
    var outer = cfg.r + 0.06;
    var m = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 160, 1),
      cometMat(cfg.speed, idx === 1, inner, outer),
    );
    m.rotation.set(cfg.tx + Math.PI / 2, 0, cfg.tz);
    groups.a.add(m);
  });
  groups.b.add(new THREE.Mesh(new THREE.SphereGeometry(1.08, 48, 32), glassMat));
  var band = new THREE.Mesh(new THREE.RingGeometry(0.4, 1.9, 96, 1), hazeBandMat);
  band.rotation.set(Math.PI / 2 + 0.45, 0, 0.2);
  groups.b.add(band);
  groups.c.add(new THREE.Mesh(new THREE.SphereGeometry(0.95, 48, 32), plasmaMat));
  Object.keys(groups).forEach(function (k) {
    world.add(groups[k]);
  });

  // light haze behind everything (wide, faint)
  var haze = glowSprite(toneB, 3.6, 0.14);
  world.add(haze);

  // orbiting mote: a soft glow, no hard dot
  var mote = glowSprite(toneC, 0.3, 0.9);
  world.add(mote);

  // core: a flame-coloured glow, travelling from the orb centre to the chest; a faint wire gem for variant A
  var coreG = new THREE.Group();
  var coreGlow = glowSprite(toneB, 1.0, 0.9);
  var coreIco = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.13, 0)),
    new THREE.LineBasicMaterial({
      color: color(toneC),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  coreG.add(coreGlow);
  coreG.add(coreIco);
  world.add(coreG);

  // hologram wire shells for the bust
  function wire(geom, tone) {
    var m = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom, 1),
      new THREE.LineBasicMaterial({
        color: color(tone),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    world.add(m);
    return m;
  }
  var headWire = wire(new THREE.SphereGeometry(1, 20, 14), toneA);
  headWire.scale.set(0.4, 0.5, 0.45);
  headWire.position.set(0, 0.64, -0.02);
  var shoulderWire = wire(new THREE.SphereGeometry(1, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2), toneA);
  shoulderWire.scale.set(0.88, 0.72, 0.42);
  shoulderWire.position.set(0, -1.1, 0);

  var anvilWire = new THREE.Group();
  [
    [0.46, 0.06, 0.2, 0, -0.97],
    [0.14, 0.07, 0.15, 0, -0.86],
    [0.58, 0.08, 0.18, 0, -0.72],
  ].forEach(function (s) {
    var w = wire(new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2), toneC);
    world.remove(w);
    w.position.set(s[3], s[4], 0.4);
    anvilWire.add(w);
  });
  world.add(anvilWire);

  // a floating hammer: handle plus head, extruded forms in wire
  var hammer = new THREE.Group();
  [
    [new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8), 0, 0],
    [new THREE.BoxGeometry(0.42, 0.2, 0.2), 0, 0.5],
  ].forEach(function (s) {
    var w = wire(s[0], toneB);
    world.remove(w);
    w.position.set(s[1], s[2], 0);
    hammer.add(w);
  });
  hammer.position.set(1.3, 0.1, 0.2);
  hammer.rotation.z = -0.5;
  world.add(hammer);

  // eyes and the speaking pulse (a soft glow, not a ring line)
  var eyeL = glowSprite(toneC, 0.16, 0);
  var eyeR = glowSprite(toneC, 0.16, 0);
  eyeL.position.set(-0.15, 0.68, 0.42);
  eyeR.position.set(0.15, 0.68, 0.42);
  world.add(eyeL);
  world.add(eyeR);
  var pulse = glowSprite(toneA, 1.3, 0);
  pulse.position.set(0, 0.64, 0);
  world.add(pulse);

  var CORE_SCALE = { a: 0.95, b: 2.1, c: 0.7 };
  function applyVariant() {
    pg.attributes.position.array.set(orbPos[variant]);
    pg.attributes.position.needsUpdate = true;
    Object.keys(groups).forEach(function (k) {
      groups[k].visible = k === variant;
    });
    coreIco.visible = variant === 'a';
    requestStatic();
  }

  // ---------- state, resize, loop ----------
  var target = 0;
  var thinkTarget = 0;
  var think = 0;
  var morph = 0;
  var speak = 0;
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
  var level = 0; // 0 full, 1 reduced particles and pixel ratio
  var dpr = Math.min(window.devicePixelRatio || 1, CFG.dprCap);
  var visible = true;

  function ss(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function resize() {
    var w = stage.clientWidth;
    var h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.userData.dist = Math.max(4.3, 2.1 / (camera.aspect * Math.tan((CFG.fov * Math.PI) / 360)));
    camera.updateProjectionMatrix();
    pu.uPx.value = (h * dpr) / (2 * Math.tan((CFG.fov * Math.PI) / 360));
    requestStatic();
  }

  function applyState() {
    var st = stage.getAttribute('data-state');
    target = st === 'active' ? 1 : 0;
    thinkTarget = st === 'thinking' ? 1 : 0;
    if (reduce.matches) {
      morph = target;
      think = thinkTarget;
      requestStatic();
    }
  }

  function update(dt) {
    var anim = !reduce.matches;
    if (anim) {
      time += dt;
      var step = CFG.morphSpeed * dt;
      morph += Math.max(-step, Math.min(step, target - morph));
      think += (thinkTarget - think) * Math.min(1, dt * 3);
    }
    var m = morph;
    var e = m * m * (3 - 2 * m);
    var talk = anim && target === 1 && m > 0.95 ? 0.5 + 0.5 * Math.sin(time * 9) : 0;
    speak += (talk - speak) * Math.min(1, dt * 12);

    pu.uMorph.value = m;
    pu.uSpeak.value = speak;
    U.uTime.value = time;
    U.uThink.value = think;
    U.uOrb.value = 1 - 0.78 * e;

    // pointer parallax, eased; off when motion is reduced
    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 4);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 4);
    var px = anim ? pointer.sx : 0;
    var py = anim ? pointer.sy : 0;
    camera.position.set(px * 0.55, py * 0.35 + 0.08, camera.userData.dist);
    camera.lookAt(0, 0.05 * e, 0);
    world.rotation.y = anim ? Math.sin(time * 0.35) * 0.22 * e + time * 0.05 * (1 - e) : 0;

    groups[variant].position.set(0, e * 0.15, -e * 0.25);
    haze.material.opacity = 0.14 * (1 - 0.5 * e) * (1 + think * 0.6);

    // mote keeps orbiting around whichever shape is showing
    var ma = anim ? time * (0.9 + think * 1.5) : 0.8;
    var mr = 1.55 - 0.15 * e;
    var mx = Math.cos(ma) * mr;
    var mz = Math.sin(ma) * mr;
    mote.position.set(mx, mz * Math.sin(0.5), mz * Math.cos(0.5));

    coreG.position.set(0, -0.72 * e, 0.45 * e);
    var cs =
      (1 - e * 0.55) * (1 + 0.12 * Math.sin(time * 2.2) + speak * 0.35 + think * 0.25 * Math.sin(time * 6));
    coreGlow.scale.setScalar(Math.max(0.2, cs) * (CORE_SCALE[variant] * (1 - e) + 0.95 * e));
    coreIco.rotation.y = time * 0.8;
    coreIco.rotation.x = time * 0.5;

    var wireOp = ss(0.35, 1, m);
    headWire.material.opacity = wireOp * 0.16;
    shoulderWire.material.opacity = wireOp * 0.22;
    anvilWire.children.forEach(function (c) {
      c.material.opacity = wireOp * 0.7;
    });
    hammer.children.forEach(function (c) {
      c.material.opacity = wireOp * 0.55;
    });
    hammer.rotation.z = -0.5 + (anim ? Math.sin(time * 1.3) * 0.12 : 0) - speak * 0.15;
    hammer.position.y = 0.1 + (anim ? Math.sin(time * 1.1) * 0.05 : 0);

    var eyeOn = ss(0.7, 1, m);
    eyeL.material.opacity = eyeR.material.opacity = eyeOn * (0.8 + 0.2 * speak);
    eyeL.scale.setScalar(0.14 + 0.05 * speak);
    eyeR.scale.setScalar(0.14 + 0.05 * speak);

    var pp = anim && target === 1 ? (time * 0.55) % 1 : 0;
    pulse.scale.setScalar(1.3 + pp * 1.3);
    pulse.material.opacity = anim && target === 1 && m > 0.95 ? (1 - pp) * 0.35 : 0;
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
      // static mode: nothing animates, frames are drawn on demand only
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
      if (slowFrames >= 2 && !params.has('nodegrade')) degrade();
      else stats(avg, cpuAccum / frames);
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
      dpr.toFixed(2);
  }

  // Two-step degrade: fewer particles and pixel ratio 1, then the flat renderer.
  function degrade() {
    slowFrames = 0;
    if (level === 0) {
      level = 1;
      dpr = 1;
      pg.setDrawRange(0, Math.floor(N * 0.4));
      resize();
      perfEl.textContent = 'slow device: reduced to ' + Math.floor(N * 0.4) + ' points';
    } else {
      setRenderer('flat', 'slow device: switched to the flat renderer');
    }
  }

  var requestedStatic = false;
  function requestStatic() {
    if (!ready || running || requestedStatic) return;
    requestedStatic = true;
    window.requestAnimationFrame(function () {
      requestedStatic = false;
      if (!running && stage.getAttribute('data-renderer') === 'webgl') {
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

  // pause when the tab is hidden or the stage is scrolled out of view
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop();
    else if (stage.getAttribute('data-renderer') === 'webgl') startLoop();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (!visible) stopLoop();
      else if (stage.getAttribute('data-renderer') === 'webgl') startLoop();
    }).observe(stage);
  }

  stage.addEventListener('pointermove', function (ev) {
    var r = stage.getBoundingClientRect();
    pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -(((ev.clientY - r.top) / r.height) * 2 - 1);
  });
  stage.addEventListener('pointerleave', function () {
    pointer.x = 0;
    pointer.y = 0;
  });

  new MutationObserver(applyState).observe(stage, { attributes: true, attributeFilter: ['data-state'] });
  reduce.addEventListener('change', function () {
    applyState();
    if (reduce.matches) stopLoop();
    else startLoop();
  });
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);

  flatBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setRenderer(btn.getAttribute('data-renderer-set'));
    });
  });

  canvas.addEventListener('webglcontextlost', function (ev) {
    ev.preventDefault();
    setRenderer('flat', 'WebGL context lost: flat renderer');
  });

  ready = true;
  applyVariant();
  applyState();
  setRenderer('webgl');
  resize();
  startLoop();
})();
