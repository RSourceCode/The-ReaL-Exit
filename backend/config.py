"""Configuration constants, action definitions, observation layout and default rewards.

New in the "Deeba's Skyway" update the world has a third dimension:

* **ledges / low walls** (``platforms``) can be climbed by jumping onto them and can carry
  plates, coins and boosts on top;
* **lifts** are tiles that rise and fall periodically once the power **lever** is pulled; riding
  one is how Deeba reaches tall towers;
* **lasers** sweep along any axis on a deterministic schedule; **shocks**, **cutters** and **spikes** are timed hazards.

The observation is an *egocentric* picture of the world (rotated so "up" is always the
direction the player is facing) plus a handful of scalar "compass" features.  The most
important channels are the ``DANGER_HORIZON`` rotator-danger layers: rotating bars move
on a deterministic schedule, so the environment tells the agent which cells will be
swept by a bar during each of the next few actions.  That turns "dodge the spinner" from
an almost impossible timing puzzle into a simple reactive decision.
"""

import math

ACTIONS = [
    {"id": "forward", "label": "Move forward (W)"},
    {"id": "backward", "label": "Move backward (S)"},
    {"id": "strafeLeft", "label": "Strafe left (A)"},
    {"id": "strafeRight", "label": "Strafe right (D)"},
    {"id": "turnLeft", "label": "Turn left (←)"},
    {"id": "turnRight", "label": "Turn right (→)"},
    {"id": "jump", "label": "Jump (Space)"},
    {"id": "interact", "label": "Interact (E)"},
    {"id": "wait", "label": "Wait"},
]

# ── Observation layout ────────────────────────────────────────────────────────────────
LOCAL_VIEW_RADIUS = 4                       # 9 x 9 egocentric window
LOCAL_VIEW_WIDTH = LOCAL_VIEW_RADIUS * 2 + 1
STATIC_CHANNELS = 13                        # wall, block, hazard, mover, platform, coin, plate, door-closed, door-open, switch,
                                            # terrain-height now, terrain-height one step ahead (lifts), laser rails
DANGER_HORIZON = 4                          # rotator danger for the next 4 actions
LOCAL_VIEW_CHANNELS = STATIC_CHANNELS + DANGER_HORIZON
SCALAR_FEATURES = 19                        # compass, distance, target vector, timer, own height, lever state, ...
LOCAL_VIEW_SIZE = LOCAL_VIEW_WIDTH * LOCAL_VIEW_WIDTH * LOCAL_VIEW_CHANNELS
OBSERVATION_SIZE = LOCAL_VIEW_SIZE + SCALAR_FEATURES

# ── Timing ────────────────────────────────────────────────────────────────────────────
LEVEL_TIME_LIMIT_SECONDS = 45
RL_ACTION_DURATION_SECONDS = 0.32
PLAYER_JUMP_IMPULSE = 8.9     # take-off speed (m/s) of the 3D character controller
WORLD_GRAVITY = 24.0        # snappy platformer gravity (m/s^2) – apex = v^2 / 2g = 1.65 m
PLAYER_JUMP_DURATION_SECONDS = 2 * PLAYER_JUMP_IMPULSE / WORLD_GRAVITY
LEVEL_TIME_LIMIT_STEPS = math.ceil(LEVEL_TIME_LIMIT_SECONDS / RL_ACTION_DURATION_SECONDS)

# ── Rewards ───────────────────────────────────────────────────────────────────────────
# Design rules (see README "Training that actually works"):
#   * Everything is on a small scale (a perfect level is worth roughly +13).
#   * "progress" is *potential-based shaping* on the true shortest-path distance to the
#     current objective (plate -> exit).  Telescoping, so it never changes which policy is
#     optimal, it only tells the agent which way is "closer" on every single step.
#   * Penalties are about 1/10th of the goal so the agent is never scared to move.
#   * Dying costs more than any single mistake, but only slightly more than a whole
#     level's worth of lost shaping – we want careful, not frozen.
DEFAULT_REWARDS = {
    "timeStep": -0.03,
    "progress": 0.12,
    "coin": 1.0,
    "powerup": 1.5,
    "plate": 3.0,
    "doorOpen": 2.0,
    "goal": 10.0,
    "collision": -0.25,
    "hazard": -2.0,          # acid
    "laserHit": -2.0,
    "shockHit": -2.5,        # mistimed a strike: the harshest, it is the most predictable hazard
    "cutterHit": -2.2,
    "spikeHit": -1.5,
    "waterStep": -0.04,      # wading is harmless but slow
    "rotatorCollision": -0.75,
    "moverCollision": -0.5,
    "platformCollision": -0.3,
    "invalidInteract": -0.05,
    "pushBlock": 0.02,
    "jumpHazard": 0.5,
    "switch": 0.3,
    "climb": 0.4,
    "deathPenalty": -3.0,
    "speedBonus": 3.0,
}

REWARD_LABELS = {
    "timeStep": "Per action / time step",
    "progress": "Shortest-path progress to objective (per cell)",
    "coin": "Collect coin",
    "plate": "Press pressure plate",
    "doorOpen": "Open door",
    "goal": "Reach goal",
    "collision": "Wall collision",
    "hazard": "Fall into acid (death)",
    "laserHit": "Touch a laser beam (death)",
    "shockHit": "Get struck by an electric shock (death)",
    "cutterHit": "Touch a cutter blade (death)",
    "spikeHit": "Step on raised spikes (death)",
    "waterStep": "Wade through water (per step)",
    "rotatorCollision": "Rotating obstacle hit",
    "moverCollision": "Moving obstacle hit",
    "platformCollision": "Bump into a ledge you cannot step onto",
    "invalidInteract": "Invalid interaction",
    "pushBlock": "Push block",
    "jumpHazard": "Jump over hazard / laser / obstacle",
    "switch": "Pull the power lever (first time per level)",
    "climb": "Jump up onto a new ledge (first time per ledge)",
    "powerup": "Collect and activate a boost",
    "deathPenalty": "Death / level restart penalty",
    "speedBonus": "Finish level sooner",
}

MAX_TRACKED = 8
DEFAULT_PORT = 5050
