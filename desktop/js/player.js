/**
 * Player Input & Character Kinematics Controller
 * Handles keyboard input, movement forces with respect to heading direction,
 * jumping impulses, and switch interaction.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';

export class PlayerController {
  constructor() {
    this.keys = new Set();
    this.wasMoving = false;
    this.moves = 0;
    this.inputBlurTimer = null;

    this.onJump = null;
    this.onInteract = null;
    this.onRestart = null;
    this.onStartMovement = null;
    this.canControl = () => true;

    this._bindEvents();
  }

  reset() {
    this.keys.clear();
    this.wasMoving = false;
    this.moves = 0;
  }

  startMovementFromKey(player, physicsManager, cameraController) {
    const playerBody = physicsManager.playerBody;
    if (!playerBody || !player.grounded || !player.upright) return;

    const forwardInput = Number(this.keys.has('w') || this.keys.has('arrowup')) - Number(this.keys.has('s') || this.keys.has('arrowdown'));
    // Swap lateral controls to match the user's left/right orientation.
    const strafe = Number(this.keys.has('a')) - Number(this.keys.has('d'));
    if (!strafe && !forwardInput) return;

    // Movement axes from the physics body's actual facing direction
    const bodyQuat = playerBody.rotation();
    const q = new THREE.Quaternion(bodyQuat.x, bodyQuat.y, bodyQuat.z, bodyQuat.w);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    let dx = forward.x * forwardInput + right.x * strafe;
    let dz = forward.z * forwardInput + right.z * strafe;
    const magnitude = Math.hypot(dx, dz) || 1;
    dx /= magnitude;
    dz /= magnitude;

    const velocity = playerBody.linvel();
    const nudge = 1 - Math.exp(-4.2 / 60);
    playerBody.setLinvel({
      x: velocity.x + (dx * 6.0 - velocity.x) * nudge,
      y: velocity.y,
      z: velocity.z + (dz * 6.0 - velocity.z) * nudge,
    }, true);
  }

  update(dt, player, physicsManager, cameraController, playerMesh) {
    if (!this.canControl() || !physicsManager.playerBody) return;

    const turn = Number(this.keys.has('arrowleft')) - Number(this.keys.has('arrowright'));
    if (turn) {
      cameraController.rotatePlayerHeading(turn * 2.5 * dt, physicsManager.playerBody, true);
    }

    if (!player.grounded || !player.upright) return;

    const forwardInput = Number(this.keys.has('w') || this.keys.has('arrowup')) - Number(this.keys.has('s') || this.keys.has('arrowdown'));
    const strafe = Number(this.keys.has('a')) - Number(this.keys.has('d'));

    // Movement axes from the physics body's actual orientation — so the robot moves
    // exactly where it is physically facing, even after an obstacle redirects it.
    const bodyQuat = physicsManager.playerBody.rotation();
    const q = new THREE.Quaternion(bodyQuat.x, bodyQuat.y, bodyQuat.z, bodyQuat.w);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    let dx = forward.x * forwardInput + right.x * strafe;
    let dz = forward.z * forwardInput + right.z * strafe;
    const length = Math.hypot(dx, dz);

    if (length > 0) {
      dx /= length;
      dz /= length;
      if (!this.wasMoving) this.moves++;
    }
    this.wasMoving = length > 0;

    const velocity = physicsManager.playerBody.linvel();
    const targetSpeed = 6.0;
    const targetX = length > 0 ? dx * targetSpeed : 0;
    const targetZ = length > 0 ? dz * targetSpeed : 0;
    const response = length > 0 ? 4.2 : 5.8;
    const blend = 1 - Math.exp(-response * dt);

    const nextX = velocity.x + (targetX - velocity.x) * blend;
    const nextZ = velocity.z + (targetZ - velocity.z) * blend;
    const nextSpeed = Math.hypot(nextX, nextZ);
    const maxSpeed = 6.6;
    const scale = nextSpeed > maxSpeed ? maxSpeed / nextSpeed : 1;

    physicsManager.playerBody.setLinvel({ x: nextX * scale, y: velocity.y, z: nextZ * scale }, true);

    const angular = physicsManager.playerBody.angvel();
    const settle = Math.exp(-dt * 9);
    physicsManager.playerBody.setAngvel({
      x: angular.x * settle,
      y: angular.y * Math.exp(-dt * 0.25),
      z: angular.z * settle,
    }, true);
  }

  _gameKey(event) {
    const physicalKeys = {
      KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
      ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', Space: ' ',
      87: 'w', 65: 'a', 83: 's', 68: 'd', 38: 'arrowup', 40: 'arrowdown', 37: 'arrowleft', 39: 'arrowright', 32: ' ',
    };
    return physicalKeys[event.code] || physicalKeys[event.keyCode] || event.key.toLowerCase();
  }

  _bindEvents() {
    window.addEventListener('keydown', (event) => {
      if (!this.canControl()) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

      const key = this._gameKey(event);
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
        event.preventDefault();
      }

      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        this.keys.add(key);
      }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown'].includes(key)) {
        if (this.onStartMovement) this.onStartMovement();
      }
      if (key === ' ' && this.onJump) {
        this.onJump();
      }
      if (key === 'e' && this.onInteract) {
        this.onInteract();
      }
      if (key === 'r' && this.onRestart) {
        this.onRestart();
      }
    }, true);

    window.addEventListener('keyup', (event) => {
      this.keys.delete(this._gameKey(event));
    }, true);

    window.addEventListener('blur', () => {
      clearTimeout(this.inputBlurTimer);
      this.inputBlurTimer = setTimeout(() => {
        if (!document.hasFocus()) this.keys.clear();
      }, 300);
    });

    window.addEventListener('focus', () => {
      clearTimeout(this.inputBlurTimer);
    });
  }
}
