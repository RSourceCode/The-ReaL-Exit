/**
 * Main Application Orchestrator
 * Bootstraps Three.js, Rapier physics, camera controls, editor, and the Python RL client.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import RAPIER from '../../node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs';

import { indexToWorld } from './constants.js';
import { buildBoard, createPlayerMesh, createCursorMesh } from './builder.js';
import { PhysicsManager, PLAYER_HALF, PLAYER_JUMP_IMPULSE } from './physics.js';
import { CameraController } from './camera.js';
import { PlayerController } from './player.js';
import { LevelEditor } from './editor.js';
import { GameManager } from './game.js';
import { UIController } from './ui.js';
import { RLClient } from './rl_client.js';
import { RLUIController } from './rl_ui.js';
import { RLPlaybackController } from './rl_playback.js';

const $ = (id) => document.getElementById(id);

export async function bootstrap() {
  await RAPIER.init();

  const container = $('world3d');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#182b3b');
  scene.fog = new THREE.Fog('#111923', 20, 38);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', '3D The-ReaL-Exit world. Drag to orbit and use WASD to move.');
  container.appendChild(renderer.domElement);

  // Lighting
  scene.add(new THREE.HemisphereLight(0xdaf4ff, 0x283343, 2.0));
  const sun = new THREE.DirectionalLight(0xffe2b3, 3.2);
  sun.position.set(-7, 13, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -9;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // Scene hierarchy groups
  const groups = {
    boardGroup: new THREE.Group(),
    objectsGroup: new THREE.Group(),
    coinsGroup: new THREE.Group(),
    decorationGroup: new THREE.Group(),
  };
  scene.add(groups.boardGroup, groups.objectsGroup, groups.coinsGroup, groups.decorationGroup);

  // Raycasting pointer
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Core managers
  const physicsManager = new PhysicsManager(RAPIER);
  const gameManager = new GameManager();
  const cameraController = new CameraController(camera, renderer, container);
  const playerController = new PlayerController();
  const editor = new LevelEditor();
  const rlClient = new RLClient();

  const playerMesh = createPlayerMesh(PLAYER_HALF);
  scene.add(playerMesh);

  const cursorMesh = createCursorMesh();
  scene.add(cursorMesh);

  let boardMeshes = null;
  const player = {
    x: indexToWorld(gameManager.world.start[0]),
    z: indexToWorld(gameManager.world.start[1]),
    jumpY: 0,
    grounded: true,
    upright: true,
  };

  function rebuildWorld() {
    boardMeshes = buildBoard(groups, gameManager.world, {
      activatedPlates: gameManager.activatedPlates,
      collected: gameManager.collected,
      switchActivated: gameManager.switchActivated,
      doorsOpen: gameManager.doorsOpen,
    });

    physicsManager.setup(
      gameManager.world,
      boardMeshes.physicsVisuals,
      boardMeshes.movingMeshes,
      boardMeshes.rotatorMeshes,
      boardMeshes.exitDoorMesh,
      boardMeshes.exitDoorGroup
    );
    // setup() replaces the Rapier world and player body on every restart/level load.
    // Keep first-person mouse turning bound to the newly created body.
    cameraController.playerBody = physicsManager.playerBody;

    const startX = indexToWorld(gameManager.world.start[0]);
    const startZ = indexToWorld(gameManager.world.start[1]);
    player.x = startX;
    player.z = startZ;
    player.jumpY = 0;
    player.grounded = true;
    player.upright = true;
    cameraController.cameraYaw = 0;

    editor.updateObjectCount(gameManager.world);
  }

  // Set up UI controller
  const ui = new UIController(gameManager, cameraController, editor, (requestedPage) => {
    if (requestedPage === 'world' || requestedPage === 'play' || requestedPage === 'build') {
      setTimeout(() => cameraController.resize(), 40);
    }
    if (requestedPage === 'ai') {
      rlUI.refreshLevels();
      requestAnimationFrame(() => rlUI.drawChart());
    }
  });

  editor.toast = (msg) => ui.toast(msg);
  editor.onWorldChanged = () => {
    rebuildWorld();
    gameManager.saveWorld(false);
  };

  // Checkpoint playback controller
  const rlPlayback = new RLPlaybackController(
    rlClient,
    gameManager,
    physicsManager,
    cameraController,
    (msg) => ui.toast(msg)
  );

  // AI Lab UI controller
  const rlUI = new RLUIController(
    rlClient,
    gameManager,
    () => {
      ui.showPage('play');
      rlPlayback.start(gameManager.campaignLevels, 431);
    },
    (msg) => ui.toast(msg)
  );
  await rlUI.init();

  // Wire level reload hooks
  gameManager.onLevelReload = () => {
    rebuildWorld();
  };

  // Wire player controls
  playerController.canControl = () => ui.activePage === 'world' && ui.mode === 'play' && !gameManager.won && !rlPlayback.isActive;
  cameraController.canControl = () => playerController.canControl();
  playerController.onStartMovement = () => {
    playerController.startMovementFromKey(player, physicsManager, cameraController);
  };
  playerController.onJump = () => {
    if (player.grounded && player.upright && physicsManager.playerBody) {
      physicsManager.playerBody.applyImpulse({ x: 0, y: PLAYER_JUMP_IMPULSE, z: 0 }, true);
      player.grounded = false;
    }
  };
  playerController.onInteract = () => {
    gameManager.interact(player, cameraController.cameraYaw, boardMeshes.switchCrystalMeshes, (m) => ui.toast(m));
  };
  playerController.onRestart = () => {
    if (rlPlayback.isActive) {
      rlPlayback.start(gameManager.campaignLevels, 431);
    } else {
      gameManager.resetRun(true, (m) => ui.toast(m));
    }
  };

  // Wire buttons
  $('restartBtn').addEventListener('click', playerController.onRestart);
  $('topResetBtn').addEventListener('click', playerController.onRestart);
  $('applyObjectProperties').addEventListener('click', () => editor.applyObjectProperties(gameManager.world));
  $('completionAction').addEventListener('click', () => {
    if (rlPlayback.isActive) {
      rlPlayback.stop();
      ui.showPage('ai');
    } else if (gameManager.world.standalone) {
      gameManager.resetRun(false);
    } else {
      gameManager.beginCampaign();
    }
  });

  // Camera selection buttons
  document.querySelectorAll('[data-camera]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cameraController.setView(btn.dataset.camera, physicsManager.playerBody, playerMesh, btn.dataset.camera === 'first');
      document.querySelectorAll('[data-camera]').forEach((b) => b.classList.toggle('active', b === btn));
      $('viewName').textContent = btn.dataset.camera.toUpperCase();
      $('defaultViewSelect').value = btn.dataset.camera;
    });
  });
  $('defaultViewSelect').addEventListener('change', (e) => {
    cameraController.setView(e.target.value, physicsManager.playerBody, playerMesh, e.target.value === 'first');
    document.querySelectorAll('[data-camera]').forEach((b) => b.classList.toggle('active', b.dataset.camera === e.target.value));
    $('viewName').textContent = e.target.value.toUpperCase();
  });

  // Pointer interactions for level editing
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (ui.mode === 'edit') {
      editor.updateCursorAt(event, raycaster, pointer, camera, boardMeshes.floorTargets, cursorMesh, true, renderer.domElement);
    }
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (ui.mode === 'edit' && !cameraController.pointerMoved) {
      editor.updateCursorAt(event, raycaster, pointer, camera, boardMeshes.floorTargets, cursorMesh, true, renderer.domElement);
      if (editor.selectedCell) {
        editor.editCell(editor.selectedCell, gameManager.world);
      }
    }
  });

  // Initial build
  rebuildWorld();
  cameraController.setView(cameraController.view, physicsManager.playerBody, playerMesh);
  gameManager.updateUI();

  // Sync camera button active states and dropdowns to the restored view
  const restoredView = cameraController.view;
  document.querySelectorAll('[data-camera]').forEach((b) => b.classList.toggle('active', b.dataset.camera === restoredView));
  $('defaultViewSelect').value = restoredView;

  // Resize handling
  const resizeObserver = new ResizeObserver(() => cameraController.resize());
  resizeObserver.observe(container);
  window.addEventListener('resize', () => cameraController.resize());

  // Main animation frame loop
  let lastFrame = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    const t = now * 0.001;

    if (ui.activePage === 'world') {
      if (rlPlayback.isActive) {
        rlPlayback.update(dt, player, playerMesh);
      } else {
        playerController.update(dt, player, physicsManager, cameraController, playerMesh);
      }

      physicsManager.step(
        dt,
        t,
        gameManager.world,
        gameManager.doorsOpen,
        boardMeshes.exitDoorGroup,
        player,
        playerMesh,
        () => ui.toast('Box tilted · movement works while lower face is supported')
      );

      gameManager.updateGameplay(
        dt,
        player,
        boardMeshes.plateMeshes,
        boardMeshes.exitDoorMesh,
        (m) => ui.toast(m),
        rlPlayback.isActive
      );

      // Visual coin bobbing
      for (let i = 0; i < boardMeshes.coinMeshes.length; i++) {
        const coin = boardMeshes.coinMeshes[i];
        coin.rotation.y = t * 1.7 + i;
        coin.position.y = 0.48 + Math.sin(t * 2.4 + i * 1.8) * 0.09;
      }

      // Visual switch bobbing
      for (let i = 0; i < boardMeshes.switchMeshes.length; i++) {
        boardMeshes.switchMeshes[i].rotation.y = t * 0.65;
        boardMeshes.switchMeshes[i].position.y = 0.65 + Math.sin(t * 1.8) * 0.045;
      }

      cameraController.update(player, playerMesh, dt);
      renderer.render(scene, camera);
    }
  }

  requestAnimationFrame(animate);
}
