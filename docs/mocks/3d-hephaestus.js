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

  // ---------- configuration (kept in one object so other agents can reuse it later) ----------
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
    // mulberry32: deterministic so the shape is the same on every load
    seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
    var s = f & 1 ? 1 : -1;
    var p = [0, 0, 0];
    p[ax] = s;
    p[(ax + 1) % 3] = a;
    p[(ax + 2) % 3] = b;
    return [c[0] + p[0] * h[0], c[1] + p[1] * h[1], c[2] + p[2] * h[2]];
  }

  function ringPoint(radius, tiltX, tiltZ) {
    var a = rnd() * Math.PI * 2;
    var x = Math.cos(a) * radius;
    var y = (rnd() - 0.5) * 0.04;
    var z = Math.sin(a) * radius;
    var y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
    var z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
    return [x * Math.cos(tiltZ) - y1 * Math.sin(tiltZ), x * Math.sin(tiltZ) + y1 * Math.cos(tiltZ), z1];
  }

  var RINGS = [
    { r: 1.3, tx: 1.15, tz: 0.25, spin: 0.18 },
    { r: 0.95, tx: -0.7, tz: 0.6, spin: -0.27 },
    { r: 0.66, tx: 0.35, tz: -0.9, spin: 0.4 },
  ];

  // Idle shape: particle shell, three tilted rings, a dense core and a little loose dust.
  function orbPoint() {
    var r = rnd();
    var p;
    if (r < 0.34) {
      p = unitVec();
      var k = 1.05 + (rnd() - 0.5) * 0.04;
      return [p[0] * k, p[1] * k, p[2] * k];
    }
    if (r < 0.66) {
      var ring = RINGS[Math.floor(rnd() * RINGS.length)];
      return ringPoint(ring.r, ring.tx, ring.tz);
    }
    if (r < 0.86) {
      p = unitVec();
      var d = Math.pow(rnd(), 0.6) * 0.3;
      return [p[0] * d, p[1] * d, p[2] * d];
    }
    p = unitVec();
    var q = 1.4 + rnd() * 0.7;
    return [p[0] * q, p[1] * q * 0.7, p[2] * q];
  }

  // Active shape: head with smith's cap and beard, neck, shoulders, anvil on the chest, a halo ring.
  function bustPoint() {
    var r = rnd();
    var p;
    if (r < 0.32) {
      p = ellipsoid([0, 0.62, 0], [0.4, 0.52, 0.44]);
      if (p[1] < 0.62) {
        // narrow the jaw
        var jaw = 0.78 + 0.22 * (1 - Math.min(1, (0.62 - p[1]) / 0.52));
        p[0] *= jaw;
        p[2] *= jaw;
      }
      if (p[1] > 1.0) {
        p[0] *= 1.07;
        p[2] *= 1.07;
        p[1] += 0.03;
      } else if (p[1] < 0.5 && p[2] > 0.08) {
        p[2] *= 1.12;
        p[1] -= 0.05;
      }
      return p;
    }
    if (r < 0.4) {
      var a = rnd() * Math.PI * 2;
      return [Math.cos(a) * 0.16, -0.34 + rnd() * 0.5, Math.sin(a) * 0.17];
    }
    if (r < 0.76) {
      // upper half of a wide ellipsoid: sloping shoulders that close at the bottom edge
      p = ellipsoid([0, -1.15, 0], [1.0, 0.85, 0.5]);
      p[1] = -1.15 + Math.abs(p[1] + 1.15);
      return p;
    }
    if (r < 0.88) {
      var boxes = [
        [
          [0, -0.96, 0.42],
          [0.5, 0.07, 0.24],
        ],
        [
          [0, -0.84, 0.42],
          [0.15, 0.08, 0.17],
        ],
        [
          [0, -0.68, 0.42],
          [0.62, 0.09, 0.2],
        ],
      ];
      var b = boxes[Math.floor(rnd() * boxes.length)];
      return boxSurface(b[0], b[1]);
    }
    return ringPoint(1.25, 1.45, 0.1);
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
  function setRenderer(kind, note) {
    stage.setAttribute('data-renderer', kind);
    flatBtns.forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-renderer-set') === kind ? 'true' : 'false');
    });
    if (note) perfEl.textContent = note;
    else if (kind === 'flat') perfEl.textContent = 'flat renderer (SVG/CSS)';
    if (kind === 'flat') stopLoop();
    else if (ready) startLoop();
  }

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

  // One Points object carries the whole body: each particle knows its orb and its bust position.
  var N = CFG.particles;
  var posOrb = new Float32Array(N * 3);
  var posBust = new Float32Array(N * 3);
  var rndAttr = new Float32Array(N * 4);
  for (var i = 0; i < N; i++) {
    var o = orbPoint();
    var b = bustPoint();
    posOrb.set(o, i * 3);
    posBust.set(b, i * 3);
    rndAttr[i * 4] = rnd();
    rndAttr[i * 4 + 1] = 0.045 + rnd() * rnd() * 0.1;
    rndAttr[i * 4 + 2] = rnd();
    rndAttr[i * 4 + 3] = rnd();
  }
  var pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(posOrb, 3));
  pg.setAttribute('aBust', new THREE.BufferAttribute(posBust, 3));
  pg.setAttribute('aRnd', new THREE.BufferAttribute(rndAttr, 4));

  var pu = {
    uMorph: { value: 0 },
    uTime: { value: 0 },
    uPx: { value: 600 },
    uA: { value: new THREE.Vector3(toneA[0], toneA[1], toneA[2]) },
    uB: { value: new THREE.Vector3(toneB[0], toneB[1], toneB[2]) },
    uC: { value: new THREE.Vector3(toneC[0], toneC[1], toneC[2]) },
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
      'uniform float uMorph, uTime, uPx;',
      'varying float vMix, vT, vY, vDepth;',
      'void main() {',
      '  float t = clamp((uMorph - aRnd.x * 0.45) / 0.55, 0.0, 1.0);',
      '  t = t * t * (3.0 - 2.0 * t);',
      '  float ang = uTime * 0.12 * (0.4 + aRnd.w) * (1.0 - t);',
      '  vec3 a = position;',
      '  a.xz = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * a.xz;',
      '  vec3 p = mix(a, aBust, t);',
      '  float mid = sin(t * 3.14159);',
      '  p += normalize(a + 1e-3) * mid * 0.55 * aRnd.w;',
      '  p.xz += vec2(-p.z, p.x) * mid * 0.9 * (aRnd.w - 0.5);',
      '  p *= 1.0 + 0.018 * sin(uTime * 1.4 + aRnd.w * 6.28) * (1.0 - t);',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_PointSize = aRnd.y * uPx / -mv.z * (1.0 + mid * 0.5) * (1.0 - 0.35 * t);',
      '  gl_Position = projectionMatrix * mv;',
      '  vMix = aRnd.z; vT = t; vY = p.y; vDepth = clamp(1.25 - (-mv.z - 3.0) * 0.28, 0.35, 1.3);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uA, uB, uC;',
      'uniform float uTime, uSpeak;',
      'varying float vMix, vT, vY, vDepth;',
      'void main() {',
      '  float d = length(gl_PointCoord - 0.5);',
      '  if (d > 0.5) discard;',
      '  float soft = pow(1.0 - d * 2.0, 2.0);',
      '  vec3 col = mix(uA, uB, vMix);',
      '  float scan = 0.7 + 0.3 * sin(vY * 70.0 - uTime * 2.5);',
      '  float sweep = exp(-pow(fract(uTime * 0.22) * 2.8 - 1.4 - vY, 2.0) * 30.0);',
      '  col = mix(col, uC, 0.25 + sweep * 0.7);',
      '  float k = mix(1.0, scan + sweep * 1.5 + uSpeak * 0.25, vT);',
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

  function addMat(tone, opacity) {
    return new THREE.MeshBasicMaterial({
      color: color(tone),
      transparent: true,
      opacity: opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  // layered rings: a thin bright torus plus a wider faint one as a cheap bloom
  var ringObjs = RINGS.map(function (cfg, idx) {
    var g = new THREE.Group();
    g.rotation.set(cfg.tx, 0, cfg.tz);
    var spin = new THREE.Group();
    var core = new THREE.Mesh(
      new THREE.TorusGeometry(cfg.r, 0.006, 6, 180),
      addMat(idx === 1 ? toneB : toneA, 0.85),
    );
    var halo = new THREE.Mesh(
      new THREE.TorusGeometry(cfg.r, 0.035, 6, 120),
      addMat(idx === 1 ? toneB : toneA, 0.12),
    );
    core.rotation.x = halo.rotation.x = Math.PI / 2;
    spin.add(core);
    spin.add(halo);
    g.add(spin);
    world.add(g);
    return { cfg: cfg, group: g, spin: spin, core: core, halo: halo };
  });

  // orbiting mote
  var mote = glowSprite(toneC, 0.26, 1);
  var moteDot = glowSprite([1, 1, 1], 0.07, 1);
  world.add(mote);
  world.add(moteDot);

  // core: a flame-coloured glow plus a small wireframe icosahedron; it travels from the orb centre to the chest
  var coreG = new THREE.Group();
  var coreGlow = glowSprite(toneB, 1.0, 0.9);
  var coreIco = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.13, 0)),
    new THREE.LineBasicMaterial({
      color: color(toneC),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  coreG.add(coreGlow);
  coreG.add(coreIco);
  world.add(coreG);

  // hologram wire shell for the bust
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
  var headWire = wire(new THREE.SphereGeometry(1, 16, 12), toneA);
  headWire.scale.set(0.4, 0.52, 0.44);
  headWire.position.set(0, 0.62, 0);
  var shoulderWire = wire(new THREE.SphereGeometry(1, 22, 6, 0, Math.PI * 2, 0, Math.PI / 2), toneA);
  shoulderWire.scale.set(1.0, 0.85, 0.5);
  shoulderWire.position.set(0, -1.15, 0);

  var anvilWire = new THREE.Group();
  [
    [0.5, 0.07, 0.24, 0, -0.96],
    [0.15, 0.08, 0.17, 0, -0.84],
    [0.62, 0.09, 0.2, 0, -0.68],
  ].forEach(function (s) {
    var w = wire(new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2), toneC);
    world.remove(w);
    w.position.set(s[3], s[4], 0.42);
    anvilWire.add(w);
  });
  world.add(anvilWire);

  // a floating hammer: handle plus head, extruded forms in wire
  var hammer = new THREE.Group();
  [
    [new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8), 0, 0, 0],
    [new THREE.BoxGeometry(0.42, 0.2, 0.2), 0, 0.5, 0],
  ].forEach(function (s) {
    var w = wire(s[0], toneB);
    world.remove(w);
    w.position.set(s[1], s[2] + s[3], 0);
    hammer.add(w);
  });
  hammer.position.set(1.3, 0.1, 0.2);
  hammer.rotation.z = -0.5;
  world.add(hammer);

  // eyes and the speaking pulse ring
  var eyeL = glowSprite(toneC, 0.16, 0);
  var eyeR = glowSprite(toneC, 0.16, 0);
  eyeL.position.set(-0.16, 0.66, 0.4);
  eyeR.position.set(0.16, 0.66, 0.4);
  world.add(eyeL);
  world.add(eyeR);
  var pulse = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.008, 6, 90), addMat(toneA, 0));
  pulse.position.set(0, 0.62, 0);
  world.add(pulse);

  // ---------- state, resize, loop ----------
  var target = 0;
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
    var dist = Math.max(4.3, 2.1 / (camera.aspect * Math.tan((CFG.fov * Math.PI) / 360)));
    camera.userData.dist = dist;
    camera.updateProjectionMatrix();
    pu.uPx.value = (h * dpr) / (2 * Math.tan((CFG.fov * Math.PI) / 360));
    requestStatic();
  }

  function applyState() {
    target = stage.getAttribute('data-state') === 'active' ? 1 : 0;
    if (reduce.matches) {
      morph = target;
      requestStatic();
    }
  }

  function update(dt) {
    var anim = !reduce.matches;
    if (anim) {
      time += dt;
      var step = CFG.morphSpeed * dt;
      morph += Math.max(-step, Math.min(step, target - morph));
    }
    var m = morph;
    var e = m * m * (3 - 2 * m);
    var talk = anim && target === 1 && m > 0.95 ? 0.5 + 0.5 * Math.sin(time * 9) : 0;
    speak += (talk - speak) * Math.min(1, dt * 12);

    pu.uMorph.value = m;
    pu.uTime.value = time;
    pu.uSpeak.value = speak;

    // pointer parallax, eased; off when motion is reduced
    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 4);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 4);
    var d = camera.userData.dist;
    var px = anim ? pointer.sx : 0;
    var py = anim ? pointer.sy : 0;
    camera.position.set(px * 0.55, py * 0.35 + 0.08, d);
    camera.lookAt(0, 0.05 * e, 0);
    world.rotation.y = anim ? Math.sin(time * 0.35) * 0.22 * e + time * 0.05 * (1 - e) : 0;

    ringObjs.forEach(function (r, idx) {
      r.spin.rotation.y = anim ? time * r.cfg.spin : 0.6 * idx;
      r.group.position.set(0, e * 0.15, -e * 0.25);
      r.core.material.opacity = 0.85 - 0.62 * e;
      r.halo.material.opacity = 0.12 - 0.07 * e;
    });

    // mote keeps orbiting around whichever shape is showing
    var ma = anim ? time * 0.9 : 0.8;
    var mr = 1.55 - 0.15 * e;
    var mx = Math.cos(ma) * mr;
    var mz = Math.sin(ma) * mr;
    var tilt = 0.5;
    mote.position.set(mx, mz * Math.sin(tilt), mz * Math.cos(tilt));
    moteDot.position.copy(mote.position);
    mote.material.opacity = 0.85;

    coreG.position.set(0, -0.72 * e, 0.45 * e);
    var cs = (1 - e * 0.55) * (1 + 0.12 * Math.sin(time * 2.2) + speak * 0.35);
    coreGlow.scale.setScalar(Math.max(0.2, cs) * 0.95);
    coreIco.rotation.y = time * 0.8;
    coreIco.rotation.x = time * 0.5;

    var wireOp = ss(0.35, 1, m);
    headWire.material.opacity = wireOp * 0.3;
    shoulderWire.material.opacity = wireOp * 0.26;
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
    pulse.scale.setScalar(1 + pp * 0.7);
    pulse.material.opacity = anim && target === 1 && m > 0.95 ? (1 - pp) * 0.5 : 0;
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
      if (slowFrames >= 2) degrade();
      stats(avg, cpuAccum / frames);
      frames = 0;
      accum = 0;
      cpuAccum = 0;
    }
  }

  function stats(avg, cpu) {
    var info = renderer.info.render;
    perfEl.textContent =
      'frame ' +
      avg.toFixed(1) +
      ' ms, cpu ' +
      cpu.toFixed(1) +
      ' ms, ' +
      info.calls +
      ' draws, ' +
      Math.round(pg.drawRange.count === Infinity ? N : pg.drawRange.count) +
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
  applyState();
  setRenderer('webgl');
  resize();
  startLoop();
})();
