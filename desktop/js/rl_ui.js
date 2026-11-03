/**
 * AI Lab UI & Training Dashboard Controller
 * Connects the training panel, chart visualization, and hyperparameter controls to the Python RL backend.
 */

import { cloneData } from './constants.js';

const $ = (id) => document.getElementById(id);

export class RLUIController {
  constructor(client, gameManager, onStartWatchInGame, toast) {
    this.client = client;
    this.gameManager = gameManager;
    this.onStartWatchInGame = onStartWatchInGame;
    this.toast = toast;

    this.algorithms = [];
    this.defaultRewards = {};
    this.rewardLabels = {};
    this.rlState = 'idle';
    this.rlRunId = 0;
    this.rlTimer = null;
    this.history = [];
    this.loadedCheckpoint = null;
  }

  async init() {
    this._bindEvents();
    try {
      const [algoRes, rewRes] = await Promise.all([
        this.client.getAlgorithms(),
        this.client.getRewards(),
      ]);
      this.algorithms = algoRes.algorithms || [];
      this.defaultRewards = rewRes.defaults || {};
      this.rewardLabels = rewRes.labels || {};
    } catch (err) {
      console.warn('Could not connect to Python backend immediately, retrying on demand:', err.message);
      this.algorithms = [
        {
          id: 'ppo',
          name: 'PPO · Clipped Policy',
          description: 'Stable on-policy learning for the mixed movement and interaction action set.',
          defaults: { learningRate: 0.08, discount: 0.99, gaeLambda: 0.95, rolloutSteps: 256, epochs: 3, clipRange: 0.2, entropy: 0.015 },
          fields: [
            { key: 'learningRate', label: 'Policy learning rate', min: 0.005, max: 0.3, step: 0.005 },
            { key: 'discount', label: 'Discount γ', min: 0.8, max: 0.999, step: 0.001 },
            { key: 'gaeLambda', label: 'GAE λ', min: 0.5, max: 1, step: 0.01 },
            { key: 'rolloutSteps', label: 'Rollout steps', min: 32, max: 1024, step: 32, integer: true },
            { key: 'epochs', label: 'Update epochs', min: 1, max: 8, step: 1, integer: true },
            { key: 'clipRange', label: 'PPO clip range', min: 0.05, max: 0.4, step: 0.01 },
            { key: 'entropy', label: 'Entropy bonus', min: 0, max: 0.1, step: 0.001 },
          ],
        },
        {
          id: 'dqn',
          name: 'DQN · Replay Q-Network',
          description: 'Off-policy value learning with a small neural Q-network and replay memory.',
          defaults: { learningRate: 0.001, discount: 0.99, epsilonStart: 1, epsilonEnd: 0.05, epsilonDecaySteps: 12000, batchSize: 32, replaySize: 5000, trainEvery: 4, targetSyncSteps: 250 },
          fields: [
            { key: 'learningRate', label: 'Learning rate', min: 0.0001, max: 0.01, step: 0.0001 },
            { key: 'discount', label: 'Discount γ', min: 0.8, max: 0.999, step: 0.001 },
            { key: 'epsilonStart', label: 'Initial exploration ε', min: 0.1, max: 1, step: 0.01 },
            { key: 'epsilonEnd', label: 'Final exploration ε', min: 0.01, max: 0.4, step: 0.01 },
            { key: 'epsilonDecaySteps', label: 'Exploration decay steps', min: 500, max: 100000, step: 500, integer: true },
            { key: 'batchSize', label: 'Replay batch size', min: 8, max: 128, step: 8, integer: true },
            { key: 'replaySize', label: 'Replay capacity', min: 500, max: 20000, step: 500, integer: true },
            { key: 'trainEvery', label: 'Train every N steps', min: 1, max: 16, step: 1, integer: true },
            { key: 'targetSyncSteps', label: 'Target sync interval', min: 50, max: 2000, step: 50, integer: true },
          ],
        },
        {
          id: 'random',
          name: 'Random · Baseline',
          description: 'Uniform random actions for measuring how much the learned policy improves.',
          defaults: { seed: 17 },
          fields: [],
        },
      ];
      this.defaultRewards = {
        timeStep: -0.01, progress: 0.1, coin: 5, plate: 10, doorOpen: 2, goal: 100,
        collision: -0.5, hazard: -10, rotatorCollision: -1, moverCollision: -0.7,
        platformCollision: -0.3, invalidInteract: -0.1, pushBlock: -0.1, jumpHazard: 0.25, switch: 1,
        deathPenalty: -5, speedBonus: 5,
      };
      this.rewardLabels = {
        timeStep: 'Per action / time step', progress: 'Visible objective closer / farther', coin: 'Collect coin',
        plate: 'Press pressure plate', doorOpen: 'Open door', goal: 'Reach goal',
        collision: 'Wall collision', hazard: 'Hit hazard', rotatorCollision: 'Rotating obstacle hit',
        moverCollision: 'Moving obstacle hit', platformCollision: 'Raised platform hit',
        invalidInteract: 'Invalid interaction', pushBlock: 'Push block', jumpHazard: 'Jump over hazard/obstacle', switch: 'Toggle switch',
        deathPenalty: 'Death / level restart penalty', speedBonus: 'Finish level sooner',
      };
    }

    this.populateAlgorithms();
    this.refreshLevels();
  }

  populateAlgorithms() {
    const select = $('rlAlgorithm');
    select.replaceChildren();
    for (const algo of this.algorithms) {
      const option = document.createElement('option');
      option.value = algo.id;
      option.textContent = algo.name;
      select.append(option);
    }
    select.value = 'ppo';
    this.renderHyperparameters();
    this.renderRewards();
    this.updateDisplay(null);
  }

  refreshLevels() {
    const select = $('rlLevels');
    const selected = select.value || 'campaign';
    select.innerHTML = '<option value="campaign">Full campaign</option>';
    this.gameManager.campaignLevels.forEach((entry, index) => {
      const option = document.createElement('option');
      option.value = `level:${index}`;
      option.textContent = `${index + 1}. ${entry.name || `Level ${index + 1}`}`;
      select.append(option);
    });
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  }

  selectedLevels() {
    const selected = $('rlLevels').value;
    if (selected.startsWith('level:')) {
      const level = this.gameManager.campaignLevels[Number(selected.split(':')[1])];
      if (!level) throw new Error('The selected level no longer exists.');
      return [cloneData(level)];
    }
    return this.gameManager.campaignLevels.map(cloneData);
  }

  renderHyperparameters(values = null) {
    const algoId = $('rlAlgorithm').value;
    const algo = this.algorithms.find((a) => a.id === algoId) || this.algorithms[0];
    const host = $('rlHyperparameters');
    host.replaceChildren();

    $('rlAlgorithmDescription').textContent = algo.description;

    if (!algo.fields || !algo.fields.length) {
      const note = document.createElement('p');
      note.className = 'rl-description';
      note.textContent = 'The random baseline has no trainable hyperparameters.';
      host.append(note);
      return;
    }

    for (const field of algo.fields) {
      const label = document.createElement('label');
      label.className = 'rl-field';
      label.textContent = field.label;

      const input = document.createElement('input');
      input.id = `rl-hp-${field.key}`;
      input.type = 'number';
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.value = values?.[field.key] ?? algo.defaults[field.key];

      label.append(input);
      host.append(label);
    }
  }

  currentHyperparameters() {
    const algoId = $('rlAlgorithm').value;
    const algo = this.algorithms.find((a) => a.id === algoId) || this.algorithms[0];
    const values = {};
    for (const field of algo.fields || []) {
      const input = $(`rl-hp-${field.key}`);
      const parsed = Number(input?.value);
      values[field.key] = field.integer ? Math.round(parsed) : parsed;
    }
    return values;
  }

  renderRewards(values = this.defaultRewards) {
    const host = $('rlRewards');
    host.replaceChildren();
    for (const [key, labelText] of Object.entries(this.rewardLabels)) {
      const label = document.createElement('label');
      label.className = 'rl-field';
      label.textContent = labelText;

      const input = document.createElement('input');
      input.id = `rl-reward-${key}`;
      input.type = 'number';
      input.step = '0.01';
      input.value = values[key] ?? this.defaultRewards[key];

      label.append(input);
      host.append(label);
    }
  }

  currentRewards() {
    return Object.fromEntries(
      Object.keys(this.defaultRewards).map((key) => {
        const input = $(`rl-reward-${key}`);
        const parsed = Number(input?.value);
        return [key, Number.isFinite(parsed) ? parsed : this.defaultRewards[key]];
      })
    );
  }

  drawChart() {
    const canvas = $('rlRewardChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.floor(rect.width));
    const height = 180;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = '#2b3a50';
    ctx.lineWidth = 1;
    for (let row = 1; row <= 3; row++) {
      const y = (row * height) / 4;
      ctx.beginPath();
      ctx.moveTo(12, y);
      ctx.lineTo(width - 8, y);
      ctx.stroke();
    }

    if (!this.history.length) return;
    const points = this.history.slice(-120);
    const rewards = points.map((ep) => ep.reward);
    let low = Math.min(...rewards);
    let high = Math.max(...rewards);
    if (high - low < 1) {
      high += 1;
      low -= 1;
    }
    const margin = 12;

    ctx.strokeStyle = '#65e0bd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((ep, index) => {
      const x = margin + (index * (width - margin * 2)) / Math.max(1, points.length - 1);
      const y = height - margin - ((ep.reward - low) / (high - low)) * (height - margin * 2);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  updateDisplay(stats = null) {
    if (!stats) {
      $('rlEpisodes').textContent = '0';
      $('rlSteps').textContent = '0';
      $('rlMeanReward').textContent = '—';
      $('rlSuccessRate').textContent = '—';
      $('rlMeanLength').textContent = '—';
      $('rlMeanCollisions').textContent = '—';
      $('rlMeanDeaths').textContent = '—';
      $('rlMeanCoins').textContent = '—';
      $('rlProgressBar').style.width = '0%';
      $('rlProgressPercent').textContent = '0%';
      this.drawChart();
      return;
    }

    $('rlEpisodes').textContent = stats.episodes.toLocaleString();
    $('rlSteps').textContent = stats.steps.toLocaleString();
    $('rlMeanReward').textContent = stats.episodes ? stats.meanReward.toFixed(1) : '—';
    $('rlSuccessRate').textContent = stats.episodes ? `${Math.round(stats.successRate * 100)}%` : '—';
    $('rlMeanLength').textContent = stats.episodes ? stats.meanLength.toFixed(0) : '—';
    $('rlMeanCollisions').textContent = stats.episodes ? stats.collisionCount.toFixed(1) : '—';
    $('rlMeanDeaths').textContent = stats.episodes ? stats.meanDeaths.toFixed(1) : '—';
    $('rlMeanCoins').textContent = stats.episodes ? stats.coinRate.toFixed(1) : '—';

    const target = Math.max(1, Number($('rlTimesteps').value) || 50000);
    const percent = Math.min(100, (stats.steps / target) * 100);
    $('rlProgressBar').style.width = `${percent}%`;
    $('rlProgressPercent').textContent = `${Math.floor(percent)}%`;
    $('rlBatchInfo').textContent = `Python Backend · ${$('rlSpeed').selectedOptions[0].textContent.split('·')[0].trim()}`;

    this.history = stats.history || [];
    this.drawChart();
  }

  setState(state, message) {
    this.rlState = state;
    $('rlStatus').textContent = message;
    $('rlStatusDot').className = `rl-status-dot${state === 'running' ? ' running' : state === 'paused' ? ' paused' : state === 'error' ? ' error' : ''}`;
    $('rlPause').disabled = !['running', 'paused'].includes(state);
    $('rlPause').textContent = state === 'paused' ? 'Resume' : 'Pause';
    $('rlStop').disabled = !['running', 'paused'].includes(state);
    $('rlStart').disabled = state === 'running' || state === 'paused';
    $('rlSave').disabled = state === 'idle' && !this.loadedCheckpoint;
    $('rlEvaluate').disabled = state === 'running' || (state === 'idle' && !this.loadedCheckpoint);
    $('rlWatchInGame').disabled = state === 'running' || (state === 'idle' && !this.loadedCheckpoint);
  }

  async scheduleStatus(runId) {
    if (runId !== this.rlRunId || this.rlState !== 'running') return;

    try {
      const res = await this.client.getTrainingStatus();
      if (res.stats) this.updateDisplay(res.stats);
      if (res.state === 'complete') {
        this.setState('complete', `Training complete · ${res.stats?.episodes || 0} episodes`);
        return;
      }
      if (res.state === 'stopped') {
        this.setState('stopped', 'Training stopped');
        return;
      }
      if (res.state === 'error') {
        this.setState('error', `Training error · ${res.error || 'Unknown backend error'}`);
        return;
      }
      this.rlTimer = setTimeout(() => this.scheduleStatus(runId), 500);
    } catch (err) {
      this.setState('error', `Training error · ${err.message}`);
    }
  }

  async startTraining() {
    try {
      clearTimeout(this.rlTimer);
      const algoId = $('rlAlgorithm').value;
      const checkpoint = this.loadedCheckpoint;

      const initPayload = {
        algorithm: algoId,
        hyperparameters: checkpoint?.hyperparameters || this.currentHyperparameters(),
        levels: checkpoint?.levels || this.selectedLevels(),
        seed: checkpoint?.seed || Number($('rlSeed').value) || 17,
        maxEpisodeSteps: checkpoint?.maxEpisodeSteps || Number($('rlEpisodeLimit').value) || 240,
        rewards: this.currentRewards(),
        checkpoint,
      };

      const res = await this.client.initTraining(initPayload);
      this.loadedCheckpoint = null;
      this.rlRunId++;
      await this.client.startTraining(
        Math.max(1000, Number($('rlTimesteps').value) || 50000),
        Number($('rlSpeed').value) || 2048
      );
      this.setState('running', `Training · ${algoId.toUpperCase()} on Python Backend`);
      this.updateDisplay(res.stats);
      this.scheduleStatus(this.rlRunId);
    } catch (err) {
      this.setState('error', `Could not start · ${err.message}`);
    }
  }

  async saveCheckpoint() {
    try {
      const res = await this.client.saveCheckpoint();
      const blob = new Blob([JSON.stringify(res.checkpoint, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `The-ReaL-Exit-${res.checkpoint.algorithm}-checkpoint.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      this.toast('Training checkpoint saved');
    } catch (err) {
      this.toast(`Checkpoint save failed: ${err.message}`);
    }
  }

  async loadCheckpointFile(file) {
    try {
      const checkpoint = JSON.parse(await file.text());
      const res = await this.client.loadCheckpoint(checkpoint);
      this.loadedCheckpoint = checkpoint;

      $('rlAlgorithm').value = res.algorithm;
      $('rlSeed').value = checkpoint.seed;
      $('rlEpisodeLimit').value = checkpoint.maxEpisodeSteps;
      $('rlTimesteps').value = Math.max(50000, checkpoint.totalSteps + 50000);

      this.renderHyperparameters(checkpoint.hyperparameters);
      this.renderRewards(checkpoint.rewards);
      this.updateDisplay(res.stats);
      this.setState('loaded', `Checkpoint loaded · ${res.algorithm.toUpperCase()} · ${checkpoint.totalSteps.toLocaleString()} steps`);
      this.toast('Checkpoint loaded · evaluate or continue training');
    } catch (err) {
      this.setState('error', `Load failed · ${err.message}`);
    }
  }

  async evaluate() {
    $('rlEvaluate').disabled = true;
    $('rlEvaluationTitle').textContent = 'Evaluating…';
    $('rlEvaluationTitle').className = 'rl-evaluation-title';
    $('rlEvaluation').textContent = 'Running 20 headless episodes without exploration on Python backend.';

    try {
      const res = await this.client.evaluate(20);
      const m = res.metrics;
      $('rlEvaluationTitle').textContent = `${Math.round(m.successRate * 100)}% success · ${m.meanReward.toFixed(1)} mean reward`;
      $('rlEvaluationTitle').className = `rl-evaluation-title ${m.successRate > 0.5 ? 'success' : 'failure'}`;
      $('rlEvaluation').textContent = `Average ${m.meanSteps.toFixed(0)} steps · ${m.meanDeaths.toFixed(1)} deaths · ${m.meanCollisions.toFixed(1)} collisions · ${m.meanCoins.toFixed(1)} coins per episode.`;
    } catch (err) {
      $('rlEvaluationTitle').textContent = 'Evaluation failed';
      $('rlEvaluation').textContent = err.message;
    } finally {
      $('rlEvaluate').disabled = this.rlState === 'running';
    }
  }

  _bindEvents() {
    $('rlAlgorithm').addEventListener('change', () => this.renderHyperparameters());
    $('rlStart').addEventListener('click', () => this.startTraining());
    $('rlPause').addEventListener('click', () => {
      if (this.rlState === 'running') {
        clearTimeout(this.rlTimer);
        this.client.controlTraining('pause').then(() => this.setState('paused', 'Training paused'))
          .catch((err) => this.setState('error', `Could not pause · ${err.message}`));
      } else if (this.rlState === 'paused') {
        this.client.controlTraining('resume').then(() => {
          this.setState('running', 'Training resumed');
          this.scheduleStatus(this.rlRunId);
        }).catch((err) => this.setState('error', `Could not resume · ${err.message}`));
      }
    });

    $('rlStop').addEventListener('click', () => {
      clearTimeout(this.rlTimer);
      this.rlRunId++;
      this.client.controlTraining('stop').then(() => this.setState('stopped', 'Training stopped'))
        .catch((err) => this.setState('error', `Could not stop · ${err.message}`));
    });

    $('rlReset').addEventListener('click', () => {
      clearTimeout(this.rlTimer);
      this.rlRunId++;
      if (['running', 'paused'].includes(this.rlState)) this.client.controlTraining('stop').catch(() => {});
      this.loadedCheckpoint = null;
      this.setState('idle', 'Ready · PPO is the recommended default');
      $('rlEvaluationTitle').textContent = 'No evaluation yet';
      $('rlEvaluationTitle').className = 'rl-evaluation-title';
      $('rlEvaluation').textContent = 'Train or load a checkpoint, then run a 20-episode evaluation with exploration disabled.';
      this.updateDisplay(null);
    });

    $('rlSave').addEventListener('click', () => this.saveCheckpoint());
    $('rlLoad').addEventListener('click', () => $('rlCheckpointFile').click());
    $('rlCheckpointFile').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) this.loadCheckpointFile(file);
      event.target.value = '';
    });

    $('rlEvaluate').addEventListener('click', () => this.evaluate());
    $('rlWatchInGame').addEventListener('click', () => {
      if (this.onStartWatchInGame) this.onStartWatchInGame();
    });

    window.addEventListener('resize', () => this.drawChart());
  }
}

