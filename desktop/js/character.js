/**
 * Deeba – a friendly little robotics-sandbox explorer.
 *
 * Soft pearl shell, glossy black visor with glowing eyes, stubby arms and feet, a glowing antenna.
 * Everything is procedural (no assets) and animated: run cycle, lean, jump stretch, landing squash,
 * ice-sliding pose, blinking, victory dance, and accessory secondary motion (scarf, cape, sprout…).
 * The model's origin is the centre of the physics capsule (feet at y = -0.5) and it faces +Z.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { RoundedBoxGeometry } from './vendor/rounded_box_geometry.js';
import { outfitById, DEFAULT_EQUIPPED } from './outfits.js';

const std = (color, roughness = 0.4, metalness = 0.1, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
const glowMat = (color) => new THREE.MeshBasicMaterial({ color });

function mesh(geometry, material, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, shadow = true } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.scale.set(sx, sy, sz);
  m.castShadow = shadow;
  return m;
}

export function createDeeba(equipped = DEFAULT_EQUIPPED) {
  const root = new THREE.Group();
  const rig = new THREE.Group();     // squash / stretch / lean happen here
  root.add(rig);

  const mats = {
    body: std('#eceff4', 0.34, 0.12),
    trim: std('#1b1e27', 0.35, 0.3),
    visor: std('#07090d', 0.08, 0.6),
    glow: glowMat('#6fe7ff'),
    eye: glowMat('#7ff6ff'),
  };

  // Torso & head
  const torso = mesh(new THREE.SphereGeometry(0.27, 28, 20), mats.body, { y: -0.2, sx: 1, sy: 0.92, sz: 0.9 });
  const belt = mesh(new THREE.TorusGeometry(0.235, 0.02, 8, 36), mats.trim, { y: -0.27, rx: Math.PI / 2, sx: 1, sy: 0.9, sz: 1 });
  const core = mesh(new THREE.CircleGeometry(0.045, 18), mats.glow, { y: -0.17, z: 0.245, shadow: false });
  const head = new THREE.Group(); head.position.y = 0.2; // pivot for look / tilt
  const skull = mesh(new THREE.SphereGeometry(0.3, 32, 22), mats.body, { sx: 1.05, sy: 0.92, sz: 0.97 });
  const visor = mesh(new THREE.SphereGeometry(0.3, 32, 20), mats.visor, { y: 0.0, z: 0.2, sx: 0.82, sy: 0.6, sz: 0.42 });
  const visorRim = mesh(new THREE.TorusGeometry(0.24, 0.014, 8, 40), mats.trim, { y: 0.0, z: 0.215, sx: 1.03, sy: 0.74, sz: 0.5, shadow: false });
  const eyes = new THREE.Group(); eyes.position.set(0, 0.02, 0.318);
  const eyeGeo = new THREE.CapsuleGeometry(0.034, 0.06, 4, 10);
  const eyeL = mesh(eyeGeo, mats.eye, { x: -0.1, shadow: false });
  const eyeR = mesh(eyeGeo, mats.eye, { x: 0.1, shadow: false });
  eyes.add(eyeL, eyeR);
  const smile = mesh(new THREE.TorusGeometry(0.045, 0.008, 6, 14, Math.PI), mats.eye, { y: -0.075, z: 0.32, rz: Math.PI, shadow: false });
  const podGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.05, 20);
  const podL = mesh(podGeo, mats.trim, { x: -0.31, y: -0.01, rz: Math.PI / 2 });
  const podR = mesh(podGeo, mats.trim, { x: 0.31, y: -0.01, rz: Math.PI / 2 });
  const podGlowGeo = new THREE.CircleGeometry(0.045, 16);
  const podGlowL = mesh(podGlowGeo, mats.glow, { x: -0.337, y: -0.01, ry: -Math.PI / 2, shadow: false });
  const podGlowR = mesh(podGlowGeo, mats.glow, { x: 0.337, y: -0.01, ry: Math.PI / 2, shadow: false });
  const antenna = new THREE.Group(); antenna.position.set(0, 0.27, -0.02);
  antenna.add(mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.17, 8), mats.trim, { y: 0.08 }));
  const bulb = mesh(new THREE.SphereGeometry(0.045, 14, 12), mats.glow, { y: 0.18, shadow: false });
  antenna.add(bulb);
  head.add(skull, visor, visorRim, eyes, smile, podL, podR, podGlowL, podGlowR, antenna);

  // Hat / face / neck anchor groups (rebuilt on outfit change)
  const hatMount = new THREE.Group(); hatMount.position.set(0, 0.26, 0); head.add(hatMount);
  const faceMount = new THREE.Group(); faceMount.position.set(0, 0.02, 0.3); head.add(faceMount);
  const neckMount = new THREE.Group(); neckMount.position.set(0, -0.035, 0); rig.add(neckMount);
  neckMount.position.y = 0.0;
  const backMount = new THREE.Group(); backMount.position.set(0, -0.15, -0.23); rig.add(backMount);

  // Limbs
  const armGeo = new THREE.CapsuleGeometry(0.052, 0.12, 4, 10);
  const handGeo = new THREE.SphereGeometry(0.065, 12, 10);
  const makeArm = (side) => {
    const g = new THREE.Group(); g.position.set(side * 0.285, -0.1, 0);
    g.add(mesh(armGeo, mats.body, { y: -0.1 }), mesh(handGeo, mats.trim, { y: -0.21 }));
    return g;
  };
  const armL = makeArm(-1), armR = makeArm(1);
  const footGeo = new RoundedBoxGeometry(0.17, 0.11, 0.27, 3, 0.04);
  const makeFoot = (side) => { const g = new THREE.Group(); g.position.set(side * 0.13, -0.43, 0.02); g.add(mesh(footGeo, mats.trim)); return g; };
  const footL = makeFoot(-1), footR = makeFoot(1);

  rig.add(torso, belt, core, head, armL, armR, footL, footR);
  // names let the death animations find (and tear off) the individual parts of a cloned model
  rig.name = 'd_rig'; torso.name = 'd_torso'; belt.name = 'd_belt'; core.name = 'd_core'; head.name = 'd_head';
  armL.name = 'd_armL'; armR.name = 'd_armR'; footL.name = 'd_footL'; footR.name = 'd_footR';

  // Soft blob shadow disc that stays on the ground regardless of the rig's animation.
  const accessories = { hat: null, face: null, neck: null, back: null };
  const dynamic = { scarfTail: null, cape: null, sprout: null, pom: null, wingL: null, wingR: null, jets: [], halo: null };

  const state = {
    yaw: 0, phase: 0, blinkT: 2 + Math.random() * 2, blink: 0, squash: 0, squashV: 0, lastVy: 0, wasGrounded: true,
    lean: 0, leanSide: 0, time: Math.random() * 10, wobble: 0, armPose: 0, dead: false, scale: 1, spawnT: 1,
  };

  function clearMount(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((n) => { n.geometry?.dispose?.(); if (n.material && !Object.values(mats).includes(n.material)) n.material.dispose?.(); });
    }
  }

  function setOutfit(eq) {
    const skin = outfitById(eq.skin) || outfitById('pearl');
    mats.body.color.set(skin.body); mats.body.metalness = skin.metal ?? 0.12; mats.body.roughness = skin.metal ? 0.25 : 0.34;
    mats.trim.color.set(skin.trim);
    mats.glow.color.set(skin.glow);
    mats.eye.color.set(skin.glow).lerp(new THREE.Color('#9ffcff'), 0.55);

    Object.assign(dynamic, { scarfTail: null, cape: null, sprout: null, pom: null, wingL: null, wingR: null, jets: [], halo: null });
    [hatMount, faceMount, neckMount, backMount].forEach(clearMount);

    const hat = outfitById(eq.hat), face = outfitById(eq.face), neck = outfitById(eq.neck), back = outfitById(eq.back);

    if (hat?.id === 'hat-sprout') {
      const stem = mesh(new THREE.CylinderGeometry(0.01, 0.014, 0.12, 6), std('#4f9d50', 0.6, 0), { y: 0.05 });
      const leaf = new THREE.Group(); leaf.position.y = 0.11;
      for (const s of [-1, 1]) leaf.add(mesh(new THREE.SphereGeometry(0.07, 12, 8), std('#6fdc6a', 0.5, 0), { x: s * 0.06, sx: 1.2, sy: 0.25, sz: 0.7, rz: s * 0.3 }));
      hatMount.add(stem, leaf); dynamic.sprout = leaf;
    } else if (hat?.id === 'hat-beanie') {
      const cap = mesh(new THREE.SphereGeometry(0.28, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), std(hat.color, 0.9, 0), { y: -0.08, sx: 1.06, sy: 0.9, sz: 0.98 });
      const rim = mesh(new THREE.TorusGeometry(0.285, 0.035, 8, 30), std('#fff1e6', 0.9, 0), { y: -0.085, rx: Math.PI / 2, sx: 1.06, sy: 0.98 });
      const pom = mesh(new THREE.SphereGeometry(0.06, 12, 10), std('#fff1e6', 0.95, 0), { y: 0.2 });
      hatMount.add(cap, rim, pom); dynamic.pom = pom;
    } else if (hat?.id === 'hat-tophat') {
      hatMount.add(
        mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.03, 24), std(hat.color, 0.3, 0.3), { y: -0.01 }),
        mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.26, 24), std(hat.color, 0.3, 0.3), { y: 0.12 }),
        mesh(new THREE.CylinderGeometry(0.162, 0.162, 0.04, 24), std('#c9354b', 0.5, 0), { y: 0.05 }),
      );
    } else if (hat?.id === 'hat-halo') {
      const ring = mesh(new THREE.TorusGeometry(0.17, 0.022, 10, 36), new THREE.MeshBasicMaterial({ color: hat.color }), { y: 0.16, rx: Math.PI / 2, shadow: false });
      hatMount.add(ring); dynamic.halo = ring;
    } else if (hat?.id === 'hat-crown') {
      const gold = std(hat.color, 0.25, 0.8, { emissive: '#7a5410', emissiveIntensity: 0.25 });
      const band = mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.08, 20, 1, true), gold, { y: 0.02 });
      band.material.side = THREE.DoubleSide; hatMount.add(band);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        hatMount.add(mesh(new THREE.ConeGeometry(0.04, 0.12, 8), gold, { x: Math.sin(a) * 0.175, z: Math.cos(a) * 0.175, y: 0.1 }));
        hatMount.add(mesh(new THREE.SphereGeometry(0.018, 8, 8), glowMat('#ff7a9a'), { x: Math.sin(a) * 0.175, z: Math.cos(a) * 0.175, y: 0.17, shadow: false }));
      }
    }

    if (face?.id === 'face-shades') {
      const lens = std(face.color, 0.05, 0.6);
      faceMount.add(mesh(new RoundedBoxGeometry(0.16, 0.085, 0.03, 2, 0.02), lens, { x: -0.1, y: 0.0, z: 0.03 }), mesh(new RoundedBoxGeometry(0.16, 0.085, 0.03, 2, 0.02), lens, { x: 0.1, y: 0.0, z: 0.03 }), mesh(new THREE.BoxGeometry(0.06, 0.016, 0.02), lens, { z: 0.03 }));
      eyes.visible = false;
    } else if (face?.id === 'face-goggles') {
      const rim = std(face.color, 0.3, 0.8);
      const lensMat = new THREE.MeshStandardMaterial({ color: '#ffcf7a', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.55, emissive: '#ff9a2a', emissiveIntensity: 0.25 });
      for (const s of [-1, 1]) {
        faceMount.add(mesh(new THREE.TorusGeometry(0.075, 0.017, 8, 24), rim, { x: s * 0.1, z: 0.04 }), mesh(new THREE.CircleGeometry(0.07, 20), lensMat, { x: s * 0.1, z: 0.043, shadow: false }));
      }
      faceMount.add(mesh(new THREE.TorusGeometry(0.3, 0.014, 6, 32, Math.PI * 1.1), std('#3a2a1a', 0.8, 0), { y: -0.03, z: -0.0, rx: Math.PI / 2, rz: -Math.PI * 0.05, sx: 1.08, sy: 0.98, shadow: false }));
      eyes.visible = true;
    } else if (face?.id === 'face-heart') {
      const heart = new THREE.Shape();
      heart.moveTo(0, -0.05); heart.bezierCurveTo(-0.07, 0.0, -0.06, 0.07, 0, 0.035); heart.bezierCurveTo(0.06, 0.07, 0.07, 0.0, 0, -0.05);
      const geo = new THREE.ShapeGeometry(heart);
      for (const s of [-1, 1]) faceMount.add(mesh(geo, glowMat(face.color), { x: s * 0.1, y: 0.0, z: 0.045, sx: 1.2, sy: 1.2, shadow: false }));
      eyes.visible = false;
    } else eyes.visible = true;

    if (neck?.id === 'neck-bow') {
      const mat = std(neck.color, 0.5, 0);
      for (const s of [-1, 1]) neckMount.add(mesh(new THREE.ConeGeometry(0.07, 0.11, 3), mat, { x: s * 0.07, y: 0.045, z: 0.2, rz: -s * Math.PI / 2, sz: 0.6 }));
      neckMount.add(mesh(new THREE.SphereGeometry(0.035, 10, 8), mat, { y: 0.045, z: 0.205 }));
    } else if (neck?.id === 'neck-scarf') {
      const mat = std(neck.color, 0.95, 0);
      neckMount.add(mesh(new THREE.TorusGeometry(0.2, 0.052, 10, 30), mat, { y: 0.02, rx: Math.PI / 2, sx: 1.05, sy: 1.0 }));
      const tail = new THREE.Group(); tail.position.set(0.12, 0.01, -0.19);
      tail.add(mesh(new RoundedBoxGeometry(0.1, 0.3, 0.03, 2, 0.01), mat, { y: -0.14 }));
      neckMount.add(tail); dynamic.scarfTail = tail;
    } else if (neck?.id === 'neck-cape') {
      const mat = std(neck.color, 0.8, 0, { side: THREE.DoubleSide });
      const cape = new THREE.Group(); cape.position.set(0, 0.0, -0.2);
      cape.add(mesh(new THREE.PlaneGeometry(0.46, 0.62, 3, 4), mat, { y: -0.3, shadow: true }));
      neckMount.add(cape, mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 28), std('#ffcf4a', 0.3, 0.8), { y: 0.02, rx: Math.PI / 2 }));
      dynamic.cape = cape;
    }

    if (back?.id === 'back-pack') {
      const mat = std(back.color, 0.7, 0.05);
      backMount.add(mesh(new RoundedBoxGeometry(0.3, 0.34, 0.14, 3, 0.05), mat, { y: -0.02 }), mesh(new RoundedBoxGeometry(0.22, 0.14, 0.04, 2, 0.02), std('#2f6a52', 0.7, 0), { y: -0.06, z: 0.085 }), mesh(new THREE.SphereGeometry(0.02, 8, 8), glowMat('#ffe28a'), { y: 0.1, z: 0.075, shadow: false }));
    } else if (back?.id === 'back-jet') {
      const mat = std(back.color, 0.3, 0.8);
      for (const s of [-1, 1]) {
        backMount.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.26, 14), mat, { x: s * 0.1, y: -0.03 }));
        const flame = mesh(new THREE.ConeGeometry(0.05, 0.2, 10), new THREE.MeshBasicMaterial({ color: '#9fe8ff', transparent: true, opacity: 0.8 }), { x: s * 0.1, y: -0.24, rx: Math.PI, shadow: false });
        backMount.add(flame); dynamic.jets.push(flame);
      }
    } else if (back?.id === 'back-wings') {
      const wingMat = new THREE.MeshBasicMaterial({ color: back.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      const shape = new THREE.Shape();
      shape.moveTo(0, 0); shape.bezierCurveTo(0.2, 0.28, 0.5, 0.3, 0.52, 0.1); shape.bezierCurveTo(0.42, 0.04, 0.3, -0.04, 0.34, -0.14); shape.bezierCurveTo(0.2, -0.08, 0.08, -0.04, 0, 0);
      const geo = new THREE.ShapeGeometry(shape);
      const wingL = new THREE.Group(); wingL.add(mesh(geo, wingMat, { shadow: false })); wingL.scale.x = -1; wingL.position.x = -0.04;
      const wingR = new THREE.Group(); wingR.add(mesh(geo, wingMat, { shadow: false })); wingR.position.x = 0.04;
      backMount.add(wingL, wingR); dynamic.wingL = wingL; dynamic.wingR = wingR;
    }
    state.equipped = eq;
  }

  function wrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

  /**
   * @param {object} s { speed01, grounded, vy, onIce, dead, won, yaw (target), airJump }
   */
  function update(dt, s) {
    state.time += dt;
    const t = state.time;
    if (s.yaw !== undefined && !state.dead) state.yaw += wrap(s.yaw - state.yaw) * Math.min(1, dt * (s.onIce ? 7 : 13));
    root.rotation.y = state.yaw;

    const speed = s.speed01 || 0;
    const grounded = s.grounded !== false;
    const vy = s.vy || 0;

    // Landing / take-off squash driven by a damped spring.
    if (grounded && !state.wasGrounded) state.squashV -= Math.min(7, -state.lastVy * 0.5);
    if (!grounded && state.wasGrounded && vy > 2) state.squashV += 3.5;
    state.wasGrounded = grounded; state.lastVy = vy;
    state.squashV += (-state.squash * 160 - state.squashV * 13) * dt;
    state.squash += state.squashV * dt;
    state.squash = Math.max(-0.35, Math.min(0.45, state.squash));
    const stretch = grounded ? 0 : Math.max(-0.12, Math.min(0.2, vy * 0.016));
    const sy = 1 - state.squash * 0.55 + stretch, sxz = 1 + state.squash * 0.3 - stretch * 0.5;
    const spawn = Math.min(1, state.spawnT); state.spawnT += dt * 3;
    const grow = spawn < 1 ? 1 - Math.pow(1 - spawn, 3) : 1;
    rig.scale.set(sxz * grow, sy * grow, sxz * grow);
    rig.position.y = (-0.5 * (1 - sy * grow)) + (grounded ? Math.abs(Math.sin(state.phase)) * 0.035 * speed : 0);

    // Locomotion
    // On ice Deeba keeps stepping while she is pushing, and slides stiff-legged (a skid) when she is not.
    const skid01 = s.onIce ? Math.min(1, (s.skid || 0) / 4.5) : 0;
    const run = grounded ? speed * (s.onIce ? (s.pushing ? 0.85 : 0) : 1) : 0;
    state.phase += dt * (5 + 11 * speed) * (run > 0.05 ? 1 : 0);
    const swing = Math.sin(state.phase) * 0.9 * run;
    footL.position.z = 0.02 + Math.sin(state.phase) * 0.14 * run;
    footR.position.z = 0.02 - Math.sin(state.phase) * 0.14 * run;
    footL.position.y = -0.43 + Math.max(0, Math.cos(state.phase)) * 0.07 * run;
    footR.position.y = -0.43 + Math.max(0, -Math.cos(state.phase)) * 0.07 * run;
    footL.position.z += 0.13 * skid01; footR.position.z -= 0.09 * skid01;       // skating stance

    let targetArm = swing, armOut = 0.08;
    if (!grounded) { targetArm = Math.PI * 0.85 - 0.2 * Math.max(0, -vy * 0.05); armOut = 0.35 + (vy > 0 ? 0.1 : 0.4); }
    else if (s.onIce) { targetArm = swing * 0.6 + 0.2; armOut = 0.25 + 0.5 * skid01; }
    else if (s.won) { targetArm = Math.PI * 0.95 + Math.sin(t * 12) * 0.3; armOut = 0.3; }
    state.armPose += (targetArm - state.armPose) * Math.min(1, dt * 16);
    armL.rotation.x = grounded && !s.won ? -state.armPose : -state.armPose * 0.4 - 0.6;
    armR.rotation.x = grounded && !s.won ? state.armPose : -state.armPose * 0.4 - 0.6;
    armL.rotation.z = armOut; armR.rotation.z = -armOut;
    if (!grounded) { armL.rotation.x = -state.armPose * 0.35 - 0.3; armR.rotation.x = -state.armPose * 0.35 - 0.3; }

    const leanTarget = s.onIce ? (s.pushing ? 0.12 * speed : 0) - 0.16 * skid01 : 0.22 * run;
    state.lean += (leanTarget - state.lean) * Math.min(1, dt * 9);
    rig.rotation.x = state.lean + (grounded ? 0 : -0.05 * vy * 0.05);
    state.slip = (state.slip || 0) + ((s.slip || 0) - (state.slip || 0)) * Math.min(1, dt * 8);
    rig.rotation.z = Math.sin(state.phase) * 0.05 * run + (s.won ? Math.sin(t * 9) * 0.12 : 0) + state.slip * 0.2 * (s.onIce ? 1 : 0);
    if (s.won) { root.rotation.y += Math.sin(t * 6) * 0.35; rig.position.y += Math.abs(Math.sin(t * 6)) * 0.12; }
    head.rotation.x = -state.lean * 0.5 + Math.sin(t * 1.3) * 0.015;
    head.rotation.z = Math.sin(t * 0.9) * 0.025 + Math.sin(state.phase) * 0.03 * run;
    head.position.y = 0.2 + (grounded ? Math.sin(t * 2.2) * 0.006 : 0);

    // Blink
    state.blinkT -= dt;
    if (state.blinkT <= 0) { state.blink = 0.13; state.blinkT = 2.2 + Math.random() * 3.5; }
    state.blink = Math.max(0, state.blink - dt);
    const lid = state.blink > 0 ? 0.1 : (s.dead ? 0.35 : 1);
    eyeL.scale.y = eyeR.scale.y = lid * (s.won ? 0.55 : 1);
    smile.scale.set(s.won ? 1.5 : 1, s.won ? 1.5 : (grounded ? 1 : -0.8), 1);
    bulb.scale.setScalar(1 + Math.sin(t * 4) * 0.12);
    antenna.rotation.z = Math.sin(t * 2.2) * 0.07 - state.lean * 0.4 + Math.sin(state.phase * 2) * 0.05 * run;
    antenna.rotation.x = -state.lean * 0.9 - 0.04 * Math.max(0, vy * 0.1);

    // Accessory secondary motion
    if (dynamic.scarfTail) { dynamic.scarfTail.rotation.x = 0.2 + 1.0 * speed * (run > 0 ? 1 : 0.2) + Math.sin(t * 7) * 0.08 * (0.3 + speed); dynamic.scarfTail.rotation.z = Math.sin(t * 5) * 0.12 * speed; }
    if (dynamic.cape) dynamic.cape.rotation.x = 0.12 + Math.min(1.1, 0.7 * speed + (grounded ? 0 : Math.max(0, -vy) * 0.05)) + Math.sin(t * 6) * 0.05;
    if (dynamic.sprout) dynamic.sprout.rotation.z = Math.sin(t * 3 + state.phase) * 0.2;
    if (dynamic.pom) dynamic.pom.position.x = Math.sin(t * 5) * 0.02 * (0.3 + speed);
    if (dynamic.halo) { dynamic.halo.position.y = 0.16 + Math.sin(t * 2.4) * 0.02; dynamic.halo.rotation.z = t; }
    if (dynamic.wingL) { const f = Math.sin(t * (grounded ? 3 : 14)) * (grounded ? 0.08 : 0.4); dynamic.wingL.rotation.y = 0.5 + f; dynamic.wingR.rotation.y = -0.5 - f; }
    for (const jet of dynamic.jets) { const on = !grounded && vy > 0 ? 1 : 0.15; jet.scale.set(on, on * (0.8 + Math.random() * 0.5), on); jet.visible = on > 0.2; }
  }

  function reset() { state.spawnT = 0; state.squash = 0; state.squashV = 0; state.dead = false; state.armPose = 0; root.visible = true; }
  function setDead(flag) { state.dead = flag; root.visible = !flag; }
  function snapYaw(yaw) { state.yaw = yaw; root.rotation.y = yaw; }

  root.userData = { rig, mats, setOutfit, update, reset, setDead, snapYaw, state, head, eyes, glowColor: () => mats.glow.color, bodyColor: () => mats.body.color, body: torso };
  setOutfit(equipped);
  root.traverse((n) => { if (n.isMesh) n.castShadow = n.castShadow !== false; });
  return root;
}

/** Back-compat wrapper used by older call sites. */
export function createPlayerMesh() { return createDeeba(); }
