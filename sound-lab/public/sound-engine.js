// Smooth Wave-Link + Continuous Dark Bass Outline Sound Engine for Calculus
// Includes:
// 1. Continuous Dark Bass Outline ("Singer's Background Bass"): stays alive while exploring,
//    glides smoothly as you move forward/backward, holds steady when you stop, and dips at open holes.
// 2. Stepped Foreground Pulses (every 0.5 or 1.0 units): rides on top of the bass outline.
// 3. Multiple selectable Sound Profiles and Background Bass Modes in Settings.
// 4. Master DynamicsCompressor limiter + voice stealing so rapid stepping never clips or muddies.

import { playVoice, VOICES } from './voices.js';

export const CLASSIC_PROFILES = ['gentle', 'warm-acoustic', 'soft-synth', 'crisp-piano', 'high-contrast', 'progress'];

export class CalculusSoundEngine {
  constructor() {
    this.ctx = null;
    this.masterCompressor = null;
    this.noiseBuffer = null;

    // User-configurable settings
    this.volume = 0.25;
    this.bassOutlineVolume = 0.35; // Relative level of the continuous dark bass outline
    this.bassOutlineMode = 'x-and-y'; // 'x-and-y' | 'x-only' | 'y-only' | 'off'
    // 'gentle' is the default since an ear test (29 Oct 2026): no sharp attacks.
    this.soundProfile = 'gentle'; // 'gentle' | 'warm-acoustic' | 'soft-synth' | 'crisp-piano' | 'high-contrast'
    this.cuesEnabled = true;
    this.stepDurationSeconds = 0.4;

    // Persistent Continuous Dark Bass Outline nodes
    this.droneActive = false;
    this.droneOscMain = null;
    this.droneOscSub = null;
    this.droneFilter = null;
    this.droneGain = null;
    this.dronePanner = null;

    // Track current foreground step gain node for clean voice transitions on rapid keypresses
    this.lastStepGain = null;

    // The graph's y window, for the 'progress' profile (set by the notebook's graph mode).
    this.yRange = null;

    // Dot and corner sounds: 'new' (bump for a solid dot, wind for an open dot, a slide through
    // a corner) or 'original' (the held tone and the air breath from before).
    this.dotSounds = 'new';

    // Clearer pitch: each step's note starts at the last step's pitch and slides to its own, so
    // going up is a short rise and going down a short fall, and the notes are a little further
    // apart. Off is exactly the original sound.
    this.pitchGlide = true;
    this.lastProgressFreq = null;
  }

  setPitchGlide(on) {
    this.pitchGlide = Boolean(on);
  }

  // The pitch to slide from: the last step's, when the height changed.
  slideFrom(prevY, y, freqOf) {
    if (!this.pitchGlide || !Number.isFinite(prevY) || !Number.isFinite(y) || prevY === y) return null;
    const f = freqOf(prevY);
    return f > 0 ? f : null;
  }

  setDotSounds(mode) {
    if (['new', 'original'].includes(mode)) this.dotSounds = mode;
  }

  // { y: [bottom, top] } of the graph being explored, or null.
  setWindow(span) {
    const r = span && span.y;
    this.yRange = Array.isArray(r) && r.every(Number.isFinite) && r[1] > r[0] ? [r[0], r[1]] : null;
  }

  // 'progress' profile: one short, rounded beep per step whose pitch climbs steadily from the
  // bottom of the graph (220 Hz) to the top (880 Hz), like NVDA's progress bar going from 0 to
  // 100. No jump at zero and no wrap: the same height is always the same pitch on this graph.
  // Above zero the beep is clear; below zero it is softer and rounder. At y = 0 a quiet octave
  // rings with it, so zero is recognisable as home.
  progressFrequency(y) {
    const [y0, y1] = this.yRange;
    const t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0)));
    return 220 * Math.pow(2, t * 2);
  }

  playProgressBeep(x, y, boundary, prevY = null) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const [y0, y1] = this.yRange;
    const freq = this.progressFrequency(y);
    const from = this.slideFrom(prevY, y, (v) => this.progressFrequency(v));
    if (this.lastStepGain) {
      try { this.lastStepGain.gain.setTargetAtTime(0.0005, now, 0.02); } catch {}
    }
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(this.computePan(x, boundary), now);
    panner.connect(this.masterCompressor);
    const below = y < -1e-9;
    const home = Math.abs(y) <= (y1 - y0) * 0.005;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    this.lastStepGain = gain;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(from || freq, now);
    if (from) osc.frequency.exponentialRampToValueAtTime(freq, now + 0.05);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(below ? freq * 1.3 : freq * 5, now);
    const peak = this.volume * 0.8 * Math.pow(330 / freq, 0.3) * (below ? 0.8 : 1);
    const length = Math.max(0.12, Math.min(0.22, this.stepDurationSeconds * 0.45));
    gain.gain.setValueAtTime(0.0005, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + length);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    osc.start(now);
    osc.stop(now + length + 0.02);
    if (home) {
      const ring = ctx.createOscillator();
      const rg = ctx.createGain();
      ring.type = 'sine';
      ring.frequency.setValueAtTime(freq * 2, now);
      rg.gain.setValueAtTime(0.0005, now);
      rg.gain.linearRampToValueAtTime(this.volume * 0.18, now + 0.02);
      rg.gain.exponentialRampToValueAtTime(0.0005, now + length + 0.15);
      ring.connect(rg);
      rg.connect(panner);
      ring.start(now);
      ring.stop(now + length + 0.17);
    }
    return { region: below ? 'bass' : y > 1e-9 ? 'tin' : 'zero', frequency: freq, gear: 0, stepInGear: 0 };
  }

  ensureContext() {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterCompressor = this.ctx.createDynamicsCompressor();
      this.masterCompressor.threshold.setValueAtTime(-14, this.ctx.currentTime);
      this.masterCompressor.knee.setValueAtTime(12, this.ctx.currentTime);
      this.masterCompressor.ratio.setValueAtTime(6, this.ctx.currentTime);
      this.masterCompressor.attack.setValueAtTime(0.005, this.ctx.currentTime);
      this.masterCompressor.release.setValueAtTime(0.15, this.ctx.currentTime);
      this.masterCompressor.connect(this.ctx.destination);
      this.noiseBuffer = this.createNoiseBuffer(0.3);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  createNoiseBuffer(durationSeconds) {
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSeconds);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  setVolume(value) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      this.volume = Math.max(0.02, Math.min(0.5, num));
      this.refreshDroneGain();
    }
  }

  setBassOutlineVolume(value) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      this.bassOutlineVolume = Math.max(0.0, Math.min(1.0, num));
      this.refreshDroneGain();
    }
  }

  setBassOutlineMode(mode) {
    if (['x-and-y', 'x-only', 'y-only', 'off'].includes(mode)) {
      this.bassOutlineMode = mode;
      if (mode === 'off') {
        this.stopBassOutline();
      }
    }
  }

  setSoundProfile(profile) {
    if (CLASSIC_PROFILES.includes(profile) || VOICES.includes(profile)) {
      this.soundProfile = profile;
    }
  }

  setCuesEnabled(enabled) {
    this.cuesEnabled = Boolean(enabled);
  }

  setStepDelayMs(delayMs) {
    const sec = Number(delayMs) / 1000;
    if (Number.isFinite(sec) && sec >= 0.08 && sec <= 2.0) {
      this.stepDurationSeconds = sec;
    }
  }

  computePan(x, boundary = 5) {
    if (!Number.isFinite(x) || Math.abs(x) <= 1e-7) return 0;
    const safeBoundary = Math.max(1, Number(boundary) || 5);
    return Math.max(-0.92, Math.min(0.92, x / safeBoundary));
  }

  // Computes the Continuous Dark Bass Outline frequency (65 Hz .. 185 Hz)
  // Always stays in the warm, dark vocal-bass register so it never clashes with the foreground step pulses.
  computeBassOutlineFrequency(x, y, boundary = 5) {
    const safeBoundary = Math.max(1, Number(boundary) || 5);
    const normX = Math.max(-1, Math.min(1, (Number.isFinite(x) ? x : 0) / safeBoundary)); // -1 (left) .. +1 (right)
    const normY = Number.isFinite(y)
      ? Math.max(-1.5, Math.min(1.5, y / safeBoundary))
      : 0;

    if (this.bassOutlineMode === 'x-only') {
      // Pure X tracking: moves smoothly up as X goes forward (-boundary -> +boundary),
      // and moves smoothly down as X goes backward (+boundary -> -boundary).
      // Base 110 Hz (A2) at X = 0; 73.4 Hz (D2) at left edge; 164.8 Hz (E3) at right edge.
      return 110.0 * Math.pow(2, (normX * 7) / 12);
    }

    if (this.bassOutlineMode === 'y-only') {
      // Pure Y contour tracking in dark bass register: 110 Hz at Y = 0, 65 Hz at bottom, 185 Hz at top.
      return 110.0 * Math.pow(2, (normY * 6) / 12);
    }

    // Default 'x-and-y' (Combined Forward/Backward X progression + Curve Y contour):
    // 55% X direction + 45% Y contour so you ALWAYS hear forward vs. backward movement even on a flat line,
    // while also feeling the curve's rise and fall in the dark bass bed.
    const combinedSemitones = normX * 4.5 + normY * 4.5;
    const freq = 110.0 * Math.pow(2, combinedSemitones / 12);
    return Math.max(55.0, Math.min(210.0, freq));
  }

  ensureBassOutlineNodes() {
    if (this.bassOutlineMode === 'off') return false;
    const ctx = this.ensureContext();
    if (this.droneActive && this.droneOscMain) return true;

    const now = ctx.currentTime;
    this.droneOscMain = ctx.createOscillator();
    this.droneOscSub = ctx.createOscillator();
    this.droneFilter = ctx.createBiquadFilter();
    this.droneGain = ctx.createGain();
    this.dronePanner = ctx.createStereoPanner();

    // Rich, dark vocal-style bass pad: soft sawtooth + warm sub-sine through a dark 195 Hz low-pass filter
    this.droneOscMain.type = 'triangle';
    this.droneOscSub.type = 'sine';

    this.droneOscMain.frequency.setValueAtTime(110, now);
    this.droneOscSub.frequency.setValueAtTime(55, now);

    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.setValueAtTime(210, now);
    this.droneFilter.Q.setValueAtTime(1.4, now);

    this.droneGain.gain.setValueAtTime(0.0001, now);
    this.dronePanner.pan.setValueAtTime(0, now);

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.65, now);

    this.droneOscMain.connect(this.droneFilter);
    this.droneOscSub.connect(subGain);
    subGain.connect(this.droneFilter);
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.dronePanner);
    this.dronePanner.connect(this.masterCompressor);

    this.droneOscMain.start(now);
    this.droneOscSub.start(now);
    this.droneActive = true;
    return true;
  }

  refreshDroneGain(multiplier = 1.0) {
    if (!this.droneActive || !this.droneGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const targetGain =
      this.bassOutlineMode === 'off'
        ? 0.0001
        : Math.max(0.0001, this.volume * this.bassOutlineVolume * 0.85 * multiplier);
    this.droneGain.gain.setTargetAtTime(targetGain, now, 0.035);
  }

  // Updates (or starts) the Continuous Dark Bass Outline as you move or hold at (x, y)
  updateBassOutline(x, lim, boundary = 5) {
    if (this.bassOutlineMode === 'off') {
      this.stopBassOutline();
      return;
    }
    if (!this.ensureBassOutlineNodes()) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const pan = this.computePan(x, boundary);
    const glideTime = Math.max(0.03, Math.min(0.14, this.stepDurationSeconds * 0.28));

    this.dronePanner.pan.setTargetAtTime(pan, now, glideTime);

    // Edge case: Open Hole (point is missing) -> dip the dark bass outline so you feel the hole in the thread
    if (!lim.defined && lim.hole) {
      const freq = this.computeBassOutlineFrequency(x, lim.y, boundary);
      this.droneOscMain.frequency.setTargetAtTime(freq, now, glideTime);
      this.droneOscSub.frequency.setTargetAtTime(freq * 0.5, now, glideTime);
      this.droneFilter.frequency.setTargetAtTime(130, now, 0.02);
      this.refreshDroneGain(0.15); // Dip volume by 85% at the open hole
      return;
    }

    // Edge case: Undefined / outside domain -> mute the outline until back on the curve
    if (!lim.defined) {
      this.refreshDroneGain(0.02);
      return;
    }

    const freq = this.computeBassOutlineFrequency(x, lim.y, boundary);
    this.droneOscMain.frequency.setTargetAtTime(freq, now, glideTime);
    this.droneOscSub.frequency.setTargetAtTime(freq * 0.5, now, glideTime);

    // Open filter slightly when Y > 0, keep darker when Y < 0
    const cutoff = lim.y > 0 ? 245 : lim.y < 0 ? 175 : 210;
    this.droneFilter.frequency.setTargetAtTime(cutoff, now, glideTime);
    this.refreshDroneGain(1.0);
  }

  stopBassOutline() {
    if (!this.droneActive || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      this.droneGain.gain.setTargetAtTime(0.0001, now, 0.03);
      const osc1 = this.droneOscMain;
      const osc2 = this.droneOscSub;
      window.setTimeout(() => {
        try { osc1.stop(); } catch {}
        try { osc2.stop(); } catch {}
      }, 140);
    } catch {}
    this.droneActive = false;
    this.droneOscMain = null;
    this.droneOscSub = null;
    this.droneFilter = null;
    this.droneGain = null;
    this.dronePanner = null;
  }

  stopAll() {
    this.stopBassOutline();
  }

  // Quantizes Y into discrete step levels with 10-unit octave gear wrapping
  computeQuantizedLevel(y) {
    if (!Number.isFinite(y)) return { region: 'undefined', frequency: 0, gear: 0, stepInGear: 0 };
    if (Math.abs(y) <= 1e-6) {
      return { region: 'zero', frequency: 330.0, gear: 0, stepInGear: 0 };
    }
    const quantizedAbs = Math.max(0.25, Math.round(Math.abs(y) * 4) / 4);
    const gear = Math.floor((quantizedAbs - 0.001) / 10);
    const stepInGear = Number((quantizedAbs - gear * 10).toPrecision(4));

    if (y > 0) {
      // Clearer pitch spreads the notes a little (2 semitones a unit); off, the original 1.5.
      const semitonesUp = stepInGear * (this.pitchGlide ? 2 : 1.5);
      const frequency = Math.min(1600, 440.0 * Math.pow(2, semitonesUp / 12));
      return { region: 'tin', frequency, gear, stepInGear };
    }

    const semitonesDown = stepInGear * (this.pitchGlide ? 1.6 : 1.3);
    const frequency = Math.max(85, 220.0 * Math.pow(2, -semitonesDown / 12));
    return { region: 'bass', frequency, gear, stepInGear };
  }

  // Plays the foreground step pulse according to the user's selected Sound Profile
  playSeatedPulse(x, y, boundary = 5, prevY = null) {
    if (this.soundProfile === 'progress' && this.yRange && Number.isFinite(y)) return this.playProgressBeep(x, y, boundary, prevY);
    const ctx = this.ensureContext();
    const pan = this.computePan(x, boundary);
    const level = this.computeQuantizedLevel(y);
    if (level.region === 'undefined') return level;

    const now = ctx.currentTime;

    // Smoothly duck previous step note if still ringing so rapid key presses never muddy or clip
    if (this.lastStepGain) {
      try {
        this.lastStepGain.gain.setTargetAtTime(0.0005, now, 0.025);
      } catch {}
    }

    const noteHold = Math.max(0.18, Math.min(0.6, this.stepDurationSeconds * 0.8));
    const noteTotal = noteHold + 0.16;

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, now);
    panner.connect(this.masterCompressor);

    if (
      this.cuesEnabled &&
      Number.isFinite(prevY) &&
      Number.isFinite(y) &&
      Math.sign(prevY) === Math.sign(y) &&
      y !== 0
    ) {
      const prevLevel = this.computeQuantizedLevel(prevY);
      if (prevLevel.gear !== level.gear) {
        this.playGearShiftTick(pan, level.gear > prevLevel.gear);
      }
    }

    const from = this.slideFrom(prevY, y, (v) => this.computeQuantizedLevel(v).frequency);

    // Instruments, beeps and game sounds (voices.js), at the same pitch for the same height.
    if (VOICES.includes(this.soundProfile)) {
      const voiceGain = ctx.createGain();
      voiceGain.connect(panner);
      this.lastStepGain = voiceGain;
      playVoice(ctx, voiceGain, this.soundProfile, { freq: level.frequency, fromFreq: from, when: now, length: this.stepDurationSeconds, volume: this.volume });
      return level;
    }

    // Configure waveform & filter according to selected Sound Profile
    const profile = this.soundProfile;
    const oscMain = ctx.createOscillator();
    const oscColor = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const colorGain = ctx.createGain();
    this.lastStepGain = gain;

    const freq = level.frequency;
    oscMain.frequency.setValueAtTime(from || freq, now);
    const glideTime = Math.min(0.08, noteHold * 0.3);
    if (from) oscMain.frequency.exponentialRampToValueAtTime(freq, now + glideTime);
    // The colour tone slides with the main one, keeping its distance.
    const colorAt = (f) => {
      oscColor.frequency.setValueAtTime(from ? (from * f) / freq : f, now);
      if (from) oscColor.frequency.exponentialRampToValueAtTime(f, now + glideTime);
    };

    if (profile === 'gentle') {
      // Pure tone with a quiet octave below, rounded off above 1.1 kHz: nothing sharp.
      oscMain.type = 'sine';
      oscColor.type = 'triangle';
      colorAt(freq * 0.5);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1100, now);
      colorGain.gain.setValueAtTime(this.volume * 0.25, now);
      colorGain.gain.exponentialRampToValueAtTime(0.0005, now + noteHold);
    } else if (profile === 'soft-synth') {
      // Ultra-smooth pure sine + soft octave sine
      oscMain.type = 'sine';
      oscColor.type = 'sine';
      colorAt(level.region === 'bass' ? freq * 0.5 : freq * 2.0);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(level.region === 'bass' ? 280 : 1800, now);
      colorGain.gain.setValueAtTime(this.volume * 0.2, now);
      colorGain.gain.exponentialRampToValueAtTime(0.0005, now + noteHold);
    } else if (profile === 'crisp-piano') {
      // Plucked electric-piano / string definition on each step
      oscMain.type = 'triangle';
      oscColor.type = 'sine';
      colorAt(freq * 2.0);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(level.region === 'bass' ? 420 : 2400, now);
      filter.frequency.exponentialRampToValueAtTime(level.region === 'bass' ? 190 : 900, now + noteHold);
      colorGain.gain.setValueAtTime(this.volume * 0.4, now);
      colorGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.08);
    } else if (profile === 'high-contrast') {
      // Maximum distinction between deep sub-bass (Y < 0) and bright metallic chime (Y > 0)
      oscMain.type = level.region === 'bass' ? 'triangle' : 'sawtooth';
      oscColor.type = 'sine';
      colorAt(level.region === 'bass' ? freq * 0.5 : freq * 2.5);
      filter.type = level.region === 'bass' ? 'lowpass' : 'highpass';
      filter.frequency.setValueAtTime(level.region === 'bass' ? 240 : 580, now);
      colorGain.gain.setValueAtTime(this.volume * 0.3, now);
      colorGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.1);
    } else {
      // Default 'warm-acoustic' (Marimba & Glass Vibraphone)
      oscMain.type = 'sine';
      oscColor.type = 'triangle';
      colorAt(level.region === 'bass' ? freq * 2.0 : freq * 3.0);
      filter.type = level.region === 'bass' ? 'lowpass' : 'highpass';
      filter.frequency.setValueAtTime(level.region === 'bass' ? 290 : 380, now);
      colorGain.gain.setValueAtTime(this.volume * 0.22, now);
      colorGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.11);
    }

    const attackTime = profile === 'crisp-piano' ? 0.008 : profile === 'gentle' ? 0.06 : 0.02;
    const peakGain = (level.region === 'bass' ? this.volume * 1.05 : this.volume * 0.72) * (profile === 'gentle' ? 0.8 : 1);

    gain.gain.setValueAtTime(0.0005, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + attackTime);
    gain.gain.exponentialRampToValueAtTime(peakGain * 0.42, now + noteHold);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + noteTotal);

    oscMain.connect(filter);
    oscColor.connect(colorGain);
    colorGain.connect(filter);
    filter.connect(gain);
    gain.connect(panner);

    oscMain.start(now);
    oscColor.start(now);
    oscMain.stop(now + noteTotal + 0.02);
    oscColor.stop(now + noteTotal + 0.02);
    return level;
  }

  playGearShiftTick(pan, goingUp) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, now);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(goingUp ? 480 : 640, now);
    osc.frequency.exponentialRampToValueAtTime(goingUp ? 640 : 480, now + 0.045);

    gain.gain.setValueAtTime(this.volume * 0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.055);

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.masterCompressor);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  // mark: the point of interest itself (a corner's slopes); delay: seconds from now, so a
  // jump's two dots are heard one after the other.
  playLandmarkEffect(kind, x = 0, boundary = 5, baseY = 0, mark = null, delay = 0) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime + Math.max(0, delay);
    const pan = kind === 'origin' || kind === 'y-axis' ? 0 : this.computePan(x, boundary);
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, now);
    panner.connect(this.masterCompressor);

    if (this.dotSounds === 'new') {
      // At the dot's own step pitch, so a dot off the curve (a jump's other end) is heard where it is.
      const freq = (Number.isFinite(baseY) && this.computeQuantizedLevel(baseY).frequency) || 330;
      if (kind === 'solid-point' || (kind === 'endpoint' && mark?.included !== false)) { this.playBump(panner, now, freq, kind === 'endpoint' ? 0.6 : 1); return; }
      if (kind === 'open-point' || kind === 'endpoint') { this.playWind(panner, now, freq, kind === 'endpoint' ? 0.6 : 1); return; }
      if (kind === 'corner') { this.playCorner(panner, now, freq, mark || {}); return; }
    }

    if (kind === 'origin') {
      // A soft chime: bell-like partials that ring out slowly, centred in stereo.
      const partials = [[523.25, 0.32], [784.0, 0.18], [1046.5, 0.08]];
      for (const [freq, level] of partials) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.0005, now);
        gain.gain.linearRampToValueAtTime(this.volume * level, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + 1.1);
        osc.connect(gain);
        gain.connect(panner);
        osc.start(now);
        osc.stop(now + 1.15);
      }
      return;
    }

    if (kind === 'x-axis' || kind === 'y-axis') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(420, now);
      osc.frequency.exponentialRampToValueAtTime(190, now + 0.028);
      gain.gain.setValueAtTime(this.volume * 0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.032);
      osc.connect(gain);
      gain.connect(panner);
      osc.start(now);
      osc.stop(now + 0.035);
      return;
    }

    if (kind === 'maximum' || kind === 'minimum') {
      const baseLevel = this.computeQuantizedLevel(Number.isFinite(baseY) ? baseY : kind === 'maximum' ? 2 : -2);
      const rootFreq = baseLevel.frequency || (kind === 'maximum' ? 587.33 : 196.0);
      const shimmerFreq = kind === 'maximum' ? rootFreq * 1.5 : rootFreq * 0.75;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(shimmerFreq, now + 0.025);

      gain.gain.setValueAtTime(0.0005, now + 0.025);
      gain.gain.linearRampToValueAtTime(this.volume * 0.45, now + 0.055);
      gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.25);

      osc.connect(gain);
      gain.connect(panner);
      osc.start(now + 0.025);
      osc.stop(now + 0.26);
      return;
    }

    if (kind === 'solid-point') {
      // A steady, held tone at the curve's own pitch: a solid dot "sits" on the line.
      const level = this.computeQuantizedLevel(Number.isFinite(baseY) ? baseY : 0);
      const freq = level.frequency || 330;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(900, now);
      gain.gain.setValueAtTime(0.0005, now);
      gain.gain.linearRampToValueAtTime(this.volume * 0.55, now + 0.05);
      gain.gain.setValueAtTime(this.volume * 0.55, now + 0.4);
      gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.6);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      osc.start(now);
      osc.stop(now + 0.62);
      return;
    }

    if (kind === 'asymptote' || kind === 'undefined') {
      // Outside the domain / at a pole: a short, quiet, muffled low knock.
      // Deliberately different from the open-hole "air breath" below, so a
      // listener can tell "a single missing point" from "no curve here".
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(95, now);
      osc.frequency.exponentialRampToValueAtTime(60, now + 0.07);
      gain.gain.setValueAtTime(0.0005, now);
      gain.gain.linearRampToValueAtTime(this.volume * 0.35, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.09);
      osc.connect(gain);
      gain.connect(panner);
      osc.start(now);
      osc.stop(now + 0.1);
      return;
    }

    if (kind === 'open-point') {
      if (this.noiseBuffer) {
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.setValueAtTime(4.5, now);
        bp.frequency.setValueAtTime(680, now);
        bp.frequency.exponentialRampToValueAtTime(260, now + 0.16);

        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(0.001, now);
        nGain.gain.linearRampToValueAtTime(this.volume * 0.9, now + 0.02);
        nGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.18);

        noise.connect(bp);
        bp.connect(nGain);
        nGain.connect(panner);
        noise.start(now);
        noise.stop(now + 0.19);
      }
    }
  }

  // A solid dot: a small soft bump, like a fingertip finding a raised dot. A short knock that
  // drops in pitch from the dot's height, with a tiny soft click on top.
  playBump(panner, now, freq, level = 1) {
    const ctx = this.ctx;
    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(freq, now);
    body.frequency.exponentialRampToValueAtTime(freq * 0.55, now + 0.09);
    bodyGain.gain.setValueAtTime(0.0005, now);
    bodyGain.gain.linearRampToValueAtTime(this.volume * 0.9 * level, now + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.16);
    body.connect(bodyGain);
    bodyGain.connect(panner);
    body.start(now);
    body.stop(now + 0.18);
    if (!this.noiseBuffer) return;
    const click = ctx.createBufferSource();
    click.buffer = this.noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, now);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(this.volume * 0.4 * level, now);
    clickGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.018);
    click.connect(lp);
    lp.connect(clickGain);
    clickGain.connect(panner);
    click.start(now);
    click.stop(now + 0.02);
  }

  // An open dot: a small breath of wind through a hollow, whistling softly at the dot's height
  // and swelling in and out, so it sounds empty where a solid dot sounds firm.
  playWind(panner, now, freq, level = 1) {
    const ctx = this.ctx;
    if (!this.noiseBuffer) return;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.setValueAtTime(9, now);
    bp.frequency.setValueAtTime(freq * 0.85, now);
    bp.frequency.exponentialRampToValueAtTime(freq * 1.12, now + 0.14);
    bp.frequency.exponentialRampToValueAtTime(freq * 0.9, now + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0005, now);
    g.gain.linearRampToValueAtTime(this.volume * 2.0 * level, now + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.28);
    noise.connect(bp);
    bp.connect(g);
    g.connect(panner);
    noise.start(now);
    noise.stop(now + 0.29);
  }

  // A sharp corner: a slide that follows the curve through it. Down then up for a valley corner
  // like |x|, up then down for a peak corner; where the curve keeps rising, a gentle rise then a
  // steeper one. Steeper sides slide further.
  playCorner(panner, now, freq, mark) {
    const ctx = this.ctx;
    const amount = (m) => (Number.isFinite(m) ? Math.atan(m) / (Math.PI / 2) : Math.sign(m) || 0); // -1 .. 1
    const start = freq * Math.pow(2, (-amount(mark.slopeLeft) * 7) / 12);
    const end = freq * Math.pow(2, (amount(mark.slopeRight) * 7) / 12);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(start, now);
    osc.frequency.exponentialRampToValueAtTime(freq, now + 0.11);
    osc.frequency.exponentialRampToValueAtTime(end, now + 0.22);
    g.gain.setValueAtTime(0.0005, now);
    g.gain.linearRampToValueAtTime(this.volume * 0.5, now + 0.03);
    g.gain.setValueAtTime(this.volume * 0.5, now + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.27);
    osc.connect(g);
    g.connect(panner);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  // Executes a step:
  // - During continuous Auto-Play (withBassOutline = true), updates and sustains the Continuous Dark Bass Outline.
  // - During manual J/K stepping (withBassOutline = false), plays only the discrete step pulse (+ optional cue) with no lingering drone.
  playStepSequence({ x, lim, boundary, prevY, passedOver = [], landedOn = [], withBassOutline = false }) {
    if (this.dotSounds !== 'new') return this.playStepSequenceOriginal({ x, lim, boundary, prevY, passedOver, landedOn, withBassOutline });
    // The dots at this x, solid first: a jump has a solid dot at one height and an open one at
    // the other, and both are heard, one after the other, each at its own height.
    const dots = landedOn.filter((l) => l.kind === 'solid-point' || l.kind === 'open-point')
      .sort((a, b) => (a.kind === 'solid-point' ? 0 : 1) - (b.kind === 'solid-point' ? 0 : 1));
    const missing = !lim.defined && (lim.hole || dots.some((d) => d.kind === 'open-point'));
    if (withBassOutline) {
      this.updateBassOutline(x, missing ? { defined: false, hole: true, y: Number.isFinite(lim.y) ? lim.y : dots[0]?.y } : lim, boundary);
    } else if (this.droneActive) {
      this.stopBassOutline();
    }
    const playDots = (first) => dots.forEach((d, i) => this.playLandmarkEffect(d.kind, x, boundary, Number.isFinite(d.y) ? d.y : lim.y, d, first + i * 0.16));

    if (!lim.defined) {
      if (!this.cuesEnabled) return;
      if (dots.length) playDots(0);
      else if (lim.hole) this.playLandmarkEffect('open-point', x, boundary, lim.y);
      else this.playLandmarkEffect('asymptote', x, boundary, 0);
      return;
    }
    // On a corner, the corner's slide (which passes through this height) is the step's note.
    const corner = this.cuesEnabled ? landedOn.find((l) => l.kind === 'corner') : null;
    if (corner) this.playLandmarkEffect('corner', x, boundary, lim.y, corner);
    else this.playSeatedPulse(x, lim.y, boundary, prevY);
    if (!this.cuesEnabled) return;
    if (dots.length) { playDots(0.03); return; }

    const priority = ['endpoint', 'corner', 'origin', 'maximum', 'minimum', 'x-axis'];
    const events = [...landedOn, ...passedOver].filter((e) => priority.includes(e.kind) && e !== corner);
    if (events.length > 0) {
      events.sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
      const top = events[0];
      this.playLandmarkEffect(top.kind, top.x, boundary, Number.isFinite(top.y) ? top.y : lim.y, top, top.kind === 'corner' ? 0.05 : 0);
    }
  }

  // The step as it sounded before the bump, wind and corner sounds (Settings: original).
  playStepSequenceOriginal({ x, lim, boundary, prevY, passedOver = [], landedOn = [], withBassOutline = false }) {
    const hasOpenHoleHere = (!lim.defined && lim.hole) || landedOn.some((l) => l.kind === 'open-point');

    if (withBassOutline) {
      this.updateBassOutline(
        x,
        hasOpenHoleHere ? { defined: false, hole: true, y: lim.y } : lim,
        boundary
      );
    } else if (this.droneActive) {
      this.stopBassOutline();
    }

    if (hasOpenHoleHere) {
      if (this.cuesEnabled) {
        this.playLandmarkEffect('open-point', x, boundary, lim.y);
      }
      return;
    }

    if (!lim.defined && !lim.hole) {
      if (this.cuesEnabled) {
        this.playLandmarkEffect('asymptote', x, boundary, 0);
      }
      return;
    }

    // 2. Play the foreground step pulse on top of the continuous dark bass outline
    this.playSeatedPulse(x, lim.y, boundary, prevY);

    if (!this.cuesEnabled) {
      return;
    }

    const priority = ['open-point', 'solid-point', 'origin', 'maximum', 'minimum', 'x-axis'];
    const allEvents = [...landedOn, ...passedOver].filter((e) => priority.includes(e.kind));
    if (allEvents.length > 0) {
      allEvents.sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
      const top = allEvents[0];
      this.playLandmarkEffect(top.kind, top.x, boundary, Number.isFinite(top.y) ? top.y : lim.y);
    }
  }
}
