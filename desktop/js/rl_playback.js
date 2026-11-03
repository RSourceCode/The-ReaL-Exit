/**
 * In-Game RL Checkpoint Playback Controller
 * Animates the 3D player in the level viewer based on actions predicted by the Python backend.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { RL_ACTION_DURATION_SECONDS, indexToWorld } from './constants.js';
import { PLAYER_HALF, PLAYER_JUMP_IMPULSE, WORLD_GRAVITY, PLAYER_JUMP_DURATION_SECONDS } from './physics.js';

const $ = (id) => document.getElementById(id);

export class RLPlaybackController {
  constructor(client, gameManager, physicsManager, cameraController, toast) {
    this.client = client;
    this.gameManager = gameManager;
    this.physicsManager = physicsManager;
    this.cameraController = cameraController;
    this.toast = toast;

    this.isActive = false;
    this.playbackState = null;
    this.isRequestPending = false;
    this.onFinished = null;
  }

  async start(levels, seed = 431, rewards = null) {
    try {
      this.toast('Initializing playback on Python backend…');
      const startRes = await this.client.startPlayback(levels, seed, rewards);
      this.isActive = true;
      this.isRequestPending = false;
      this.playbackState = {
        elapsed: 0,
        duration: RL_ACTION_DURATION_SECONDS,
        turnDuration: 0.63,
        from: null,
        to: null,
        jump: false,
        throw: false,
        visualYaw: 0,
        fromYaw: 0,
        toYaw: 0,
        currentLevelIndex: startRes.levelIndex,
      };
      this.toast('Checkpoint playback started · use camera controls to watch');
    } catch (err) {
      this.toast(`Playback failed: ${err.message}`);
      this.isActive = false;
    }
  }

  stop() {
    this.isActive = false;
    this.playbackState = null;
    this.isRequestPending = false;
  }

  async update(dt, player, playerMesh) {
    if (!this.isActive || !this.playbackState || !this.physicsManager.playerBody) return;

    const pb = this.playbackState;
    pb.elapsed += dt;

    if (!pb.from || pb.elapsed >= pb.duration) {
      if (this.isRequestPending) return;
      this.isRequestPending = true;

      try {
        const stepRes = await this.client.stepPlayback();
        this.isRequestPending = false;

        const { action, previousPosition, position, heading, levelIndex, deathCount, result } = stepRes;
        $('deathCount').textContent = deathCount;

        if (result.death) {
          pb.elapsed = 0;
          pb.from = null;
          pb.visualYaw = pb.fromYaw = pb.toYaw = 0;
          this.gameManager.loadCampaignLevel(levelIndex);
          this.toast(result.timedOut ? 'Time ran out · checkpoint restarted this level' : 'Agent died · checkpoint restarted this level');
          return;
        }

        if (result.levelChanged) {
          pb.elapsed = 0;
          pb.from = null;
          pb.visualYaw = pb.fromYaw = pb.toYaw = 0;
          this.gameManager.loadCampaignLevel(levelIndex);
          return;
        }

        if (result.done) {
          if (position) {
            this.physicsManager.playerBody.setTranslation({
              x: indexToWorld(position[0]),
              y: PLAYER_HALF + 0.05,
              z: indexToWorld(position[1]),
            }, true);
            this.physicsManager.syncPlayerFromPhysics(player, playerMesh, null);
          }
          this._finishPlayback(result);
          return;
        }

        pb.from = { x: indexToWorld(previousPosition[0]), z: indexToWorld(previousPosition[1]) };
        pb.to = { x: indexToWorld(position[0]), z: indexToWorld(position[1]) };
        pb.jump = action === 6;
        pb.throw = Boolean(result.rotatorHit);
        pb.duration = pb.jump ? PLAYER_JUMP_DURATION_SECONDS : RL_ACTION_DURATION_SECONDS;
        pb.elapsed = 0;
        pb.fromYaw = pb.visualYaw;

        const desiredYaw = (heading * Math.PI) / 2;
        const yawDelta = Math.atan2(Math.sin(desiredYaw - pb.fromYaw), Math.cos(desiredYaw - pb.fromYaw));
        pb.toYaw = pb.fromYaw + yawDelta;
      } catch (err) {
        this.isRequestPending = false;
        this.stop();
        this.toast(`Playback error: ${err.message}`);
        return;
      }
    }

    const amount = Math.min(1, pb.elapsed / pb.duration);
    const turnAmount = Math.min(1, pb.elapsed / pb.turnDuration);
    const smoothTurn = turnAmount * turnAmount * (3 - 2 * turnAmount);

    this.cameraController.cameraYaw = THREE.MathUtils.lerp(pb.fromYaw, pb.toYaw, smoothTurn);
    pb.visualYaw = this.cameraController.cameraYaw;

    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.cameraController.cameraYaw);
    this.physicsManager.playerBody.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, true);

    const jumpTime = amount * PLAYER_JUMP_DURATION_SECONDS;
    const jumpY = pb.jump
      ? PLAYER_JUMP_IMPULSE * jumpTime - 0.5 * WORLD_GRAVITY * jumpTime * jumpTime
      : pb.throw ? Math.sin(amount * Math.PI) * 0.58 : 0;
    this.physicsManager.playerBody.setTranslation({
      x: THREE.MathUtils.lerp(pb.from.x, pb.to.x, amount),
      y: PLAYER_HALF + 0.05 + jumpY,
      z: THREE.MathUtils.lerp(pb.from.z, pb.to.z, amount),
    }, true);

    this.physicsManager.playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.physicsManager.playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.physicsManager.syncPlayerFromPhysics(player, playerMesh, null);
  }

  _finishPlayback(result) {
    this.stop();
    this.gameManager.won = true;
    $('completionTitle').textContent = result.success ? 'Checkpoint run complete!' : 'Checkpoint run ended';
    $('completionMessage').textContent = result.success
      ? 'The trained policy cleared the levels successfully!'
      : 'The policy ended. Adjust rewards or continue training the checkpoint.';
    $('completionAction').textContent = 'Return to AI Lab';
    $('completionOverlay').hidden = false;

    if (this.onFinished) this.onFinished(result);
  }
}

