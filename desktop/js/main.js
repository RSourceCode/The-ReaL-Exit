/**
 * Main application orchestrator: Three.js scene, Rapier physics, camera, game rules, audio, effects,
 * wardrobe, level editor and the Python RL client.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import RAPIER from '../../node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs';

import { indexToWorld } from './constants.js';
import { buildBoard, createCursorMesh, createEnvironment } from './builder.js';
import { createDeeba } from './character.js';
import { PhysicsManager, RUN_SPEED } from './physics.js';
import { CameraController } from './camera.js';
import { PlayerController } from './player.js';
import { LevelEditor } from './editor.js';
import { GameManager } from './game.js';
import { UIController } from './ui.js';
import { RLClient } from './rl_client.js';
import { RLUIController } from './rl_ui.js';
import { RLPlaybackController } from './rl_playback.js';
import { AudioFeedback } from './audio.js';
import { Effects } from './effects.js';
import { Wardrobe } from './outfits.js';
import { WardrobeUI } from './wardrobe_ui.js';

const $ = (id) => document.getElementById(id);

export async function bootstrap() {
  console.info('[boot] initializing Rapier physics');
  await RAPIER.init();
  console.info('[boot] Rapier physics ready');

  const container = $('world3d');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 220);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', 'Deeba\'s Skyway 3D world. Use WASD to move, Space to jump.');
  container.appendChild(renderer.domElement);

  // Lighting (colours are driven by the per-level mood in createEnvironment)
  const hemi = new THREE.HemisphereLight(0xe6f4ff, 0x6d8a63, 1.5);
  const sun = new THREE.DirectionalLight(0xfff1da, 3.1);
  sun.position.set(-8, 14, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  const rim = new THREE.DirectionalLight(0x6ab8ff, 0.8);
  rim.position.set(8, 6, -9);
  scene.add(hemi, sun, rim);
  const environment = createEnvironment(scene, { sun, hemi, rim });

  const groups = { boardGroup: new THREE.Group(), objectsGroup: new THREE.Group(), coinsGroup: new THREE.Group(), decorationGroup: new THREE.Group() };
  scene.add(groups.boardGroup, groups.objectsGroup, groups.coinsGroup, groups.decorationGroup);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Core managers
  const physicsManager = new PhysicsManager(RAPIER);
  const gameManager = new GameManager();
  const audio = new AudioFeedback();
  const wardrobe = new Wardrobe();
  const effects = new Effects(scene);
  const cameraController = new CameraController(camera, renderer, container, scene);
  const playerController = new PlayerController();
  const editor = new LevelEditor();
  scene.add(editor.handlesGroup);
  const rlClient = new RLClient();

  const playerMesh = createDeeba(wardrobe.equipped);
  scene.add(playerMesh);
  wardrobe.onChange((w) => playerMesh.userData.setOutfit(w.equipped));
  const cursorMesh = createCursorMesh();
  scene.add(cursorMesh);

  let board = null;
  const player = {
    x: 0, z: 0, jumpY: 0, grounded: true, upright: true, speedMultiplier: 1, jumpMultiplier: 1, hazardShield: false,
    onIce: false, vx: 0, vy: 0, vz: 0, velocity: { x: 0, y: 0, z: 0 },
  };
  let gameClock = 0;
  let timeScale = 1;
  let slowUntil = 0;

  gameManager.onSound = (kind) => audio.play(kind);
  gameManager.onPowerup = (action, until) => { physicsManager.obstaclesFrozenUntil = action === 'freeze' ? until : 0; };
  gameManager.onPauseDuration = (duration) => { if (physicsManager.obstaclesFrozenUntil) physicsManager.obstaclesFrozenUntil += duration; };
  gameManager.onCoin = (pos, color = '#ffd36a') => effects.sparkle(pos, color);
  gameManager.onDeath = (cause, pos) => {
    const mats = playerMesh.userData.mats;
    effects.burst(pos, [`#${mats.body.color.getHexString()}`, `#${mats.glow.color.getHexString()}`, `#${mats.trim.color.getHexString()}`]);
    if (cause === 'laser' || cause === 'shock' || cause === 'barrier') effects.zap(pos);
    playerMesh.userData.setDead(true);
    cameraController.shake(0.45);
    slowUntil = performance.now() + 650;
    physicsManager.frozenPlayer = true;
    audio.setMuffled(false);
  };
  gameManager.onRespawn = () => {
    playerMesh.userData.setDead(false);
    playerMesh.userData.reset();
  };
  gameManager.onAchievement = () => { audio.play('powerup'); ui.toast('Achievement unlocked · view your milestones'); };

  function rebuildWorld() {
    const play = gameManager.refreshPlay();
    board = buildBoard(groups, play, {
      activatedPlates: gameManager.activatedPlates,
      collected: gameManager.collected,
      powerupsCollected: gameManager.powerupsCollected,
      switchActivated: gameManager.switchActivated,
      doorsOpen: gameManager.doorsOpen,
    });
    physicsManager.setup(play, board);
    physicsManager.frozenPlayer = false;
    cameraController.playerBody = physicsManager.playerBody;
    cameraController.occluders = board.occluders;

    player.x = indexToWorld(gameManager.world.start[0]);
    player.z = indexToWorld(gameManager.world.start[1]);
    Object.assign(player, { jumpY: 0, grounded: true, upright: true, speedMultiplier: 1, jumpMultiplier: 1, hazardShield: false, onIce: false, vx: 0, vy: 0, vz: 0 });
    physicsManager.obstaclesFrozenUntil = 0;
    gameClock = 0;
    gameManager.leverActivated = false;
    playerMesh.position.set(player.x, 0.52, player.z);
    playerMesh.userData.reset();
    playerMesh.userData.snapYaw(0);
    effects.clear();
    if (ui) {
      effects.spawn({ x: player.x, y: 0.5, z: player.z }, `#${playerMesh.userData.mats.glow.color.getHexString()}`);
      audio.play('spawn');
    }
    environment.setMood(gameManager.activeLevelIndex);
    audio.setMood(gameManager.activeLevelIndex);
    // Face the exit by default: swing the camera behind Deeba.
    cameraController.theta = Math.PI;
    cameraController.initialized = false;
    editor.updateObjectCount(gameManager.world);
  }

  let ui = null;
  ui = new UIController(gameManager, cameraController, editor, (requestedPage) => {
    if (['world', 'play', 'build'].includes(requestedPage)) setTimeout(() => cameraController.resize(), 40);
    if (requestedPage === 'ai') { rlUI.refreshLevels(); requestAnimationFrame(() => rlUI.drawChart()); }
    cameraController.menuOrbit = !['play', 'build'].includes(requestedPage);
    if (!['play', 'build'].includes(requestedPage)) audio.quiet();
    audio.setMuffled(false);
  }, playerMesh, audio, wardrobe);
  const wardrobeUI = new WardrobeUI(wardrobe, gameManager, audio, (m) => ui.toast(m));
  ui.wardrobeUI = wardrobeUI;
  cameraController.menuOrbit = true;

  editor.toast = (msg) => ui.toast(msg);
  editor.onWorldChanged = () => { rebuildWorld(); gameManager.saveWorld(false); };

  const rlPlayback = new RLPlaybackController(rlClient, gameManager, physicsManager, cameraController, (msg) => ui.toast(msg), () => board);
  const rlUI = new RLUIController(rlClient, gameManager, () => { ui.showPage('play'); rlPlayback.start(gameManager.campaignLevels, 431); }, (msg) => ui.toast(msg));
  rlUI.init().catch((error) => { console.error('AI Lab initialization failed:', error); ui.toast('AI Lab is unavailable · gameplay is ready'); });

  gameManager.onLevelReload = () => rebuildWorld();

  // Controls
  const canPlay = () => ui.activePage === 'world' && ui.mode === 'play' && !gameManager.won && !gameManager.transitioning && !gameManager.dying && !rlPlayback.isActive && !ui.isPaused;
  playerController.canControl = canPlay;
  cameraController.canControl = canPlay;
  playerController.onJump = () => { audio.unlock(); physicsManager.requestJump(); };
  playerController.onStartMovement = () => audio.unlock();
  playerController.onInteract = () => gameManager.interact(player, cameraController.cameraYaw, board.switchCrystalMeshes, (m) => ui.toast(m), board.leverMeshes);
  playerController.onRestart = () => {
    if (rlPlayback.isActive) rlPlayback.start(gameManager.campaignLevels, 431);
    else gameManager.resetRun(true, (m) => ui.toast(m));
  };

  physicsManager.events = {
    jump: () => { audio.play('jump'); effects.dust({ x: player.x, y: player.jumpY, z: player.z }, 5); },
    land: (impact) => {
      if (impact < 2.5) return;
      audio.play('land', impact / 14);
      effects.dust({ x: player.x, y: player.jumpY, z: player.z }, Math.min(10, 3 + impact * 0.5));
      if (impact > 14) cameraController.shake(0.08);
    },
    bump: (strength) => { audio.play('bump', strength); cameraController.shake(0.12 * strength); },
    crate: () => audio.play('crate'),
    fell: () => { physicsManager.respawnAtStart(gameManager.world); ui.toast('Back to the start'); },
  };

  $('restartBtn').addEventListener('click', playerController.onRestart);
  $('topResetBtn').addEventListener('click', playerController.onRestart);
  $('completionAction').addEventListener('click', () => {
    if (rlPlayback.isActive) { rlPlayback.stop(); ui.showPage('ai'); }
    else if (gameManager.world.standalone) gameManager.resetRun(false);
    else gameManager.beginCampaign();
  });

  const setView = (view) => {
    cameraController.setView(view, physicsManager.playerBody, playerMesh, view === 'first');
    document.querySelectorAll('[data-camera]').forEach((b) => b.classList.toggle('active', b.dataset.camera === view));
    if ($('viewName')) $('viewName').textContent = view.toUpperCase();
    if ($('defaultViewSelect')) $('defaultViewSelect').value = view;
  };
  document.querySelectorAll('[data-camera]').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.camera)));
  $('defaultViewSelect')?.addEventListener('change', (e) => setView(e.target.value));

  // Level editor picking
  const pick = (event) => editor.updateCursorAt(event, raycaster, pointer, camera, board.floorTargets, cursorMesh, ui.mode === 'edit', renderer.domElement, gameManager.world);
  let handleDrag = false;
  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (ui.mode !== 'edit' || event.button !== 0) return;
    const handle = editor.pickHandle(raycaster, pointer, camera, renderer.domElement, event);
    if (!handle) return;
    editor.beginDrag(handle, raycaster);
    handleDrag = true; cameraController.drag = null; cameraController.pointerMoved = true;
    try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (handleDrag) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1; pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera); editor.dragMove(raycaster);
      return;
    }
    if (ui.mode === 'edit') pick(event);
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (handleDrag) { handleDrag = false; editor.endDrag(); gameManager.saveWorld(false); cameraController.drag = null; setTimeout(() => { cameraController.pointerMoved = false; }, 0); return; }
    if (ui.mode === 'edit' && !cameraController.pointerMoved) { pick(event); if (editor.selectedCell) editor.editCell(editor.selectedCell, gameManager.world); }
  });

  // Audio unlock on the first gesture; the soundtrack starts then.
  const unlockAudio = () => { audio.unlock(); audio.startMusic(gameManager.activeLevelIndex); };
  ['pointerdown', 'keydown'].forEach((evt) => window.addEventListener(evt, unlockAudio, { once: false, passive: true }));

  rebuildWorld();
  setView(cameraController.view);
  gameManager.updateUI();
  console.info('[boot] initial world built', gameManager.world.name);

  new ResizeObserver(() => cameraController.resize()).observe(container);
  window.addEventListener('resize', () => cameraController.resize());
  cameraController.resize();

  // Expose for automated testing / debugging.
  window.__deeba = { editor, camera, gameManager, physicsManager, player, playerMesh, cameraController, effects, audio, wardrobe, get board() { return board; }, ui, rlPlayback, scene, renderer };

  // ── Main loop ──────────────────────────────────────────────────────────────────────────────────
  let lastFrame = performance.now();
  let footstepClock = 0;
  const promptEl = $('interactPrompt');
  function animate(now) {
    requestAnimationFrame(animate);
    let dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    timeScale = now < slowUntil ? 0.3 : 1;
    const t = now * 0.001;
    const live = ui.activePage === 'world' && !ui.isPaused && !gameManager.transitioning;
    const simulate = live && ui.mode === 'play';
    dt *= timeScale;

    if (live) {
      physicsManager.simulatePlayer = !rlPlayback.isActive;
      if (rlPlayback.isActive) rlPlayback.update(dt, player, playerMesh);
      else playerController.update(dt, player, physicsManager, cameraController);
      if (!rlPlayback.isActive) gameClock += dt;
      const clock = rlPlayback.isActive ? rlPlayback.simTime : gameClock;

      physicsManager.step(dt, clock, gameManager.world, gameManager.doorsOpen, board.exitDoorGroup, { powered: gameManager.leverActivated, channels: gameManager.channelsOn });
      physicsManager.syncPlayerFromPhysics(player, playerMesh);
      physicsManager.syncVisuals(board.exitDoorGroup);

      const frozen = gameManager.activePowerup === 'freeze';
      board.movingLaserMeshes.forEach((l) => l.setFrozen(frozen));

      if (simulate) gameManager.updateGameplay(dt, player, board, (m) => ui.toast(m), rlPlayback.isActive, { sim: clock, crates: board.physicsVisuals });
      board.tick(t, { sim: clock, powered: gameManager.leverActivated, channelsOn: gameManager.channelsOn, doorsOpen: gameManager.doorsOpen, frozen });
    } else {
      board.tick(t, { sim: gameClock, powered: gameManager.leverActivated, channelsOn: gameManager.channelsOn, doorsOpen: gameManager.doorsOpen, frozen: false });
      physicsManager.syncVisuals(board.exitDoorGroup);
    }

    // Character animation + facing
    const speed = Math.hypot(player.vx || 0, player.vz || 0);
    const input = physicsManager.input;
    let yaw;
    if (player.yawOverride !== undefined) yaw = player.yawOverride;
    else if (speed > 0.6 && live) yaw = Math.atan2(player.vx, player.vz);
    else if (Math.hypot(input.dx, input.dz) > 0.1 && live) yaw = Math.atan2(input.dx, input.dz);
    const dead = gameManager.dying;
    if (!dead) {
      playerMesh.userData.update(dt, {
        speed01: Math.min(1, speed / RUN_SPEED), grounded: player.grounded, vy: player.vy || 0, onIce: player.onIce,
        won: gameManager.won && !rlPlayback.isActive, yaw,
      });
    }
    playerMesh.visible = !dead && cameraController.view !== 'first';

    // Sounds that follow the player
    if (live && simulate) {
      const moving = player.grounded && speed > 1;
      if (moving && !player.onIce) {
        footstepClock += dt;
        if (footstepClock >= (gameManager.activePowerup === 'speed' ? 0.2 : 0.3)) { audio.play('footstep'); footstepClock = 0; }
      } else footstepClock = 0;
      audio.setMotion(speed / RUN_SPEED, player.onIce, player.grounded);
      let nearest = 99;
      for (const l of board.movingLaserMeshes) nearest = Math.min(nearest, Math.hypot(l.holder.position.x - player.x, l.holder.position.z - player.z));
      for (const h of board.shockMeshes) nearest = Math.min(nearest, h.striking ? Math.hypot(h.pos.x - player.x, h.pos.z - player.z) : 99);
      for (const h of board.cutterMeshes) nearest = Math.min(nearest, Math.hypot(h.holder.position.x - player.x, h.holder.position.z - player.z));
      audio.setHum(nearest < 4 ? 1 - nearest / 4 : 0);
      const nearLift = (gameManager.world.lifts || []).length && gameManager.leverActivated && Math.hypot(player.x - 0, player.z - 0) < 20;
      audio.setLift(!!nearLift);
      const target = gameManager.nearestInteractable(player);
      if (promptEl) {
        promptEl.classList.toggle('show', !!target && canPlay());
        if (target) promptEl.querySelector('span').textContent = target.kind === 'levers' ? (gameManager.leverActivated ? 'Reset lever' : 'Pull lever') : 'Use crystal';
      }
    } else {
      audio.quiet();
      promptEl?.classList.remove('show');
    }
    audio.setMuffled(ui.isPaused || ui.activePage !== 'world');

    if ($('activePowerup')) $('activePowerup').textContent = gameManager.activePowerup
      ? `${gameManager.activePowerup.toUpperCase()} · ${Math.max(0, Math.ceil((gameManager.powerupUntil - Date.now()) / 1000))}s` : 'None';

    // Boost visuals on Deeba
    const mats = playerMesh.userData.mats;
    mats.glow.color.lerp(mats.glow.color, 0); // (glow colour is set by outfit)

    environment.update(t, dt);
    editor.handlesGroup.visible = ui.mode === 'edit' && !!editor.selection;
    if (editor.handlesGroup.visible) editor.tickHandles(camera, t);
    effects.update(dt, t);
    cameraController.update(player, playerMesh, dt, gameClock);
    // Keep the sun shadow centred on the island
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
  console.info('[boot] first animation frame scheduled');
}
