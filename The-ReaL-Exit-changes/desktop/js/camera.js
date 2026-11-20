/**
 * Camera controller: smooth spring-arm orbit camera.
 * Views: 'follow' (chase, default), 'iso' (raised overview that drifts with Deeba), 'top', 'first'.
 * Drag to orbit, wheel to zoom, ←/→ to rotate.  Movement is camera-relative (see player.js).
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { CAMERA_KEY, RENAMED_CAMERA_KEY } from './constants.js';

const PRESETS = {
  follow: { phi: 1.08, radius: 5.4, min: 2.5, max: 12, follow: 1 },
  iso: { phi: 0.5, radius: 17, min: 7, max: 26, follow: 0.35 },
  top: { phi: 0.16, radius: 21, min: 8, max: 30, follow: 0.2 },
  first: { phi: 1.5, radius: 0, min: 0, max: 0, follow: 1 },
};

export class CameraController {
  constructor(camera, renderer, container, scene = null) {
    this.camera = camera;
    this.renderer = renderer;
    this.container = container;
    this.scene = scene;
    this.raycaster = new THREE.Raycaster();
    this.occluders = [];

    let saved = null;
    try { saved = localStorage.getItem(CAMERA_KEY) || localStorage.getItem(RENAMED_CAMERA_KEY); } catch { /* optional */ }
    this.view = PRESETS[saved] ? saved : 'follow';

    this.theta = Math.PI;             // azimuth (camera sits at +sinθ,+cosθ of the target)
    this.phi = PRESETS[this.view].phi;
    this.radius = PRESETS[this.view].radius;
    this.pitch = 0;                   // first-person pitch
    this.focus = new THREE.Vector3();
    this.smoothPos = new THREE.Vector3();
    this.initialized = false;
    this.shakeAmount = 0;
    this.menuOrbit = false;
    this.roomScale = 1;      // bigger rooms pull the iso / top / menu cameras back (set by main.js)
    this.drag = null;
    this.pointerMoved = false;
    this.canControl = () => true;
    this.playerBody = null;
    this.cameraYaw = 0;               // kept for older call sites (= heading of the camera forward)

    this._bindEvents();
  }

  get isFirst() { return this.view === 'first'; }

  /** Horizontal unit vector the camera is looking along. */
  getForward() { return { x: -Math.sin(this.theta), z: -Math.cos(this.theta) }; }

  rotate(delta) { this.theta += delta; }
  shake(amount = 0.4) { this.shakeAmount = Math.max(this.shakeAmount, amount); }

  setView(view, playerBody = null, playerMesh = null, captureMouse = false) {
    if (!PRESETS[view]) view = 'follow';
    if (view !== 'first' && document.pointerLockElement === this.renderer.domElement) document.exitPointerLock?.();
    this.view = view;
    if (playerBody) this.playerBody = playerBody;
    try { localStorage.setItem(CAMERA_KEY, view); } catch { /* optional */ }
    const p = PRESETS[view];
    this.phi = p.phi; this.radius = (p.radius || this.radius) * (view === 'follow' ? 1 : this.roomScale);
    if (view === 'top') this.theta = Math.PI;
    if (view === 'iso') this.theta = Math.PI + 0.7;
    if (view === 'first') this.pitch = 0;
    if (captureMouse && view === 'first') {
      try { this.renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); } catch { /* needs gesture */ }
    }
    if (playerMesh) playerMesh.visible = view !== 'first';
    this.initialized = false;
  }

  update(player, playerMesh, dt = 0.016, simTime = 0) {
    const preset = PRESETS[this.view];
    const pos = playerMesh.position;
    const blend = dt > 0 && this.initialized ? 1 - Math.exp(-dt * 7) : 1;
    this.cameraYaw = Math.atan2(-Math.sin(this.theta), -Math.cos(this.theta));

    if (this.view === 'first') {
      const eye = new THREE.Vector3(pos.x, pos.y + 0.32, pos.z);
      this.camera.position.copy(eye);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(this.pitch, this.theta, 0);
      this.initialized = true;
      return;
    }

    if (this.menuOrbit) this.theta += dt * 0.18;

    const chest = new THREE.Vector3(pos.x, pos.y + 0.25, pos.z);
    const centre = new THREE.Vector3(0, 0.4, 0);
    const target = centre.clone().lerp(chest, this.menuOrbit ? 0.15 : preset.follow);
    if (this.menuOrbit) { this.phi += (0.95 - this.phi) * 0.05; this.radius += (17 * this.roomScale - this.radius) * 0.05; }
    if (!this.initialized) this.focus.copy(target); else this.focus.lerp(target, 1 - Math.exp(-dt * 5.5));

    const speed = Math.hypot(player.vx || 0, player.vz || 0);
    const radius = this.radius * (1 + Math.min(0.1, speed * 0.012));
    const sinPhi = Math.sin(this.phi);
    const desired = new THREE.Vector3(
      this.focus.x + radius * sinPhi * Math.sin(this.theta),
      this.focus.y + radius * Math.cos(this.phi),
      this.focus.z + radius * sinPhi * Math.cos(this.theta),
    );

    // Spring-arm: shorten the boom if geometry is in the way.
    if (this.occluders.length) {
      const dir = desired.clone().sub(this.focus);
      const dist = dir.length();
      this.raycaster.set(this.focus, dir.normalize());
      this.raycaster.far = dist;
      const hit = this.raycaster.intersectObjects(this.occluders, false)[0];
      if (hit && hit.distance > 0.3) desired.copy(this.focus).addScaledVector(this.raycaster.ray.direction, Math.max(1.2, hit.distance - 0.35));
    }
    desired.y = Math.max(desired.y, 0.35);

    if (!this.initialized) this.smoothPos.copy(desired); else this.smoothPos.lerp(desired, blend);
    this.camera.position.copy(this.smoothPos);

    if (this.shakeAmount > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmount;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmount;
      this.shakeAmount *= Math.exp(-dt * 7);
    }
    this.camera.rotation.order = 'XYZ';
    this.camera.lookAt(this.focus);
    this.initialized = true;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (event) => {
      el.focus();
      if (this.view === 'first') {
        if (!this.canControl()) return;
        if (document.pointerLockElement !== el) { try { el.requestPointerLock?.()?.catch?.(() => {}); } catch { /* ignore */ } }
        return;
      }
      this.drag = { x: event.clientX, y: event.clientY, theta: this.theta, phi: this.phi };
      this.pointerMoved = false;
      try { el.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', (event) => {
      if (!this.drag || this.view === 'first') return;
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 4) this.pointerMoved = true;
      if (this.pointerMoved) {
        this.theta = this.drag.theta - dx * 0.0055;
        const min = this.view === 'top' ? 0.05 : 0.25;
        this.phi = THREE.MathUtils.clamp(this.drag.phi - dy * 0.004, min, 1.5);
      }
    });
    window.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement !== el || this.view !== 'first' || !this.canControl()) return;
      this.theta -= event.movementX * 0.0028;
      this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0025, -1.2, 1.2);
    }, true);
    el.addEventListener('pointerup', () => { this.drag = null; });
    el.addEventListener('wheel', (event) => {
      event.preventDefault();
      const p = PRESETS[this.view];
      if (p.max) this.radius = THREE.MathUtils.clamp(this.radius + event.deltaY * 0.008, p.min, p.max * (this.view === 'follow' ? 1 : this.roomScale));
    }, { passive: false });
    el.addEventListener('contextmenu', (event) => event.preventDefault());
  }
}
