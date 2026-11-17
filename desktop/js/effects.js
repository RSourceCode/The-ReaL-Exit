/**
 * Particle + light effects: Deeba's burst, coin sparkles, landing dust, spawn motes, ambient fireflies.
 * One instanced mesh drives every particle so effects cost a single draw call.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';

const MAX = 600;
const rand = (a, b) => a + Math.random() * (b - a);

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.07, 0),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      MAX,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    const colorBuf = new Float32Array(MAX * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colorBuf, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    this.p = [];            // active particles
    this.rings = [];        // expanding rings
    this.dummy = new THREE.Object3D();
    this.color = new THREE.Color();
    this.flash = new THREE.PointLight('#ffffff', 0, 9, 2);
    scene.add(this.flash);
    this.flashT = 0; this.flashDur = 0.001; this.flashPeak = 0;

    this.ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    this.fireflies = this._makeFireflies();
    scene.add(this.fireflies.points);
  }

  _emit(pos, vel, { color = '#fff', life = 1, size = 1, gravity = 12, drag = 0.4, spin = 0, shrink = true }) {
    if (this.p.length >= MAX) this.p.shift();
    this.p.push({
      x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z,
      life, age: 0, size, gravity, drag, shrink, color: new THREE.Color(color),
      rx: Math.random() * 6, ry: Math.random() * 6, spin: spin || rand(-8, 8),
    });
  }

  _ring(pos, { color = '#ffffff', from = 0.2, to = 2.2, life = 0.5, y = 0, rotX = -Math.PI / 2 }) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.set(pos.x, pos.y + y, pos.z); m.rotation.x = rotX; m.scale.setScalar(from);
    this.scene.add(m);
    this.rings.push({ m, from, to, life, age: 0 });
  }

  _flash(color, peak, dur, pos) {
    this.flash.color.set(color); this.flash.position.copy(pos);
    this.flashPeak = peak; this.flashDur = dur; this.flashT = dur;
  }

  /** The signature "Deeba bursts apart" effect. */
  burst(pos, colors = ['#eceff4', '#6fe7ff', '#1b1e27']) {
    const c = new THREE.Color(colors[0]);
    for (let i = 0; i < 80; i++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1.4), rand(-1, 1)).normalize();
      const sp = rand(2.5, 8.5);
      this._emit(pos, dir.multiplyScalar(sp), { color: colors[i % colors.length], life: rand(0.8, 1.6), size: rand(0.8, 2.1), gravity: 15, drag: 0.5 });
    }
    for (let i = 0; i < 70; i++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize();
      this._emit(pos, dir.multiplyScalar(rand(5, 13)), { color: i % 3 ? '#ffd27a' : colors[1], life: rand(0.25, 0.7), size: rand(0.3, 0.7), gravity: 6, drag: 2 });
    }
    this._ring(pos, { color: colors[1], from: 0.3, to: 4.2, life: 0.55, y: -0.3 });
    this._ring(pos, { color: '#ffffff', from: 0.2, to: 2.6, life: 0.35, y: 0, rotX: 0 });
    this._flash('#fff1d6', 9, 0.45, pos);
    void c;
  }

  sparkle(pos, color = '#ffd36a', n = 14) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.8, 2.6);
      this._emit(pos, { x: Math.cos(a) * s, y: rand(1.2, 3.6), z: Math.sin(a) * s }, { color, life: rand(0.45, 0.9), size: rand(0.5, 1.0), gravity: 6, drag: 1.5 });
    }
    this._ring(pos, { color, from: 0.1, to: 0.9, life: 0.35, y: 0, rotX: -Math.PI / 2 });
  }

  dust(pos, amount = 6, color = '#e6efe0') {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.6, 1.8);
      this._emit({ x: pos.x, y: pos.y + 0.04, z: pos.z }, { x: Math.cos(a) * s, y: rand(0.2, 1.0), z: Math.sin(a) * s }, { color, life: rand(0.3, 0.55), size: rand(0.7, 1.3), gravity: -1, drag: 3.5 });
    }
  }

  spawn(pos, color = '#6fe7ff') {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0.6, 1.3);
      this._emit({ x: pos.x + Math.cos(a) * r, y: pos.y - 0.4, z: pos.z + Math.sin(a) * r }, { x: -Math.cos(a) * 0.6, y: rand(1.5, 3.6), z: -Math.sin(a) * 0.6 }, { color, life: rand(0.5, 0.9), size: rand(0.5, 0.9), gravity: -2, drag: 1 });
    }
    this._ring(pos, { color, from: 1.6, to: 0.3, life: 0.5, y: -0.45 });
  }

  zap(pos, color = '#ff4d78') {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      this._emit(pos, { x: Math.cos(a) * rand(2, 6), y: rand(0, 4), z: Math.sin(a) * rand(2, 6) }, { color, life: rand(0.2, 0.5), size: rand(0.4, 0.8), gravity: 8, drag: 2 });
    }
    this._flash(color, 5, 0.25, pos);
  }

  _makeFireflies() {
    const n = 70;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const seeds = [];
    for (let i = 0; i < n; i++) {
      seeds.push({ a: Math.random() * 6.28, r: rand(1, 9), y: rand(0.4, 3.4), s: rand(0.1, 0.35), p: Math.random() * 6.28 });
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: '#d9ffb0', size: 0.11, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, seeds, pos };
  }

  update(dt, t) {
    // Particles
    const d = this.dummy, col = this.color;
    let w = 0;
    for (let i = 0; i < this.p.length; i++) {
      const q = this.p[i];
      q.age += dt;
      if (q.age >= q.life) { this.p.splice(i--, 1); continue; }
      const drag = Math.exp(-q.drag * dt);
      q.vx *= drag; q.vz *= drag; q.vy = q.vy * drag - q.gravity * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.y < 0.02 && q.gravity > 0) { q.y = 0.02; q.vy *= -0.35; q.vx *= 0.6; q.vz *= 0.6; }
      const k = q.age / q.life;
      const scale = q.size * (q.shrink ? 1 - k * k : 1);
      q.rx += q.spin * dt; q.ry += q.spin * 0.7 * dt;
      d.position.set(q.x, q.y, q.z); d.rotation.set(q.rx, q.ry, 0); d.scale.setScalar(Math.max(0.01, scale));
      d.updateMatrix();
      this.mesh.setMatrixAt(w, d.matrix);
      col.copy(q.color); this.mesh.setColorAt(w, col);
      w++;
    }
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    // Rings
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.age += dt;
      const k = Math.min(1, r.age / r.life);
      r.m.scale.setScalar(r.from + (r.to - r.from) * (1 - Math.pow(1 - k, 3)));
      r.m.material.opacity = 0.9 * (1 - k);
      if (k >= 1) { this.scene.remove(r.m); r.m.material.dispose(); this.rings.splice(i--, 1); }
    }

    // Flash light
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt);
      this.flash.intensity = this.flashPeak * Math.pow(this.flashT / this.flashDur, 2);
    } else this.flash.intensity = 0;

    // Fireflies drift slowly around the island
    const { seeds, pos, points } = this.fireflies;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i], a = s.a + t * s.s * 0.3;
      pos[i * 3] = Math.cos(a) * s.r + Math.sin(t * 0.7 + s.p) * 0.4;
      pos[i * 3 + 1] = s.y + Math.sin(t * 0.9 + s.p) * 0.35;
      pos[i * 3 + 2] = Math.sin(a * 1.1) * s.r + Math.cos(t * 0.6 + s.p) * 0.4;
    }
    points.geometry.attributes.position.needsUpdate = true;
    points.material.opacity = 0.55 + Math.sin(t * 1.7) * 0.25;
  }

  clear() { this.p.length = 0; for (const r of this.rings) { this.scene.remove(r.m); r.m.material.dispose(); } this.rings.length = 0; }
}
