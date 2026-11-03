"""Configuration constants, action definitions, and default hyperparameters.

Defines the observation space dimensions, action mappings, and default reward
structures for the The-ReaL-Exit reinforcement learning environment.
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

LOCAL_VIEW_RADIUS = 3
LOCAL_VIEW_CHANNELS = 14
LOCAL_VIEW_WIDTH = LOCAL_VIEW_RADIUS * 2 + 1
HEADING_FEATURES = 4
TRACKED_FEATURES = 8
OBSERVATION_HEADER_SIZE = HEADING_FEATURES + TRACKED_FEATURES * 3 + 12
OBSERVATION_SIZE = OBSERVATION_HEADER_SIZE + LOCAL_VIEW_WIDTH * LOCAL_VIEW_WIDTH * LOCAL_VIEW_CHANNELS
LEVEL_TIME_LIMIT_SECONDS = 8
RL_ACTION_DURATION_SECONDS = 0.32
PLAYER_JUMP_IMPULSE = 6.37
WORLD_GRAVITY = 9.81
PLAYER_JUMP_DURATION_SECONDS = 2 * PLAYER_JUMP_IMPULSE / WORLD_GRAVITY
LEVEL_TIME_LIMIT_STEPS = math.ceil(LEVEL_TIME_LIMIT_SECONDS / RL_ACTION_DURATION_SECONDS)

DEFAULT_REWARDS = {
    "timeStep": -0.01,
    "progress": 0.1,
    "coin": 5.0,
    "plate": 10.0,
    "doorOpen": 2.0,
    "goal": 100.0,
    "collision": -0.5,
    "hazard": -10.0,
    "rotatorCollision": -1.0,
    "moverCollision": -0.7,
    "platformCollision": -0.3,
    "invalidInteract": -0.1,
    "pushBlock": -0.1,
    "jumpHazard": 0.25,
    "switch": 1.0,
    "deathPenalty": -5.0,
    "speedBonus": 5.0,
}

REWARD_LABELS = {
    "timeStep": "Per action / time step",
    "progress": "Visible objective closer / farther",
    "coin": "Collect coin",
    "plate": "Press pressure plate",
    "doorOpen": "Open door",
    "goal": "Reach goal",
    "collision": "Wall collision",
    "hazard": "Hit hazard",
    "rotatorCollision": "Rotating obstacle hit",
    "moverCollision": "Moving obstacle hit",
    "platformCollision": "Raised platform hit",
    "invalidInteract": "Invalid interaction",
    "pushBlock": "Push block",
    "jumpHazard": "Jump over hazard/obstacle",
    "switch": "Toggle switch",
    "deathPenalty": "Death / level restart penalty",
    "speedBonus": "Finish level sooner",
}

MAX_TRACKED = 8
DEFAULT_PORT = 5050

