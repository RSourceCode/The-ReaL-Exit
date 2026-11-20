/**
 * Obstacle-specific death animations.
 *
 * When Deeba dies, the live model is hidden and a throw-away copy is animated instead, so nothing about the real
 * character ever needs restoring.  Every cause has its own ending:
 *
 *   acid    – she thrashes, sinks into the pool and dissolves into green froth and bubbles
 *   laser   – the beam slices her in two; the halves slide apart across a glowing cut and burn out
 *   shock   – she is electrocuted (flickering, arcs, shaking), chars black and crumbles to ash and smoke
 *   cutter  – the blade tears her into parts (head, torso, arms, feet) that fly off and bounce, with sparks
 *   spikes  – impaled: she is lifted, hangs limp, then deflates as oil sprays out and bolts pop loose
 *   time    – she powers down: eyes go dark, she droops and slumps, and a last spark of light drifts away
 *
 * Particles use the shared Effects emitter, so a death still costs almost nothing.
 */
import * as THREE from '../../node_modules/three/build/three.module.js';

export const DEATH_MS = { acid: 1900, lava: 1900, laser: 1800, barrier: 1800, shock: 2000, cutter: 1900, spikes: 1900, time: 1900 };
export const deathDuration = (cause) => DEATH_MS[cause] ?? 1400;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ease = (k) => 1 - Math.pow(1 - clamp01(k), 3);
const V = (x, y, z) => ({ x, y, z });

/** Clone the model (own materials, no shared userData rig references). */
function cloneModel(root) {
  const keep = root.userData; root.userData = {};
  let copy;
  try { copy = root.clone(true); } finally { root.userData = keep; }
  const mats = [];
  copy.traverse((o) => {
    o.userData = {};
    if (o.isMesh && o.material) {
      o.material = o.material.clone();
      o.castShadow = o.castShadow && true;
      mats.push(o.material);
    }
  });
  for (const m of mats) { m.userData.base = m.color ? m.color.clone() : null; m.userData.opacity = m.opacity; m.userData.emissive = m.emissive ? m.emissive.clone() : null; m.userData.eInt = m.emissiveIntensity ?? 1; }
  return { copy, mats };
}

export class DeathDirector {
  constructor(scene, effects) {
    this.scene = scene; this.fx = effects;
    this.actors = []; this.mats = []; this.pieces = []; this.anim = null; this.lights = [];
  }

  get active() { return !!this.anim; }

  clear() {
    for (const a of this.actors) { this.scene.remove(a); }
    for (const p of this.pieces) { this.scene.remove(p.obj); }
    for (const m of this.mats) m.dispose?.();
    for (const l of this.lights) { this.scene.remove(l); l.dispose?.(); }
    this.actors = []; this.mats = []; this.pieces = []; this.lights = []; this.anim = null;
  }

  /** Begin the animation for `cause` using the live player model `root` standing at `pos`. */
  start(cause, root, pos, extra = {}) {
    this.clear();
    const { copy, mats } = cloneModel(root);
    copy.position.copy(root.position); copy.quaternion.copy(root.quaternion); copy.scale.copy(root.scale); copy.visible = true;
    this.scene.add(copy); this.actors.push(copy); this.mats.push(...mats);
    const part = (n) => copy.getObjectByName(n);
    const a = {
      cause, t: 0, dur: deathDuration(cause) / 1000, actor: copy, mats, pos: { x: copy.position.x, y: copy.position.y, z: copy.position.z },
      rig: part('d_rig'), head: part('d_head'), armL: part('d_armL'), armR: part('d_armR'), footL: part('d_footL'), footR: part('d_footR'),
      acc: 0, acc2: 0, dir: extra.dir || { x: 0, z: 1 }, flick: 0,
    };
    a.baseRigY = a.rig?.position.y ?? 0; a.baseScale = a.rig ? a.rig.scale.clone() : new THREE.Vector3(1, 1, 1);
    this.anim = a;
    const init = { acid: this._initAcid, lava: this._initAcid, laser: this._initLaser, barrier: this._initLaser, shock: this._initShock, cutter: this._initCutter, spikes: this._initSpikes, time: this._initTime }[cause];
    (init || this._initGeneric).call(this, a);
  }

  update(dt) {
    const a = this.anim; if (!a) return;
    a.t += dt;
    const step = { acid: this._acid, lava: this._acid, laser: this._laser, barrier: this._laser, shock: this._shock, cutter: this._cutter, spikes: this._spikes, time: this._time }[a.cause] || this._generic;
    step.call(this, a, dt);
    this._stepPieces(dt);
  }

  // ───────────────────────── helpers ─────────────────────────
  _tint(a, color, k, emissive = null, eInt = 0) {
    const c = new THREE.Color(color);
    for (const m of a.mats) {
      if (m.color && m.userData.base) m.color.copy(m.userData.base).lerp(c, k);
      if (emissive && m.emissive) { m.emissive.set(emissive); m.emissiveIntensity = eInt; }
    }
  }
  _fade(a, k) { for (const m of a.mats) { m.transparent = true; m.opacity = (m.userData.opacity ?? 1) * (1 - clamp01(k)); } }
  _light(color, intensity, pos, dist = 7) { const l = new THREE.PointLight(color, intensity, dist, 2); l.position.set(pos.x, pos.y, pos.z); this.scene.add(l); this.lights.push(l); return l; }

  /** Free-flying pieces (cutter parts, laser halves) with gravity and floor bounce. */
  _addPiece(obj, vel, spin, { r = 0.15, life = 1.2, gravity = 18, bounce = 0.35 } = {}) {
    this.pieces.push({ obj, vx: vel.x, vy: vel.y, vz: vel.z, sx: spin.x, sy: spin.y, sz: spin.z, r, age: 0, life, gravity, bounce });
  }
  _stepPieces(dt) {
    for (const p of this.pieces) {
      p.age += dt;
      p.vy -= p.gravity * dt;
      p.obj.position.x += p.vx * dt; p.obj.position.y += p.vy * dt; p.obj.position.z += p.vz * dt;
      p.obj.rotation.x += p.sx * dt; p.obj.rotation.y += p.sy * dt; p.obj.rotation.z += p.sz * dt;
      if (p.obj.position.y < p.r) {
        p.obj.position.y = p.r;
        if (Math.abs(p.vy) > 1.2) this.fx.dust?.({ x: p.obj.position.x, y: 0, z: p.obj.position.z }, 3, '#ffb15a');
        p.vy = Math.abs(p.vy) * p.bounce; p.vx *= 0.7; p.vz *= 0.7; p.sx *= 0.6; p.sy *= 0.6; p.sz *= 0.6;
      }
      if (p.age > p.life) { const k = clamp01((p.age - p.life) / 0.45); p.obj.scale.setScalar(Math.max(0.001, 1 - k)); }
    }
  }

  // ───────────────────────── generic ─────────────────────────
  _initGeneric(a) { this.fx.burst?.(a.pos); a.actor.visible = false; }
  _generic() {}

  // ───────────────────────── acid: sink, thrash, dissolve ─────────────────────────
  _initAcid(a) {
    const p = a.pos;
    this.fx._ring({ x: p.x, y: 0.05, z: p.z }, { color: '#b8ff4a', from: 0.3, to: 2.4, life: 0.6 });
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * 6.283, s = rand(1.2, 3.4);
      this.fx._emit({ x: p.x, y: 0.1, z: p.z }, V(Math.cos(ang) * s, rand(2.5, 5.5), Math.sin(ang) * s), { color: i % 2 ? '#9cf53a' : '#d8ff7a', life: rand(0.5, 0.9), size: rand(0.5, 1.1), gravity: 14, drag: 0.6 });
    }
    a.light = this._light('#8dff3a', 3, { x: p.x, y: 0.6, z: p.z }, 6);
  }
  _acid(a, dt) {
    const t = a.t, p = a.pos, sink = ease(t / 1.35);
    a.actor.position.y = p.y - sink * 1.15;
    const flail = (1 - sink * 0.8);
    if (a.rig) { a.rig.rotation.z = Math.sin(t * 24) * 0.32 * flail; a.rig.rotation.x = Math.sin(t * 17) * 0.18 * flail; a.rig.scale.x = a.baseScale.x * (1 + Math.sin(t * 20) * 0.07 * flail); }
    if (a.armL) { a.armL.rotation.x = -2.5 + Math.sin(t * 31) * 0.5; a.armL.rotation.z = 0.6 + Math.sin(t * 27) * 0.4; }
    if (a.armR) { a.armR.rotation.x = -2.5 + Math.sin(t * 29 + 1) * 0.5; a.armR.rotation.z = -0.6 - Math.sin(t * 25) * 0.4; }
    if (a.head) a.head.rotation.z = Math.sin(t * 19) * 0.25 * flail;
    const d = clamp01((t - 0.1) / 1.1);
    this._tint(a, '#7cd62a', d * 0.85, '#6dff2a', d * 0.9);
    if (t > 0.9) this._fade(a, (t - 0.9) / 0.9);
    // bubbles and froth boil up from where she went in
    a.acc += dt;
    while (a.acc > 0.035) {
      a.acc -= 0.035;
      const o = { x: p.x + rand(-0.3, 0.3), y: 0.06, z: p.z + rand(-0.3, 0.3) };
      this.fx._emit(o, V(rand(-0.3, 0.3), rand(0.8, 2.2), rand(-0.3, 0.3)), { color: Math.random() > 0.5 ? '#c8ff5e' : '#7be22b', life: rand(0.5, 1.0), size: rand(0.5, 1.3), gravity: -2, drag: 1.5 });
      if (Math.random() > 0.6) this.fx._emit({ ...o, y: 0.2 }, V(rand(-0.2, 0.2), rand(0.4, 1.0), rand(-0.2, 0.2)), { color: '#e6ffb0', life: rand(0.8, 1.3), size: rand(1.4, 2.4), gravity: -1.2, drag: 1.2 });
    }
    if (a.light) a.light.intensity = 3 * (1 - clamp01(t / a.dur));
  }

  // ───────────────────────── laser: sliced in two ─────────────────────────
  _initLaser(a) {
    const p = a.pos, cutLocal = 0.15;           // the beam height relative to the model origin (body centre)
    a.cutLocal = cutLocal;
    const downClone = a.actor.clone(true);          // cloned before either cap exists
    const mk = (up) => {
      const g = up ? a.actor : downClone;
      const mats = [];
      g.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.side = THREE.DoubleSide; mats.push(o.material); } });
      const plane = new THREE.Plane(new THREE.Vector3(0, up ? 1 : -1, 0), 0);
      for (const m of mats) { m.clippingPlanes = [plane]; m.clipShadows = true; m.userData = { opacity: 1, base: null }; }
      const cap = new THREE.Mesh(new THREE.CircleGeometry(0.44, 28), new THREE.MeshBasicMaterial({ color: '#ff8a3c', toneMapped: false, side: THREE.DoubleSide }));
      cap.rotation.x = up ? Math.PI / 2 : -Math.PI / 2; cap.position.y = cutLocal; g.add(cap);
      if (!up) { this.scene.add(g); this.actors.push(g); }
      this.mats.push(...mats);
      return { g, plane, mats, cap };
    };
    a.up = mk(true); a.down = mk(false);
    a.vUp = { x: a.dir.x * -0.6 + rand(-0.4, 0.4), y: 1.8, z: a.dir.z * -0.6 + rand(-0.4, 0.4) };
    a.vDown = { x: a.dir.x * 0.5, y: 0, z: a.dir.z * 0.5 };
    a.upOff = V(0, 0, 0); a.downOff = V(0, 0, 0); a.spinUp = rand(1.2, 2.2) * (Math.random() > 0.5 ? 1 : -1);
    for (let i = 0; i < 46; i++) {
      const ang = Math.random() * 6.283, s = rand(2, 7);
      this.fx._emit({ x: p.x, y: p.y + cutLocal, z: p.z }, V(Math.cos(ang) * s, rand(-0.5, 3), Math.sin(ang) * s), { color: i % 3 ? '#ffb347' : '#fff2c0', life: rand(0.25, 0.7), size: rand(0.3, 0.8), gravity: 10, drag: 1.2 });
    }
    this.fx._flash?.('#ff8a3c', 7, 0.35, { x: p.x, y: p.y + 0.4, z: p.z });
    a.light = this._light('#ff7a30', 2.5, { x: p.x, y: p.y + 0.3, z: p.z }, 6);
  }
  _laser(a, dt) {
    const t = a.t, p = a.pos;
    // the halves wait one beat (the slice), then slide apart and tip over
    const k = clamp01((t - 0.12) / 0.5), tip = ease(k);
    const slide = ease((t - 0.12) / 0.8);
    a.vUp.y -= 14 * dt;
    a.upOff.x += a.vUp.x * dt * (t > 0.12 ? 1 : 0); a.upOff.z += a.vUp.z * dt * (t > 0.12 ? 1 : 0); a.upOff.y = Math.max(-0.1, a.upOff.y + (t > 0.12 ? a.vUp.y * dt : 0));
    const up = a.up, down = a.down;
    up.g.position.set(p.x + a.upOff.x, p.y + a.upOff.y, p.z + a.upOff.z);
    up.g.rotation.z = a.spinUp * tip * 0.55; up.g.rotation.x = -a.spinUp * tip * 0.3;
    down.g.position.set(p.x + a.dir.x * 0.25 * slide, p.y - 0.02 * slide, p.z + a.dir.z * 0.25 * slide);
    down.g.rotation.z = -a.spinUp * tip * 0.22; down.g.rotation.x = a.spinUp * tip * 0.15;
    for (const h of [up, down]) {
      h.g.updateMatrixWorld(true);
      const n = new THREE.Vector3(0, h === up ? 1 : -1, 0).applyQuaternion(h.g.quaternion);
      const pt = h.g.localToWorld(new THREE.Vector3(0, a.cutLocal, 0));
      h.plane.setFromNormalAndCoplanarPoint(n, pt);
      h.cap.material.color.setRGB(1, 0.35 + 0.45 * (1 - clamp01(t / 1.2)), 0.1 + 0.2 * (1 - clamp01(t / 1.2)));
    }
    // glowing cut edges shed sparks while the halves cool
    a.acc += dt;
    while (a.acc > 0.04 && t < 1.2) {
      a.acc -= 0.04;
      for (const h of [up, down]) {
        const o = h.g.localToWorld(new THREE.Vector3(rand(-0.3, 0.3), a.cutLocal, rand(-0.3, 0.3)));
        this.fx._emit(o, V(rand(-1, 1), rand(0.3, 2), rand(-1, 1)), { color: Math.random() > 0.4 ? '#ff9a3c' : '#ffe08a', life: rand(0.3, 0.6), size: rand(0.3, 0.6), gravity: 9, drag: 1.5 });
      }
    }
    if (t > 1.0) { const f = (t - 1.0) / 0.7; for (const h of [up, down]) { for (const m of h.mats) { m.transparent = true; m.opacity = 1 - clamp01(f); } h.cap.material.transparent = true; h.cap.material.opacity = 1 - clamp01(f); } }
    // heat-tint the halves
    for (const h of [up, down]) for (const m of h.mats) if (m.emissive) { m.emissive.set('#ff5a1a'); m.emissiveIntensity = 0.7 * (1 - clamp01(t / 1.3)); }
    if (a.light) a.light.intensity = 2.5 * (1 - clamp01(t / 1.0));
  }

  // ───────────────────────── shock: electrocuted, charred, ash ─────────────────────────
  _initShock(a) {
    const p = a.pos;
    this.fx.zap?.({ x: p.x, y: p.y + 0.3, z: p.z }, '#d6ff7a');
    a.light = this._light('#caff6a', 5, { x: p.x, y: p.y + 0.5, z: p.z }, 7);
    a.arcs = Array.from({ length: 6 }, () => {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#e6ffa8', toneMapped: false, transparent: true, opacity: 0 })); l.frustumCulled = false; this.scene.add(l); this.actors.push(l); return l;
    });
  }
  _shock(a, dt) {
    const t = a.t, p = a.pos;
    const live = t < 1.15;                         // zapping
    const burnt = clamp01((t - 0.4) / 1.0);
    if (live) {
      // violent shaking and an X-ray style flicker between normal and white-hot
      const sh = 0.045;
      a.actor.position.set(p.x + rand(-sh, sh), p.y + rand(0, sh), p.z + rand(-sh, sh));
      if (a.rig) { a.rig.rotation.z = rand(-0.12, 0.12); a.rig.rotation.x = rand(-0.12, 0.12); }
      if (a.armL) { a.armL.rotation.x = rand(-2.4, -1.4); a.armL.rotation.z = rand(0.4, 1.2); }
      if (a.armR) { a.armR.rotation.x = rand(-2.4, -1.4); a.armR.rotation.z = -rand(0.4, 1.2); }
      a.flick += dt;
      const white = Math.floor(t * 22) % 2 === 0;
      this._tint(a, white ? '#ffffff' : '#bfe0ff', white ? 0.85 : 0.2 + burnt * 0.3, white ? '#d6ffa0' : '#000000', white ? 1.4 : 0);
      if (a.light) a.light.intensity = white ? 6 : 1.5;
      for (const l of a.arcs) {
        l.material.opacity = Math.random() > 0.35 ? 1 : 0;
        if (l.material.opacity) {
          const pos = l.geometry.attributes.position; let x = p.x + rand(-0.15, 0.15), y = p.y + rand(-0.3, 0.45), z = p.z + rand(-0.15, 0.15);
          const ang = Math.random() * 6.283;
          for (let i = 0; i < 5; i++) { pos.setXYZ(i, x, y, z); x += Math.cos(ang) * 0.22 + rand(-0.12, 0.12); z += Math.sin(ang) * 0.22 + rand(-0.12, 0.12); y += rand(-0.18, 0.22); }
          pos.needsUpdate = true;
        }
      }
      a.acc += dt;
      while (a.acc > 0.05) { a.acc -= 0.05; this.fx.zap?.({ x: p.x, y: p.y + 0.1, z: p.z }, '#e6ffa0'); }
    } else {
      // charred: black, slumping, ember-glowing, then crumbling into ash
      for (const l of a.arcs) l.material.opacity = 0;
      const c = clamp01((t - 1.15) / 0.85);
      this._tint(a, '#171412', 0.92, '#ff5a14', 0.5 * (1 - c));
      a.actor.position.set(p.x, p.y, p.z);
      if (a.rig) { a.rig.scale.set(a.baseScale.x * (1 + 0.1 * c), a.baseScale.y * (1 - 0.55 * ease(c)), a.baseScale.z * (1 + 0.1 * c)); a.rig.rotation.x = 0.35 * ease(c); a.rig.rotation.z = 0; }
      if (a.armL) { a.armL.rotation.x = -0.2; a.armL.rotation.z = 0.15; } if (a.armR) { a.armR.rotation.x = -0.2; a.armR.rotation.z = -0.15; }
      if (a.head) a.head.rotation.x = 0.7 * ease(c);
      this._fade(a, Math.max(0, (c - 0.45) / 0.55));
      if (a.light) a.light.intensity = Math.max(0, 1.2 * (1 - c));
      a.acc += dt;
      while (a.acc > 0.03) {
        a.acc -= 0.03;
        this.fx._emit({ x: p.x + rand(-0.25, 0.25), y: p.y - 0.2 + rand(0, 0.5), z: p.z + rand(-0.25, 0.25) }, V(rand(-0.3, 0.3), rand(0.5, 1.4), rand(-0.3, 0.3)), { color: '#5d5957', life: rand(0.9, 1.5), size: rand(1.3, 2.4), gravity: -1.2, drag: 1.0 });
        if (c > 0.3) this.fx._emit({ x: p.x + rand(-0.3, 0.3), y: p.y + rand(-0.3, 0.3), z: p.z + rand(-0.3, 0.3) }, V(rand(-0.6, 0.6), rand(0.2, 1.0), rand(-0.6, 0.6)), { color: Math.random() > 0.5 ? '#9b9692' : '#2a2625', life: rand(0.6, 1.2), size: rand(0.4, 0.9), gravity: 2.5, drag: 1.4 });
      }
    }
  }

  // ───────────────────────── cutter: torn apart ─────────────────────────
  _initCutter(a) {
    const p = a.pos, parts = [];
    const names = ['d_torso', 'd_belt', 'd_core', 'd_head', 'd_armL', 'd_armR', 'd_footL', 'd_footR'];
    const bladeDir = a.dir;
    a.actor.updateMatrixWorld(true);
    for (const n of names) { const o = a.actor.getObjectByName(n); if (o) parts.push([n, o]); }
    for (const [n, o] of parts) {
      this.scene.attach(o);                         // keeps its world transform, now free of the rig
      const big = n === 'd_torso' || n === 'd_head';
      const sp = big ? rand(3, 6) : rand(4, 9);
      const ang = Math.atan2(bladeDir.z, bladeDir.x) + rand(-1.3, 1.3);
      this._addPiece(o, V(Math.cos(ang) * sp, rand(3.5, 7.5), Math.sin(ang) * sp), V(rand(-12, 12), rand(-12, 12), rand(-12, 12)), { r: n === 'd_torso' ? 0.25 : n === 'd_head' ? 0.22 : 0.1, life: 1.15, gravity: 20, bounce: 0.38 });
      this.actors.push(o); a.pieceCount = (a.pieceCount || 0) + 1;
    }
    for (let i = 0; i < 70; i++) {
      const ang = Math.random() * 6.283, s = rand(3, 10);
      this.fx._emit({ x: p.x, y: p.y + 0.1, z: p.z }, V(Math.cos(ang) * s, rand(0.5, 5), Math.sin(ang) * s), { color: i % 3 ? '#ffae3a' : '#fff3c4', life: rand(0.25, 0.8), size: rand(0.3, 0.8), gravity: 11, drag: 1.1 });
    }
    this.fx._ring({ x: p.x, y: p.y, z: p.z }, { color: '#ffd27a', from: 0.2, to: 3.2, life: 0.4, rotX: 0 });
    this.fx._flash?.('#ffcf80', 8, 0.35, { x: p.x, y: p.y + 0.4, z: p.z });
  }
  _cutter(a, dt) {
    const t = a.t, p = a.pos;
    a.acc += dt;
    // the parts trail sparks and little puffs of smoke as they tumble
    while (a.acc > 0.05 && t < 1.2) {
      a.acc -= 0.05;
      for (const pc of this.pieces) if (Math.random() > 0.55) this.fx._emit(pc.obj.position, V(rand(-1, 1), rand(0.2, 1.5), rand(-1, 1)), { color: Math.random() > 0.5 ? '#ffb347' : '#6a6665', life: rand(0.25, 0.5), size: rand(0.3, 0.7), gravity: 6, drag: 1.5 });
    }
    // the eyes of the head flicker out
    const head = a.head; if (head) for (const m of a.mats) if (m.emissive) m.emissiveIntensity = Math.random() > 0.3 ? m.userData.eInt : 0;
    if (t > 1.15 && !a._poof) { a._poof = true; for (const pc of this.pieces) this.fx.dust?.({ x: pc.obj.position.x, y: 0.1, z: pc.obj.position.z }, 5, '#9a9694'); }
    void p;
  }

  // ───────────────────────── spikes: impaled, deflates ─────────────────────────
  _initSpikes(a) {
    const p = a.pos;
    for (let i = 0; i < 22; i++) this.fx._emit({ x: p.x, y: p.y - 0.2, z: p.z }, V(rand(-2.5, 2.5), rand(1, 4), rand(-2.5, 2.5)), { color: i % 3 ? '#2b2326' : '#ffd36a', life: rand(0.5, 1.0), size: rand(0.4, 0.9), gravity: 14, drag: 0.8 });
    this.fx._ring({ x: p.x, y: 0.05, z: p.z }, { color: '#ffffff', from: 0.2, to: 1.8, life: 0.35 });
    // loose bolts that pop off the chassis and tumble away
    a.bolts = Array.from({ length: 5 }, () => {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 6), new THREE.MeshStandardMaterial({ color: '#c9d1d6', metalness: 0.8, roughness: 0.3 }));
      b.position.set(p.x, p.y + rand(-0.1, 0.3), p.z); b.visible = false; this.scene.add(b); this.actors.push(b); this.mats.push(b.material); return b;
    });
    a.popped = 0;
  }
  _spikes(a, dt) {
    const t = a.t, p = a.pos;
    const lift = ease(t / 0.18) * 0.38;
    const hang = 1 - ease((t - 1.05) / 0.5);
    a.actor.position.set(p.x, p.y + lift * hang - (1 - hang) * 0.35, p.z);
    const deflate = ease((t - 0.35) / 0.9);
    if (a.rig) { a.rig.scale.set(a.baseScale.x * (1 + 0.18 * deflate), a.baseScale.y * (1 - 0.5 * deflate), a.baseScale.z * (1 + 0.18 * deflate)); a.rig.rotation.z = Math.sin(t * 9) * 0.05 * (1 - deflate) + 0.25 * deflate; a.rig.rotation.x = -0.15 * (1 - deflate); }
    const shudder = t < 0.4 ? Math.sin(t * 60) * 0.35 : 0;
    if (a.armL) { a.armL.rotation.z = 1.3 + shudder * 0.2; a.armL.rotation.x = -0.3 + shudder * 0.3; }
    if (a.armR) { a.armR.rotation.z = -1.3 - shudder * 0.2; a.armR.rotation.x = -0.3 - shudder * 0.3; }
    if (a.head) a.head.rotation.x = 0.35 * deflate;
    for (const m of a.mats) if (m.emissive && m.userData.emissive) m.emissiveIntensity = (m.userData.eInt ?? 1) * (1 - 0.9 * deflate);
    this._tint(a, '#9aa0a6', deflate * 0.35);
    // hissing air + oil spray from the punctures, bolts popping loose
    a.acc += dt;
    while (a.acc > 0.045 && t < 1.5) {
      a.acc -= 0.045;
      this.fx._emit({ x: p.x + rand(-0.2, 0.2), y: p.y - 0.2 + rand(0, 0.35), z: p.z + rand(-0.2, 0.2) }, V(rand(-0.6, 0.6), rand(0.6, 1.8), rand(-0.6, 0.6)), { color: '#e9eef2', life: rand(0.4, 0.8), size: rand(0.8, 1.6), gravity: -0.8, drag: 1.4 });
      if (Math.random() > 0.6) this.fx._emit({ x: p.x, y: p.y - 0.1, z: p.z }, V(rand(-1.6, 1.6), rand(1, 3), rand(-1.6, 1.6)), { color: '#241d20', life: rand(0.4, 0.8), size: rand(0.4, 0.8), gravity: 14, drag: 0.6 });
    }
    while (a.popped < a.bolts.length && t > 0.45 + a.popped * 0.16) {
      const b = a.bolts[a.popped++]; b.visible = true; b.position.set(p.x, p.y + 0.1, p.z);
      this._addPiece(b, V(rand(-2.2, 2.2), rand(3, 5), rand(-2.2, 2.2)), V(rand(-14, 14), rand(-14, 14), 0), { r: 0.04, life: 1.0, gravity: 18, bounce: 0.5 });
    }
    if (t > 1.3) this._fade(a, (t - 1.3) / 0.6);
  }

  // ───────────────────────── time: powers down ─────────────────────────
  _initTime(a) {
    const p = a.pos;
    this.fx._ring({ x: p.x, y: 0.05, z: p.z }, { color: '#6fe7ff', from: 2.4, to: 0.15, life: 0.9 });
    a.light = this._light('#6fe7ff', 2.5, { x: p.x, y: p.y + 0.4, z: p.z }, 5);
  }
  _time(a, dt) {
    const t = a.t, p = a.pos, d = ease(t / 1.1);
    for (const m of a.mats) if (m.emissive && m.userData.emissive) m.emissiveIntensity = (m.userData.eInt ?? 1) * (Math.random() > 0.25 + d * 0.6 ? 1 : 0.1) * (1 - d);
    this._tint(a, '#59646b', d * 0.7);
    if (a.rig) { a.rig.scale.set(a.baseScale.x * (1 + 0.08 * d), a.baseScale.y * (1 - 0.22 * d), a.baseScale.z * (1 + 0.08 * d)); a.rig.rotation.x = 0.3 * d; }
    if (a.head) a.head.rotation.x = 0.85 * d;
    if (a.armL) { a.armL.rotation.z = 0.08; a.armL.rotation.x = -0.1 * d; } if (a.armR) { a.armR.rotation.z = -0.08; a.armR.rotation.x = -0.1 * d; }
    a.actor.position.set(p.x, p.y - 0.08 * d, p.z);
    a.acc += dt;
    while (a.acc > 0.11 && t < 1.2) { a.acc -= 0.11; this.fx._emit({ x: p.x + rand(-0.2, 0.2), y: p.y + rand(-0.2, 0.3), z: p.z + rand(-0.2, 0.2) }, V(rand(-0.8, 0.8), rand(0.2, 1.5), rand(-0.8, 0.8)), { color: Math.random() > 0.5 ? '#ffd36a' : '#6fe7ff', life: rand(0.3, 0.6), size: rand(0.3, 0.6), gravity: 7, drag: 1.4 }); }
    if (t > 1.2 && !a._soul) {
      a._soul = true;
      for (let i = 0; i < 16; i++) this.fx._emit({ x: p.x + rand(-0.25, 0.25), y: p.y + 0.2, z: p.z + rand(-0.25, 0.25) }, V(rand(-0.3, 0.3), rand(1.2, 2.6), rand(-0.3, 0.3)), { color: '#bff6ff', life: rand(0.9, 1.5), size: rand(0.5, 0.9), gravity: -1.5, drag: 0.8 });
    }
    if (t > 1.2) this._fade(a, (t - 1.2) / 0.6);
    if (a.light) a.light.intensity = 2.5 * (1 - d);
  }
}
