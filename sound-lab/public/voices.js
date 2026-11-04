// Voices for the graph's step notes: instruments, beeps and game sounds, all made in the
// browser (no recordings). Every voice plays the same pitch for the same height, so changing
// the voice changes only the colour of the sound, never what it tells you.
//
// A note can start at the previous step's pitch and slide to its own (fromFreq): going up is
// heard as a short rise, going down as a short fall.

export const VOICE_GROUPS = [
  ['Instruments', [
    ['piano', 'Piano'],
    ['guitar', 'Guitar: plucked string'],
    ['harp', 'Harp'],
    ['marimba', 'Marimba: wooden bar'],
    ['kalimba', 'Kalimba: thumb piano'],
    ['vibraphone', 'Vibraphone: metal bar with a slow shimmer'],
    ['flute', 'Flute: soft and breathy'],
    ['cello', 'Cello: bowed string'],
  ]],
  ['Beeps', [
    ['beep', 'Beep: short pure tone'],
    ['soft-square', 'Computer beep: hollow, rounded'],
    ['chirp', 'Chirp: each note slides all the way from the last height'],
  ]],
  ['Game sounds', [
    ['chiptune', 'Chiptune: retro square wave'],
    ['retro-triangle', 'Retro bass: stepped triangle wave'],
    ['bubble', 'Bubble pop'],
    ['arcade', 'Arcade blip: note and its octave'],
  ]],
];
export const VOICES = VOICE_GROUPS.flatMap(([, list]) => list.map(([value]) => value));

const plucks = new Map(); // plucked-string sounds, made once per pitch
const noises = new WeakMap();
function noiseBuffer(ctx) {
  if (noises.has(ctx)) return noises.get(ctx);
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  noises.set(ctx, buffer);
  return buffer;
}

// A plucked string (Karplus-Strong): a burst of noise in a short loop that loses its brightness
// as it rings. brightness 0..1; decay close to 1 rings longer.
function pluckBuffer(ctx, freq, seconds, brightness, decay) {
  const key = `${Math.round(freq * 10)}:${brightness}:${decay}:${seconds}`;
  if (plucks.has(key)) return plucks.get(key);
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(1, length, rate);
  const out = buffer.getChannelData(0);
  const period = Math.max(2, Math.round(rate / freq));
  const loop = new Float32Array(period);
  let last = 0;
  for (let i = 0; i < period; i += 1) { last = brightness * (Math.random() * 2 - 1) + (1 - brightness) * last; loop[i] = last; }
  for (let i = 0, k = 0; i < length; i += 1, k = (k + 1) % period) {
    const next = loop[(k + 1) % period];
    out[i] = loop[k];
    loop[k] = decay * 0.5 * (loop[k] + next);
  }
  if (plucks.size > 300) plucks.clear();
  plucks.set(key, buffer);
  return buffer;
}

// A square-ish wave with a narrow pulse (the 8-bit sound), as a periodic wave.
const pulses = new WeakMap();
function pulseWave(ctx, duty = 0.25) {
  if (pulses.has(ctx)) return pulses.get(ctx);
  const n = 40;
  const real = new Float32Array(n), imag = new Float32Array(n);
  for (let k = 1; k < n; k += 1) imag[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  const wave = ctx.createPeriodicWave(real, imag);
  pulses.set(ctx, wave);
  return wave;
}

// An oscillator at a pitch that slides from fromFreq (if given) to freq.
function tone(ctx, type, freq, fromFreq, when, slide) {
  const osc = ctx.createOscillator();
  if (type instanceof PeriodicWave) osc.setPeriodicWave(type); else osc.type = type;
  if (fromFreq && Math.abs(fromFreq - freq) > 0.5) {
    osc.frequency.setValueAtTime(fromFreq, when);
    osc.frequency.exponentialRampToValueAtTime(freq, when + slide);
  } else {
    osc.frequency.setValueAtTime(freq, when);
  }
  return osc;
}

// A gain that rises in `attack` seconds to `peak` and fades away by `end`.
function envelope(ctx, when, attack, peak, end) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0005, when);
  g.gain.linearRampToValueAtTime(peak, when + attack);
  g.gain.exponentialRampToValueAtTime(0.0005, when + end);
  return g;
}

// Several partials ([ratio, level, seconds]) struck together, as a bar or a piano string.
function struck(ctx, out, freq, fromFreq, when, slide, peak, partials, attack = 0.004) {
  let longest = 0;
  for (const [ratio, level, seconds] of partials) {
    const f = freq * ratio;
    if (f > 9000) continue;
    const osc = tone(ctx, 'sine', f, fromFreq ? fromFreq * ratio : null, when, slide);
    const g = envelope(ctx, when, attack, peak * level, seconds);
    osc.connect(g); g.connect(out);
    osc.start(when); osc.stop(when + seconds + 0.05);
    longest = Math.max(longest, seconds);
  }
  return longest;
}

// Plays one note. out: where the sound goes (a stereo panner). length: the step's time in
// seconds (voices that hold, like the flute, hold for about that long). Returns the time the
// note is heard for.
export function playVoice(ctx, out, voice, { freq, fromFreq = null, when = ctx.currentTime, length = 0.3, volume = 0.25 }) {
  const slide = Math.min(0.09, Math.max(0.04, length * 0.25));
  // Higher notes sound louder to the ear: a little less level up high keeps them even.
  const even = Math.pow(330 / Math.max(80, freq), 0.25);
  const peak = volume * even;
  switch (voice) {
    case 'piano': {
      const B = 0.0004; // a real string's overtones are slightly sharp
      const partials = [1, 2, 3, 4, 5, 6].map((n) => [n * Math.sqrt(1 + B * n * n), 0.9 / Math.pow(n, 1.4), Math.max(0.25, 1.4 / Math.sqrt(n) - freq / 2000)]);
      return struck(ctx, out, freq, fromFreq, when, slide, peak, partials, 0.005);
    }
    case 'marimba':
      return struck(ctx, out, freq, fromFreq, when, slide, peak * 1.1, [[1, 1, 0.55], [3.93, 0.28, 0.09], [9.2, 0.06, 0.03]], 0.003);
    case 'kalimba':
      return struck(ctx, out, freq, fromFreq, when, slide, peak, [[1, 1, 0.9], [5.95, 0.22, 0.12], [2, 0.12, 0.3]], 0.003);
    case 'vibraphone': {
      // A slow shimmer: the volume swells and fades five times a second.
      const shimmer = ctx.createGain();
      shimmer.gain.setValueAtTime(1, when);
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.setValueAtTime(5.2, when);
      depth.gain.setValueAtTime(0.25, when);
      lfo.connect(depth); depth.connect(shimmer.gain);
      shimmer.connect(out);
      const t = struck(ctx, shimmer, freq, fromFreq, when, slide, peak * 0.9, [[1, 1, 1.1], [4, 0.22, 0.35], [10, 0.04, 0.08]], 0.006);
      lfo.start(when); lfo.stop(when + t + 0.05);
      return t;
    }
    case 'guitar':
    case 'harp': {
      const harp = voice === 'harp';
      const seconds = harp ? 1.2 : 0.8;
      const src = ctx.createBufferSource();
      src.buffer = pluckBuffer(ctx, freq, seconds, harp ? 0.55 : 0.75, harp ? 0.998 : 0.994);
      if (fromFreq && Math.abs(fromFreq - freq) > 0.5) {
        src.playbackRate.setValueAtTime(fromFreq / freq, when);
        src.playbackRate.exponentialRampToValueAtTime(1, when + slide);
      }
      const tone2 = ctx.createBiquadFilter();
      tone2.type = 'lowpass';
      tone2.frequency.setValueAtTime(harp ? 2600 : 3600, when);
      const g = envelope(ctx, when, 0.002, peak * 1.6, seconds);
      src.connect(tone2); tone2.connect(g); g.connect(out);
      src.start(when); src.stop(when + seconds);
      return seconds;
    }
    case 'flute':
    case 'cello': {
      const flute = voice === 'flute';
      const hold = Math.max(0.2, Math.min(0.7, length * 0.9));
      const osc = tone(ctx, flute ? 'sine' : 'sawtooth', freq, fromFreq, when, slide);
      // Vibrato: the pitch wavers a little, as a player's does.
      const vib = ctx.createOscillator();
      const vibDepth = ctx.createGain();
      vib.frequency.setValueAtTime(flute ? 4.8 : 5.5, when);
      vibDepth.gain.setValueAtTime(0, when);
      vibDepth.gain.linearRampToValueAtTime(freq * (flute ? 0.004 : 0.006), when + 0.15);
      vib.connect(vibDepth); vibDepth.connect(osc.frequency);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(flute ? freq * 3 : Math.min(5000, freq * 4), when);
      filter.Q.setValueAtTime(0.7, when);
      const g = ctx.createGain();
      const level = peak * (flute ? 0.7 : 0.75);
      g.gain.setValueAtTime(0.0005, when);
      g.gain.linearRampToValueAtTime(level, when + (flute ? 0.06 : 0.08));
      g.gain.setValueAtTime(level, when + hold);
      g.gain.exponentialRampToValueAtTime(0.0005, when + hold + 0.15);
      osc.connect(filter); filter.connect(g); g.connect(out);
      if (flute) {
        // The breath: a little soft noise around the note.
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer(ctx);
        const air = ctx.createBiquadFilter();
        air.type = 'bandpass';
        air.frequency.setValueAtTime(freq * 2, when);
        air.Q.setValueAtTime(1.5, when);
        const ag = envelope(ctx, when, 0.03, peak * 0.25, 0.12);
        noise.connect(air); air.connect(ag); ag.connect(out);
        noise.start(when); noise.stop(when + 0.15);
      }
      osc.start(when); vib.start(when);
      osc.stop(when + hold + 0.2); vib.stop(when + hold + 0.2);
      return hold + 0.15;
    }
    case 'beep':
    case 'soft-square': {
      const square = voice === 'soft-square';
      const t = Math.max(0.09, Math.min(0.16, length * 0.4));
      const osc = tone(ctx, square ? 'square' : 'sine', freq, fromFreq, when, Math.min(slide, t * 0.5));
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(square ? Math.min(3000, freq * 4) : 6000, when);
      const level = peak * (square ? 0.45 : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0005, when);
      g.gain.linearRampToValueAtTime(level, when + 0.006);
      g.gain.setValueAtTime(level, when + t);
      g.gain.exponentialRampToValueAtTime(0.0005, when + t + 0.03);
      osc.connect(filter); filter.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + t + 0.05);
      return t + 0.03;
    }
    case 'chirp': {
      // The whole note is the slide: rising, falling, or level when the height did not change.
      const t = Math.max(0.12, Math.min(0.24, length * 0.55));
      const osc = tone(ctx, 'sine', freq, fromFreq, when, t * 0.8);
      const color = tone(ctx, 'triangle', freq * 2, fromFreq ? fromFreq * 2 : null, when, t * 0.8);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.12, when);
      const g = envelope(ctx, when, 0.01, peak, t);
      osc.connect(g); color.connect(cg); cg.connect(g); g.connect(out);
      osc.start(when); color.start(when); osc.stop(when + t + 0.05); color.stop(when + t + 0.05);
      return t;
    }
    case 'chiptune':
    case 'retro-triangle': {
      // 8-bit sound: a raw wave whose volume falls in steps, not smoothly.
      const tri = voice === 'retro-triangle';
      const t = Math.max(0.1, Math.min(0.22, length * 0.5));
      const osc = tone(ctx, tri ? 'triangle' : pulseWave(ctx), freq, fromFreq, when, Math.min(slide, 0.05));
      const g = ctx.createGain();
      const level = peak * (tri ? 1.1 : 0.75);
      const steps = 6;
      g.gain.setValueAtTime(level, when);
      for (let i = 1; i <= steps; i += 1) g.gain.setValueAtTime(level * (1 - i / (steps + 1)), when + (t * i) / steps);
      g.gain.setValueAtTime(0, when + t + 0.01);
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + t + 0.03);
      return t;
    }
    case 'bubble': {
      // A pop: the pitch rises quickly into the note, then the bubble is gone.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 0.6, when);
      osc.frequency.exponentialRampToValueAtTime(freq, when + 0.035);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.08, when + 0.12);
      const g = envelope(ctx, when, 0.008, peak * 1.2, 0.13);
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + 0.16);
      return 0.13;
    }
    case 'arcade': {
      // The note, then its octave a moment later: same note name, so the height stays clear.
      const t = 0.07;
      [[freq, fromFreq, 0], [freq * 2, null, t]].forEach(([f, from, at]) => {
        const osc = tone(ctx, 'square', f, from, when + at, Math.min(slide, 0.04));
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(Math.min(4000, f * 3), when);
        const g = envelope(ctx, when + at, 0.004, peak * (at ? 0.4 : 0.65), t + 0.02);
        osc.connect(filter); filter.connect(g); g.connect(out);
        osc.start(when + at); osc.stop(when + at + t + 0.05);
      });
      return t * 2 + 0.02;
    }
    default:
      return 0;
  }
}
