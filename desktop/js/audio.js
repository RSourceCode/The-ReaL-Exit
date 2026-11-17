/**
 * Deeba's Skyway audio engine.
 *
 * Everything is synthesised with the Web Audio API – no audio assets are shipped.
 *  • A soft generative soundtrack: warm pad chords, a quiet sub drone and sparse bell notes through a
 *    ping-pong delay and a hall reverb.  Each level nudges the key so the music keeps evolving.
 *  • Gentle sound effects for jumping, landing, rolling / sliding, coins, plates, levers, lifts, lasers,
 *    doors, winning and the character bursting apart.
 */

const SETTINGS_KEY = 'the-real-exit-audio-v2';
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Chord progression in semitones above the key's root (kept consonant and "open" for a calm mood).
const PROGRESSION = [
  [0, 7, 11, 14, 16],   // Imaj9
  [-3, 4, 9, 12, 16],   // vi
  [-7, 0, 5, 9, 12],    // IVmaj7
  [-5, 2, 7, 11, 14],   // V6/9
];
const PENTATONIC = [0, 2, 4, 7, 9];
const KEYS = [48, 50, 53, 55, 52, 57, 45, 47, 50]; // MIDI root per level mood

export class AudioFeedback {
  constructor() {
    this.context = null;
    this.settings = { master: 0.8, music: 0.55, sfx: 0.9, muted: false };
    try {
      Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
      if (localStorage.getItem('the-real-exit-audio-v1') === 'off') this.settings.muted = true;
    } catch { /* settings are optional */ }
    this.musicOn = false;
    this.mood = 0;
    this.chordIndex = 0;
    this.nextChordAt = 0;
    this.nextBellAt = 0;
    this.scheduler = null;
    this.muffled = false;
    this.lastPlayed = new Map();
    this.combo = 0;
    this.comboAt = 0;
    this.loops = {};
    this.motion = { speed: 0, ice: false, grounded: true };
  }

  /** Back-compat with the old on/off switch. */
  get enabled() { return !this.settings.muted; }
  set enabled(value) { this.settings.muted = !value; this._applyVolumes(); this._save(); }

  // ── Context & routing ───────────────────────────────────────────────────────────────────────
  unlock() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!this.context) this._build(new Ctx());
      if (this.context.state === 'suspended') this.context.resume();
      return this.context;
    } catch { return null; }
  }

  _build(ctx) {
    this.context = ctx;
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14; this.limiter.ratio.value = 4; this.limiter.attack.value = 0.01; this.limiter.release.value = 0.25;
    this.tone = ctx.createBiquadFilter(); this.tone.type = 'lowpass'; this.tone.frequency.value = 18000;
    this.master.connect(this.tone).connect(this.limiter).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);

    // Shared hall reverb and ping-pong delay (both fed by "send" gains).
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(3.2, 2.4);
    this.reverbReturn = ctx.createGain(); this.reverbReturn.gain.value = 0.9;
    this.reverb.connect(this.reverbReturn).connect(this.master);
    this.reverbIn = ctx.createGain(); this.reverbIn.connect(this.reverb);

    this.delayIn = ctx.createGain();
    const left = ctx.createDelay(1.5), right = ctx.createDelay(1.5);
    left.delayTime.value = 0.34; right.delayTime.value = 0.51;
    const feedback = ctx.createGain(); feedback.gain.value = 0.36;
    const damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2600;
    this.delayIn.connect(left); left.connect(damp); damp.connect(right); right.connect(feedback); feedback.connect(left);
    const merger = ctx.createChannelMerger(2);
    damp.connect(merger, 0, 0); right.connect(merger, 0, 1);
    merger.connect(this.master);
    this.delayIn.connect(this.reverbIn);

    this.noiseBuffer = this._noise(2);
    this._applyVolumes();
    this._startLoops();
  }

  _impulse(seconds, decay) {
    const ctx = this.context, rate = ctx.sampleRate, length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      let low = 0;
      for (let i = 0; i < length; i++) {
        const fade = Math.pow(1 - i / length, decay);
        low += (Math.random() * 2 - 1 - low) * 0.32; // one-pole low-pass keeps the tail warm, not hissy
        data[i] = low * fade;
      }
    }
    return buffer;
  }

  _noise(seconds) {
    const ctx = this.context, length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _save() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* optional */ } }

  _applyVolumes() {
    if (!this.context) return;
    const t = this.context.currentTime, s = this.settings, on = s.muted ? 0 : 1;
    this.master.gain.setTargetAtTime(s.master * on, t, 0.05);
    this.musicBus.gain.setTargetAtTime(s.music * 0.5, t, 0.1);
    this.sfxBus.gain.setTargetAtTime(s.sfx, t, 0.05);
  }

  setVolumes(partial) {
    Object.assign(this.settings, partial);
    this._applyVolumes();
    this._save();
  }

  /** Close the "air" (low-pass) while the game is paused or a menu is open. */
  setMuffled(flag) {
    this.muffled = flag;
    if (this.context) this.tone.frequency.setTargetAtTime(flag ? 650 : 18000, this.context.currentTime, 0.12);
  }

  // ── Building blocks ─────────────────────────────────────────────────────────────────────────
  _tone({ f0, f1 = f0, dur = 0.2, type = 'sine', gain = 0.1, attack = 0.008, delay = 0, reverb = 0, echo = 0, bus = null, detune = 0 }) {
    const ctx = this.context, t = ctx.currentTime + delay;
    const osc = ctx.createOscillator(), amp = ctx.createGain();
    osc.type = type; osc.detune.value = detune;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(gain, t + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(bus || this.sfxBus);
    if (reverb) { const send = ctx.createGain(); send.gain.value = reverb; amp.connect(send).connect(this.reverbIn); }
    if (echo) { const send = ctx.createGain(); send.gain.value = echo; amp.connect(send).connect(this.delayIn); }
    osc.start(t); osc.stop(t + dur + 0.05);
    return { osc, amp };
  }

  _burst({ dur = 0.15, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, gain = 0.1, attack = 0.004, delay = 0, reverb = 0 }) {
    const ctx = this.context, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(gain, t + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(amp).connect(this.sfxBus);
    if (reverb) { const send = ctx.createGain(); send.gain.value = reverb; amp.connect(send).connect(this.reverbIn); }
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }

  /** A bell / glass-like note: sine + inharmonic partial with a long soft decay. */
  _bell(freq, { gain = 0.08, dur = 2.4, delay = 0, bus = null, echo = 0.5, reverb = 0.6 } = {}) {
    this._tone({ f0: freq, dur, gain, attack: 0.006, delay, bus, echo, reverb });
    this._tone({ f0: freq * 2.76, dur: dur * 0.35, gain: gain * 0.22, attack: 0.004, delay, bus, echo: echo * 0.5, reverb });
    this._tone({ f0: freq * 4.1, dur: dur * 0.15, gain: gain * 0.08, attack: 0.003, delay, bus, reverb });
  }

  _throttle(kind, ms) {
    const now = performance.now();
    if (now - (this.lastPlayed.get(kind) || 0) < ms) return false;
    this.lastPlayed.set(kind, now);
    return true;
  }

  // ── Sound effects ───────────────────────────────────────────────────────────────────────────
  play(kind = 'tap', arg = 1) {
    if (this.settings.muted) return;
    if (!this.context || this.context.state !== 'running') return;
    const ctx = this.context;
    try {
      switch (kind) {
        case 'jump':
          this._tone({ f0: 330, f1: 700, dur: 0.16, gain: 0.14, attack: 0.01, reverb: 0.15 });
          this._tone({ f0: 660, f1: 1100, dur: 0.1, gain: 0.04, type: 'triangle' });
          this._burst({ type: 'highpass', f0: 1800, dur: 0.12, gain: 0.025, q: 0.4 });
          break;
        case 'land': {
          if (!this._throttle('land', 90)) break;
          const k = Math.min(1, Math.max(0.15, arg));
          this._tone({ f0: 150, f1: 52, dur: 0.17, gain: 0.2 * k, attack: 0.004 });
          this._burst({ type: 'lowpass', f0: 700, f1: 200, dur: 0.1, gain: 0.07 * k });
          break;
        }
        case 'footstep':
          if (!this._throttle('footstep', 120)) break;
          this._burst({ type: 'bandpass', f0: rand(700, 1100), q: 0.9, dur: 0.055, gain: 0.05 });
          this._tone({ f0: rand(95, 125), f1: 70, dur: 0.06, gain: 0.04 });
          break;
        case 'coin': {
          const now = performance.now();
          this.combo = now - this.comboAt < 1400 ? Math.min(this.combo + 1, 7) : 0;
          this.comboAt = now;
          const f = midi(88 + [0, 2, 4, 7, 9, 12, 14, 16][this.combo] - 4);
          this._bell(f, { gain: 0.1, dur: 1.4 });
          this._bell(f * 1.5, { gain: 0.06, dur: 1.2, delay: 0.075 });
          break;
        }
        case 'powerup':
          [72, 76, 79, 84, 88].forEach((n, i) => this._bell(midi(n), { gain: 0.07, dur: 1.4, delay: i * 0.07 }));
          this._burst({ type: 'bandpass', f0: 600, f1: 4200, q: 1.5, dur: 0.45, gain: 0.04, reverb: 0.5 });
          break;
        case 'lever':
          this._burst({ type: 'bandpass', f0: 1700, q: 3, dur: 0.035, gain: 0.1 });
          this._tone({ f0: 150, f1: 85, dur: 0.18, gain: 0.16, type: 'triangle' });
          this._burst({ type: 'bandpass', f0: 1100, q: 3, dur: 0.04, gain: 0.08, delay: 0.1 });
          this._tone({ f0: 230, f1: 120, dur: 0.14, gain: 0.1, delay: 0.1, type: 'triangle' });
          break;
        case 'plate':
          this._tone({ f0: 210, f1: 135, dur: 0.15, gain: 0.17, type: 'triangle' });
          this._burst({ type: 'bandpass', f0: 1400, q: 2, dur: 0.04, gain: 0.07 });
          this._bell(midi(76), { gain: 0.05, dur: 0.9, delay: 0.05 });
          break;
        case 'plateOff':
          this._tone({ f0: 150, f1: 210, dur: 0.12, gain: 0.1, type: 'triangle' });
          this._burst({ type: 'bandpass', f0: 900, q: 2, dur: 0.03, gain: 0.05 });
          break;
        case 'door': {
          [48, 55, 60, 64, 67].forEach((n, i) => this._tone({ f0: midi(n), dur: 1.5, gain: 0.07, attack: 0.5, reverb: 0.7, delay: i * 0.05, type: 'triangle' }));
          this._burst({ type: 'bandpass', f0: 250, f1: 1600, q: 0.8, dur: 1.1, gain: 0.05, attack: 0.5, reverb: 0.5 });
          break;
        }
        case 'win': {
          [72, 76, 79, 84, 88, 91, 96].forEach((n, i) => this._bell(midi(n), { gain: 0.085, dur: 2.2, delay: i * 0.11 }));
          [48, 55, 60, 64].forEach((n) => this._tone({ f0: midi(n), dur: 2.6, gain: 0.05, attack: 0.25, reverb: 0.8, delay: 0.1, type: 'triangle' }));
          break;
        }
        case 'burst': case 'hazard': {
          // A soft "pop" that blooms into a crackle and a falling sigh – dramatic but never harsh.
          this._burst({ type: 'bandpass', f0: 4200, f1: 260, q: 0.9, dur: 0.55, gain: 0.3, reverb: 0.3 });
          this._tone({ f0: 240, f1: 38, dur: 0.5, gain: 0.3, attack: 0.004 });
          this._tone({ f0: 900, f1: 120, dur: 0.3, gain: 0.08, type: 'triangle' });
          for (let i = 0; i < 9; i++) this._burst({ type: 'highpass', f0: rand(2500, 5500), q: 0.7, dur: rand(0.01, 0.035), gain: rand(0.03, 0.09), delay: rand(0.03, 0.5) });
          this._tone({ f0: midi(69), f1: midi(64), dur: 0.9, gain: 0.07, attack: 0.15, delay: 0.25, reverb: 0.8, type: 'triangle' });
          break;
        }
        case 'spawn':
          this._burst({ type: 'bandpass', f0: 500, f1: 3500, q: 1.3, dur: 0.35, gain: 0.05, reverb: 0.6 });
          [76, 83, 88].forEach((n, i) => this._bell(midi(n), { gain: 0.05, dur: 1, delay: 0.08 + i * 0.06 }));
          break;
        case 'crate':
          if (!this._throttle('crate', 160)) break;
          this._burst({ type: 'bandpass', f0: rand(260, 380), q: 1.2, dur: 0.14, gain: 0.07 });
          this._tone({ f0: 90, f1: 70, dur: 0.12, gain: 0.05 });
          break;
        case 'bump':
          if (!this._throttle('bump', 150)) break;
          this._tone({ f0: 130, f1: 80, dur: 0.1, gain: 0.1 * Math.min(1, arg) });
          break;
        case 'tick':
          this._tone({ f0: 1100, dur: 0.05, gain: 0.05, type: 'triangle' });
          break;
        case 'hover':
          if (!this._throttle('hover', 50)) break;
          this._tone({ f0: 1250, f1: 1500, dur: 0.035, gain: 0.025, type: 'triangle' });
          break;
        case 'buy':
          this.play('coin'); this._bell(midi(91), { gain: 0.06, dur: 1.2, delay: 0.15 });
          break;
        case 'equip':
          this._tone({ f0: 520, f1: 780, dur: 0.1, gain: 0.07, type: 'triangle', reverb: 0.3 });
          this._bell(midi(84), { gain: 0.04, dur: 0.8, delay: 0.05 });
          break;
        case 'error':
          this._tone({ f0: 210, f1: 160, dur: 0.18, gain: 0.07, type: 'triangle' });
          break;
        case 'tap': case 'click':
        default:
          this._tone({ f0: 640, f1: 820, dur: 0.06, gain: 0.06, type: 'triangle', reverb: 0.2 });
      }
    } catch { /* audio is an enhancement only */ }
    void ctx;
  }

  // ── Continuous loops (rolling / ice slide, laser hum, lift motor) ───────────────────────────
  _startLoops() {
    const ctx = this.context;
    const make = (build) => { const nodes = build(); nodes.gain.gain.value = 0; return nodes; };
    const noiseLoop = (type, f, q) => {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer; src.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = f; filter.Q.value = q;
      const gain = ctx.createGain();
      src.connect(filter).connect(gain).connect(this.sfxBus);
      src.start();
      return { src, filter, gain };
    };
    this.loops.roll = make(() => noiseLoop('lowpass', 420, 0.5));
    this.loops.slide = make(() => noiseLoop('bandpass', 3200, 1.6));
    this.loops.hum = make(() => {
      const gain = ctx.createGain();
      const a = ctx.createOscillator(); a.type = 'sawtooth'; a.frequency.value = 98;
      const b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = 196.8;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 420;
      a.connect(filter); b.connect(filter); filter.connect(gain).connect(this.sfxBus);
      a.start(); b.start();
      return { gain, filter, a, b };
    });
    this.loops.lift = make(() => {
      const gain = ctx.createGain();
      const a = ctx.createOscillator(); a.type = 'triangle'; a.frequency.value = 58;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 220;
      a.connect(filter).connect(gain).connect(this.sfxBus);
      a.start();
      return { gain, a };
    });
  }

  /** Called every frame with the character's motion so rolling / sliding sounds follow it. */
  setMotion(speed01, onIce, grounded) {
    if (!this.context || !this.loops.roll) return;
    const t = this.context.currentTime, s = Math.min(1, Math.max(0, speed01));
    const live = grounded && !this.settings.muted ? s : 0;
    this.loops.roll.gain.gain.setTargetAtTime(onIce ? 0 : live * 0.05, t, 0.08);
    this.loops.roll.filter.frequency.setTargetAtTime(260 + s * 520, t, 0.1);
    this.loops.slide.gain.gain.setTargetAtTime(onIce ? live * 0.06 : 0, t, 0.1);
    this.loops.slide.filter.frequency.setTargetAtTime(2400 + s * 2600, t, 0.1);
    this.motion = { speed: s, ice: onIce, grounded };
  }

  /** 0..1 loudness of the nearest active laser (a calm electrical hum that swells as you approach). */
  setHum(level) {
    if (!this.context || !this.loops.hum) return;
    const t = this.context.currentTime;
    this.loops.hum.gain.gain.setTargetAtTime(Math.min(1, Math.max(0, level)) * 0.05, t, 0.1);
    this.loops.hum.filter.frequency.setTargetAtTime(300 + level * 500, t, 0.1);
  }

  setLift(active) {
    if (!this.context || !this.loops.lift) return;
    this.loops.lift.gain.gain.setTargetAtTime(active ? 0.05 : 0, this.context.currentTime, 0.25);
  }

  /** Silence all continuous loops (menus, pause, level change). */
  quiet() { this.setMotion(0, false, false); this.setHum(0); this.setLift(false); }

  // ── Generative music ────────────────────────────────────────────────────────────────────────
  startMusic(mood = 0) {
    this.mood = mood;
    if (!this.context) return;
    if (this.musicOn) return;
    this.musicOn = true;
    const now = this.context.currentTime;
    this.nextChordAt = now + 0.2;
    this.nextBellAt = now + 2;
    this.chordIndex = 0;
    clearInterval(this.scheduler);
    this.scheduler = setInterval(() => this._schedule(), 220);
  }

  setMood(index) { this.mood = index; }

  stopMusic() {
    this.musicOn = false;
    clearInterval(this.scheduler);
  }

  _root() { return KEYS[this.mood % KEYS.length]; }

  _schedule() {
    if (!this.context || this.context.state !== 'running' || !this.musicOn) return;
    const now = this.context.currentTime;
    while (this.nextChordAt < now + 1.5) {
      this._chord(this.nextChordAt, PROGRESSION[this.chordIndex % PROGRESSION.length]);
      this.chordIndex++;
      this.nextChordAt += 7.5;
    }
    while (this.nextBellAt < now + 1.5) {
      const chord = PROGRESSION[(this.chordIndex + PROGRESSION.length - 1) % PROGRESSION.length];
      const note = this._root() + 24 + pick(PENTATONIC) + (chord[0] > 0 ? 7 : 0) + pick([0, 0, 12]);
      this._musicBell(midi(note), this.nextBellAt - now);
      if (Math.random() < 0.3) this._musicBell(midi(note + pick([4, 7, 9])), this.nextBellAt - now + rand(0.18, 0.4), 0.7);
      this.nextBellAt += rand(1.3, 3.4);
    }
  }

  _chord(when, intervals) {
    const ctx = this.context, root = this._root();
    const delay = Math.max(0, when - ctx.currentTime);
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 0.4;
    filter.frequency.setValueAtTime(500, ctx.currentTime + delay);
    filter.frequency.linearRampToValueAtTime(1300, ctx.currentTime + delay + 3.5);
    filter.frequency.linearRampToValueAtTime(600, ctx.currentTime + delay + 8);
    const amp = ctx.createGain();
    filter.connect(amp).connect(this.musicBus);
    const send = ctx.createGain(); send.gain.value = 0.55; amp.connect(send).connect(this.reverbIn);
    const dur = 9.5;
    amp.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
    amp.gain.linearRampToValueAtTime(0.16, ctx.currentTime + delay + 2.4);
    amp.gain.linearRampToValueAtTime(0.1, ctx.currentTime + delay + 6);
    amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + dur);
    intervals.forEach((interval, i) => {
      for (const [type, detune, level] of [['triangle', -5, 0.5], ['sine', 6, 0.7], ['sine', 0, 0.35]]) {
        const osc = ctx.createOscillator(); osc.type = type; osc.detune.value = detune;
        osc.frequency.value = midi(root + 12 + interval + (i === 0 ? -12 : 0));
        const g = ctx.createGain(); g.gain.value = level / (i === 0 ? 1.4 : 2.2);
        osc.connect(g).connect(filter);
        osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + dur + 0.1);
      }
    });
    // A warm sub drone under the chord's root.
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = midi(root + intervals[0] - 12);
    const subGain = ctx.createGain(); subGain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
    subGain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + delay + 3);
    subGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + dur);
    sub.connect(subGain).connect(this.musicBus);
    sub.start(ctx.currentTime + delay); sub.stop(ctx.currentTime + delay + dur + 0.1);
  }

  _musicBell(freq, delay, scale = 1) {
    this._bell(freq, { gain: 0.07 * scale, dur: 3.2, delay: Math.max(0, delay), bus: this.musicBus, echo: 0.55, reverb: 0.8 });
  }
}
