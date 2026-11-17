/**
 * Python Backend API Client
 * Facilitates REST communication between the JavaScript UI and the Python RL backend.
 */

export class RLClient {
  constructor(baseUrl = null) {
    if (baseUrl !== null) {
      this.baseUrl = baseUrl;
    } else if (typeof window !== 'undefined' && window.location.protocol === 'worldforge:') {
      this.baseUrl = ''; // Same-origin relative path through Electron protocol proxy
    } else {
      this.baseUrl = 'http://127.0.0.1:5050';
    }
  }

  async _request(endpoint, method = 'GET', data = null) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (data !== null) {
      options.body = JSON.stringify(data);
    }

    let res;
    try {
      res = await fetch(`${this.baseUrl}${endpoint}`, options);
    } catch (err) {
      // Fall back only when the Electron protocol request itself fails. Preserve
      // HTTP error responses so backend validation and traceback details survive.
      if (this.baseUrl !== '' || endpoint.startsWith('http')) throw err;
      try {
        res = await fetch(`http://127.0.0.1:5050${endpoint}`, options);
      } catch (fallbackError) {
        throw new Error(`Backend unavailable at 127.0.0.1:5050: ${fallbackError.message}`);
      }
    }

    const body = await res.text();
    if (!res.ok) {
      let detail = body;
      try { detail = JSON.parse(body).error || body; } catch { /* retain plain-text error */ }
      throw new Error(`HTTP ${res.status}${detail ? ` · ${detail}` : ''}`);
    }
    try { return body ? JSON.parse(body) : {}; }
    catch { throw new Error(`Backend returned invalid JSON from ${endpoint}`); }
  }

  async checkHealth() {
    return this._request('/api/health');
  }

  async getAlgorithms() {
    return this._request('/api/algorithms');
  }

  async getRewards() {
    return this._request('/api/rewards');
  }

  async initTraining(config) {
    return this._request('/api/train/init', 'POST', config);
  }

  async startTraining(targetSteps = 50000, stepBudget = 2048) {
    return this._request('/api/train/start', 'POST', { targetSteps, stepBudget });
  }

  async getTrainingStatus() {
    return this._request('/api/train/status');
  }

  async controlTraining(action) {
    return this._request('/api/train/control', 'POST', { action });
  }

  async stepChunk(stepBudget = 512, targetSteps = 50000) {
    return this._request('/api/train/chunk', 'POST', { stepBudget, targetSteps });
  }

  async evaluate(episodes = 20) {
    return this._request('/api/train/evaluate', 'POST', { episodes });
  }

  async saveCheckpoint() {
    return this._request('/api/checkpoint/save', 'POST');
  }

  async loadCheckpoint(checkpoint) {
    return this._request('/api/checkpoint/load', 'POST', { checkpoint });
  }

  async startPlayback(levels, seed = 431, rewards = null) {
    return this._request('/api/playback/start', 'POST', { levels, seed, rewards });
  }

  async stepPlayback() {
    return this._request('/api/playback/step', 'POST');
  }
}
