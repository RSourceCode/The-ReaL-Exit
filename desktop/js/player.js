/**
 * Player input: camera-relative movement like a modern 3D game.
 * W/S move away from / toward the camera, A/D strafe, Space jumps (hold for a higher jump),
 * ←/→ rotate the camera, E interacts, R restarts.
 */

const MOVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown'];
const TURN_KEYS = ['arrowleft', 'arrowright'];

export class PlayerController {
  constructor() {
    this.keys = new Set();
    this.moves = 0;
    this.wasMoving = false;
    this.inputBlurTimer = null;
    this.onJump = null;
    this.onInteract = null;
    this.onRestart = null;
    this.onStartMovement = null;
    this.canControl = () => true;
    this._bindEvents();
  }

  reset() { this.keys.clear(); this.moves = 0; this.wasMoving = false; }

  /** Write this frame's desired movement into the physics input. */
  update(dt, player, physicsManager, cameraController) {
    const input = physicsManager.input;
    if (!this.canControl()) { input.dx = 0; input.dz = 0; input.jumpHeld = false; this.wasMoving = false; return; }

    const turn = Number(this.keys.has('arrowleft')) - Number(this.keys.has('arrowright'));
    if (turn) cameraController.rotate(turn * 2.2 * dt);

    const fwdIn = Number(this.keys.has('w') || this.keys.has('arrowup')) - Number(this.keys.has('s') || this.keys.has('arrowdown'));
    const strafe = Number(this.keys.has('d')) - Number(this.keys.has('a'));
    const f = cameraController.getForward();            // horizontal, unit
    const rx = -f.z, rz = f.x;                          // right = forward × up
    let dx = f.x * fwdIn + rx * strafe;
    let dz = f.z * fwdIn + rz * strafe;
    const len = Math.hypot(dx, dz);
    if (len > 1) { dx /= len; dz /= len; }
    input.dx = dx; input.dz = dz;
    input.speedMult = player.speedMultiplier || 1;
    input.jumpMult = player.jumpMultiplier || 1;
    input.jumpHeld = this.keys.has(' ');
    if (len > 0 && !this.wasMoving) this.moves++;
    this.wasMoving = len > 0;
  }

  _gameKey(event) {
    const byCode = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyE: 'e', KeyR: 'r', ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', Space: ' ' };
    return byCode[event.code] || (event.key || '').toLowerCase();
  }

  _bindEvents() {
    window.addEventListener('keydown', (event) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      const key = this._gameKey(event);
      if (!this.canControl()) { if (key === 'r' && this.onRestart && !event.repeat) this.onRestart(); return; }
      if ([...MOVE_KEYS, ...TURN_KEYS, ' '].includes(key)) event.preventDefault();
      if ([...MOVE_KEYS, ...TURN_KEYS, ' '].includes(key)) {
        if (key === ' ' && !event.repeat) this.onJump?.();
        this.keys.add(key);
      }
      if (event.repeat) return;
      if (MOVE_KEYS.includes(key)) this.onStartMovement?.();
      if (key === 'e') this.onInteract?.();
      if (key === 'r') this.onRestart?.();
    }, true);

    window.addEventListener('keyup', (event) => { this.keys.delete(this._gameKey(event)); }, true);
    window.addEventListener('blur', () => {
      clearTimeout(this.inputBlurTimer);
      this.inputBlurTimer = setTimeout(() => { if (!document.hasFocus()) this.keys.clear(); }, 300);
    });
    window.addEventListener('focus', () => clearTimeout(this.inputBlurTimer));
  }
}
