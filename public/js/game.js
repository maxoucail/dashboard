import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ── Constants ──────────────────────────────────────────────────────────────
const ARENA_R      = 13;
const TOP_R        = 0.6;
const MAX_SPIN     = 100;
const SPIN_DECAY   = 0.4;          // per second passive loss
const MOVE_FORCE   = 20;
const MAX_VEL      = 11;
const DRAG         = 0.88;         // pow per 60fps tick
const RESTITUTION  = 0.72;
const SPIN_DMG_K   = 6;            // collision spin damage factor
const BROADCAST_MS = 50;

export const NEON = [
  0x00ffff, 0xff00cc, 0xffee00, 0x00ff88,
  0xff5500, 0x44aaff, 0xff0044, 0x88ff00,
];

// ── SpinstormGame ──────────────────────────────────────────────────────────
export class SpinstormGame {
  constructor(canvas, myPlayer, p2p, onEliminated) {
    this.canvas     = canvas;
    this.myPlayer   = myPlayer;
    this.p2p        = p2p;
    this.onEliminated = onEliminated;

    this.tops     = new Map(); // socketId → state
    this.meshes   = new Map(); // socketId → THREE.Group
    this.trails   = new Map(); // socketId → ParticleTrail
    this.effects  = [];        // CollisionEffect[]

    this.keys = { up: false, down: false, left: false, right: false, boost: false };
    this.running  = false;
    this.lastBroadcast = 0;
    this.lastTime = performance.now();
    this.winner   = null;

    this._initRenderer();
    this._buildArena();
    this._buildStars();
    this._bindInput();
    this._bindP2P();
    window.addEventListener('resize', () => this._onResize());
  }

  // ── Renderer & postprocessing ────────────────────────────────────────────
  _initRenderer() {
    const w = this.canvas.clientWidth  || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.toneMapping          = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure  = 1.1;
    this.renderer.outputColorSpace     = THREE.SRGBColorSpace;

    this.scene  = new THREE.Scene();
    this.scene.background = new THREE.Color(0x010113);
    this.scene.fog = new THREE.FogExp2(0x010113, 0.012);

    this.camera = new THREE.PerspectiveCamera(58, w / h, 0.1, 600);
    this.camera.position.set(0, 20, 16);
    this.camera.lookAt(0, 0, 0);
    this._camTarget = new THREE.Vector3();

    this.scene.add(new THREE.AmbientLight(0x112255, 3));

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.3, 0.55, 0.25);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
  }

  // ── Arena ────────────────────────────────────────────────────────────────
  _buildArena() {
    // Floor with grid shader
    const floorGeo = new THREE.CircleGeometry(ARENA_R, 128);
    const floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:      { value: 0 },
        uInnerCol:  { value: new THREE.Color(0x000d2e) },
        uOuterCol:  { value: new THREE.Color(0x001a55) },
        uGridCol:   { value: new THREE.Color(0x0055ff) },
        uAccentCol: { value: new THREE.Color(0x00eeff) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3  uInnerCol, uOuterCol, uGridCol, uAccentCol;
        varying vec2 vUv;
        void main() {
          vec2 c = vUv * 2.0 - 1.0;
          float d = length(c);
          if (d > 1.0) { gl_FragColor = vec4(0.); return; }

          // grid
          vec2 g = fract(vUv * 14.0);
          float lx = smoothstep(0.0, 0.04, g.x) * (1.0 - smoothstep(0.96, 1.0, g.x));
          float ly = smoothstep(0.0, 0.04, g.y) * (1.0 - smoothstep(0.96, 1.0, g.y));
          float grid = 1.0 - min(lx, ly);

          // concentric rings
          float rings = pow(max(0., sin(d * 20.0 - uTime * 1.5) * 0.5 + 0.5), 6.0) * (1.0 - d);

          // radial pulse
          float pulse = sin(d * 8.0 - uTime * 2.5) * 0.5 + 0.5;
          pulse *= (1.0 - d) * 0.4;

          vec3 base = mix(uInnerCol, uOuterCol, d * d);
          base = mix(base, uGridCol,   grid   * 0.55);
          base = mix(base, uAccentCol, rings  * 0.7);
          base += uAccentCol * pulse * 0.15;

          float fade = 1.0 - smoothstep(0.82, 1.0, d);
          gl_FragColor = vec4(base, fade);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this._floorMat = floorMat;
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Edge glow rings
    this._addRing(ARENA_R,        0.18, 0x00ccff, 0.9);
    this._addRing(ARENA_R + 0.25, 0.45, 0x0033aa, 0.35);
    this._addRing(ARENA_R + 0.9,  0.7,  0x001133, 0.15);

    // Void plane
    const void_ = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshBasicMaterial({ color: 0x000008 })
    );
    void_.rotation.x = -Math.PI / 2;
    void_.position.y = -0.2;
    this.scene.add(void_);
  }

  _addRing(r, width, color, opacity) {
    const geo = new THREE.RingGeometry(r - width / 2, r + width / 2, 128);
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.01;
    this.scene.add(mesh);
  }

  // ── Stars ────────────────────────────────────────────────────────────────
  _buildStars() {
    const n = 2500;
    const geo = new THREE.BufferGeometry();
    const pos  = new Float32Array(n * 3);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const r  = 160 + Math.random() * 80;
      pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
      pos[i*3+1] = r * Math.sin(ph) * Math.sin(th);
      pos[i*3+2] = r * Math.cos(ph);
      size[i] = Math.random() * 3.5 + 0.5;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(size, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSize;
        uniform float uTime;
        void main() {
          float twinkle = 1.0 + 0.3 * sin(uTime * 2.0 + position.x * 0.1);
          gl_PointSize = aSize * twinkle;
          gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0 - d * 1.8);
        }
      `,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._starsMat = mat;
    this.scene.add(new THREE.Points(geo, mat));
  }

  // ── Top mesh ─────────────────────────────────────────────────────────────
  _buildTopMesh(hexColor) {
    const col = new THREE.Color(hexColor);
    const group = new THREE.Group();

    // Body (lathe — classic top silhouette)
    const pts = [
      new THREE.Vector2(0.01, -0.72),
      new THREE.Vector2(0.08, -0.6),
      new THREE.Vector2(0.18, -0.42),
      new THREE.Vector2(0.36, -0.12),
      new THREE.Vector2(0.52,  0.08),
      new THREE.Vector2(0.57,  0.24),
      new THREE.Vector2(0.52,  0.40),
      new THREE.Vector2(0.38,  0.55),
      new THREE.Vector2(0.18,  0.65),
      new THREE.Vector2(0.06,  0.70),
      new THREE.Vector2(0.00,  0.70),
    ];
    const bodyGeo = new THREE.LatheGeometry(pts, 40);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: 0.55,
      metalness: 0.85, roughness: 0.12,
    });
    group.add(new THREE.Mesh(bodyGeo, bodyMat));

    // Equator blade ring
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: col, emissiveIntensity: 1.5,
      metalness: 1, roughness: 0,
    });
    const bladeRing = new THREE.Mesh(new THREE.TorusGeometry(0.54, 0.045, 8, 56), bladeMat);
    bladeRing.position.y = 0.14;
    group.add(bladeRing);

    // Tip cap (emissive dot)
    const tipGeo = new THREE.SphereGeometry(0.06, 12, 12);
    const tipMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = -0.72;
    group.add(tip);

    // Crown gem
    const crownGeo = new THREE.OctahedronGeometry(0.12, 0);
    const crownMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const crown = new THREE.Mesh(crownGeo, crownMat);
    crown.position.y = 0.58;
    group.add(crown);

    // Lights
    const pl = new THREE.PointLight(hexColor, 4, 9);
    pl.position.y = 0.2;
    group.add(pl);
    const pl2 = new THREE.PointLight(hexColor, 2, 5);
    pl2.position.y = -0.5;
    group.add(pl2);

    return group;
  }

  // ── Spawn / remove ────────────────────────────────────────────────────────
  spawnTop(socketId, username, color, x = 0, z = 0) {
    const state = {
      id: socketId, username, color,
      x, z, vx: 0, vz: 0,
      angle: 0, spinAngle: 0,
      spin: MAX_SPIN, alive: true,
      // interpolation targets (remote only)
      tx: x, tz: z, tvx: 0, tvz: 0, tspin: MAX_SPIN,
    };
    this.tops.set(socketId, state);

    const mesh = this._buildTopMesh(color);
    mesh.position.set(x, 0.72, z);
    this.scene.add(mesh);
    this.meshes.set(socketId, mesh);

    this.trails.set(socketId, new ParticleTrail(color, this.scene));
    return state;
  }

  removeTop(socketId) {
    const mesh = this.meshes.get(socketId);
    if (mesh) { this.scene.remove(mesh); this.meshes.delete(socketId); }
    const trail = this.trails.get(socketId);
    if (trail) { trail.destroy(this.scene); this.trails.delete(socketId); }
    this.tops.delete(socketId);
  }

  // ── Input ────────────────────────────────────────────────────────────────
  _bindInput() {
    const map = {
      KeyW:'up', ArrowUp:'up', KeyS:'down', ArrowDown:'down',
      KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right',
      Space:'boost', ShiftLeft:'boost',
    };
    window.addEventListener('keydown', e => { if (map[e.code]) { this.keys[map[e.code]] = true; e.preventDefault(); } });
    window.addEventListener('keyup',   e => { if (map[e.code]) this.keys[map[e.code]] = false; });
  }

  // ── P2P ──────────────────────────────────────────────────────────────────
  _bindP2P() {
    this.p2p.on('message', ({ from, data }) => {
      if (data.type === 'top-state') {
        const t = this.tops.get(from);
        if (!t) return;
        t.tx = data.x; t.tz = data.z;
        t.tvx = data.vx; t.tvz = data.vz;
        t.tspin = data.spin;
        t.alive = data.alive;
      } else if (data.type === 'fx-collision') {
        this._spawnCollisionFX(data.x, data.z, data.color);
      }
    });

    this.p2p.on('peer-disconnected', ({ peerId }) => {
      this.removeTop(peerId);
      this._checkWin();
    });
  }

  // ── Game start ────────────────────────────────────────────────────────────
  start(players) {
    this.running = true;
    const n = players.length;
    players.forEach((p, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = Math.min(ARENA_R * 0.55, 7);
      this.spawnTop(p.id, p.username, NEON[i % NEON.length], Math.cos(a) * r, Math.sin(a) * r);
    });
    this._loop();
  }

  // ── Game loop ─────────────────────────────────────────────────────────────
  _loop() {
    if (!this.running) return;
    requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const dt  = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    this._update(dt, now);
    this.composer.render();
  }

  _update(dt, now) {
    const myTop = this.tops.get(this.myPlayer.socketId);

    // --- My top physics
    if (myTop?.alive) {
      this._physicsMe(myTop, dt);
      if (Math.hypot(myTop.x, myTop.z) > ARENA_R || myTop.spin <= 0) {
        myTop.alive = false;
        this.p2p.broadcast({ type: 'top-state', x: myTop.x, z: myTop.z, vx: 0, vz: 0, spin: 0, alive: false });
        this.onEliminated?.();
        this._checkWin();
      }
    }

    // --- Remote tops interpolation
    this.tops.forEach((t, id) => {
      if (id === this.myPlayer.socketId) return;
      const k = 1 - Math.pow(0.08, dt * 20);
      t.x  += (t.tx - t.x)  * k;
      t.z  += (t.tz - t.z)  * k;
      t.vx = t.tvx; t.vz = t.tvz;
      t.spin += (t.tspin - t.spin) * k;
      if (!t.alive && Math.hypot(t.x - t.tx, t.z - t.tz) < 0.5) {
        this._triggerDeathFX(t);
        this.removeTop(id);
        this._checkWin();
      }
    });

    // --- Collisions (all living pairs)
    const alive = [...this.tops.values()].filter(t => t.alive);
    for (let i = 0; i < alive.length; i++)
      for (let j = i + 1; j < alive.length; j++)
        this._collide(alive[i], alive[j]);

    // --- Broadcast my state
    if (myTop?.alive && now - this.lastBroadcast > BROADCAST_MS) {
      this.lastBroadcast = now;
      this.p2p.broadcast({ type: 'top-state', x: myTop.x, z: myTop.z, vx: myTop.vx, vz: myTop.vz, spin: myTop.spin, alive: true });
    }

    // --- Update visuals
    this.tops.forEach((t, id) => {
      const m = this.meshes.get(id);
      if (!m) return;
      m.position.x = t.x; m.position.z = t.z;

      const wobble = (1 - t.spin / MAX_SPIN) * 0.18;
      m.rotation.x = Math.sin(now * 0.004 * (t.spin / MAX_SPIN + 0.3)) * wobble;
      m.rotation.z = Math.cos(now * 0.003 * (t.spin / MAX_SPIN + 0.3)) * wobble * 0.8;

      t.spinAngle += (t.spin / MAX_SPIN) * 18 * dt;
      m.rotation.y = t.spinAngle;
      m.position.y = 0.72 - wobble * 0.25;

      this.trails.get(id)?.update(t.x, t.z, dt);
    });

    // --- Collision effects
    this.effects = this.effects.filter(e => e.tick(dt));

    // --- Scene uniforms
    const t = now * 0.001;
    this._floorMat.uniforms.uTime.value = t;
    this._starsMat.uniforms.uTime.value = t;

    // --- Camera softly follows my top
    if (myTop?.alive) {
      this._camTarget.set(myTop.x * 0.25, 20, myTop.z * 0.25 + 14);
    }
    this.camera.position.lerp(this._camTarget, 0.04);
    this.camera.lookAt(
      this.camera.position.x * 0.15,
      0,
      this.camera.position.z * 0.15 - 3
    );

    // --- HUD
    this._updateHUD();
  }

  // ── My physics ────────────────────────────────────────────────────────────
  _physicsMe(t, dt) {
    const { up, down, left, right, boost } = this.keys;
    const sr = t.spin / MAX_SPIN;

    if (left)  t.angle -= 2.8 * dt;
    if (right) t.angle += 2.8 * dt;

    if (up) {
      t.vx += Math.sin(t.angle) * MOVE_FORCE * sr * dt;
      t.vz += Math.cos(t.angle) * MOVE_FORCE * sr * dt;
      t.spin -= 1.2 * dt;
    }
    if (down) {
      t.vx -= Math.sin(t.angle) * MOVE_FORCE * 0.55 * sr * dt;
      t.vz -= Math.cos(t.angle) * MOVE_FORCE * 0.55 * sr * dt;
      t.spin -= 0.8 * dt;
    }
    if (boost && t.spin > 15) {
      const bsr = sr * 1.5;
      t.vx += Math.sin(t.angle) * MOVE_FORCE * bsr * dt;
      t.vz += Math.cos(t.angle) * MOVE_FORCE * bsr * dt;
      t.spin -= 4 * dt;
    }

    const spd = Math.hypot(t.vx, t.vz);
    if (spd > MAX_VEL) { t.vx *= MAX_VEL / spd; t.vz *= MAX_VEL / spd; }

    t.x += t.vx * dt;
    t.z += t.vz * dt;

    const drag = Math.pow(DRAG, dt * 60);
    t.vx *= drag; t.vz *= drag;

    t.spin = Math.max(0, t.spin - SPIN_DECAY * dt);
  }

  // ── Collision resolution ──────────────────────────────────────────────────
  _collide(a, b) {
    const dx   = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const min  = TOP_R * 2;
    if (dist >= min || dist < 0.001) return;

    const nx = dx / dist, nz = dz / dist;
    const ov = (min - dist) * 0.5;

    const isMineA = a.id === this.myPlayer.socketId;
    const isMineB = b.id === this.myPlayer.socketId;

    if (isMineA) { a.x -= nx * ov; a.z -= nz * ov; }
    if (isMineB) { b.x += nx * ov; b.z += nz * ov; }

    const dvx = b.vx - a.vx, dvz = b.vz - a.vz;
    const velN = dvx * nx + dvz * nz;
    if (velN >= 0) return;

    const j = -(1 + RESTITUTION) * velN * 0.5;
    const impact = Math.abs(velN);
    const dmg    = impact * SPIN_DMG_K;

    if (isMineA) { a.vx -= j * nx; a.vz -= j * nz; a.spin = Math.max(0, a.spin - dmg); }
    if (isMineB) { b.vx += j * nx; b.vz += j * nz; b.spin = Math.max(0, b.spin - dmg); }

    if (isMineA || isMineB) {
      const fx = (a.x + b.x) * 0.5, fz = (a.z + b.z) * 0.5;
      const col = isMineA ? a.color : b.color;
      this._spawnCollisionFX(fx, fz, col);
      this.p2p.broadcast({ type: 'fx-collision', x: fx, z: fz, color: col });
    }
  }

  _spawnCollisionFX(x, z, color) {
    this.effects.push(new CollisionFX(x, z, color, this.scene));
  }

  _triggerDeathFX(t) {
    this.effects.push(new DeathFX(t.x, t.z, t.color, this.scene));
  }

  // ── Win check ─────────────────────────────────────────────────────────────
  _checkWin() {
    const alive = [...this.tops.values()].filter(t => t.alive);
    if (alive.length === 1) {
      this.winner = alive[0];
      document.getElementById('win-name').textContent = alive[0].username;
      document.getElementById('win-overlay').classList.remove('hidden');
    } else if (alive.length === 0) {
      document.getElementById('win-name').textContent = '— Match nul —';
      document.getElementById('win-overlay').classList.remove('hidden');
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────
  _updateHUD() {
    const me = this.tops.get(this.myPlayer.socketId);
    if (me) {
      const pct = (me.spin / MAX_SPIN) * 100;
      document.getElementById('hud-bar-fill').style.width = pct + '%';
      document.getElementById('hud-bar-fill').style.background =
        pct > 50 ? '#00ffff' : pct > 25 ? '#ffaa00' : '#ff2200';
      document.getElementById('hud-spin-val').textContent = Math.ceil(me.spin);
    }

    const list = document.getElementById('hud-players');
    if (!list) return;
    list.innerHTML = '';
    this.tops.forEach(t => {
      const row = document.createElement('div');
      row.className = 'hud-player-row' + (t.id === this.myPlayer.socketId ? ' me' : '');
      row.innerHTML = `
        <span class="hud-player-name" style="color:#${t.color.toString(16).padStart(6,'0')}">${t.username}</span>
        <div class="hud-mini-bar"><div class="hud-mini-fill" style="width:${(t.spin/MAX_SPIN)*100}%;background:#${t.color.toString(16).padStart(6,'0')}"></div></div>
      `;
      list.appendChild(row);
    });
  }

  _onResize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  destroy() {
    this.running = false;
    this.renderer.dispose();
  }
}

// ── Particle Trail ─────────────────────────────────────────────────────────
class ParticleTrail {
  constructor(color, scene) {
    this._particles = [];
    this._max = 70;
    this._timer = 0;
    const geo = new THREE.BufferGeometry();
    const pos   = new Float32Array(this._max * 3);
    const alpha = new Float32Array(this._max);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) } },
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main() {
          vA = aAlpha;
          gl_PointSize = 6.0 * aAlpha;
          gl_Position  = projectionMatrix * modelViewMatrix * vec4(position,1.);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(uColor, vA * (1.0 - d * 1.8));
        }
      `,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._geo = geo;
    this._mesh = new THREE.Points(geo, mat);
    scene.add(this._mesh);
  }

  update(x, z, dt) {
    this._timer += dt;
    if (this._timer > 0.025) {
      this._timer = 0;
      this._particles.unshift({ x: x + (Math.random()-.5)*.35, y: .08 + Math.random()*.25, z: z + (Math.random()-.5)*.35, life: 1 });
      if (this._particles.length > this._max) this._particles.pop();
    }
    const pos = this._geo.attributes.position.array;
    const alp = this._geo.attributes.aAlpha.array;
    for (let i = 0; i < this._max; i++) {
      if (i < this._particles.length) {
        const p = this._particles[i];
        p.life -= dt * 1.8;
        pos[i*3]=p.x; pos[i*3+1]=p.y; pos[i*3+2]=p.z;
        alp[i] = Math.max(0, p.life);
      } else { pos[i*3+1]=-999; alp[i]=0; }
    }
    this._geo.attributes.position.needsUpdate = true;
    this._geo.attributes.aAlpha.needsUpdate   = true;
    this._particles = this._particles.filter(p => p.life > 0);
  }

  destroy(scene) {
    scene.remove(this._mesh);
    this._geo.dispose();
  }
}

// ── Collision FX ──────────────────────────────────────────────────────────
class CollisionFX {
  constructor(x, z, color, scene) {
    this._scene = scene;
    this._life  = 1;
    const n = 28;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    this._vel = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const sp = 2.5 + Math.random() * 4.5;
      this._vel.push({ x: Math.cos(a)*sp, y: 1.2+Math.random()*2.5, z: Math.sin(a)*sp });
      pos[i*3]=x; pos[i*3+1]=.5; pos[i*3+2]=z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size:.18, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false });
    this._pts = new THREE.Points(geo, mat); this._geo=geo; this._mat=mat;
    scene.add(this._pts);

    const rm = new THREE.Mesh(
      new THREE.RingGeometry(.05,.28,32),
      new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.9, side:THREE.DoubleSide })
    );
    rm.rotation.x=-Math.PI/2; rm.position.set(x,.04,z);
    this._ring=rm; this._ringMat=rm.material;
    scene.add(rm);
  }

  tick(dt) {
    this._life -= dt * 2.2;
    const pos = this._geo.attributes.position.array;
    for (let i=0;i<this._vel.length;i++) {
      const v=this._vel[i];
      pos[i*3]+=v.x*dt; pos[i*3+1]+=v.y*dt; pos[i*3+2]+=v.z*dt;
      v.y -= 7*dt;
    }
    this._geo.attributes.position.needsUpdate=true;
    this._mat.opacity=Math.max(0,this._life);
    const s=1+(1-this._life)*5;
    this._ring.scale.set(s,s,s);
    this._ringMat.opacity=Math.max(0,this._life*.85);
    if(this._life<=0){
      this._scene.remove(this._pts); this._scene.remove(this._ring);
      this._geo.dispose(); this._mat.dispose(); this._ringMat.dispose();
      return false;
    }
    return true;
  }
}

// ── Death FX ─────────────────────────────────────────────────────────────
class DeathFX {
  constructor(x, z, color, scene) {
    this._scene=scene; this._life=1;
    const n=60;
    const geo=new THREE.BufferGeometry();
    const pos=new Float32Array(n*3);
    this._vel=[];
    for(let i=0;i<n;i++){
      const th=Math.random()*Math.PI*2, ph=Math.random()*Math.PI;
      const sp=3+Math.random()*6;
      this._vel.push({x:Math.sin(ph)*Math.cos(th)*sp,y:Math.sin(ph)*Math.sin(th)*sp,z:Math.cos(ph)*sp});
      pos[i*3]=x; pos[i*3+1]=.5; pos[i*3+2]=z;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
    const mat=new THREE.PointsMaterial({color,size:.22,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false});
    this._pts=new THREE.Points(geo,mat); this._geo=geo; this._mat=mat;
    scene.add(this._pts);
  }

  tick(dt){
    this._life-=dt*1.5;
    const pos=this._geo.attributes.position.array;
    for(let i=0;i<this._vel.length;i++){
      const v=this._vel[i];
      pos[i*3]+=v.x*dt; pos[i*3+1]+=v.y*dt; pos[i*3+2]+=v.z*dt;
      v.y-=5*dt;
    }
    this._geo.attributes.position.needsUpdate=true;
    this._mat.opacity=Math.max(0,this._life);
    if(this._life<=0){this._scene.remove(this._pts);this._geo.dispose();this._mat.dispose();return false;}
    return true;
  }
}
