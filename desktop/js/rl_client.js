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
    const url = `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (data !== null) {
      options.body = JSON.stringify(data);
    }

    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const errorText = await res.text();
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.error || `HTTP ${res.status}`);
        } catch {
          throw new Error(errorText || `HTTP ${res.status}`);
        }
      }
      return await res.json();
    } catch (err) {
      // Fallback: if relative proxy failed and not already using direct URL, try direct 127.0.0.1:5050
      if (this.baseUrl === '' && !endpoint.startsWith('http')) {
        const directUrl = `http://127.0.0.1:5050${endpoint}`;
        const fallbackRes = await fetch(directUrl, options);
        if (!fallbackRes.ok) {
          throw new Error(`HTTP ${fallbackRes.status}`);
        }
        return await fallbackRes.json();
      }
      throw err;
    }
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
