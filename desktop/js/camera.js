/**
 * Camera Controller
 * Manages isometric, top-down, third-person chase, and first-person views.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { HALF_GRID, CAMERA_KEY, RENAMED_CAMERA_KEY } from './constants.js';
import { PLAYER_HALF } from './physics.js';

export class CameraController {
  constructor(camera, renderer, container) {
    this.camera = camera;
    this.renderer = renderer;
    this.container = container;

    this.view = localStorage.getItem(CAMERA_KEY) || localStorage.getItem(RENAMED_CAMERA_KEY) || 'follow';
    if (!['iso', 'top', 'follow', 'first'].includes(this.view)) this.view = 'iso';

    this.orbitTheta = 0.82;
    this.orbitPhi = 1.02;
    this.orbitRadius = 14.8;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
    this.cameraFocus = new THREE.Vector3();
    this.cameraInitialized = false;

    this.drag = null;
    this.pointerMoved = false;
    this.canControl = () => true;

    this._bindEvents();
  }

  setView(view, playerBody = null, playerMesh = null, captureMouse = false) {
    if (view !== 'first' && document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock?.();
    }
    this.view = view;
    if (playerBody) this.playerBody = playerBody;
    localStorage.setItem(CAMERA_KEY, view);

    // The view selector itself is a user gesture, so re-entering first person
    // can reacquire pointer lock after it was released by another view.
    if (captureMouse && view === 'first' && document.pointerLockElement !== this.renderer.domElement) {
      this.renderer.domElement.focus();
      try {
        const lockRequest = this.renderer.domElement.requestPointerLock?.();
        lockRequest?.catch?.(() => {});
      } catch {
        // The canvas click handler can request lock later if this wasn't a user gesture.
      }
    }

    if (view === 'iso') {
      this.orbitTheta = 0.82;
      this.orbitPhi = 0.68;
      this.orbitRadius = 12;
    } else if (view === 'top') {
      this.orbitTheta = 0.15;
      this.orbitPhi = 0.14;
      this.orbitRadius = 15.7;
    } else if (view === 'follow') {
      this.orbitTheta = Math.PI;
      this.orbitPhi = 1.15;
      this.orbitRadius = 3.7;
    } else if (view === 'first') {
      this.cameraPitch = 0;
    }

    if (playerMesh) {
      playerMesh.visible = view !== 'first';
    }
  }

  rotatePlayerHeading(delta, playerBody = null, rotateBody = true) {
    this.cameraYaw += delta;
    if (!playerBody || !rotateBody) return;
    const rot = playerBody.rotation();
    const bodyRotation = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const turnRotation = new THREE.Quaternion(0, Math.sin(delta / 2), 0, Math.cos(delta / 2));
    bodyRotation.premultiply(turnRotation);
    playerBody.setRotation({ x: bodyRotation.x, y: bodyRotation.y, z: bodyRotation.z, w: bodyRotation.w }, true);
  }

  update(player, playerMesh, dt = 0) {
    const blend = dt > 0 ? 1 - Math.exp(-dt * 4.5) : 1;
    const bodyRotation = playerMesh.quaternion.clone();
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyRotation);
    if (Math.hypot(facing.x, facing.z) > 1e-4) this.cameraYaw = Math.atan2(facing.x, facing.z);

    if (this.view === 'first') {
      // Use the actual rigid-body pose for both the eye point and view direction.
      // This keeps first person attached to the character while it jumps or topples.
      const eye = playerMesh.position.clone().add(
        new THREE.Vector3(0, 0.06, PLAYER_HALF * 0.72).applyQuaternion(bodyRotation)
      );
      const localLook = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(this.cameraPitch, Math.PI, 0, 'YXZ')
      );
      const eyeRotation = bodyRotation.multiply(localLook);
      this.camera.position.copy(eye);
      this.camera.quaternion.copy(eyeRotation);
      this.cameraInitialized = true;
      return;
    }

    const target = this.view === 'follow'
      ? new THREE.Vector3(player.x, player.jumpY + PLAYER_HALF, player.z)
      : new THREE.Vector3(0, 0.38, 0);

    const sinPhi = Math.sin(this.orbitPhi);
    let desiredPosition;

    if (this.view === 'follow') {
      const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(playerMesh.quaternion);
      facing.y = 0;
      if (facing.lengthSq() < 1e-4) facing.set(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw));
      else facing.normalize();

      desiredPosition = new THREE.Vector3(
        target.x - facing.x * this.orbitRadius * sinPhi,
        target.y + this.orbitRadius * Math.cos(this.orbitPhi),
        target.z - facing.z * this.orbitRadius * sinPhi
      );
    } else {
      desiredPosition = new THREE.Vector3(
        target.x + this.orbitRadius * sinPhi * Math.sin(this.orbitTheta),
        target.y + this.orbitRadius * Math.cos(this.orbitPhi),
        target.z + this.orbitRadius * sinPhi * Math.cos(this.orbitTheta)
      );
    }

    if (!this.cameraInitialized || blend === 1) {
      this.camera.position.copy(desiredPosition);
      this.cameraFocus.copy(target);
    } else {
      this.camera.position.lerp(desiredPosition, blend);
      this.cameraFocus.lerp(target, blend);
    }

    if (this.view === 'follow') {
      const wallLimit = HALF_GRID - 0.35;
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -wallLimit, wallLimit);
      this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -wallLimit, wallLimit);
    }

    this.camera.lookAt(this.cameraFocus);
    this.cameraInitialized = true;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
  }

  _bindEvents() {
    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      this.renderer.domElement.focus();
      if (this.view === 'first') {
        if (!this.canControl()) return;
        if (document.pointerLockElement !== this.renderer.domElement) {
          try {
            const lockRequest = this.renderer.domElement.requestPointerLock?.();
            lockRequest?.catch?.(() => {});
          } catch {
            // Pointer lock requires a click and may be unavailable in some builds.
          }
        }
        return;
      }
      this.drag = {
        x: event.clientX, y: event.clientY,
        theta: this.orbitTheta, phi: this.orbitPhi,
        yaw: this.cameraYaw, pitch: this.cameraPitch,
      };
      this.pointerMoved = false;
      this.renderer.domElement.setPointerCapture(event.pointerId);
    });

    this.renderer.domElement.addEventListener('pointermove', (event) => {
      if (!this.drag || this.view === 'first') return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 4) this.pointerMoved = true;
      if (this.pointerMoved) {
        this.orbitTheta = this.drag.theta - dx * 0.006;
        this.orbitPhi = THREE.MathUtils.clamp(this.drag.phi + dy * 0.005, 0.12, 1.48);
      }
    });

    // Keep the original pointer-lock mouse path; it is stable in Electron.
    window.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement !== this.renderer.domElement || this.view !== 'first' || !this.canControl()) return;
      this.rotatePlayerHeading(-event.movementX * 0.0028, this.playerBody, true);
      this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch - event.movementY * 0.0025, -1.15, 1.15);
    }, true);

    this.renderer.domElement.addEventListener('pointerup', () => {
      this.drag = null;
    });

    this.renderer.domElement.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius + event.deltaY * 0.008, 2.8, 23);
    }, { passive: false });

    this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  }
}
