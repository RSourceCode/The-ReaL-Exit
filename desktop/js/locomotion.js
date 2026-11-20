/**
 * Ground / air / ice locomotion, kept free of any engine dependency so it can be unit-tested.
 *
 * Velocity chases the wanted velocity at a limited rate.  On normal floor that rate is huge (snappy), in the
 * air it is modest, and on ice it is small enough to *skid* – yet high enough that Deeba still walks off
 * briskly and can steer.  Stepping on / off ice is eased by `p.ice` (0..1) so the feel never snaps.
 */
export const GROUND_ACCEL = 62, GROUND_DECEL = 52, AIR_ACCEL = 20, AIR_DECEL = 3.5;
export const ICE_ACCEL = 12;        // pushing the way you already slide
export const ICE_STEER = 6.5;       // pushing against / across the slide (the skid)
export const ICE_FRICTION = 1.5;    // coasting: constant part …
export const ICE_DRAG = 0.32;       // … plus a part that grows with speed
export const ICE_BLEND_TIME = 0.1;  // seconds to fade between floor and ice handling

const lerp = (a, b, t) => a + (b - a) * t;

/** Ease p.ice toward 1 while standing on ice, 0 otherwise. */
export function blendIce(p, onIce, h) {
  const step = h / ICE_BLEND_TIME;
  const target = onIce ? 1 : 0;
  p.ice = Math.max(0, Math.min(1, (p.ice || 0) + Math.max(-step, Math.min(step, target - (p.ice || 0)))));
  return p.ice;
}

/** Rate (m/s²) at which velocity may change this step. */
export function horizontalRate(p, grounded, has, dirX, dirZ) {
  const speed = Math.hypot(p.vx, p.vz);
  if (!grounded) return has ? AIR_ACCEL : AIR_DECEL;
  const ice = p.ice || 0;
  const floor = has ? GROUND_ACCEL : GROUND_DECEL;
  const along = speed > 1e-4 ? (p.vx * dirX + p.vz * dirZ) / speed : 1;
  const slick = has ? lerp(ICE_STEER, ICE_ACCEL, Math.max(0, (along + 0.2) / 1.2)) : ICE_FRICTION + ICE_DRAG * speed;
  return lerp(floor, slick, ice);
}

/** Move p.vx / p.vz one step toward (wantX, wantZ). */
export function approachVelocity(p, wantX, wantZ, rate, h) {
  const ex = wantX - p.vx, ez = wantZ - p.vz, em = Math.hypot(ex, ez);
  if (em < 1e-6) return;
  const k = Math.min(1, (rate * h) / em);
  p.vx += ex * k; p.vz += ez * k;
}

/**
 * Should the character controller's result overwrite our velocity (we hit something)?
 * Compared in velocity units so slow slides are never mistaken for collisions.
 */
export function hitSomething(p, achievedVx, achievedVz) {
  const speed = Math.hypot(p.vx, p.vz);
  const lost = Math.hypot(p.vx - achievedVx, p.vz - achievedVz);
  return lost > Math.max(0.45, 0.18 * speed);
}
