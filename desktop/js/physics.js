/**
 * Rapier Rigid-Body Physics System
 * Manages physical colliders, kinematics, character dynamics, and raycasts.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { GRID_SIZE, HALF_GRID, EXIT_OPENING_WIDTH, gridToWorld, indexToWorld } from './constants.js';
import { getObjectProperties } from './materials.js';

export const PLAYER_HALF = 0.37;
export const PHYSICS_STEP = 1 / 60;
export const PLAYER_JUMP_IMPULSE = 6.37;
export const WORLD_GRAVITY = 9.81;
export const PLAYER_JUMP_DURATION_SECONDS = (2 * PLAYER_JUMP_IMPULSE) / WORLD_GRAVITY;

export class PhysicsManager {
  constructor(RAPIER) {
    this.RAPIER = RAPIER;
    this.physicsWorld = null;
    this.playerBody = null;
    this.playerCollider = null;
    this.physicsAccumulator = 0;
    this.tiltNotice = false;

    this.movingBodies = [];
    this.rotatorBodies = [];
    this.physicsVisuals = [];
    this.exitDoorBody = null;
    this.exitDoorCollider = null;
  }

  addFixedBox(x, y, z, halfX, halfY, halfZ, friction = 0.86) {
    const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    const body = this.physicsWorld.createRigidBody(bodyDesc);
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
      .setFriction(friction)
      .setRestitution(0.02);
    this.physicsWorld.createCollider(colliderDesc, body);
    return body;
  }

  setup(world, visuals, movingMeshes, rotatorMeshes, exitDoorMesh, exitDoorGroup) {
    if (this.physicsWorld) {
      this.physicsWorld.free();
    }
    this.physicsWorld = new this.RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physicsWorld.timestep = PHYSICS_STEP;
    this.physicsAccumulator = 0;
    this.tiltNotice = false;

    this.movingBodies = [];
    this.rotatorBodies = [];
    this.physicsVisuals = visuals;
    this.exitDoorBody = null;
    this.exitDoorCollider = null;

    // Floor Base Collider
    this.addFixedBox(0, -0.055, 0, GRID_SIZE / 2 + 0.13, 0.065, GRID_SIZE / 2 + 0.13);

    // Inner Walls Colliders
    for (const cell of world.walls) {
      if (world.exitDoor && cell[0] === world.exitDoor[0] && cell[1] === world.exitDoor[1]) continue;
      const doorSideWall = world.exitDoor && (
        (world.exitDoor[1] === 0 && cell[1] === 0) ||
        (world.exitDoor[1] === GRID_SIZE - 1 && cell[1] === GRID_SIZE - 1) ||
        (world.exitDoor[0] === 0 && cell[0] === 0) ||
        (world.exitDoor[0] === GRID_SIZE - 1 && cell[0] === GRID_SIZE - 1)
      );
      if (doorSideWall) continue;
      const props = getObjectProperties(world, 'wall', cell);
      const { x, z } = gridToWorld(cell[0], cell[1]);
      if (props.collision !== false) {
        this.addFixedBox(x, props.height / 2, z, props.size / 2, props.height / 2 + 0.045, props.size / 2);
      }
    }

    // Outer Shell Colliders with Door Opening
    if (world.exitDoor && (world.exitDoor[0] === 0 || world.exitDoor[0] === GRID_SIZE - 1 || world.exitDoor[1] === 0 || world.exitDoor[1] === GRID_SIZE - 1)) {
      const { x, z } = gridToWorld(world.exitDoor[0], world.exitDoor[1]);
      const alongX = world.exitDoor[0] === 0 || world.exitDoor[0] === GRID_SIZE - 1;
      const side = alongX ? (world.exitDoor[0] === 0 ? -1 : 1) : (world.exitDoor[1] === 0 ? -1 : 1);
      const doorIndex = alongX ? world.exitDoor[1] : world.exitDoor[0];
      const openingOffset = (EXIT_OPENING_WIDTH - 1) / 2;
      const edge = HALF_GRID + 0.12;

      const addBoundarySegment = (from, to) => {
        if (to < from) return;
        const length = to - from + 1;
        const middle = (from + to) / 2 - HALF_GRID;
        if (alongX) this.addFixedBox(side * edge, 8.5 / 2, middle, 0.175, 8.5 / 2 + 0.045, length / 2);
        else this.addFixedBox(middle, 8.5 / 2, side * edge, length / 2, 8.5 / 2 + 0.045, 0.175);
      };

      addBoundarySegment(0, doorIndex - 1 - openingOffset);
      addBoundarySegment(doorIndex + 1 + openingOffset, GRID_SIZE - 1);
      const headerHalfWidth = EXIT_OPENING_WIDTH / 2;
      this.addFixedBox(
        x, (8.5 + 2.9) / 2, z,
        alongX ? 0.5 : headerHalfWidth, (8.5 - 2.9) / 2,
        alongX ? headerHalfWidth : 0.5
      );
    }

    // Platform Colliders
    for (const cell of world.platforms || []) {
      const props = getObjectProperties(world, 'platform', cell);
      const { x, z } = gridToWorld(cell[0], cell[1]);
      if (props.collision !== false) {
        this.addFixedBox(x, (props.height + 0.12) / 2, z, (props.size + 0.08) / 2, (props.height + 0.12) / 2, (props.size + 0.08) / 2);
      }
    }

    // Stairs Colliders
    for (const cell of world.stairs) {
      const { x, z } = gridToWorld(cell[0], cell[1]);
      for (let step = 0; step < 4; step++) {
        const height = 0.23 * (step + 1);
        this.addFixedBox(x - 0.36 + step * 0.24, height / 2, z, 0.12, height / 2, 0.41, 0.9);
      }
    }

    // Pushable Blocks Dynamics
    for (const entry of this.physicsVisuals) {
      const { x, z } = gridToWorld(entry.cell[0], entry.cell[1]);
      const props = getObjectProperties(world, 'block', entry.cell);
      if (props.collision === false) continue;
      const halfY = (props.height + 0.07) / 2;
      const body = this.physicsWorld.createRigidBody(
        this.RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, halfY, z)
          .setCanSleep(false)
          .setCcdEnabled(true)
          .setLinearDamping(0.18)
          .setAngularDamping(0.24)
      );
      const collider = this.RAPIER.ColliderDesc.cuboid((props.size + 0.02) / 2, halfY, (props.size + 0.02) / 2)
        .setMass(1.4)
        .setFriction(0.82)
        .setRestitution(0.04);
      this.physicsWorld.createCollider(collider, body);
      entry.body = body;
    }

    // Moving Obstacles Kinematics
    for (const mesh of movingMeshes) {
      const { x, z, index } = mesh.userData;
      const body = this.physicsWorld.createRigidBody(
        this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0.35, z)
      );
      this.physicsWorld.createCollider(this.RAPIER.ColliderDesc.cuboid(0.44, 0.09, 0.35).setFriction(0.9), body);
      this.movingBodies.push({ mesh, body, x, z, index });
    }

    // Rotator Bars Kinematics
    for (let index = 0; index < rotatorMeshes.length; index++) {
      const mesh = rotatorMeshes[index];
      const { x, z } = gridToWorld(world.rotators[index][0], world.rotators[index][1]);
      const body = this.physicsWorld.createRigidBody(
        this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0.55, z)
      );
      this.physicsWorld.createCollider(
        this.RAPIER.ColliderDesc.cuboid(1.04, 0.12, 0.16).setFriction(0.65).setRestitution(0.28),
        body
      );
      this.rotatorBodies.push({ mesh, body, index });
    }

    // Exit Door Kinematic Panel
    if (exitDoorMesh && world.exitDoor) {
      const { x, z } = gridToWorld(world.exitDoor[0], world.exitDoor[1]);
      const alongX = world.exitDoor[0] === 0 || world.exitDoor[0] === GRID_SIZE - 1;
      const rotation = alongX
        ? { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }
        : { x: 0, y: 0, z: 0, w: 1 };
      this.exitDoorBody = this.physicsWorld.createRigidBody(
        this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 1.3, z).setRotation(rotation)
      );
      this.exitDoorCollider = this.physicsWorld.createCollider(
        this.RAPIER.ColliderDesc.cuboid(EXIT_OPENING_WIDTH * 0.39, 1.275, 0.08).setFriction(0.86),
        this.exitDoorBody
      );
    }

    // Player Dynamic Rigid Body
    const startX = indexToWorld(world.start[0]);
    const startZ = indexToWorld(world.start[1]);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    this.playerBody = this.physicsWorld.createRigidBody(
      this.RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(startX, PLAYER_HALF + 0.05, startZ)
        .setRotation(rotation)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setLinearDamping(0.25)
        .setAngularDamping(5.2)
    );
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(PLAYER_HALF, PLAYER_HALF, PLAYER_HALF)
      .setMass(1)
      .setFriction(0.78)
      .setRestitution(0);
    this.playerCollider = this.physicsWorld.createCollider(colliderDesc, this.playerBody);
  }

  syncPlayerFromPhysics(player, playerMesh, onTiltCallback) {
    if (!this.playerBody) return;
    const position = this.playerBody.translation();
    const rotation = this.playerBody.rotation();
    player.x = position.x;
    player.z = position.z;
    player.jumpY = position.y - PLAYER_HALF;
    playerMesh.position.set(position.x, position.y, position.z);
    playerMesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    // Multi-point downward raycasting for robust ground contact detection
    const down = { x: 0, y: -1, z: 0 };
    const supportRay = (x, y, z, distance) => this.physicsWorld.castRay(
      new this.RAPIER.Ray({ x, y, z }, down), distance, true, undefined, undefined, this.playerCollider
    );
    const lowerFace = new THREE.Vector3(0, -PLAYER_HALF, 0).applyQuaternion(playerMesh.quaternion);
    let supported = !!supportRay(position.x + lowerFace.x, position.y + lowerFace.y + 0.12, position.z + lowerFace.z, 0.42);

    if (!supported) {
      const bottomCorners = [
        new THREE.Vector3(-PLAYER_HALF, -PLAYER_HALF, -PLAYER_HALF),
        new THREE.Vector3(-PLAYER_HALF, -PLAYER_HALF, PLAYER_HALF),
        new THREE.Vector3(PLAYER_HALF, -PLAYER_HALF, -PLAYER_HALF),
        new THREE.Vector3(PLAYER_HALF, -PLAYER_HALF, PLAYER_HALF),
      ];
      supported = bottomCorners.some((corner) => {
        corner.applyQuaternion(playerMesh.quaternion);
        return !!supportRay(position.x + corner.x, position.y + corner.y + 0.12, position.z + corner.z, 0.42);
      });
    }

    player.grounded = supported;
    const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
    player.upright = upY > 0.82;

    if (!player.upright && upY >= 0.5 && !this.tiltNotice) {
      this.tiltNotice = true;
      if (onTiltCallback) onTiltCallback();
    }
    if (player.upright) {
      this.tiltNotice = false;
    }
  }

  step(dt, elapsed, world, doorsOpen, exitDoorGroup, player, playerMesh, onTiltCallback) {
    this.physicsAccumulator = Math.min(this.physicsAccumulator + dt, PHYSICS_STEP * 8);

    while (this.physicsAccumulator >= PHYSICS_STEP) {
      const t = elapsed - this.physicsAccumulator + PHYSICS_STEP;

      for (const moving of this.movingBodies) {
        const x = moving.x + Math.sin(t * 0.8 + moving.index * 1.7) * 1.35;
        moving.body.setNextKinematicTranslation({ x, y: 0.35, z: moving.z });
      }

      for (const rotator of this.rotatorBodies) {
        const angle = t * (world.rotatorSpeed || 1.1) * (rotator.index % 2 ? -1 : 1);
        rotator.body.setNextKinematicRotation({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) });
        rotator.mesh.rotation.y = angle;
      }

      if (this.exitDoorBody && world.exitDoor) {
        const current = this.exitDoorBody.translation();
        const targetY = doorsOpen ? 3.7 : 1.3;
        const nextY = current.y + THREE.MathUtils.clamp(targetY - current.y, -0.075, 0.075);
        const { x, z } = gridToWorld(world.exitDoor[0], world.exitDoor[1]);
        this.exitDoorBody.setNextKinematicTranslation({ x, y: nextY, z });
      }

      this.physicsWorld.step();
      this.physicsAccumulator -= PHYSICS_STEP;
    }

    for (const entry of this.physicsVisuals) {
      if (entry.body) {
        const position = entry.body.translation();
        const rotation = entry.body.rotation();
        entry.mesh.position.set(position.x, position.y, position.z);
        entry.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      }
    }

    for (const moving of this.movingBodies) {
      const position = moving.body.translation();
      moving.mesh.position.set(position.x, position.y, position.z);
    }

    if (this.exitDoorBody && exitDoorGroup) {
      const position = this.exitDoorBody.translation();
      exitDoorGroup.position.y = position.y - 1.3;
    }

    this.syncPlayerFromPhysics(player, playerMesh, onTiltCallback);
  }
}

