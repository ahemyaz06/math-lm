import {
  addCoordinate,
  compileEquation,
  detectLandmarks,
  findStepEvents,
  formatNumber,
  sampleFunctionPath,
} from '/graph-math.js';
import { CalculusSoundEngine } from '/sound-engine.js';

const sound = new CalculusSoundEngine();

const form = document.getElementById('equation-form');
const eqInput = document.getElementById('equation-input');
const openSettingsBtn = document.getElementById('open-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const settingsDialog = document.getElementById('settings-dialog');
const profileSelect = document.getElementById('profile-select');
const bassModeSelect = document.getElementById('bass-mode-select');
const stepSelect = document.getElementById('step-select');
const rateSelect = document.getElementById('rate-select');
const cuesCheckbox = document.getElementById('cues-checkbox');
const boundarySelect = document.getElementById('boundary-select');
const volumeInput = document.getElementById('volume-input');
const bassOutlineVolumeInput = document.getElementById('bass-outline-volume');
const soundPad = document.getElementById('sound-pad');
const visualReadout = document.getElementById('visual-readout');
const eventBanner = document.getElementById('last-event-banner');
const svg = document.getElementById('graph-svg');
const liveStatus = document.getElementById('on-demand-status');

const STEP_OPTIONS = [0.5, 1.0, 0.25];
const RATE_OPTIONS = [800, 400, 250, 150];
const BASS_MODES = ['x-and-y', 'x-only', 'y-only', 'off'];
const BASS_MODE_LABELS = {
  'x-and-y': 'Combined X direction and Y contour',
  'x-only': 'Horizontal X direction only',
  'y-only': 'Curve Y height only',
  'off': 'Off',
};

let graph = null;
let boundary = 5;
let stepSize = 0.5;
let pulseRateMs = 400;
let cuesEnabled = true;
let bassMode = 'x-and-y';
let soundProfile = 'gentle';
let currentX = 0;
let prevY = null;
let customPoints = [];
let landmarks = [];
let lastStepEvents = { passedOver: [], landedOn: [] };
let autoTimer = null;
let announceCounter = 0;
let lastManualStepTime = 0;

sound.setStepDelayMs(pulseRateMs);
sound.setCuesEnabled(cuesEnabled);
sound.setBassOutlineMode(bassMode);
sound.setSoundProfile(soundProfile);

function speakOnDemand(text) {
  announceCounter += 1;
  const suffix = announceCounter % 2 === 0 ? '\u200B' : '';
  liveStatus.textContent = `${text}${suffix}`;
}

function stopAutoPlay(silent = true) {
  if (autoTimer !== null) {
    window.clearInterval(autoTimer);
    autoTimer = null;
    if (!silent) {
      speakOnDemand(`Paused at X ${formatNumber(currentX)}.`);
    }
    updateVisualBanner('Movement paused.');
  }
  sound.stopBassOutline();
}

// Stop continuous bass drone if browser tab is hidden or Sound Pad loses focus to another control
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoPlay(true);
    sound.stopBassOutline();
  }
});

soundPad.addEventListener('blur', () => {
  stopAutoPlay(true);
  sound.stopBassOutline();
});

function loadEquationText(rawText, presetPoints = [], announce = true) {
  stopAutoPlay(true);
  sound.stopBassOutline();
  try {
    const compiled = compileEquation(rawText);
    graph = compiled;
    customPoints = [...presetPoints];
    landmarks = detectLandmarks(graph, boundary, customPoints);
    currentX = 0;
    const lim = graph.limitAt(currentX);
    prevY = lim.defined || lim.hole ? lim.y : null;
    lastStepEvents = findStepEvents(landmarks, currentX, currentX);
    renderSvg();
    updateVisualBanner();
    if (announce) {
      speakOnDemand(`Loaded ${graph.label}. Focus the Stereo Sound Pad to explore.`);
    }
    return true;
  } catch (err) {
    speakOnDemand(`Equation error: ${err.message}`);
    updateVisualBanner(`Error: ${err.message}`);
    return false;
  }
}

function describeVoiceRegion(lim) {
  if (!lim.defined && lim.hole) {
    return `Open hole (limit Y = ${formatNumber(lim.y)})`;
  }
  if (!lim.defined) {
    return 'Undefined';
  }
  const lvl = sound.computeQuantizedLevel(lim.y);
  if (lvl.region === 'zero') return 'Zero line (Y = 0)';
  if (lvl.region === 'tin') {
    return `Treble +${lvl.stepInGear}${lvl.gear > 0 ? ` (Gear +${lvl.gear * 10})` : ''}`;
  }
  if (lvl.region === 'bass') {
    return `Bass -${lvl.stepInGear}${lvl.gear > 0 ? ` (Gear -${lvl.gear * 10})` : ''}`;
  }
  return '';
}

function updateVisualBanner(extraText = '') {
  if (!graph) return;
  const lim = graph.limitAt(currentX);
  const yText = lim.defined ? formatNumber(lim.y) : lim.hole ? `hole at ${formatNumber(lim.y)}` : 'undefined';
  const voiceDesc = describeVoiceRegion(lim);
  const cueState = cuesEnabled ? 'Cues: ON' : 'Cues: OFF';
  const bassState = `Bass Outline: ${bassMode}`;
  visualReadout.textContent = `${graph.label} | X = ${formatNumber(currentX)}, Y = ${yText} | ${voiceDesc} | Step: ${stepSize} (${(pulseRateMs / 1000).toFixed(2)}s) | ${bassState} | ${cueState}`;

  const eventParts = [];
  if (cuesEnabled) {
    if (lastStepEvents.passedOver.length > 0) {
      eventParts.push(`Passed over: ${lastStepEvents.passedOver.map((l) => l.label).join('; ')}`);
    }
    if (lastStepEvents.landedOn.length > 0) {
      eventParts.push(`Landed on: ${lastStepEvents.landedOn.map((l) => l.label).join('; ')}`);
    }
  }
  if (extraText) {
    eventParts.push(extraText);
  }
  eventBanner.textContent = eventParts.length
    ? eventParts.join(' | ')
    : 'J / K (or Left / Right) to step, A to play, B for Bass Outline, C for Cues, V to speak coordinate, S for Settings.';
}

function stepToX(targetX, fromX = currentX, isAutoPlay = false) {
  if (!graph) return;
  const clampedX = Math.max(-boundary, Math.min(boundary, targetX));
  const events = findStepEvents(landmarks, fromX, clampedX);
  currentX = clampedX;
  lastStepEvents = events;
  const lim = graph.limitAt(currentX);

  sound.playStepSequence({
    x: currentX,
    lim,
    boundary,
    prevY,
    passedOver: events.passedOver,
    landedOn: events.landedOn,
    withBassOutline: isAutoPlay,
  });

  if (lim.defined || lim.hole) {
    prevY = lim.y;
  }
  renderSvg();
  updateVisualBanner();
}

function stepByDirection(direction, isAutoPlay = false) {
  if (!graph) return;
  const scaled = currentX / stepSize;
  const nextIndex =
    direction > 0
      ? Math.floor(scaled + 1e-7) + 1
      : Math.ceil(scaled - 1e-7) - 1;
  const nextX = addCoordinate(0, nextIndex * stepSize);
  if (nextX > boundary + 1e-9 || nextX < -boundary - 1e-9) {
    sound.stopBassOutline();
    sound.playGearShiftTick(sound.computePan(currentX, boundary), false);
    updateVisualBanner(`At window edge X = ${formatNumber(currentX)}.`);
    return;
  }
  stepToX(nextX, currentX, isAutoPlay);
}

function toggleAutoPlay() {
  if (!graph) return;
  if (autoTimer !== null) {
    stopAutoPlay(true);
    return;
  }
  if (currentX >= boundary - 1e-6) {
    currentX = -boundary;
    const lim = graph.limitAt(currentX);
    prevY = lim.defined || lim.hole ? lim.y : null;
    stepToX(currentX, currentX, true);
  } else {
    stepByDirection(1, true);
  }

  startAutoTimer();
}

function startAutoTimer() {
  autoTimer = window.setInterval(() => {
    if (currentX >= boundary - 1e-6) {
      stopAutoPlay(true);
      updateVisualBanner('Reached right edge.');
      return;
    }
    stepByDirection(1, true);
    if (currentX >= boundary - 1e-6) {
      window.setTimeout(() => {
        if (autoTimer !== null) {
          stopAutoPlay(true);
          updateVisualBanner('Reached right edge.');
        }
      }, pulseRateMs);
    }
  }, pulseRateMs);
}

function toggleCues() {
  cuesEnabled = !cuesEnabled;
  cuesCheckbox.checked = cuesEnabled;
  sound.setCuesEnabled(cuesEnabled);
  updateVisualBanner();
  speakOnDemand(`Landmark sound cues ${cuesEnabled ? 'on' : 'off'}.`);
}

function cycleBassMode() {
  const nextIdx = (BASS_MODES.indexOf(bassMode) + 1) % BASS_MODES.length;
  bassMode = BASS_MODES[nextIdx];
  bassModeSelect.value = bassMode;
  sound.setBassOutlineMode(bassMode);
  if (autoTimer !== null && graph && bassMode !== 'off') {
    sound.updateBassOutline(currentX, graph.limitAt(currentX), boundary);
  }
  updateVisualBanner();
  speakOnDemand(`Background bass outline: ${BASS_MODE_LABELS[bassMode]}.`);
}

function speakCurrentPositionOnDemand() {
  if (!graph) return;
  const lim = graph.limitAt(currentX);
  const ySpoken = lim.defined
    ? `Y ${formatNumber(lim.y)}`
    : lim.hole
      ? `open hole near Y ${formatNumber(lim.y)}`
      : 'Y undefined';
  const regionText = describeVoiceRegion(lim);
  const landedText = lastStepEvents.landedOn.length
    ? `On ${lastStepEvents.landedOn.map((l) => l.label).join(', ')}.`
    : '';
  const passedText = lastStepEvents.passedOver.length
    ? `Passed over ${lastStepEvents.passedOver.map((l) => l.label).join(', ')}.`
    : '';
  speakOnDemand(`X ${formatNumber(currentX)}, ${ySpoken}. ${regionText}. ${landedText} ${passedText}`.replace(/\s+/g, ' ').trim());
}

function speakLandmarkSummary() {
  if (!graph) return;
  if (!landmarks.length) {
    speakOnDemand(`${graph.label}. No landmarks between minus ${boundary} and ${boundary}.`);
    return;
  }
  const summary = landmarks.map((l) => l.label).join('. ');
  speakOnDemand(`${graph.label}. ${landmarks.length} landmarks: ${summary}`);
}

function jumpToLandmark(direction) {
  if (!graph || !landmarks.length) {
    speakOnDemand('No landmarks on this curve.');
    return;
  }
  const eps = 1e-5;
  let target = null;
  if (direction > 0) {
    target = landmarks.find((l) => l.x > currentX + eps) || landmarks[0];
  } else {
    target = [...landmarks].reverse().find((l) => l.x < currentX - eps) || landmarks.at(-1);
  }
  if (!target) return;
  stepToX(target.x, target.x);
  speakOnDemand(`Jumped to ${target.label}.`);
}

function toggleCustomPoint(kind) {
  if (!graph) return;
  const existingIdx = customPoints.findIndex((p) => Math.abs(p.x - currentX) <= 1e-5);
  if (existingIdx >= 0 && customPoints[existingIdx].kind === kind) {
    customPoints.splice(existingIdx, 1);
    landmarks = detectLandmarks(graph, boundary, customPoints);
    lastStepEvents = findStepEvents(landmarks, currentX, currentX);
    renderSvg();
    updateVisualBanner();
    speakOnDemand(`Removed ${kind === 'open-point' ? 'open hole' : 'solid point'} at X ${formatNumber(currentX)}.`);
    return;
  }
  if (existingIdx >= 0) {
    customPoints.splice(existingIdx, 1);
  }
  const lim = graph.limitAt(currentX);
  if (!lim.defined && !lim.hole) {
    // Never invent Y = 0 where the function does not exist (sqrt(x) at x < 0).
    speakOnDemand(`Cannot mark a point at X ${formatNumber(currentX)}: the function is undefined here.`);
    updateVisualBanner(`No point marked: undefined at X = ${formatNumber(currentX)}.`);
    return;
  }
  const yVal = lim.y;
  customPoints.push({ kind, x: currentX, y: yVal });
  landmarks = detectLandmarks(graph, boundary, customPoints);
  lastStepEvents = findStepEvents(landmarks, currentX, currentX);
  sound.playLandmarkEffect(kind, currentX, boundary, yVal);
  renderSvg();
  updateVisualBanner();
  speakOnDemand(`Marked ${kind === 'open-point' ? 'open point (hole)' : 'solid point'} at X ${formatNumber(currentX)}, Y ${formatNumber(yVal)}.`);
}

function renderSvg() {
  if (!graph) return;
  const width = 600;
  const height = 340;
  const pad = 28;
  const toScreenX = (x) => pad + ((x + boundary) / (boundary * 2)) * (width - pad * 2);
  const toScreenY = (y) => height - pad - ((y + boundary) / (boundary * 2)) * (height - pad * 2);

  const elements = [];

  const gridStep = boundary <= 5 ? 1 : boundary <= 10 ? 2 : 5;
  for (let g = -boundary; g <= boundary; g += gridStep) {
    const sx = toScreenX(g);
    const sy = toScreenY(g);
    const isZero = Math.abs(g) <= 1e-9;
    const stroke = isZero ? '#64748b' : '#1e293b';
    const strokeWidth = isZero ? 2 : 1;
    elements.push(`<line x1="${sx}" y1="${pad}" x2="${sx}" y2="${height - pad}" stroke="${stroke}" stroke-width="${strokeWidth}" />`);
    elements.push(`<line x1="${pad}" y1="${sy}" x2="${width - pad}" y2="${sy}" stroke="${stroke}" stroke-width="${strokeWidth}" />`);
  }

  const segments = sampleFunctionPath(graph, boundary, 360);
  for (const seg of segments) {
    const pointsAttr = seg
      .map((pt) => `${toScreenX(pt.x).toFixed(1)},${toScreenY(Math.max(-boundary * 1.2, Math.min(boundary * 1.2, pt.y))).toFixed(1)}`)
      .join(' ');
    elements.push(`<polyline fill="none" stroke="#38bdf8" stroke-width="2.5" points="${pointsAttr}" />`);
  }

  for (const lm of landmarks) {
    if (!Number.isFinite(lm.y) || Math.abs(lm.y) > boundary * 1.2) continue;
    const cx = toScreenX(lm.x);
    const cy = toScreenY(lm.y);
    if (lm.kind === 'open-point') {
      elements.push(`<circle cx="${cx}" cy="${cy}" r="6" fill="#060911" stroke="#f43f5e" stroke-width="2.5" />`);
    } else if (lm.kind === 'solid-point') {
      elements.push(`<circle cx="${cx}" cy="${cy}" r="6" fill="#4ade80" stroke="#060911" stroke-width="1.5" />`);
    } else if (lm.kind === 'maximum' || lm.kind === 'minimum') {
      elements.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="#facc15" />`);
    } else if (lm.kind === 'origin') {
      elements.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="#a855f7" />`);
    }
  }

  const lim = graph.limitAt(currentX);
  const cursorX = toScreenX(currentX);
  elements.push(`<line x1="${cursorX}" y1="${pad}" x2="${cursorX}" y2="${height - pad}" stroke="#facc15" stroke-width="1.5" stroke-dasharray="4 4" />`);
  if (lim.defined || lim.hole) {
    const clampedY = Math.max(-boundary * 1.15, Math.min(boundary * 1.15, lim.y));
    const cursorY = toScreenY(clampedY);
    const fill = !lim.defined && lim.hole ? '#060911' : lim.y < 0 ? '#f97316' : lim.y > 0 ? '#22d3ee' : '#facc15';
    elements.push(`<circle cx="${cursorX}" cy="${cursorY}" r="8" fill="${fill}" stroke="#facc15" stroke-width="3" />`);
  }

  svg.innerHTML = elements.join('');
}

// Form & dialog handlers
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (loadEquationText(eqInput.value, [], true)) {
    soundPad.focus();
  }
});

function openSettings() {
  stopAutoPlay(true);
  sound.stopBassOutline();
  if (!settingsDialog.open) {
    settingsDialog.showModal();
  }
}

function closeSettings() {
  sound.stopBassOutline();
  if (settingsDialog.open) {
    settingsDialog.close();
  }
  soundPad.focus();
}

openSettingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);
settingsDialog.addEventListener('close', () => {
  sound.stopBassOutline();
  soundPad.focus();
});

profileSelect.addEventListener('change', () => {
  soundProfile = profileSelect.value;
  sound.setSoundProfile(soundProfile);
  sound.playSeatedPulse(1, 2, boundary, 1);
  updateVisualBanner(`Sound profile set to ${soundProfile}.`);
});

bassModeSelect.addEventListener('change', () => {
  bassMode = bassModeSelect.value;
  sound.setBassOutlineMode(bassMode);
  updateVisualBanner(`Background bass outline set to ${BASS_MODE_LABELS[bassMode]}.`);
});

stepSelect.addEventListener('change', () => {
  stepSize = Number(stepSelect.value) || 0.5;
  updateVisualBanner(`Step distance set to ${stepSize} units.`);
});

rateSelect.addEventListener('change', () => {
  pulseRateMs = Number(rateSelect.value) || 400;
  sound.setStepDelayMs(pulseRateMs);
  if (autoTimer !== null) {
    stopAutoPlay(true);
    toggleAutoPlay();
  }
  updateVisualBanner(`Step delay set to ${(pulseRateMs / 1000).toFixed(2)}s.`);
});

cuesCheckbox.addEventListener('change', () => {
  cuesEnabled = cuesCheckbox.checked;
  sound.setCuesEnabled(cuesEnabled);
  updateVisualBanner();
});

boundarySelect.addEventListener('change', () => {
  boundary = Number(boundarySelect.value) || 5;
  if (graph) {
    landmarks = detectLandmarks(graph, boundary, customPoints);
    currentX = Math.max(-boundary, Math.min(boundary, currentX));
    const lim = graph.limitAt(currentX);
    prevY = lim.defined || lim.hole ? lim.y : null;
    lastStepEvents = findStepEvents(landmarks, currentX, currentX);
    renderSvg();
    updateVisualBanner(`Axis window set to -${boundary} .. +${boundary}.`);
  }
});

volumeInput.addEventListener('input', () => {
  sound.setVolume(volumeInput.value);
});

bassOutlineVolumeInput.addEventListener('input', () => {
  sound.setBassOutlineVolume(bassOutlineVolumeInput.value);
});

const PRESETS = {
  parabola: {
    eq: 'y = x^2 - 4',
    boundary: 5,
    points: [],
  },
  cubic: {
    eq: 'y = x^3 - 3*x',
    boundary: 5,
    points: [],
  },
  hole: {
    eq: 'y = (x^2 - 4)/(x - 2)',
    boundary: 5,
    points: [],
  },
  points: {
    eq: 'y = 2*x',
    boundary: 5,
    points: [
      { kind: 'solid-point', x: 1, y: 2 },
      { kind: 'open-point', x: -1, y: -2 },
    ],
  },
};

for (const btn of document.querySelectorAll('.preset-btn')) {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset];
    if (!preset) return;
    eqInput.value = preset.eq;
    boundary = preset.boundary;
    boundarySelect.value = String(boundary);
    loadEquationText(preset.eq, preset.points, true);
    closeSettings();
  });
}

function triggerSoundDemo(kind) {
  stopAutoPlay(true);
  if (kind === 'outline') {
    const savedMode = sound.bassOutlineMode;
    if (savedMode === 'off') sound.setBassOutlineMode('x-and-y');
    sound.updateBassOutline(-3, { defined: true, y: -2 }, 5);
    window.setTimeout(() => sound.updateBassOutline(0, { defined: true, y: 0 }, 5), 350);
    window.setTimeout(() => sound.updateBassOutline(3, { defined: true, y: 2 }, 5), 700);
    window.setTimeout(() => {
      sound.stopBassOutline();
      sound.setBassOutlineMode(savedMode);
    }, 1350);
  } else if (kind === 'bass') {
    sound.playSeatedPulse(-2, -3, boundary, -2);
  } else if (kind === 'tin') {
    sound.playSeatedPulse(2, 3, boundary, 2);
  } else if (kind === 'origin') {
    sound.playLandmarkEffect('origin', 0, boundary, 0);
  } else if (kind === 'peak-valley') {
    sound.playSeatedPulse(-1, 2, boundary, 1);
    sound.playLandmarkEffect('maximum', -1, boundary, 2);
    window.setTimeout(() => {
      sound.playSeatedPulse(1, -2, boundary, -1);
      sound.playLandmarkEffect('minimum', 1, boundary, -2);
    }, 450);
  } else if (kind === 'solid') {
    sound.playSeatedPulse(1, 2, boundary, 1);
    sound.playLandmarkEffect('solid-point', 1, boundary, 2);
  } else if (kind === 'open') {
    sound.playLandmarkEffect('open-point', 2, boundary, 4);
  }
}

for (const btn of document.querySelectorAll('.sound-test-btn')) {
  btn.addEventListener('click', () => {
    triggerSoundDemo(btn.dataset.sound);
  });
}

const PAD_KEYS_HELP = 'J or Left Arrow: step back. K or Right Arrow: step forward. A or Space: play or pause. '
  + 'Home and End: window edges. Period and comma: next and previous landmark. V or Enter: speak coordinates. '
  + 'I: list landmarks. F: step distance. R: playback speed. B: bass mode. C: landmark cues on or off. '
  + 'P: mark or unmark a solid point. H: mark or unmark an open hole. O: go to X zero. '
  + 'N: new equation. S: settings. Escape: stop. Question mark: this list.';

// Keyboard handling inside the Stereo Sound Pad
soundPad.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const key = event.key;

  if (key === 'k' || key === 'K' || key === 'ArrowRight') {
    event.preventDefault();
    const now = performance.now();
    if (event.repeat && now - lastManualStepTime < 85) return;
    lastManualStepTime = now;
    stopAutoPlay(true);
    stepByDirection(1);
    return;
  }

  if (key === 'j' || key === 'J' || key === 'ArrowLeft') {
    event.preventDefault();
    const now = performance.now();
    if (event.repeat && now - lastManualStepTime < 85) return;
    lastManualStepTime = now;
    stopAutoPlay(true);
    stepByDirection(-1);
    return;
  }

  if (key === 'a' || key === 'A' || key === ' ') {
    event.preventDefault();
    toggleAutoPlay();
    return;
  }

  if (key === 'b' || key === 'B') {
    event.preventDefault();
    cycleBassMode();
    return;
  }

  if (key === 'c' || key === 'C') {
    event.preventDefault();
    toggleCues();
    return;
  }

  if (key === 's' || key === 'S') {
    event.preventDefault();
    openSettings();
    return;
  }

  if (key === 'v' || key === 'V' || key === 'Enter') {
    event.preventDefault();
    speakCurrentPositionOnDemand();
    return;
  }

  if (key === 'i' || key === 'I') {
    event.preventDefault();
    speakLandmarkSummary();
    return;
  }

  if (key === '.') {
    event.preventDefault();
    stopAutoPlay(true);
    jumpToLandmark(1);
    return;
  }

  if (key === ',') {
    event.preventDefault();
    stopAutoPlay(true);
    jumpToLandmark(-1);
    return;
  }

  if (key === 'o' || key === 'O') {
    event.preventDefault();
    stopAutoPlay(true);
    stepToX(0, currentX);
    return;
  }

  if (key === 'Home') {
    event.preventDefault();
    stopAutoPlay(true);
    stepToX(-boundary, -boundary);
    return;
  }

  if (key === 'End') {
    event.preventDefault();
    stopAutoPlay(true);
    stepToX(boundary, boundary);
    return;
  }

  if (key === 'f' || key === 'F') {
    event.preventDefault();
    const idx = (STEP_OPTIONS.indexOf(stepSize) + 1) % STEP_OPTIONS.length;
    stepSize = STEP_OPTIONS[idx];
    stepSelect.value = String(stepSize);
    updateVisualBanner(`Step distance ${stepSize}`);
    speakOnDemand(`Step distance ${stepSize} units.`);
    return;
  }

  if (key === 'r' || key === 'R') {
    event.preventDefault();
    const idx = (RATE_OPTIONS.indexOf(pulseRateMs) + 1) % RATE_OPTIONS.length;
    pulseRateMs = RATE_OPTIONS[idx];
    rateSelect.value = String(pulseRateMs);
    sound.setStepDelayMs(pulseRateMs);
    if (autoTimer !== null) {
      // Restart the timer at the new rate without taking an extra step.
      window.clearInterval(autoTimer);
      startAutoTimer();
    }
    speakOnDemand(`Step delay ${(pulseRateMs / 1000).toFixed(2)} seconds.`);
    return;
  }

  if (key === 'p' || key === 'P') {
    event.preventDefault();
    toggleCustomPoint('solid-point');
    return;
  }

  if (key === 'h' || key === 'H') {
    event.preventDefault();
    toggleCustomPoint('open-point');
    return;
  }

  if (key === 'n' || key === 'N') {
    event.preventDefault();
    stopAutoPlay(true);
    sound.stopBassOutline();
    eqInput.focus();
    eqInput.select();
    return;
  }

  if (key === '?') {
    event.preventDefault();
    speakOnDemand(PAD_KEYS_HELP);
    return;
  }

  if (key === 'Escape') {
    stopAutoPlay(true);
    sound.stopBassOutline();
    updateVisualBanner('Stopped and muted background bass hold.');
    return;
  }
});

loadEquationText(eqInput.value, [], false);
