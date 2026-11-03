/**
 * The-ReaL-Exit Game State & Campaign Manager
 * Tracks level progression, objectives, plate triggers, doors, deaths, and timer logic.
 */

import {
  GRID_SIZE,
  LEVEL_TIME_LIMIT_SECONDS,
  SAVE_KEY,
  gridToWorld,
  freshCampaign,
  loadCampaign,
  makeLevel,
} from './constants.js';

const $ = (id) => document.getElementById(id);

export class GameManager {
  constructor() {
    this.campaignLevels = loadCampaign();
    this.activeLevelIndex = 0;
    this.world = this.campaignLevels[this.activeLevelIndex];

    this.collected = new Set();
    this.switchActivated = false;
    this.activatedPlates = new Set();
    this.doorsOpen = false;
    this.won = false;
    this.moves = 0;
    this.runDeaths = 0;

    this.startedAt = Date.now();
    this.levelStartedAt = Date.now();
    this.elapsedSeconds = 0;

    this.onLevelReload = null;
    this.onLevelClear = null;
  }

  loadCampaignLevel(index) {
    if (index < 0 || index >= this.campaignLevels.length) return;
    this.activeLevelIndex = index;
    this.world = this.campaignLevels[index];

    this.collected.clear();
    this.switchActivated = false;
    this.activatedPlates.clear();
    this.doorsOpen = (this.world.plates || []).length === 0;
    this.won = false;
    this.moves = 0;

    $('completionOverlay').hidden = true;
    this.levelStartedAt = Date.now();
    this.elapsedSeconds = 0;

    if (this.onLevelReload) this.onLevelReload();
    this.updateUI();

    $('worldTitle').textContent = this.world.name;
    $('worldEyebrow').textContent = this.world.standalone
      ? 'STANDALONE LEVEL'
      : `CAMPAIGN · LEVEL ${index + 1} OF ${this.campaignLevels.length}`;
    $('worldDescription').textContent = 'Press the plate, dodge the rotating bar, and cross the open door.';
  }

  beginCampaign() {
    const selected = this.campaignLevels[this.activeLevelIndex];
    this.runDeaths = 0;
    this.loadCampaignLevel(selected?.standalone ? this.activeLevelIndex : 0);
  }

  addCampaignLevel() {
    const next = makeLevel(this.campaignLevels.length);
    next.name = `Level ${this.campaignLevels.length + 1}`;
    this.campaignLevels.push(next);
    this.loadCampaignLevel(this.campaignLevels.length - 1);
    this.saveWorld(false);
  }

  resetRun(showMessage = true, toast = null) {
    $('completionOverlay').hidden = true;
    this.collected.clear();
    this.switchActivated = false;
    this.activatedPlates.clear();
    this.doorsOpen = (this.world.plates || []).length === 0;
    this.won = false;
    this.moves = 0;
    this.levelStartedAt = Date.now();

    if (this.onLevelReload) this.onLevelReload();
    this.updateUI();
    if (showMessage && toast) toast('Run restarted');
  }

  winRun(toast) {
    if (this.won) return;
    this.won = true;

    if (this.world.standalone) {
      if (toast) toast('Congratulations! Level complete!');
      $('completionTitle').textContent = 'Congratulations!';
      $('completionMessage').textContent = `${this.world.name} is complete.`;
      $('completionAction').textContent = 'Play this level again';
      $('completionOverlay').hidden = false;
    } else if (this.activeLevelIndex === this.campaignLevels.length - 1) {
      if (toast) toast('All levels complete! You finished the campaign!');
      $('completionTitle').textContent = 'All levels complete!';
      $('completionMessage').textContent = `You cleared all ${this.campaignLevels.length} rooms.`;
      $('completionAction').textContent = 'Play campaign again';
      $('completionOverlay').hidden = false;
    } else {
      if (toast) toast(`Level ${this.activeLevelIndex + 1} complete · entering level ${this.activeLevelIndex + 2}`);
      this.loadCampaignLevel(this.activeLevelIndex + 1);
    }
    this.updateUI();
  }

  updateGameplay(dt, player, plateMeshes, exitDoorMesh, toast, isPlayback = false) {
    if (this.won) return;

    this.elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    this.drawElapsed();

    // Level Time Limit
    if (Date.now() - this.levelStartedAt >= LEVEL_TIME_LIMIT_SECONDS * 1000) {
      const failedLevel = this.activeLevelIndex + 1;
      this.runDeaths++;
      this.resetRun(false);
      if (toast) toast(`Time ran out · level ${failedLevel} restarted`);
      return;
    }

    // Hazard Collisions
    if (!isPlayback && this.world.hazards?.some((cell) => {
      const hazardPos = gridToWorld(cell[0], cell[1]);
      return player.jumpY < 0.35 && Math.hypot(player.x - hazardPos.x, player.z - hazardPos.z) < 0.46;
    })) {
      const failedLevel = this.activeLevelIndex + 1;
      this.runDeaths++;
      this.resetRun(false);
      if (toast) toast(`You died · level ${failedLevel} restarted`);
      return;
    }

    // Pressure Plate Triggers
    for (const plate of plateMeshes) {
      const key = `${plate.cell[0]},${plate.cell[1]}`;
      const p = gridToWorld(plate.cell[0], plate.cell[1]);
      if (player.grounded && Math.hypot(player.x - p.x, player.z - p.z) < 0.46 && !this.activatedPlates.has(key)) {
        this.activatedPlates.add(key);
        plate.active = true;
        plate.top.position.y = 0.12;
        plate.top.material.color.set('#70edb6');
        plate.top.material.emissive.set('#1d9b64');
        if (toast) toast('Pressure plate pressed');
      }
    }

    // Door Unlock Condition
    if (!this.doorsOpen && (this.world.plates || []).length > 0 && this.activatedPlates.size >= this.world.plates.length) {
      this.doorsOpen = true;
      if (exitDoorMesh) exitDoorMesh.material.color.set('#77bd91');
      if (toast) toast('All plates pressed · door opening');
      this.updateUI();
    }

    // Exit Door Crossing
    if (this.doorsOpen && this.world.exitDoor) {
      const [doorX, doorZ] = this.world.exitDoor;
      const door = gridToWorld(doorX, doorZ);
      const nearDoor = Math.hypot(player.x - door.x, player.z - door.z) < 0.8;
      const crossedOuterDoor = doorZ === GRID_SIZE - 1 ? player.z > door.z + 0.2 && Math.abs(player.x - door.x) < 0.72
        : doorZ === 0 ? player.z < door.z - 0.2 && Math.abs(player.x - door.x) < 0.72
          : doorX === GRID_SIZE - 1 ? player.x > door.x + 0.2 && Math.abs(player.z - door.z) < 0.72
            : doorX === 0 ? player.x < door.x - 0.2 && Math.abs(player.z - door.z) < 0.72 : nearDoor;

      if (crossedOuterDoor) {
        this.winRun(toast);
      }
    }
  }

  interact(player, cameraYaw, switchCrystalMeshes, toast) {
    const nearest = (this.world.switches || []).find((cell) => {
      const p = gridToWorld(cell[0], cell[1]);
      const dx = p.x - player.x, dz = p.z - player.z;
      const distance = Math.hypot(dx, dz);
      const facing = (dx * Math.sin(cameraYaw) + dz * Math.cos(cameraYaw)) / Math.max(distance, 0.001);
      return distance < 1.65 && facing > 0.62;
    });

    if (!nearest) {
      if (toast) toast('Face the signal crystal and move closer');
      return;
    }

    this.switchActivated = !this.switchActivated;
    for (const crystal of switchCrystalMeshes) {
      crystal.material.color.set(this.switchActivated ? '#75f0ce' : '#8b91ff');
      crystal.material.emissive.set(this.switchActivated ? '#39dba6' : '#4b43c7');
      crystal.material.emissiveIntensity = this.switchActivated ? 1.5 : 0.9;
    }
    this.updateUI();
    if (toast) toast(this.switchActivated ? 'Signal crystal activated' : 'Signal crystal deactivated');
  }

  drawElapsed() {
    const remaining = Math.max(0, Math.ceil(LEVEL_TIME_LIMIT_SECONDS - (Date.now() - this.levelStartedAt) / 1000));
    $('timer').textContent = `00:${String(remaining).padStart(2, '0')}`;
  }

  updateUI() {
    const plateCount = this.activatedPlates.size;
    const totalPlates = (this.world.plates || []).length;
    $('coinCount').textContent = `LEVEL ${this.activeLevelIndex + 1} / ${this.campaignLevels.length}`;
    $('homeSparks').textContent = `${this.activeLevelIndex + 1} / ${this.campaignLevels.length}`;
    $('coinProgress').textContent = `${this.collected.size} / ${(this.world.coins || []).length}`;
    $('moves').textContent = this.moves;
    $('deathCount').textContent = this.runDeaths;

    $('checkPlate').textContent = plateCount === totalPlates && totalPlates ? '✓' : '·';
    $('checkPlate').style.color = plateCount === totalPlates && totalPlates ? 'var(--mint)' : '';
    $('checkDoor').textContent = this.doorsOpen ? '✓' : '·';
    $('checkDoor').style.color = this.doorsOpen ? 'var(--mint)' : '';
    $('checkExit').textContent = this.won ? '✓' : '·';
    $('checkExit').style.color = this.won ? 'var(--mint)' : '';

    $('progressBar').style.width = `${totalPlates ? (plateCount / totalPlates) * 100 : 0}%`;
    $('progressText').textContent = this.doorsOpen ? 'Door open · cross to continue' : `Pressure plates: ${plateCount} of ${totalPlates}`;
    $('activeLevelName').textContent = this.world.name;

    this.drawElapsed();
    this.refreshLevelNavigation();
  }

  refreshLevelNavigation() {
    const host = $('levelList');
    if (!host) return;
    host.innerHTML = '';
    this.campaignLevels.forEach((level, index) => {
      const button = document.createElement('button');
      button.className = `level-select${index === this.activeLevelIndex ? ' active' : ''}`;
      button.textContent = `${String(index + 1).padStart(2, '0')}  ${level.name}`;
      button.addEventListener('click', () => this.loadCampaignLevel(index));
      host.append(button);
    });
    $('levelCount').textContent = `${this.campaignLevels.length} ${this.campaignLevels.length === 1 ? 'LEVEL' : 'LEVELS'}`;
    $('panelLevelCount').textContent = `${String(this.activeLevelIndex + 1).padStart(2, '0')} / ${String(this.campaignLevels.length).padStart(2, '0')}`;

    const standaloneToggle = $('standaloneLevel');
    if (standaloneToggle) standaloneToggle.checked = !!this.world.standalone;
    const speedControl = $('rotatorSpeed');
    if (speedControl) speedControl.value = this.world.rotatorSpeed || 1.1;
  }

  saveWorld(showMessage = true, toast = null) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ version: 1, levels: this.campaignLevels }));
      if (showMessage && toast) toast('Levels saved on this computer');
    } catch {
      if (toast) toast('Could not save this world');
    }
  }

  exportWorld() {
    const blob = new Blob([JSON.stringify(this.world, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'the-first-forge.world.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  restoreStarterWorld(toast = null) {
    this.campaignLevels = freshCampaign();
    this.loadCampaignLevel(0);
    this.saveWorld(false);
    if (toast) toast('Four-level campaign restored');
  }
}

