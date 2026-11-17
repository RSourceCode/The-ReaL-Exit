/**
 * The-ReaL-Exit Game State & Campaign Manager
 * Tracks level progression, objectives, plate triggers, doors, deaths, and timer logic.
 */

import { surfaceHeightAt } from './materials.js';
import {
  GRID_SIZE,
  HALF_GRID,
  LEVEL_TIME_LIMIT_SECONDS,
  SAVE_KEY,
  gridToWorld,
  freshCampaign,
  loadCampaign,
  makeLevel,
  LIST_FIELDS,
  lethalHazard,
  channelOf,
  expandLevel,
  migrateLevel,
} from './constants.js';

const $ = (id) => document.getElementById(id);
const BEST_KEY = 'the-real-exit-best-v1';
const WALLET_KEY = 'the-real-exit-wallet-v1';
const COINS_TOTAL_KEY = 'the-real-exit-lifetime-coins-v1';
const ACHIEVEMENT_KEY = 'the-real-exit-achievements-v1';

function readBest() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY) || '{}') || {}; } catch { return {}; }
}
function writeBest(best) {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch { /* storage unavailable */ }
}
function readNumber(key) { try { return Math.max(0, Number(localStorage.getItem(key)) || 0); } catch { return 0; } }
function readSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); } }

export class GameManager {
  constructor() {
    this.campaignLevels = loadCampaign();
    this.activeLevelIndex = 0;
    this.world = this.campaignLevels[this.activeLevelIndex];

    this.collected = new Set();
    this.powerupsCollected = new Set();
    this.wallet = readNumber(WALLET_KEY);
    this.achievements = readSet(ACHIEVEMENT_KEY);
    this.activePowerup = null;
    this.powerupUntil = 0;
    this.leverActivated = false;
    this.leverStates = new Map();
    this.channelsOn = new Set();
    this.onPowerup = null;
    this.onSound = null;
    this.onDeath = null;       // (cause, position) -> visual burst
    this.onRespawn = null;
    this.onCoin = null;        // (position)
    this.onPlate = null;
    this.onLever = null;
    this.dying = false;
    this.playerPos = { x: 0, y: 0, z: 0 };
    this.onAchievement = null;
    this.switchActivated = false;
    this.activatedPlates = new Set();
    this.doorsOpen = false;
    this.won = false;
    this.transitioning = false;
    this.transitionTimers = [];
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
    this.dying = false;
    clearTimeout(this._deathTimer);
    this.activeLevelIndex = index;
    this.world = this.campaignLevels[index];

    this.collected.clear();
    this.powerupsCollected.clear();
    this.activePowerup = null;
    this.powerupUntil = 0;
    this.leverActivated = false;
    this.leverStates = new Map();
    this.channelsOn = new Set();
    this.switchActivated = false;
    this.activatedPlates.clear();
    this.doorsOpen = this._doorPlates().length === 0;
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
    $('worldDescription').textContent = this.world.hint || 'Press the plates, grab coins, and reach the exit gate.';
    if ($('hudHint')) { $('hudHint').textContent = this.world.hint || ''; $('hudHint').classList.add('show'); clearTimeout(this._hintTimer); this._hintTimer = setTimeout(() => $('hudHint')?.classList.remove('show'), 7000); }
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

  /** The level with every resized object expanded to the cells it covers (what physics, rendering and hazards use). */
  refreshPlay() { this._play = expandLevel(this.world); return this._play; }
  get play() { return this._play || this.refreshPlay(); }

  generateChallengeLevel() {
    const level = makeLevel(this.campaignLevels.length);
    const variant = this.campaignLevels.length % 4;
    level.name = `Experimental Chamber ${this.campaignLevels.length - 7}`;
    level.walls = level.walls.filter(([x, z]) => x === 0 || z === 0 || x === GRID_SIZE - 1 || z === GRID_SIZE - 1);
    level.blocks = [[variant % 2 ? 7 : 5, 5]];
    level.hazards = [[4, 7], [5, 7], [7, 7], [8, 7]];
    level.coins = [[2, 3], [10, 3], [6, 8], [3, 10], [9, 10]];
    level.plates = [[6, 4]];
    level.continuousPlates = [];
    level.rotators = [[6, 9]];
    level.rotatorSpeed = 1.1 + variant * 0.3;
    level.shocks = variant % 2 ? [[6, 10, 'down', 3, 3, 3]] : [[5, 9, 'down', 3, 3, 3], [7, 10, 'down', 3, 3.5, 3]];
    level.cutters = variant % 2 ? [[6, 8, 'x', 3, 0.5, 1]] : [];
    level.spikes = [[3, 9, 0], [9, 9, 3]];
    level.water = [[2, 6], [3, 6], [9, 6], [10, 6]];
    level.ice = [[4, 10], [8, 10]];
    level.powerups = [[2, 4, ['speed', 'jump', 'freeze', 'shield'][variant]]];
    level.levers = [[2, 2]];
    level.lasers = [[6, 10, 'z', 1, 5, 'x', 0.5, 1]];
    const shift = (list) => (list || []).map((c) => [c[0] + 2, c[1] + 4, ...c.slice(2)]);
    for (const k of ['blocks', 'hazards', 'coins', 'plates', 'rotators', 'shocks', 'cutters', 'spikes', 'water', 'ice', 'powerups', 'levers', 'lasers']) level[k] = shift(level[k]);
    level.start = [HALF_GRID, 2];
    level.standalone = true;
    this.campaignLevels.push(level);
    this.loadCampaignLevel(this.campaignLevels.length - 1);
    this.saveWorld(false);
    return level;
  }

  resetRun(showMessage = true, toast = null) {
    this.dying = false;
    clearTimeout(this._deathTimer);
    this.transitionTimers.forEach(clearTimeout);
    this.transitionTimers = [];
    this.transitioning = false;
    $('transitionOverlay').hidden = true;
    $('completionOverlay').hidden = true;
    this.collected.clear();
    this.powerupsCollected.clear();
    this.activePowerup = null;
    this.powerupUntil = 0;
    this.leverActivated = false;
    this.leverStates = new Map();
    this.channelsOn = new Set();
    this.switchActivated = false;
    this.activatedPlates.clear();
    this.doorsOpen = this._doorPlates().length === 0;
    this.won = false;
    this.moves = 0;
    this.levelStartedAt = Date.now();

    if (this.onLevelReload) this.onLevelReload();
    this.updateUI();
    if (showMessage && toast) toast('Run restarted');
  }

  timeLimit() { return this.world.timeLimit || LEVEL_TIME_LIMIT_SECONDS; }

  /** Stars: 1 = cleared, 2 = every coin OR a fast run, 3 = both. */
  rateRun(seconds) {
    const coins = (this.world.coins || []).length;
    const allCoins = coins === 0 || this.collected.size >= coins;
    const fast = seconds <= this.timeLimit() * 0.6;
    return 1 + Number(allCoins && coins > 0) + Number(fast);
  }

  spendCoins(cost) {
    if (this.wallet < cost) return false;
    this.wallet -= cost;
    try { localStorage.setItem(WALLET_KEY, String(this.wallet)); } catch { /* session only */ }
    this.updateUI();
    return true;
  }

  addCoins(n) {
    this.wallet += n;
    try { localStorage.setItem(WALLET_KEY, String(this.wallet)); } catch { /* session only */ }
  }

  winRun(toast) {
    if (this.won) return;
    if (this.playbackActive) return;
    this.won = true;
    if (!this.playbackActive) this.onSound?.('win');

    const seconds = (Date.now() - this.levelStartedAt) / 1000;
    const stars = this.rateRun(seconds);
    if (!this.playbackActive) this._unlock('first_clear');
    const best = readBest();
    const previous = best[this.world.name];
    const record = !previous || seconds < previous.time;
    best[this.world.name] = { time: record ? seconds : previous.time, stars: Math.max(stars, previous?.stars || 0) };
    if (!this.playbackActive) writeBest(best); // AI playback never sets human records
    const gained = this.playbackActive ? 0 : Math.max(0, stars - (previous?.stars || 0)) * 2;
    if (gained) { this.addCoins(gained); if (toast) toast(`+${gained} bonus coins for stars`); }
    if (toast) toast(`${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}  ${seconds.toFixed(1)}s${record ? ' · new best!' : ` · best ${previous.time.toFixed(1)}s`}`);

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
      const overlay = $('transitionOverlay');
      this.transitioning = true;
      $('transitionStage').textContent = 'VICTORY ANIMATION';
      $('transitionTitle').textContent = 'Room cleared';
      $('transitionReward').textContent = `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)} · ${this.collected.size} gold found`;
      overlay.hidden = false;
      this.transitionTimers = [setTimeout(() => {
        $('transitionStage').textContent = 'REWARD SUMMARY';
        $('transitionTitle').textContent = `Level ${this.activeLevelIndex + 2} is ready`;
      }, 520), setTimeout(() => {
        $('transitionStage').textContent = 'NEXT CHAMBER REVEAL';
        this.loadCampaignLevel(this.activeLevelIndex + 1);
      }, 1050), setTimeout(() => {
        overlay.hidden = true;
        this.transitioning = false;
        this.transitionTimers = [];
      }, 1680)];
    }
    this.updateUI();
  }

  /** Kill Deeba: the burst animation plays in main.js, then the level restarts. */
  kill(cause, toast) {
    if (this.dying || this.won) return;
    this.dying = true;
    this.runDeaths++;
    this.onSound?.('burst');
    this.onDeath?.(cause, { ...this.playerPos });
    const failedLevel = this.activeLevelIndex + 1;
    const messages = { acid: 'Acid! ', lava: 'Acid! ', laser: 'Sliced by a laser · ', shock: 'Shocked · ', cutter: 'Cut by a blade · ', spikes: 'Spiked · ', time: 'Time ran out · ' };
    if (toast) toast(`${messages[cause] || 'You died · '}level ${failedLevel} restarting`);
    this.updateUI();
    this._deathTimer = setTimeout(() => {
      this.resetRun(false);
      this.onRespawn?.();
    }, 1250);
  }

  /**
   * One frame of game rules. `board` is the object returned by buildBoard, `ctx` = { sim, crates }.
   * Heights: player.jumpY is the height of Deeba's feet above the ground plane.
   */
  updateGameplay(dt, player, board, toast, isPlayback = false, ctx = {}) {
    if (this.won || this.dying) return;
    this.playbackActive = isPlayback;
    const sim = ctx.sim ?? performance.now() / 1000;
    this.playerPos = { x: player.x, y: player.jumpY + 0.5, z: player.z };
    const feet = player.jumpY;
    const frozen = this.activePowerup === 'freeze';

    // Coins
    for (const coin of board.coinMeshes) {
      const i = coin.userData?.coinIndex;
      if (i === undefined || this.collected.has(i) || !this.world.coins?.[i]) continue;
      const p = gridToWorld(this.world.coins[i][0], this.world.coins[i][1]);
      const closeXZ = Math.hypot(player.x - p.x, player.z - p.z) < 0.6;
      const closeY = coin.userData.baseY - 0.55 - feet < 0.9 && feet - (coin.userData.baseY - 0.55) < 0.95;
      if (closeXZ && closeY) {
        this.collected.add(i);
        coin.visible = false;
        if (!isPlayback) { this._awardCoin(i); this.onSound?.('coin'); this.onCoin?.({ x: p.x, y: coin.userData.baseY, z: p.z }); }
        if (toast) toast(`Coin ${this.collected.size} / ${this.world.coins.length}`);
        this.updateUI();
      }
    }

    if (!isPlayback) {
      for (const pickup of board.powerupMeshes) {
        const i = pickup.userData?.powerupIndex;
        const [gx, gz, type] = this.world.powerups?.[i] || [];
        if (i === undefined || this.powerupsCollected.has(i) || gx === undefined) continue;
        const p = gridToWorld(gx, gz);
        if (Math.hypot(player.x - p.x, player.z - p.z) < 0.65 && Math.abs(feet - pickup.position.y) < 1.1) {
          this.powerupsCollected.add(i);
          pickup.visible = false;
          this._clearBoost(player);
          this.activePowerup = type || 'speed';
          this.powerupUntil = Date.now() + 9000;
          if (this.activePowerup === 'speed') player.speedMultiplier = 1.55;
          if (this.activePowerup === 'jump') player.jumpMultiplier = 1.45;
          if (this.activePowerup === 'shield') player.hazardShield = true;
          if (this.activePowerup === 'freeze') this.onPowerup?.('freeze', this.powerupUntil);
          if (toast) toast(`${this.activePowerup.toUpperCase()} boost · 9 seconds`);
          this.onSound?.('powerup');
          this.onCoin?.({ x: p.x, y: pickup.position.y + 0.6, z: p.z }, '#c9b6ff');
          this._unlock('first_powerup');
        }
      }
      if (this.activePowerup && Date.now() >= this.powerupUntil) { this._clearBoost(player); this.activePowerup = null; }
    }

    this.elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    this.drawElapsed();

    // Time limit (the Python environment owns the clock during AI playback)
    if (!isPlayback && Date.now() - this.levelStartedAt >= this.timeLimit() * 1000) { this.kill('time', toast); return; }

    // Hazards
    if (!isPlayback && !player.hazardShield) {
      let cause = null;
      const play = this.play;
      for (const cell of play.hazards || []) {
        const p = gridToWorld(cell[0], cell[1]);
        if (feet < 0.35 && Math.abs(player.x - p.x) < 0.56 && Math.abs(player.z - p.z) < 0.56) { cause = 'acid'; break; }
      }
      if (!cause && !frozen) cause = lethalHazard(play, player.x + HALF_GRID, player.z + HALF_GRID, feet, sim, this.channelsOn);
      if (cause) { this.kill(cause, toast); return; }
    }

    // Pressure plates – work on the ground and on top of ledges.
    for (const plate of board.plateMeshes) {
      const key = `${plate.cell[0]},${plate.cell[1]}`;
      const p = gridToWorld(plate.cell[0], plate.cell[1]);
      const continuous = (this.world.continuousPlates || []).some(([x, z]) => x === plate.cell[0] && z === plate.cell[1]);
      const playerPressed = player.grounded && Math.hypot(player.x - p.x, player.z - p.z) < 0.46 && Math.abs(feet - plate.surface) < 0.35;
      const cratePressed = plate.surface === 0 && (ctx.crates || []).some((entry) => Math.hypot(entry.mesh.position.x - p.x, entry.mesh.position.z - p.z) < 0.53);
      const pressed = playerPressed || cratePressed;
      const wasActive = this.activatedPlates.has(key);
      if (pressed && !wasActive) {
        this.activatedPlates.add(key);
        if (toast) toast(cratePressed ? 'Crate is holding the plate down' : 'Plate pressed');
        this.onSound?.('plate');
      } else if (!pressed && continuous && wasActive) { this.activatedPlates.delete(key); this.onSound?.('plateOff'); }
      plate.setActive(this.activatedPlates.has(key));
    }

    this._recomputeChannels();
    const doorPlates = this._doorPlates();
    const platesComplete = doorPlates.length === 0 || doorPlates.every((c) => this.activatedPlates.has(`${c[0]},${c[1]}`));
    if (this.doorsOpen !== platesComplete) {
      this.doorsOpen = platesComplete;
      if (board.exitDoorMesh) board.exitDoorMesh.material.color.set(this.doorsOpen ? '#77bd91' : '#56636a');
      if (toast) toast(this.doorsOpen ? 'Gate opening' : 'Pressure released · gate closing');
      if (this.doorsOpen) this.onSound?.('door');
      this.updateUI();
    }

    // Exit crossing
    if (this.doorsOpen && this.world.exitDoor) {
      const [doorX, doorZ] = this.world.exitDoor;
      const door = gridToWorld(doorX, doorZ);
      const crossed = doorZ === GRID_SIZE - 1 ? player.z > door.z + 0.2 && Math.abs(player.x - door.x) < 0.72
        : doorZ === 0 ? player.z < door.z - 0.2 && Math.abs(player.x - door.x) < 0.72
          : doorX === GRID_SIZE - 1 ? player.x > door.x + 0.2 && Math.abs(player.z - door.z) < 0.72
            : doorX === 0 ? player.x < door.x - 0.2 && Math.abs(player.z - door.z) < 0.72
              : Math.hypot(player.x - door.x, player.z - door.z) < 0.8;
      if (crossed) this.winRun(toast);
    }
  }

  _clearBoost(player) {
    if (this.activePowerup === 'speed') player.speedMultiplier = 1;
    if (this.activePowerup === 'jump') player.jumpMultiplier = 1;
    if (this.activePowerup === 'shield') player.hazardShield = false;
    if (this.activePowerup === 'freeze') this.onPowerup?.('thaw', 0);
  }

  _doorPlates() { return (this.world.plates || []).filter((c) => channelOf(this.world, 'plate', c) === 0); }

  /** Channels 1-6 are 'on' while a plate of that colour is pressed or a lever of that colour is pulled. */
  _recomputeChannels() {
    const on = new Set();
    for (const c of this.world.plates || []) {
      const ch = channelOf(this.world, 'plate', c);
      if (ch && this.activatedPlates.has(`${c[0]},${c[1]}`)) on.add(ch);
    }
    let lever0 = false;
    for (const c of this.world.levers || []) {
      const ch = channelOf(this.world, 'lever', c), s = !!this.leverStates.get(`${c[0]},${c[1]}`);
      if (!s) continue;
      if (ch) on.add(ch); else lever0 = true;
    }
    this.leverActivated = lever0;
    this.channelsOn = on;
  }

  /** Nearest lever / crystal within reach (for the on-screen "Press E" prompt and for interacting). */
  nearestInteractable(player) {
    let best = null, bestD = 1.6;
    for (const kind of ['levers', 'switches']) {
      for (const cell of this.world[kind] || []) {
        const p = gridToWorld(cell[0], cell[1]);
        const d = Math.hypot(p.x - player.x, p.z - player.z);
        if (d < bestD && Math.abs(player.jumpY - surfaceHeightAt(this.world, cell[0], cell[1])) < 1.3) { best = { kind, cell }; bestD = d; }
      }
    }
    return best;
  }

  interact(player, cameraYaw, switchCrystalMeshes, toast, leverMeshes = []) {
    const target = this.nearestInteractable(player);
    if (!target) { if (toast) toast('Nothing to use here · walk up to a lever and press E'); return; }
    if (target.kind === 'levers') {
      const key = `${target.cell[0]},${target.cell[1]}`;
      const now = !this.leverStates.get(key);
      this.leverStates.set(key, now);
      this._recomputeChannels();
      for (const lever of leverMeshes) {
        const mine = lever.userData.cell[0] === target.cell[0] && lever.userData.cell[1] === target.cell[1];
        if (!mine) continue;
        lever.userData.activated = now;
        lever.userData.pivot.rotation.z = now ? -0.78 : 0.78;
        lever.userData.pivot.children[1]?.material?.color?.set(now ? '#ffffff' : lever.userData.color || '#ff9d60');
      }
      const ch = channelOf(this.world, 'lever', target.cell);
      if (toast) toast(now ? (ch ? 'Lever pulled · wire is live' : ((this.world.lifts || []).length ? 'Lever pulled · platforms are moving' : 'Lever pulled')) : 'Lever reset');
      this.onSound?.('lever');
      this.onLever?.(this.leverActivated);
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
    const remaining = Math.max(0, Math.ceil(this.timeLimit() - (Date.now() - this.levelStartedAt) / 1000));
    $('timer').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    $('timer').classList.toggle('urgent', remaining <= 10);
  }

  updateUI() {
    const plateCount = this.activatedPlates.size;
    const totalPlates = (this.world.plates || []).length;
    $('coinCount').textContent = `LEVEL ${this.activeLevelIndex + 1} / ${this.campaignLevels.length}`;
    $('homeSparks').textContent = `${this.activeLevelIndex + 1} / ${this.campaignLevels.length}`;
    if ($('homeCampaignCount')) $('homeCampaignCount').textContent = String(this.campaignLevels.length).padStart(2, '0');
    $('coinProgress').textContent = `${this.collected.size} / ${(this.world.coins || []).length}`;
    $('moves').textContent = this.moves;
    $('deathCount').textContent = this.runDeaths;
    if ($('walletCount')) $('walletCount').textContent = this.wallet;
    if ($('shopWallet')) $('shopWallet').textContent = this.wallet;
    if ($('achievementCount')) $('achievementCount').textContent = `${this.achievements.size} / 4`;
    if ($('activePowerup')) $('activePowerup').textContent = this.activePowerup
      ? `${this.activePowerup.toUpperCase()} · ${Math.max(0, Math.ceil((this.powerupUntil - Date.now()) / 1000))}s`
      : 'None';
    document.querySelectorAll('[data-achievement]').forEach((card) => card.classList.toggle('unlocked', this.achievements.has(card.dataset.achievement)));

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

  _awardCoin(index) {
    const key = `the-real-exit-claimed:${this.world.name}:${index}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
      this.wallet += 1;
      localStorage.setItem(WALLET_KEY, String(this.wallet));
    } catch { /* Local play continues if storage is unavailable. */ }
    this._unlock('first_coin');
    if (this.wallet >= 10) this._unlock('coin_collector');
    if ($('walletCount')) $('walletCount').textContent = this.wallet;
  }

  _unlock(id) {
    if (this.achievements.has(id)) return;
    this.achievements.add(id);
    try { localStorage.setItem(ACHIEVEMENT_KEY, JSON.stringify([...this.achievements])); } catch { /* Non-fatal. */ }
    if ($('achievementCount')) $('achievementCount').textContent = `${this.achievements.size} / 4`;
    document.querySelectorAll(`[data-achievement="${id}"]`).forEach((card) => card.classList.add('unlocked'));
    this.onAchievement?.(id);
  }

  refreshLevelNavigation() {
    const host = $('levelList');
    if (!host) return;
    host.innerHTML = '';
    this.campaignLevels.forEach((level, index) => {
      const button = document.createElement('button');
      button.className = `level-select${index === this.activeLevelIndex ? ' active' : ''}`;
      const record = readBest()[level.name];
      const stars = record ? '★'.repeat(record.stars) + '☆'.repeat(3 - record.stars) : '';
      button.textContent = `${String(index + 1).padStart(2, '0')}  ${level.name}${stars ? `  ${stars}` : ''}`;
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

  importWorldData(payload) {
    const incoming = Array.isArray(payload?.levels) ? payload.levels : [payload];
    const listFields = LIST_FIELDS;
    const valid = incoming.filter((level) => level && typeof level === 'object' && Array.isArray(level.start) && level.start.length === 2);
    if (!valid.length) throw new Error('This file does not contain a valid level');
    for (const source of valid) {
      const level = migrateLevel({ ...source });
      for (const key of listFields) level[key] = Array.isArray(level[key]) ? level[key] : [];
      level.exitDoor = Array.isArray(level.exitDoor) ? level.exitDoor : [GRID_SIZE >> 1, GRID_SIZE - 1];
      level.goal = [...level.exitDoor];
      level.objectProperties ||= {};
      level.name ||= `Imported ${this.campaignLevels.length + 1}`;
      level.standalone = false;
      this.campaignLevels.push(level);
    }
    this.loadCampaignLevel(this.campaignLevels.length - 1);
    this.saveWorld(false);
    return valid.length;
  }

  restoreStarterWorld(toast = null) {
    this.campaignLevels = freshCampaign();
    this.loadCampaignLevel(0);
    this.saveWorld(false);
    if (toast) toast('Nine-level campaign restored');
  }
}

