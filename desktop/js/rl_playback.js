/**
 * In-Game RL Checkpoint Playback Controller
 * Animates the 3D player in the level viewer based on actions predicted by the Python backend.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { RL_ACTION_DURATION_SECONDS, HALF_GRID, indexToWorld } from './constants.js';
import { PLAYER_JUMP_IMPULSE, WORLD_GRAVITY, PLAYER_JUMP_DURATION_SECONDS } from './physics.js';

const $ = (id) => document.getElementById(id);

export class RLPlaybackController {
  constructor(client, gameManager, physicsManager, cameraController, toast, getBoardMeshes = () => null) {
    this.client = client;
    this.gameManager = gameManager;
    this.physicsManager = physicsManager;
    this.cameraController = cameraController;
    this.toast = toast;
    this.getBoardMeshes = getBoardMeshes;

    this.isActive = false;
    this.playbackState = null;
    this.isRequestPending = false;
    this.onFinished = null;
    // Simulated clock (seconds) that drives the rotating bars. The Python environment is the
    // source of truth for bar angles, so the 3D scene follows its clock instead of the wall
    // clock – otherwise the agent would dodge bars that are not where the picture shows them.
    this.simTime = 0;
  }

  async start(levels, seed = 431, rewards = null) {
    try {
      this.toast('Initializing playback on Python backend…');
      const startRes = await this.client.startPlayback(levels, seed, rewards);
      this.isActive = true;
      this.isRequestPending = false;
      this.simTime = startRes.simTime ?? 0;
      this.playbackState = {
        simFrom: this.simTime,
        simTo: this.simTime,
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
    if (window.__deeba?.player) delete window.__deeba.player.yawOverride;
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
        this.gameManager.activePowerup = result.powerupType || null;
        this.gameManager.powerupUntil = Date.now() + (result.powerupRemaining || 0) * 1000;
        this.gameManager.leverActivated = Boolean(result.leverOn);
        this.gameManager.channelsOn = new Set(result.channelsOn || []);
        this.physicsManager.obstaclesFrozenUntil = result.powerupType === 'freeze'
          ? Date.now() + (result.powerupRemaining || 0) * 1000 : 0;
        const boardMeshes = this.getBoardMeshes();
        if (Array.isArray(result.blocks) && boardMeshes?.physicsVisuals) {
          result.blocks.forEach((cell, index) => {
            const entry = boardMeshes.physicsVisuals[index];
            if (!entry?.body) return;
            const halfY = entry.body.translation().y;
            entry.body.setTranslation({ x: cell[0] - HALF_GRID, y: halfY, z: cell[1] - HALF_GRID }, true);
            entry.body.setNextKinematicTranslation?.({ x: cell[0] - HALF_GRID, y: halfY, z: cell[1] - HALF_GRID });
            entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            entry.mesh.position.set(cell[0] - HALF_GRID, halfY, cell[1] - HALF_GRID);
          });
        }
        if (boardMeshes?.leverMeshes) {
          for (const lever of boardMeshes.leverMeshes) {
            const ch = lever.userData.channel || 0;
            const on = ch ? (result.channelsOn || []).includes(ch) : Boolean(result.leverOn);
            lever.userData.activated = on;
            lever.userData.pivot.rotation.z = on ? -0.78 : 0.78;
            lever.userData.pivot.children[1]?.material?.color?.set(on ? '#ffffff' : lever.userData.color || '#ff9d60');
          }
        }
        $('deathCount').textContent = deathCount;
        pb.simFrom = stepRes.simTimeBefore ?? this.simTime;
        pb.simTo = stepRes.simTimeAfter ?? pb.simFrom;
        this.simTime = pb.simTo;

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
            this.physicsManager.setPlayerFeet(indexToWorld(position[0]), result.elevation ?? 0, indexToWorld(position[1]));
            this.physicsManager.syncPlayerFromPhysics(player, playerMesh);
          }
          this._finishPlayback(result);
          return;
        }

        pb.fromElev = result.elevationBefore ?? 0;
        pb.toElev = result.elevation ?? 0;
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
    this.simTime = THREE.MathUtils.lerp(pb.simFrom, pb.simTo, amount);
    const turnAmount = Math.min(1, pb.elapsed / pb.turnDuration);
    const smoothTurn = turnAmount * turnAmount * (3 - 2 * turnAmount);

    const yaw = THREE.MathUtils.lerp(pb.fromYaw, pb.toYaw, smoothTurn);
    pb.visualYaw = yaw;
    player.yawOverride = yaw;
    // Chase camera drifts behind the agent's heading.
    const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
    this.cameraController.theta += wrap(yaw + Math.PI - this.cameraController.theta) * Math.min(1, dt * 2.5);

    const jumpTime = amount * PLAYER_JUMP_DURATION_SECONDS;
    const arc = pb.jump
      ? Math.max(0, PLAYER_JUMP_IMPULSE * jumpTime - 0.5 * WORLD_GRAVITY * jumpTime * jumpTime)
      : pb.throw ? Math.sin(amount * Math.PI) * 0.58 : 0;
    const elev = THREE.MathUtils.lerp(pb.fromElev ?? 0, pb.toElev ?? 0, pb.jump ? Math.min(1, amount * 1.6) : amount);
    this.physicsManager.setPlayerFeet(
      THREE.MathUtils.lerp(pb.from.x, pb.to.x, amount),
      elev + arc,
      THREE.MathUtils.lerp(pb.from.z, pb.to.z, amount),
    );
    this.physicsManager.syncPlayerFromPhysics(player, playerMesh);
    player.grounded = arc < 0.02;
    player.vy = pb.jump ? PLAYER_JUMP_IMPULSE - WORLD_GRAVITY * jumpTime : 0;
    player.vx = (pb.to.x - pb.from.x) / pb.duration; player.vz = (pb.to.z - pb.from.z) / pb.duration;
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

