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
  GRID_SIZE, HALF_GRID, EXIT_OPENING_WIDTH, LIFT_DEFAULT_HEIGHT, PLATFORM_TOP_PAD, WALL_TOP_PAD,
  gridToWorld, indexToWorld, liftTop, channelOf,
} from './constants.js';
import { getObjectProperties, mergeCells, surfaceHeightAt } from './materials.js';

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
const FALL_LIMIT = -6, ROOM_LIMIT = HALF_GRID + 1.2;
const MAX_FALL_SPEED = 32;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.13;
const AUTOSTEP_HEIGHT = 0.32;

const GROUND_ACCEL = 62, GROUND_DECEL = 52, AIR_ACCEL = 20, AIR_DECEL = 3.5, ICE_ACCEL = 3.2, ICE_DECEL = 0.55;

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
      vx: 0, vy: 0, vz: 0, grounded: true, groundTime: 0, coyote: 0, onIce: false, bumpCooldown: 0, airTime: 0,
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
    this.exitDoorBody = null; this.exitDoorCollider = null;
    this.jumpBuffer = 0;
    this.iceCells = new Set((world.ice || []).map(([x, z]) => `${x},${z}`));

    // Lab floor slab plus a ceiling lid, so nothing can ever leave the closed room.
    this.addFixedBox(0, -0.5, 0, HALF_GRID + 3.5, 0.5, HALF_GRID + 3.5, 0.9);
    this.addFixedBox(0, 5.1, 0, HALF_GRID + 3.5, 0.5, HALF_GRID + 3.5, 0.2);

    // Outer fence ring (cells on the border). Invisible tall colliders; the builder draws the fence.
    const door = world.exitDoor;
    const edge = GRID_SIZE - 1;
    const fence = (axis, side) => {
      const doorHere = door && (axis === 'z' ? door[1] === (side < 0 ? 0 : edge) : door[0] === (side < 0 ? 0 : edge));
      const segment = (from, to) => {
        if (to < from) return;
        const len = to - from + 1, mid = (from + to) / 2 - HALF_GRID, c = side * HALF_GRID;
        if (axis === 'z') this.addFixedBox(mid, 3, c, len / 2, 3, 0.5); else this.addFixedBox(c, 3, mid, 0.5, 3, len / 2);
      };
      if (!doorHere) { segment(0, edge); return; }
      const index = door[axis === 'z' ? 0 : 1], half = Math.ceil((EXIT_OPENING_WIDTH - 1) / 2);
      segment(0, index - 1 - half); segment(index + 1 + half, edge);
    };
    fence('z', -1); fence('z', 1); fence('x', -1); fence('x', 1);

    const isBorder = ([x, z]) => x === 0 || z === 0 || x === edge || z === edge;
    const isDoor = ([x, z]) => door && door[0] === x && door[1] === z;

    // Walls → merged colliders
    const walls = world.walls.filter((c) => !isBorder(c) && !isDoor(c) && getObjectProperties(world, 'wall', c).collision !== false);
    for (const r of mergeCells(walls, (c) => { const p = getObjectProperties(world, 'wall', c); return `${p.height}|${p.size}`; })) {
      const props = getObjectProperties(world, 'wall', r.cell);
      const top = props.height + WALL_TOP_PAD;
      const cx = (r.x0 + r.x1) / 2 - HALF_GRID, cz = (r.z0 + r.z1) / 2 - HALF_GRID;
      this.addFixedBox(cx, top / 2, cz, (r.x1 - r.x0 + 1) / 2, top / 2, (r.z1 - r.z0 + 1) / 2);
    }

    // Platforms / ledges → merged colliders
    const platforms = (world.platforms || []).filter((c) => getObjectProperties(world, 'platform', c).collision !== false);
    for (const r of mergeCells(platforms, (c) => String(getObjectProperties(world, 'platform', c).height))) {
      const props = getObjectProperties(world, 'platform', r.cell);
      const top = props.height + PLATFORM_TOP_PAD;
      const cx = (r.x0 + r.x1) / 2 - HALF_GRID, cz = (r.z0 + r.z1) / 2 - HALF_GRID;
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
      this.physicsWorld.createCollider(R.ColliderDesc.cuboid(half, halfY, half).setMass(3).setFriction(0.4).setRestitution(0), body);
      entry.body = body; entry.halfY = halfY;
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

    // Rotating bars: no collider – contact is resolved as a knock-back in stepPlayer.
    (board.rotatorMeshes || []).forEach((mesh, index) => {
      const { x, z } = gridToWorld(world.rotators[index][0], world.rotators[index][1]);
      this.rotatorBodies.push({ mesh, index, x, z, angle: 0 });
    });

    // Exit door
    if (board.exitDoorMesh && door) {
      const { x, z } = gridToWorld(door[0], door[1]);
      const alongX = door[0] === 0 || door[0] === GRID_SIZE - 1;
      const rot = alongX ? { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) } : { x: 0, y: 0, z: 0, w: 1 };
      this.exitDoorBody = this.physicsWorld.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 1.3, z).setRotation(rot));
      this.exitDoorCollider = this.physicsWorld.createCollider(R.ColliderDesc.cuboid(EXIT_OPENING_WIDTH * 0.4, 1.3, 0.08), this.exitDoorBody);
    }

    // Player: kinematic capsule + character controller
    this.playerBody = this.physicsWorld.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PLAYER_CENTER + 0.02, 0));
    this.playerCollider = this.physicsWorld.createCollider(R.ColliderDesc.capsule(PLAYER_CYL_HALF, PLAYER_RADIUS).setFriction(0), this.playerBody);
    this.controller = this.physicsWorld.createCharacterController(0.012);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.enableAutostep(AUTOSTEP_HEIGHT, 0.12, false);
    this.controller.enableSnapToGround(0.22);
    this.controller.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((62 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(false);

    this.placePlayer(indexToWorld(world.start[0]), 0, indexToWorld(world.start[1]));
    this.p.vx = this.p.vy = this.p.vz = 0;
    this.stepWorldOnce();
  }

  stepWorldOnce() { this.physicsWorld?.step(); }

  /** Called by the game when the room's hard guards fire (NaN / out of the room). */
  respawnAtStart(world) { this.placePlayer(indexToWorld(world.start[0]), 0, indexToWorld(world.start[1])); }

  /** Teleport Deeba (feet position) and reset her motion state. */
  placePlayer(x, feetY, z) {
    const p = this.p;
    p.x = p.px = x; p.z = p.pz = z; p.y = p.py = feetY + PLAYER_CENTER + 0.02;
    p.vx = p.vy = p.vz = 0; p.grounded = true; p.coyote = 0; p.airTime = 0; p.onIce = false;
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
    const gx = Math.round(p.x + HALF_GRID), gz = Math.round(p.z + HALF_GRID);
    // A short ground timer (not the raw per-step flag) so a one-step grounded flicker cannot cancel the slide.
    p.groundTime = p.grounded ? 0.12 : Math.max(0, p.groundTime - h);
    p.onIce = p.groundTime > 0 && feet < 0.15 && this.iceCells.has(`${gx},${gz}`);

    // Horizontal: accelerate toward the desired velocity (different friction on ground / air / ice).
    const speed = RUN_SPEED * (inp.speedMult || 1);
    const wantX = inp.dx * speed, wantZ = inp.dz * speed;
    const has = Math.hypot(inp.dx, inp.dz) > 0.05;
    const rate = p.grounded ? (p.onIce ? (has ? ICE_ACCEL : ICE_DECEL) : (has ? GROUND_ACCEL : GROUND_DECEL)) : (has ? AIR_ACCEL : AIR_DECEL);
    const ex = wantX - p.vx, ez = wantZ - p.vz, em = Math.hypot(ex, ez);
    if (em > 1e-5) {
      const k = Math.min(1, (rate * h) / em);
      p.vx += ex * k; p.vz += ez * k;
    }

    if (!has && p.grounded && !p.onIce && Math.hypot(p.vx, p.vz) < 0.3) { p.vx = 0; p.vz = 0; } // kill numerical drift
    if (!has && p.onIce && Math.hypot(p.vx, p.vz) < 0.08) { p.vx = 0; p.vz = 0; }

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
    this.controller.computeColliderMovement(this.playerCollider, desired);
    const m = this.controller.computedMovement();
    const wasGrounded = p.grounded;
    const preSpeed = Math.hypot(p.vx, p.vz);

    p.x += m.x + carry.dx; p.y += m.y; p.z += m.z + carry.dz;
    p.grounded = this.controller.computedGrounded();

    // Update velocity from what the world actually allowed (sliding, wall hits).
    const nvx = m.x / h, nvz = m.z / h;
    if (Math.hypot(m.x - desired.x, m.z - desired.z) > 0.12 * Math.hypot(desired.x, desired.z) + 0.003) {
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

    if (p.grounded) {
      if (!wasGrounded) {
        this.events.land?.(Math.abs(Math.min(0, fallSpeed)));
      }
      if (p.vy < 0) p.vy = 0;
      p.airTime = 0;
    } else p.airTime += h;

    // Never trust a bad number: a NaN or an escape from the room puts Deeba back on her feet at the start.
    if (!Number.isFinite(p.x + p.y + p.z) || p.y < FALL_LIMIT || Math.abs(p.x) > ROOM_LIMIT || Math.abs(p.z) > ROOM_LIMIT) {
      this.events.fell?.();
      return;
    }
    // Move the body *now* (not at the next world step) so the collider is never one step behind the pose.
    this.playerBody.setTranslation({ x: p.x, y: p.y, z: p.z }, false);
    this.playerBody.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
  }

  _stepRotators(t, world, hit) {
    const p = this.p;
    const feet = p.y - PLAYER_CENTER;
    for (const rot of this.rotatorBodies) {
      const frozen = Date.now() < this.obstaclesFrozenUntil;
      if (!frozen) rot.angle = t * (world.rotatorSpeed || 1.1) * (rot.index % 2 ? -1 : 1);
      rot.mesh.rotation.y = rot.angle;
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

      if (this.exitDoorBody && world.exitDoor) {
        const cur = this.exitDoorBody.translation();
        const targetY = doorsOpen ? 3.9 : 1.3;
        const nextY = cur.y + THREE.MathUtils.clamp(targetY - cur.y, -0.03, 0.03);
        const { x, z } = gridToWorld(world.exitDoor[0], world.exitDoor[1]);
        this.exitDoorBody.setNextKinematicTranslation({ x, y: nextY, z });
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
    player.onIce = p.onIce;
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
    if (this.exitDoorBody && exitDoorGroup) exitDoorGroup.position.y = this.exitDoorBody.translation().y - 1.3;
  }
}
