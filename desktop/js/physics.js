/**
 * Physics: a real-game character controller on top of Rapier.
 *
 *  • Deeba is a *kinematic capsule* moved by Rapier's KinematicCharacterController – the same approach used by
 *    most 3D games.  It gives sliding along walls, auto-stepping over tiny lips, snap-to-ground on slopes, and
 *    never gets stuck on seams or tips over like the old rigid-body cube did.
 *  • Movement is acceleration based (ground / air / ice friction), with gravity, variable-height jumps,
 *    coyote time and jump buffering for responsive, forgiving platforming.
 *  • The simulation runs on a fixed 120 Hz step and the rendered pose is interpolated, so motion stays smooth at
 *    any frame rate.
 *  • Walls and ledges are merged into long continuous colliders (no ghost-edges between cells).
 *  • Lifts are kinematic platforms that carry the player; crates are dynamic bodies Deeba pushes with weight.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import {
  GRID_W, GRID_D, HALF_X, HALF_Z, DOOR_CLEAR, PLATFORM_TOP_PAD, WALL_TOP_PAD,
  gridToWorld, indexToWorld, liftTop, channelOf, activateWorld, doorSide,
} from './constants.js';
import { getObjectProperties, mergeCells, surfaceHeightAt } from './materials.js';
import { blendIce, horizontalRate, approachVelocity, hitSomething } from './locomotion.js';

// ── Tunables (kept in one place so the feel is easy to adjust) ───────────────────────────────────
export const PLAYER_RADIUS = 0.3;
export const PLAYER_CYL_HALF = 0.2;
export const PLAYER_CENTER = PLAYER_RADIUS + PLAYER_CYL_HALF; // centre height above the feet
export const PLAYER_HALF = PLAYER_CENTER;                      // legacy alias used by camera / playback
export const PHYSICS_STEP = 1 / 120;
export const WORLD_GRAVITY = 24.0;
export const PLAYER_JUMP_IMPULSE = 8.9;                        // initial upward speed (apex ≈ 1.65 m)
export const PLAYER_JUMP_DURATION_SECONDS = (2 * PLAYER_JUMP_IMPULSE) / WORLD_GRAVITY;
export const RUN_SPEED = 6.0;
const MAX_SUBSTEPS = 6;            // never simulate more than 50 ms of backlog per frame (prevents the hang spiral)
const FALL_LIMIT = -6;
const MAX_FALL_SPEED = 32;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.13;
const AUTOSTEP_HEIGHT = 0.32;

// Collision groups (membership << 16 | filter).  Deeba is *not* part of the rigid-body solver with crates – the
// character controller treats crates as solid and we push them ourselves – so a crate can never be squeezed
// into her (or she into it) by the solver.  Rotating bars are kinematic and shove crates, but not Deeba.
const GROUP_STATIC = 0x0001, GROUP_PLAYER = 0x0002, GROUP_CRATE = 0x0004, GROUP_BAR = 0x0008;
const PLAYER_GROUPS = (GROUP_PLAYER << 16) | GROUP_STATIC;
const CRATE_GROUPS = (GROUP_CRATE << 16) | (GROUP_STATIC | GROUP_CRATE | GROUP_BAR);
const BAR_GROUPS = (GROUP_BAR << 16) | GROUP_CRATE;
const DOOR_SPEED = 1.1;   // gate travel per second (0..1)

export class PhysicsManager {
  constructor(RAPIER) {
    this.RAPIER = RAPIER;
    this.physicsWorld = null;
    this.playerBody = null;
    this.playerCollider = null;
    this.controller = null;
    this.physicsAccumulator = 0;

    this.movingBodies = [];
    this.rotatorBodies = [];
    this.liftBodies = [];
    this.physicsVisuals = [];
    this.exitDoorBody = null;
    this.exitDoorCollider = null;
    this.doorBodies = [];
    this.doorProgress = 0;
    this.ignoredColliders = new Set();
    this.obstaclesFrozenUntil = 0;

    this.events = {};        // { jump, land(impact), bump(strength), crate() }
    this.input = { dx: 0, dz: 0, jumpHeld: false, speedMult: 1, jumpMult: 1 };
    this.jumpBuffer = 0;
    this.iceCells = new Set();
    this.simulatePlayer = true;
    this.frozenPlayer = false;
    this.p = this._blankPlayer();
  }

  _blankPlayer() {
    return {
      x: 0, y: PLAYER_CENTER, z: 0, px: 0, py: PLAYER_CENTER, pz: 0,
      vx: 0, vy: 0, vz: 0, grounded: true, groundTime: 0, coyote: 0, onIce: false, ice: 0, bumpCooldown: 0, airTime: 0,
    };
  }

  addFixedBox(x, y, z, halfX, halfY, halfZ, friction = 0.8) {
    const body = this.physicsWorld.createRigidBody(this.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    this.physicsWorld.createCollider(this.RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ).setFriction(friction).setRestitution(0), body);
    return body;
  }

  /** Request a jump; it stays valid for a short buffer window so a slightly early press still works. */
  requestJump() { this.jumpBuffer = JUMP_BUFFER; }

  setup(world, board) {
    const R = this.RAPIER;
    activateWorld(world);
    const W = GRID_W, D = GRID_D;
    if (this.physicsWorld) {
      try { if (this.controller) this.physicsWorld.removeCharacterController(this.controller); } catch { /* already gone */ }
      this.physicsWorld.free();
    }
    this.controller = null;
    this.physicsWorld = new R.World({ x: 0, y: -WORLD_GRAVITY, z: 0 });
    this.physicsWorld.timestep = PHYSICS_STEP;
    this.physicsAccumulator = 0;
    this.movingBodies = []; this.rotatorBodies = []; this.liftBodies = [];
    this.physicsVisuals = board.physicsVisuals || [];
    this.exitDoorBody = null; this.exitDoorCollider = null; this.doorBodies = []; this.doorProgress = 0; this.ignoredColliders = new Set();
    this.jumpBuffer = 0;
    this.iceCells = new Set((world.ice || []).map(([x, z]) => `${x},${z}`));

    // Lab floor slab plus a ceiling lid, so nothing can ever leave the closed room.
    this.addFixedBox(0, -0.5, 0, HALF_X + 3.5, 0.5, HALF_Z + 3.5, 0.9);
    this.addFixedBox(0, 5.1, 0, HALF_X + 3.5, 0.5, HALF_Z + 3.5, 0.2);

    // Outer fence ring (cells on the border). Invisible tall colliders; the builder draws the walls.
    // The exit gate fills a 3-cell opening in one of them (see the door block below).
    const door = world.exitDoor;
    const edgeX = W - 1, edgeZ = D - 1;
    const fence = (axis, side) => {
      const last = axis === 'z' ? edgeX : edgeZ;
      const doorHere = door && (axis === 'z' ? door[1] === (side < 0 ? 0 : edgeZ) : door[0] === (side < 0 ? 0 : edgeX));
      const segment = (from, to) => {
        if (to < from) return;
        const len = to - from + 1;
        if (axis === 'z') this.addFixedBox((from + to) / 2 - HALF_X, 3, side * HALF_Z, len / 2, 3, 0.5);
        else this.addFixedBox(side * HALF_X, 3, (from + to) / 2 - HALF_Z, 0.5, 3, len / 2);
      };
      if (!doorHere) { segment(0, last); return; }
      const index = door[axis === 'z' ? 0 : 1];
      segment(0, index - 2); segment(index + 2, last);
    };
    fence('z', -1); fence('z', 1); fence('x', -1); fence('x', 1);

    const edge = edgeX;
    const isBorder = ([x, z]) => x === 0 || z === 0 || x === edgeX || z === edgeZ;
    const isDoor = ([x, z]) => door && door[0] === x && door[1] === z;

    // Walls → merged colliders
    const walls = world.walls.filter((c) => !isBorder(c) && !isDoor(c) && getObjectProperties(world, 'wall', c).collision !== false);
    for (const r of mergeCells(walls, (c) => { const p = getObjectProperties(world, 'wall', c); return `${p.height}|${p.size}`; })) {
      const props = getObjectProperties(world, 'wall', r.cell);
      const top = props.height + WALL_TOP_PAD;
      const cx = (r.x0 + r.x1) / 2 - HALF_X, cz = (r.z0 + r.z1) / 2 - HALF_Z;
      this.addFixedBox(cx, top / 2, cz, (r.x1 - r.x0 + 1) / 2, top / 2, (r.z1 - r.z0 + 1) / 2);
    }

    // Platforms / ledges → merged colliders
    const platforms = (world.platforms || []).filter((c) => getObjectProperties(world, 'platform', c).collision !== false);
    for (const r of mergeCells(platforms, (c) => String(getObjectProperties(world, 'platform', c).height))) {
      const props = getObjectProperties(world, 'platform', r.cell);
      const top = props.height + PLATFORM_TOP_PAD;
      const cx = (r.x0 + r.x1) / 2 - HALF_X, cz = (r.z0 + r.z1) / 2 - HALF_Z;
      this.addFixedBox(cx, top / 2, cz, (r.x1 - r.x0 + 1) / 2, top / 2, (r.z1 - r.z0 + 1) / 2);
    }

    // Stairs (legacy editor piece)
    for (const cell of world.stairs || []) {
      const { x, z } = gridToWorld(cell[0], cell[1]);
      for (let step = 0; step < 4; step++) {
        const height = 0.23 * (step + 1);
        this.addFixedBox(x - 0.36 + step * 0.24, height / 2, z, 0.12, height / 2, 0.41, 0.9);
      }
    }

    // Crates: dynamic, no rotation (they slide like heavy boxes), strongly damped so they stop when released.
    for (const entry of this.physicsVisuals) {
      const { x, z } = gridToWorld(entry.cell[0], entry.cell[1]);
      const props = getObjectProperties(world, 'block', entry.cell);
      if (props.collision === false) continue;
      const half = props.size / 2, halfY = props.height / 2;
      const body = this.physicsWorld.createRigidBody(
        R.RigidBodyDesc.dynamic().setTranslation(x, surfaceHeightAt(world, entry.cell[0], entry.cell[1]) + halfY + 0.02, z).lockRotations().setCanSleep(false).setCcdEnabled(true).setLinearDamping(7.5),
      );
      this.physicsWorld.createCollider(R.ColliderDesc.cuboid(half, halfY, half).setMass(3).setFriction(0.4).setRestitution(0).setCollisionGroups(CRATE_GROUPS), body);
      entry.body = body; entry.halfY = halfY; entry.half = half;
    }

    // Lifts: kinematic platforms
    (board.liftMeshes || []).forEach((lift) => {
      const { x, z } = gridToWorld(lift.cell[0], lift.cell[1]);
      const body = this.physicsWorld.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, -0.46, z));
      this.physicsWorld.createCollider(R.ColliderDesc.cuboid(0.47, 0.5, 0.47).setFriction(0.9), body);
      this.liftBodies.push({ ...lift, body, x, z, top: 0.04, channel: channelOf(world, 'lift', lift.cell) });
    });

    // Legacy horizontal movers
    for (const mesh of board.movingMeshes || []) {
      const { x, z, index } = mesh.userData;
      const body = this.physicsWorld.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0.35, z));
      this.physicsWorld.createCollider(R.ColliderDesc.cuboid(0.44, 0.09, 0.35).setFriction(0.9), body);
      this.movingBodies.push({ mesh, body, x, z, index, cx: x });
    }

    // Rotating bars: a kinematic collider so crates are shoved (and cannot pass through).  Deeba is not blocked by
    // it (the controller ignores it) – contact with her is a knock-back in _stepRotators instead.
    (board.rotatorMeshes || []).forEach((mesh, index) => {
      const { x, z } = gridToWorld(world.rotators[index][0], world.rotators[index][1]);
      const body = this.physicsWorld.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0, z));
      const bar = this.physicsWorld.createCollider(R.ColliderDesc.cuboid(1.1, 0.12, 0.14).setTranslation(0, 0.55, 0).setCollisionGroups(BAR_GROUPS), body);
      const hub = this.physicsWorld.createCollider(R.ColliderDesc.cylinder(0.25, 0.27).setTranslation(0, 0.25, 0).setCollisionGroups(BAR_GROUPS), body);
      this.ignoredColliders.add(bar.handle); this.ignoredColliders.add(hub.handle);
      this.rotatorBodies.push({ mesh, index, x, z, angle: 0, body });
    });

    // Exit gate: two sliding panels that fill the opening, flanked by solid pillars (no gap to walk around).
    if (board.door && door) {
      const side = doorSide(door, W, D);
      const { x, z } = gridToWorld(door[0], door[1]);
      const alongX = side === 'z0' || side === 'z1';
      const box = (along, y, hAlong, hY, hThick) => ({ cx: x + (alongX ? along : 0), cz: z + (alongX ? 0 : along), hx: alongX ? hAlong : hThick, hz: alongX ? hThick : hAlong, y, hY });
      const make = (b, kinematic) => {
        const desc = kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed();
        const body = this.physicsWorld.createRigidBody(desc.setTranslation(b.cx, b.y, b.cz));
        this.physicsWorld.createCollider(R.ColliderDesc.cuboid(b.hx, b.hY, b.hz).setFriction(0.2), body);
        return body;
      };
      const pillarAt = DOOR_CLEAR / 2 + 0.15;
      for (const s of [-1, 1]) make(box(s * pillarAt, 1.7, 0.15, 1.7, 0.5), false);
      this.doorBodies = [-1, 1].map((s) => ({ s, base: { x, z }, alongX, body: make(box(s * DOOR_CLEAR / 4, 1.7, DOOR_CLEAR / 4, 1.7, 0.09), true) }));
    }

    // Player: kinematic capsule + character controller
    this.playerBody = this.physicsWorld.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PLAYER_CENTER + 0.02, 0));
    this.playerCollider = this.physicsWorld.createCollider(R.ColliderDesc.capsule(PLAYER_CYL_HALF, PLAYER_RADIUS).setFriction(0).setCollisionGroups(PLAYER_GROUPS), this.playerBody);
    this.controller = this.physicsWorld.createCharacterController(0.012);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.enableAutostep(AUTOSTEP_HEIGHT, 0.12, false);
    this.controller.enableSnapToGround(0.22);
    this.controller.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((62 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(false);

    this.placePlayer(indexToWorld(world.start[0], 'x'), 0, indexToWorld(world.start[1], 'z'));
    this.p.vx = this.p.vy = this.p.vz = 0;
    this.stepWorldOnce();
  }

  stepWorldOnce() { this.physicsWorld?.step(); }

  /** Called by the game when the room's hard guards fire (NaN / out of the room). */
  respawnAtStart(world) { this.placePlayer(indexToWorld(world.start[0], 'x'), 0, indexToWorld(world.start[1], 'z')); }

  /** Teleport Deeba (feet position) and reset her motion state. */
  placePlayer(x, feetY, z) {
    const p = this.p;
    p.x = p.px = x; p.z = p.pz = z; p.y = p.py = feetY + PLAYER_CENTER + 0.02;
    p.vx = p.vy = p.vz = 0; p.grounded = true; p.coyote = 0; p.airTime = 0; p.onIce = false; p.ice = 0;
    this.playerBody?.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.playerBody?.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
  }

  /** Pose set from outside (AI playback). Does not simulate. */
  setPlayerFeet(x, feetY, z) {
    const p = this.p;
    p.x = p.px = x; p.z = p.pz = z; p.y = p.py = feetY + PLAYER_CENTER;
    this.playerBody?.setTranslation({ x, y: p.y, z }, true);
    this.playerBody?.setNextKinematicTranslation({ x, y: p.y, z });
  }

  launch(vx, vy, vz) { const p = this.p; p.vx = vx; p.vy = vy; p.vz = vz; p.grounded = false; p.coyote = 0; }

  // ── The fixed-step player simulation ────────────────────────────────────────────────────────
  _stepPlayer(h, t, carry) {
    const p = this.p, inp = this.input, R = this.RAPIER;
    p.px = p.x; p.py = p.y; p.pz = p.z;
    const feet = p.y - PLAYER_CENTER;

    // Surface under the feet: ice only counts when standing on the ground floor.
    const gx = Math.round(p.x + HALF_X), gz = Math.round(p.z + HALF_Z);
    // A short ground timer (not the raw per-step flag) so a one-step grounded flicker cannot cancel the slide.
    p.groundTime = p.grounded ? 0.12 : Math.max(0, p.groundTime - h);
    p.onIce = p.groundTime > 0 && feet < 0.15 && this.iceCells.has(`${gx},${gz}`);
    blendIce(p, p.onIce, h);

    // Horizontal: chase the wanted velocity.  Floor is snappy, air is floaty, ice lets Deeba get going briskly
    // but skid when she turns or lets go (see locomotion.js).
    const speed = RUN_SPEED * (inp.speedMult || 1);
    const wantX = inp.dx * speed, wantZ = inp.dz * speed;
    const dl = Math.hypot(inp.dx, inp.dz);
    const has = dl > 0.05;
    const rate = horizontalRate(p, p.grounded, has, has ? inp.dx / dl : 0, has ? inp.dz / dl : 0);
    approachVelocity(p, wantX, wantZ, rate, h);

    const idleSpeed = Math.hypot(p.vx, p.vz);
    if (!has && p.grounded && p.ice < 0.5 && idleSpeed < 0.3) { p.vx = 0; p.vz = 0; } // kill numerical drift
    if (!has && p.ice >= 0.5 && idleSpeed < 0.06) { p.vx = 0; p.vz = 0; }
    p.skid = p.ice > 0.5 ? Math.max(0, idleSpeed - Math.max(0, (p.vx * inp.dx + p.vz * inp.dz)) ) : 0;

    // Vertical: coyote time, buffered jump, variable-height jump, snappier fall.
    p.coyote = p.grounded ? COYOTE_TIME : Math.max(0, p.coyote - h);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - h);
    if (this.jumpBuffer > 0 && p.coyote > 0) {
      p.vy = PLAYER_JUMP_IMPULSE * Math.sqrt(inp.jumpMult || 1);
      p.grounded = false; p.coyote = 0; this.jumpBuffer = 0;
      this.events.jump?.();
    }
    const rising = p.vy > 0;
    const g = WORLD_GRAVITY * (rising ? (inp.jumpHeld ? 1 : 2.4) : 1.3);
    p.vy = Math.max(-MAX_FALL_SPEED, p.vy - g * h);
    if (p.grounded && p.vy < 0) p.vy = -2; // keeps the controller pressed on the ground

    const fallSpeed = p.vy;
    const desired = { x: p.vx * h, y: p.vy * h + carry.dy, z: p.vz * h };
    this.controller.computeColliderMovement(this.playerCollider, desired, undefined, undefined, this._controllerFilter);
    const m = this.controller.computedMovement();
    const wasGrounded = p.grounded;
    const preSpeed = Math.hypot(p.vx, p.vz);

    p.x += m.x + carry.dx; p.y += m.y; p.z += m.z + carry.dz;
    p.grounded = this.controller.computedGrounded();

    // Update velocity from what the world actually allowed (sliding, wall hits).  Compared in velocity units
    // so a slow slide on ice is never mistaken for a collision (that used to wipe out Deeba's speed).
    const nvx = m.x / h, nvz = m.z / h;
    if (hitSomething(p, nvx, nvz)) {
      p.vx = nvx; p.vz = nvz;
      const lost = preSpeed - Math.hypot(nvx, nvz);
      if (lost > 4 && p.bumpCooldown <= 0) { this.events.bump?.(Math.min(1, lost / 9)); p.bumpCooldown = 0.25; }
    }
    if (p.vy > 0 && m.y < desired.y - 1e-4 && !p.grounded) p.vy = 0; // bonked the ceiling
    p.bumpCooldown = Math.max(0, p.bumpCooldown - h);

    // Push crates that Deeba walked into.
    for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
      const col = this.controller.computedCollision(i);
      const body = col?.collider?.parent?.();
      const entry = body && this.physicsVisuals.find((v) => v.body === body);
      if (!entry) continue;
      // Push along the dominant axis from Deeba toward the crate (robust to contact-normal conventions).
      const cp = body.translation();
      const ddx = cp.x - p.x, ddz = cp.z - p.z;
      let px = 0, pz = 0;
      if (Math.abs(ddx) > Math.abs(ddz)) px = Math.sign(ddx); else pz = Math.sign(ddz);
      const into = Math.max(0, (this.input.dx * px + this.input.dz * pz) * RUN_SPEED * (this.input.speedMult || 1));
      if (into < 0.5) continue;
      const push = Math.min(2.4, into * 0.5);
      const v = body.linvel();
      body.setLinvel({ x: px * push, y: v.y, z: pz * push }, true);
      this.events.crate?.();
    }

    this._resolveCrateOverlap();

    if (p.grounded) {
      if (!wasGrounded) {
        this.events.land?.(Math.abs(Math.min(0, fallSpeed)));
      }
      if (p.vy < 0) p.vy = 0;
      p.airTime = 0;
    } else p.airTime += h;

    // Never trust a bad number: a NaN or an escape from the room puts Deeba back on her feet at the start.
    if (!Number.isFinite(p.x + p.y + p.z) || p.y < FALL_LIMIT || Math.abs(p.x) > HALF_X + 1.2 || Math.abs(p.z) > HALF_Z + 1.2) {
      this.events.fell?.();
      return;
    }
    // Move the body *now* (not at the next world step) so the collider is never one step behind the pose.
    this.playerBody.setTranslation({ x: p.x, y: p.y, z: p.z }, false);
    this.playerBody.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
  }

  /** Predicate for the character controller: everything is solid except the rotating bars. */
  _controllerFilter = (collider) => !this.ignoredColliders.has(collider.handle);

  /**
   * Safety net: if a crate ever ends up overlapping Deeba (a bar shoved it into her, a lift lifted it, she was
   * knocked into it…), push her out along the shortest way instead of letting her sit inside the box.
   */
  _resolveCrateOverlap() {
    const p = this.p;
    const feet = p.y - PLAYER_CENTER, head = feet + 2 * PLAYER_CENTER;
    for (const entry of this.physicsVisuals) {
      if (!entry.body) continue;
      const c = entry.body.translation();
      const hx = entry.half ?? 0.39, hy = entry.halfY ?? 0.39;
      const top = c.y + hy, bottom = c.y - hy;
      if (feet >= top - 0.1 || head <= bottom + 0.05) continue;           // above (standing on it) or below it
      const dx = p.x - c.x, dz = p.z - c.z;
      const ox = Math.max(Math.abs(dx) - hx, 0), oz = Math.max(Math.abs(dz) - hx, 0);
      const dist = Math.hypot(ox, oz);
      if (dist >= PLAYER_RADIUS - 0.02) continue;
      let nx, nz, push;
      if (dist > 1e-4) { nx = Math.sign(dx) * (ox / dist); nz = Math.sign(dz) * (oz / dist); push = PLAYER_RADIUS - dist; }
      else {                                                              // centre is inside the box: leave by the nearest face
        const px = hx - Math.abs(dx), pz = hx - Math.abs(dz);
        if (px < pz) { nx = Math.sign(dx) || 1; nz = 0; push = px + PLAYER_RADIUS; } else { nx = 0; nz = Math.sign(dz) || 1; push = pz + PLAYER_RADIUS; }
      }
      p.x += nx * push; p.z += nz * push;
      const into = p.vx * nx + p.vz * nz;
      if (into < 0) { p.vx -= nx * into; p.vz -= nz * into; }
    }
  }

  _stepRotators(t, world, hit) {
    const p = this.p;
    const feet = p.y - PLAYER_CENTER;
    for (const rot of this.rotatorBodies) {
      const frozen = Date.now() < this.obstaclesFrozenUntil;
      if (!frozen) rot.angle = t * (world.rotatorSpeed || 1.1) * (rot.index % 2 ? -1 : 1);
      rot.mesh.rotation.y = rot.angle;
      rot.body?.setNextKinematicRotation({ x: 0, y: Math.sin(rot.angle / 2), z: 0, w: Math.cos(rot.angle / 2) });
      if (hit && p.bumpCooldown <= 0 && !this.frozenPlayer) {
        const dx = p.x - rot.x, dz = p.z - rot.z;
        const c = Math.cos(rot.angle), s = Math.sin(rot.angle);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) < 1.02 + PLAYER_RADIUS * 0.6 && Math.abs(lz) < 0.17 + PLAYER_RADIUS * 0.7 && feet < 0.68 && feet + 2 * PLAYER_CENTER > 0.42) {
          const sign = lz >= 0 ? 1 : -1;
          p.vx = s * sign * 7.5; p.vz = c * sign * 7.5; p.vy = 6.5; p.grounded = false; p.coyote = 0; p.bumpCooldown = 0.5;
          this.events.bump?.(1);
        }
      }
    }
  }

  /** Advance the world. ctx = { world, powered, doorsOpen, collisionHits } */
  step(dt, elapsed, world, doorsOpen, exitDoorGroup, ctx = {}) {
    if (!this.physicsWorld || !this.controller) return;
    this.physicsAccumulator = Math.min(this.physicsAccumulator + Math.min(dt, 0.05), PHYSICS_STEP * MAX_SUBSTEPS);
    const powered = !!ctx.powered;
    const channels = ctx.channels || null;
    while (this.physicsAccumulator >= PHYSICS_STEP) {
      const t = elapsed - this.physicsAccumulator + PHYSICS_STEP;
      const frozen = Date.now() < this.obstaclesFrozenUntil;
      const carry = { dx: 0, dy: 0, dz: 0 };
      const p = this.p;

      // Lifts (move first, so the carry for this step is known)
      for (const lift of this.liftBodies) {
        const next = liftTop(lift.index, lift.high, t, lift.channel ? !!channels?.has(lift.channel) : powered);
        const d = next - lift.top;
        const feet = p.y - PLAYER_CENTER;
        if (p.grounded && Math.abs(p.x - lift.x) < 0.52 && Math.abs(p.z - lift.z) < 0.52 && Math.abs(feet - lift.top) < 0.14) carry.dy += d;
        lift.top = next;
        lift.body.setNextKinematicTranslation({ x: lift.x, y: next - 0.5, z: lift.z });
        lift.mesh.userData.top = next;
      }
      for (const mover of this.movingBodies) {
        if (frozen) continue;
        const x = mover.cx + Math.sin(t * 0.8 + mover.index * 1.7) * 1.35;
        const feet = p.y - PLAYER_CENTER;
        if (p.grounded && Math.abs(p.x - mover.body.translation().x) < 0.5 && Math.abs(p.z - mover.z) < 0.4 && Math.abs(feet - 0.44) < 0.14) carry.dx += x - mover.body.translation().x;
        mover.body.setNextKinematicTranslation({ x, y: 0.35, z: mover.z });
      }
      this._stepRotators(t, world, this.simulatePlayer);

      if (this.doorBodies.length) {
        this.doorProgress = THREE.MathUtils.clamp(this.doorProgress + THREE.MathUtils.clamp((doorsOpen ? 1 : 0) - this.doorProgress, -DOOR_SPEED * PHYSICS_STEP, DOOR_SPEED * PHYSICS_STEP), 0, 1);
        const slide = DOOR_CLEAR / 4 + this.doorProgress * (DOOR_CLEAR / 2 + 0.1);
        for (const d of this.doorBodies) {
          const off = d.s * slide;
          d.body.setNextKinematicTranslation({ x: d.base.x + (d.alongX ? off : 0), y: 1.7, z: d.base.z + (d.alongX ? 0 : off) });
        }
      }

      if (this.simulatePlayer && !this.frozenPlayer) this._stepPlayer(PHYSICS_STEP, t, carry);
      try { this.physicsWorld.step(); } catch (error) { console.warn('[physics] step failed, resetting crates', error); this.physicsAccumulator = 0; break; }
      this.physicsAccumulator -= PHYSICS_STEP;
    }
  }

  /** Copy the physics pose into the shared player object and the (interpolated) pose into the mesh. */
  syncPlayerFromPhysics(player, playerMesh) {
    const p = this.p;
    const alpha = this.simulatePlayer ? Math.min(1, this.physicsAccumulator / PHYSICS_STEP) : 1;
    player.x = p.x; player.z = p.z;
    player.jumpY = p.y - PLAYER_CENTER;
    player.grounded = p.grounded;
    player.upright = true;
    player.onIce = p.onIce; player.skid = p.skid || 0; player.iceBlend = p.ice || 0;
    player.vx = p.vx; player.vy = p.vy; player.vz = p.vz;
    player.velocity = { x: p.vx, y: p.vy, z: p.vz };
    if (playerMesh) {
      playerMesh.position.set(p.px + (p.x - p.px) * alpha, p.py + (p.y - p.py) * alpha, p.pz + (p.z - p.pz) * alpha);
    }
  }

  syncVisuals(exitDoorGroup) {
    for (const entry of this.physicsVisuals) {
      if (!entry.body) continue;
      const pos = entry.body.translation();
      entry.mesh.position.set(pos.x, pos.y, pos.z);
    }
    for (const lift of this.liftBodies) lift.mesh.position.y = lift.top;
    for (const mover of this.movingBodies) {
      const pos = mover.body.translation();
      mover.mesh.position.set(pos.x, pos.y, pos.z);
    }
    exitDoorGroup?.userData?.setProgress?.(this.doorProgress);
  }
}
