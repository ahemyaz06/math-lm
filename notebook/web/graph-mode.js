// Graph mode: explore a graph by sound, using Sound Lab's engine and math.
// J/K trace the selected function; arrow keys move freely (no bass) and the curve's
// tone plays when the cursor lands on it; Space plays with the bass and reads the
// coordinate when it stops; Tab switches functions.
import { CalculusSoundEngine } from '/sound/sound-engine.js';
import { compileEquation, detectLandmarks, findStepEvents, formatNumber } from '/sound/graph-math.js';
import { HIDEABLE, compileFunction, describeFunction, landmarksOf, say, setNumberStyle, spokenLabel } from './graphs.js';

const STEPS = [0.1, 0.25, 0.5, 1];
// say() rounds as Settings asks (nearest half by default); exact() is for what you chose
// yourself: where the cursor is along x (already on your step) and the step size.
const exact = (n) => formatNumber(Math.abs(n) < 1e-9 ? 0 : n).replace('-', 'minus ');
// Numbers inside a stored description, rounded the same way (descriptions without a formula).
// A dot in words, numbers rounded; what the stored words say it is (a jump, a hole) is kept.
function dotWords(p) {
  const [x, y] = p.coordinate;
  const dot = `${p.kind} at ${say(x)}, ${say(y)}`;
  const was = p.label || '';
  if (/^jump at/.test(was)) return `jump at x = ${say(x)}: ${dot}`;
  if (/^hole at/.test(was)) return `hole at ${say(x)}, ${say(y)}: both sides go to ${say(y)}`;
  if (/^the value at/.test(was)) return `the value at x = ${say(x)} is ${say(y)}, away from the curve`;
  return dot;
}
const roundWords = (text) => text.replace(/(minus )?(\d+(?:\.\d+)?(?:e(?:minus |\+)?\d+)?)/g, (m, minus, num) => {
  const v = Number(num.replace('eminus ', 'e-')) * (minus ? -1 : 1);
  return Number.isFinite(v) ? say(v) : m;
});

// A slope in words, to one decimal: "slope 2, rising", "flat, slope 0".
function slopeWords(m, about = '') {
  if (!Number.isFinite(m)) return `vertical, going straight ${m > 0 ? 'up' : 'down'}`;
  if (Math.abs(m) > 1000) return `${about}nearly vertical, ${m > 0 ? 'rising' : 'falling'} very steeply`;
  const r = Math.round(m * 10) / 10;
  if (r === 0) return `flat, slope ${about}0`;
  const how = Math.abs(r) < 0.5 ? ' gently' : Math.abs(r) > 3 ? ' steeply' : '';
  return `slope ${about}${formatNumber(r).replace('-', 'minus ')}, ${r > 0 ? 'rising' : 'falling'}${how}`;
}

// A function made from the exact points the PDF reader found (straight pieces or samples).
function sampledFunction(curve, dots = []) {
  // Samples may have null between pieces (a student copy's curve breaks at a jump or an
  // asymptote); between pieces there is no point.
  const segments = [[]];
  for (const p of curve.corners || curve.samples || []) {
    if (p === null) { if (segments.at(-1).length) segments.push([]); } else segments.at(-1).push({ x: p[0], y: p[1] });
  }
  const pieces = segments.filter((s) => s.length).map((s) => s.sort((a, b) => a.x - b.x));
  const lo = pieces[0]?.[0].x ?? 0, hi = pieces.at(-1)?.at(-1).x ?? 0;
  return {
    label: curve.label && curve.color ? `${curve.label}, ${curve.color}` : curve.label || `${curve.color} ${curve.kind === 'curve' ? 'curve' : 'line'}`,
    lo, hi,
    // Which piece x is on, so the picture lifts its pen between pieces (a jump).
    piece(x) { return pieces.findIndex((s) => x >= s[0].x - 1e-9 && x <= s.at(-1).x + 1e-9); },
    limitAt(x) {
      // Where two pieces meet (a jump), the drawn dots say which height is the point: the
      // solid dot's, and an open dot's height is only approached.
      const here = pieces.filter((s) => x >= s[0].x - 1e-9 && x <= s.at(-1).x + 1e-9);
      const ends = here.map((s) => (Math.abs(s[0].x - x) < 1e-9 ? s[0].y : Math.abs(s.at(-1).x - x) < 1e-9 ? s.at(-1).y : null)).filter((v) => v !== null);
      const dotAt = (kind) => dots.find((d) => d.kind === kind && Math.abs(d.coordinate[0] - x) < 1e-9 && ends.some((v) => Math.abs(v - d.coordinate[1]) < 1e-6));
      if (ends.length) {
        const solid = dotAt('solid dot');
        if (solid) return { defined: true, y: solid.coordinate[1] };
        const open = dotAt('open dot');
        const other = ends.find((v) => !open || Math.abs(v - open.coordinate[1]) >= 1e-6);
        if (open && other === undefined) return { defined: false, hole: true, y: open.coordinate[1] };
        if (open) return { defined: true, y: other };
      }
      const pts = here[0];
      if (!pts || (pts.length < 2 && Math.abs(pts[0].x - x) > 1e-9)) return { defined: false, hole: false, y: NaN };
      let k = pts.findIndex((p) => p.x >= x);
      if (k <= 0) return { defined: true, y: pts[0].y };
      const a = pts[k - 1], b = pts[k];
      const y = b.x === a.x ? b.y : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
      return { defined: true, y };
    },
    landmarks() {
      const out = [];
      for (const t of curve.turning_points || []) out.push({ kind: t.kind === 'peak' ? 'maximum' : 'minimum', x: t.at[0], y: t.at[1], label: `${t.kind} at ${say(t.at[0])}, ${say(t.at[1])}` });
      for (const z of curve.crosses_x_axis_at || []) out.push({ kind: Math.abs(z) < 1e-6 ? 'origin' : 'x-axis', x: z, y: 0, label: `crosses the x-axis at ${say(z)}` });
      if (Number.isFinite(curve.crosses_y_axis_at) && !(curve.crosses_x_axis_at || []).some((z) => Math.abs(z) < 1e-6)) {
        out.push({ kind: 'y-axis', x: 0, y: curve.crosses_y_axis_at, label: `crosses the y-axis at ${say(curve.crosses_y_axis_at)}` });
      }
      for (const a of curve.asymptotes || []) out.push({ kind: 'asymptote', x: a, y: null, label: `vertical asymptote at x = ${say(a)}` });
      for (const sh of curve.shapes || []) out.push({ ...sh, x: sh.at[0], y: sh.at[1] });
      if (curve.kind !== 'curve') {
        const c = curve.corners || [];
        for (let i = 1; i < c.length - 1; i += 1) {
          if (!c[i - 1] || !c[i] || !c[i + 1]) continue; // a break between pieces is no corner
          const [x, y] = c[i];
          out.push({ kind: 'corner', x, y, slopeLeft: (y - c[i - 1][1]) / (x - c[i - 1][0]), slopeRight: (c[i + 1][1] - y) / (c[i + 1][0] - x), label: `corner at ${say(x)}, ${say(y)}` });
        }
      }
      return out;
    },
  };
}

function equationFunction(text) {
  const graph = compileEquation(text);
  return { label: graph.label, lo: -Infinity, hi: Infinity, limitAt: (x) => graph.limitAt(x), graph };
}

// A function written in the document (LaTeX, piecewise too), see graphs.js.
function latexFunction({ latex }) {
  const f = compileFunction(latex, 'latex');
  return { label: f.label, lo: -Infinity, hi: Infinity, limitAt: (x) => f.graph.limitAt(x), graph: f.graph, compiled: f };
}

export class GraphMode {
  constructor({ root, status, onExit, reading = null }) {
    this.root = root;
    this.status = status;
    this.reading = reading; // the same words on screen, for sighted helpers
    this.onExit = onExit;
    this.sound = new CalculusSoundEngine();
    this.applySettings({});
    this.timer = null;
    this.speakTimer = null;
    root.addEventListener('keydown', (e) => this.key(e));
    root.addEventListener('blur', () => this.pause(false));
  }

  // Settings > Graph sound.
  applySettings(s) {
    this.settings = { sound_profile: 'gentle', bass_mode: 'x-and-y', step: 0.5, play_speed_ms: 400, cues: true,
      volume: 0.25, bass_volume: 0.35, free_move_tones: true, dot_sounds: 'new', graph_numbers: 'half', pitch_glide: true, slope_sound: false, ...this.settings, ...s };
    const v = this.settings;
    this.sound.setSoundProfile(v.sound_profile);
    this.sound.setBassOutlineMode(v.bass_mode);
    this.sound.setCuesEnabled(v.cues);
    this.sound.setVolume(v.volume);
    this.sound.setBassOutlineVolume(v.bass_volume);
    this.sound.setStepDelayMs(v.play_speed_ms);
    this.sound.setDotSounds(v.dot_sounds);
    this.sound.setPitchGlide(v.pitch_glide);
    if ('slope_sound' in s) this.slopeSound = Boolean(v.slope_sound); // D in graph mode turns it on or off for now
    setNumberStyle(v.graph_numbers);
  }

  // Settings > Graph sound: hear a sound before saving it. The example climbs from 0 to 3,
  // falls to minus 2 and comes back to 0, from left to right; then a solid dot and an open dot.
  // short: just a climb and a fall, when moving through the choices.
  previewEngineFor(values) {
    const engine = this.previewEngine ||= new CalculusSoundEngine();
    const v = { ...this.settings, ...values };
    engine.setSoundProfile(v.sound_profile);
    engine.setVolume(v.volume);
    engine.setBassOutlineVolume(v.bass_volume);
    engine.setBassOutlineMode(v.bass_mode === 'off' ? 'x-and-y' : v.bass_mode);
    engine.setCuesEnabled(true);
    engine.setPitchGlide(v.pitch_glide);
    engine.setDotSounds(v.dot_sounds);
    engine.setStepDelayMs(300);
    engine.setWindow({ y: [-3, 4] });
    for (const t of this.previewTimers || []) clearTimeout(t);
    engine.stopBassOutline();
    this.previewTimers = [];
    return engine;
  }

  // The sound guide (Help > Sound guide): one sound, played as graph mode would play it.
  // name: one of GUIDE_SOUNDS' names.
  guide(name, values) {
    const e = this.previewEngineFor(values);
    const at = (ms, f) => this.previewTimers.push(setTimeout(f, ms));
    const notes = (ys, gap = 300, xs = null, withSlope = false) => ys.forEach((y, i) => at(i * gap, () => {
      const x = xs ? xs[i] : -3 + (6 * i) / Math.max(1, ys.length - 1);
      e.playSeatedPulse(x, y, 4, i ? ys[i - 1] : null);
      if (withSlope) e.playSlopeNote(x, 2 * x, 4, i ? 2 * (xs ? xs[i - 1] : 0) : null, 0.13);
    }));
    const effect = (kind, y = 1, mark = null, x = 0) => e.playLandmarkEffect(kind, x, 4, y, mark);
    switch (name) {
      case 'above': return notes([1, 3, 6], 450, [0, 0, 0]);
      case 'zero': return notes([0], 300, [0]);
      case 'below': return notes([-1, -3, -6], 450, [0, 0, 0]);
      case 'up': return notes([0, 0.5, 1, 1.5, 2, 2.5, 3]);
      case 'down': return notes([3, 2.5, 2, 1.5, 1, 0.5, 0, -0.5, -1]);
      case 'leftright': return notes([1, 1, 1], 500, [-4, 0, 4]);
      case 'gear': return notes([9, 9.5, 10, 10.5, 11], 400, [0, 0, 0, 0, 0]);
      case 'bass': {
        const ys = [0, 0.5, 1, 1.5, 2, 1.5, 1, 0.5, 0, -0.5, -1];
        ys.forEach((y, i) => at(i * 300, () => {
          const x = -3 + (6 * i) / (ys.length - 1);
          e.playStepSequence({ x, lim: { defined: true, y }, boundary: 4, prevY: i ? ys[i - 1] : null, withBassOutline: true });
        }));
        return at(ys.length * 300 + 200, () => e.stopBassOutline());
      }
      case 'peak': return effect('maximum', 2);
      case 'valley': return effect('minimum', -2);
      case 'x-axis': return effect('x-axis', 0, null, 1);
      case 'y-axis': return effect('y-axis', 1);
      case 'origin': return effect('origin', 0);
      case 'solid': return effect('solid-point', 1);
      case 'open': return effect('open-point', 1);
      case 'corner': return effect('corner', 0, { slopeLeft: -1, slopeRight: 1 }, 1);
      case 'asymptote': return effect('asymptote', 0, null, 1);
      case 'end': return effect('endpoint', 1, { included: true });
      case 'slope': {
        // y = x^2 from -2 to 2: the slope note falls, passes the middle note at the valley, then rises.
        const xs = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];
        return notes(xs.map((x) => x * x), 450, xs, true);
      }
      default: return undefined;
    }
  }

  preview(values, short = false) {
    const engine = this.previewEngineFor(values);
    const ys = short ? [0, 1, 2, 1, 0] : [0, 0.5, 1, 1.5, 2, 2.5, 3, 2.5, 2, 1.5, 1, 0.5, 0, -0.5, -1, -1.5, -2, -1.5, -1, -0.5, 0];
    const gap = short ? 220 : 300;
    this.previewTimers = ys.map((y, i) => setTimeout(() => {
      const x = -4 + (8 * i) / (ys.length - 1);
      engine.playSeatedPulse(x, y, 4, i ? ys[i - 1] : null);
    }, i * gap));
    if (!short) {
      const end = ys.length * gap + 300;
      this.previewTimers.push(setTimeout(() => engine.playLandmarkEffect('solid-point', 0, 4, 1), end));
      this.previewTimers.push(setTimeout(() => engine.playLandmarkEffect('open-point', 0, 4, 1), end + 700));
    }
    return short ? '' : 'Up from 0 to 3, down to minus 2, back to 0; then a solid dot and an open dot.';
  }

  // graph: { title, summary, span: {x:[a,b], y:[c,d]}, curves: [...], points: [...], equations: [...] }
  open(graph) {
    this.graph = graph;
    const span = graph.span || { x: [-5, 5], y: [-5, 5] };
    this.span = span;
    this.sound.setWindow(span);
    this.boundary = Math.max(Math.abs(span.x[0]), Math.abs(span.x[1]), 1);
    this.functions = [
      ...(graph.curves || []).filter((c) => !(c.kind !== 'curve' && c.corners?.length === 2 && c.corners[0][0] === c.corners[1][0])).map((c) => sampledFunction(c, graph.points || [])),
      ...(graph.equations || []).map(equationFunction),
      ...(graph.functions || []).map(latexFunction),
    ];
    // Every function's holes and open ends, for the picture.
    this.shapes = this.functions.flatMap((f) => (f.graph ? landmarksOf(f.graph, this.boundary) : []));
    this.verticals = (graph.curves || []).filter((c) => c.kind !== 'curve' && c.corners?.length === 2 && c.corners[0][0] === c.corners[1][0]);
    this.dots = (graph.points || []).map((p) => ({ kind: p.kind === 'open dot' ? 'open-point' : 'solid-point', x: p.coordinate[0], y: p.coordinate[1],
      label: dotWords(p), owner: p.function ?? null }));
    this.index = 0;
    this.step = STEPS.includes(this.settings.step) ? this.settings.step : 0.5;
    this.free = { x: 0, y: 0 };
    this.tracing = this.functions.length > 0;
    this.prepareFunction(true);
    this.root.hidden = false;
    this.root.focus();
    const names = this.functions.map((f) => f.label).join('; ');
    this.speak(`Graph mode. ${this.functions.length} ${this.functions.length === 1 ? 'function' : 'functions'}${names ? `: ${names}` : ''}. `
      + `J and K trace, arrow keys move freely, Space plays, Tab changes function, question mark for keys, Escape returns to the document.`);
    this.draw();
  }

  close() {
    this.pause(false);
    this.sound.stopBassOutline();
    this.root.hidden = true;
    this.onExit?.();
  }

  get fn() { return this.functions[this.index]; }

  prepareFunction(start) {
    const f = this.fn;
    if (!f) return;
    const lo = Math.max(f.lo, this.span.x[0]), hi = Math.min(f.hi, this.span.x[1]);
    this.lo = lo; this.hi = hi;
    const own = f.graph ? landmarksOf(f.graph, this.boundary) : f.landmarks();
    // A function's own dots (a piecewise jump's open end is off the curve), or any dot it passes through.
    const owner = this.index - this.functions.length + (this.graph.functions || []).length;
    const onCurve = this.dots.filter((d) => (d.owner !== null ? d.owner === owner
      : Math.abs((f.limitAt(d.x).y ?? NaN) - d.y) < 0.15 || !f.limitAt(d.x).defined
        || (f.piece && f.piece(d.x - 1e-6) !== f.piece(d.x + 1e-6) && f.piece(d.x - 1e-6) >= 0))); // both dots of a drawn jump
    // A student copy can keep some points of interest for the student to find.
    const hidden = new Set(this.graph.hidden || []);
    this.landmarks = [...own.map((l) => ({ ...l, label: spokenLabel(l) })), ...onCurve]
      .filter((l) => !hidden.has(l.kind) && l.x >= lo - 1e-9 && l.x <= hi + 1e-9).sort((a, b) => a.x - b.x);
    if (start) this.x = this.onGrid(Math.max(lo, Math.min(hi, 0)));
    this.prevY = null;
    this.prevSlope = null;
  }

  onGrid(x) { return Math.round(x / this.step) * this.step; }

  speak(text, delay = 0) {
    clearTimeout(this.speakTimer);
    const write = () => {
      this.status.textContent = '';
      setTimeout(() => { this.status.textContent = text; }, 20);
      if (this.reading) this.reading.textContent = text;
    };
    if (delay) this.speakTimer = setTimeout(write, delay); else write();
  }

  where() {
    if (!this.tracing) {
      const on = this.functionsAt(this.free.x, this.free.y);
      return `x ${exact(this.free.x)}, y ${exact(this.free.y)}${on.length ? `, on ${on.map((f) => f.label).join(' and ')}` : ''}`;
    }
    const lim = this.fn.limitAt(this.x);
    if (lim.defined) return `x ${exact(this.x)}, y ${say(lim.y)}`;
    if (lim.hole) return `x ${exact(this.x)}: a hole; the curve approaches y ${say(lim.y)}`;
    return `x ${exact(this.x)}: no point on ${this.fn.label} here`;
  }

  functionsAt(x, y) {
    return this.functions.filter((f) => { const l = f.limitAt(x); return l.defined && Math.abs(l.y - y) <= this.step / 2 + 1e-9; });
  }

  // One step along the selected function, Sound Lab style.
  traceTo(x, withBass) {
    const f = this.fn;
    if (!f) return;
    const clamped = Math.max(this.lo, Math.min(this.hi, x));
    const events = findStepEvents(this.landmarks, this.x, clamped);
    this.x = clamped;
    const lim = f.limitAt(this.x);
    this.sound.playStepSequence({ x: this.x, lim, boundary: this.boundary, prevY: this.prevY, passedOver: events.passedOver, landedOn: events.landedOn, withBassOutline: withBass });
    if (lim.defined || lim.hole) this.prevY = lim.y;
    if (this.slopeSound) {
      const m = lim.defined ? this.slopeAt(this.x).slope : null;
      this.sound.playSlopeNote(this.x, m, this.boundary, this.prevSlope, Math.min(0.15, this.settings.play_speed_ms * 0.00045));
      this.prevSlope = m;
    }
    this.draw();
    const landed = events.landedOn.map((l) => l.label).join('; ');
    if (!withBass) this.speak(`${this.where()}${landed ? `. ${landed}` : ''}`, 650); // read once you stop moving
  }

  moveFree(dx, dy) {
    this.pause(false);
    if (this.tracing) {
      const lim = this.fn?.limitAt(this.x);
      this.free = { x: this.x, y: lim?.defined ? this.onGrid(lim.y) : 0 };
      this.tracing = false;
    }
    const x = Math.max(this.span.x[0], Math.min(this.span.x[1], this.free.x + dx * this.step));
    const y = Math.max(this.span.y[0], Math.min(this.span.y[1], this.free.y + dy * this.step));
    this.free = { x: Number(x.toFixed(6)), y: Number(y.toFixed(6)) };
    // No bass while you move yourself; a curve's own tone plays when you land on it.
    const on = this.functionsAt(this.free.x, this.free.y);
    const dot = this.dots.find((d) => Math.abs(d.x - this.free.x) < this.step / 2 && Math.abs(d.y - this.free.y) < this.step / 2);
    if (!this.settings.free_move_tones) { /* tones turned off in Settings; the position is still read */ }
    else if (Math.abs(this.free.x) < 1e-9 && Math.abs(this.free.y) < 1e-9) this.sound.playLandmarkEffect('origin', 0, this.boundary, 0);
    else if (dot) this.sound.playLandmarkEffect(dot.kind, dot.x, this.boundary, dot.y, dot);
    else if (on.length) this.sound.playSeatedPulse(this.free.x, on[0].limitAt(this.free.x).y, this.boundary, null);
    this.draw();
    this.speak(this.where() + (dot ? `, ${dot.label}` : ''), 650);
  }

  play() {
    if (this.timer) { this.pause(true); return; }
    if (!this.fn) return;
    this.tracing = true;
    if (this.x >= this.hi - 1e-9) this.x = this.onGrid(this.lo) < this.lo ? this.onGrid(this.lo) + this.step : this.onGrid(this.lo);
    this.speak('Playing.');
    this.timer = setInterval(() => {
      if (this.x >= this.hi - 1e-9) { this.pause(true); return; }
      this.traceTo(Math.min(this.hi, this.onGrid(this.x) + this.step), true);
    }, this.settings.play_speed_ms);
  }

  pause(announce) {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.sound.stopBassOutline();
    if (announce) this.speak(`Stopped at ${this.where()}.`); // the coordinate where it stopped
  }

  jumpLandmark(direction) {
    this.pause(false);
    this.tracing = true;
    const list = direction > 0 ? this.landmarks.filter((l) => l.x > this.x + 1e-9) : this.landmarks.filter((l) => l.x < this.x - 1e-9).reverse();
    if (!list.length) { this.speak(direction > 0 ? 'No more points of interest to the right.' : 'No more points of interest to the left.'); return; }
    this.traceTo(list[0].x, false);
    // Everything at that x is read together: a jump's two dots and the axis crossing there.
    const here = this.landmarks.filter((l) => Math.abs(l.x - list[0].x) < 1e-9);
    this.speak([...new Set(here.map((l) => l.label))].join('; '));
  }

  // The curve's height just left (dir -1) or right (dir 1) of x, closer and closer:
  // { value } where it settles, { infinite: 1 or -1 } where it runs off, or null (no curve there,
  // or it never settles).
  sideLimit(x, dir) {
    const f = this.fn;
    const v = [1e-3, 1e-4, 1e-5, 1e-6].map((h) => { const l = f.limitAt(x + dir * h); return l.defined ? l.y : NaN; });
    if (!v.slice(1).every(Number.isFinite)) return null;
    if (Math.abs(v[3]) > 1e4 && Math.abs(v[3]) > 10 * Math.abs(v[0])) return { infinite: Math.sign(v[3]) };
    if (Math.abs(v[1] - v[3]) > 0.01 * (1 + Math.abs(v[3]))) return null;
    return { value: Number(v[3].toPrecision(6)) };
  }

  // L: the limits at the cursor from the left and the right, and the value there.
  limits() {
    if (!this.fn) return 'No function to read.';
    const x = this.tracing ? this.x : this.free.x;
    const words = (l) => (!l ? 'no limit' : l.infinite ? (l.infinite > 0 ? 'goes up to infinity' : 'goes down to minus infinity') : say(l.value));
    const left = this.sideLimit(x, -1), right = this.sideLimit(x, 1);
    const here = this.fn.limitAt(x);
    const value = here.defined ? `the value is ${say(here.y)}` : 'there is no point here';
    const same = left && right && !left.infinite && !right.infinite && Math.abs(left.value - right.value) <= 1e-4 * (1 + Math.abs(left.value));
    let verdict;
    if (same) verdict = here.defined && Math.abs(here.y - left.value) <= 1e-4 * (1 + Math.abs(here.y)) ? 'Continuous here.' : here.defined ? 'The limit and the value differ.' : 'A hole: the limit exists, but there is no point.';
    else if (left && right && left.infinite && left.infinite === right.infinite) verdict = 'A vertical asymptote.';
    else if (left && right) verdict = left.infinite || right.infinite ? 'A vertical asymptote: the two sides differ.' : 'No limit: the two sides differ, a jump.';
    else verdict = !left && !right ? 'No curve on either side.' : `The curve is only on the ${left ? 'left' : 'right'}.`;
    const sides = same ? `from both sides ${say(left.value)}` : `from the left ${words(left)}, from the right ${words(right)}`;
    return `At x = ${exact(x)}: ${sides}; ${value}. ${verdict}`;
  }

  // The slope at x from the curve's heights on each side: { slope } where both sides agree,
  // otherwise { left, right } (a corner, a jump or an end), each null where there is none.
  slopeAt(x) {
    const f = this.fn;
    const h = 1e-4;
    const y = (t) => { const l = f.limitAt(t); return l.defined ? l.y : NaN; };
    const y0 = y(x);
    if (!Number.isFinite(y0)) return { slope: null, left: null, right: null };
    // One side's slope; where it keeps growing as the step shrinks (the start of sqrt x, the
    // middle of cbrt x) the curve is vertical there: an infinite slope.
    const side = (dir) => {
      const a = y(x + dir * h), b = y(x + dir * h / 100);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      // A gap that does not close as the step shrinks is a jump: no slope across it.
      if (Math.abs(b - y0) > 1e-3 && Math.abs(b - y0) > 0.5 * Math.abs(a - y0)) return NaN;
      const far = (a - y0) / (dir * h), near = (b - y0) / (dir * h / 100);
      return Math.abs(near) > 50 && Math.abs(near) > 4 * Math.abs(far) ? Math.sign(near) * Infinity : near;
    };
    const left = side(-1), right = side(1);
    if (Number.isNaN(left) || Number.isNaN(right)) return { slope: null, left, right, jump: true };
    const same = left !== null && right !== null && (left === right || Math.abs(left - right) <= 0.02 * (1 + Math.abs(left) + Math.abs(right)));
    if (same) return { slope: Number.isFinite(left) ? (left + right) / 2 : left, left, right };
    return { slope: null, left, right };
  }

  // S: the slope at the cursor, in words. A graph drawn on the page (no formula) gives an estimate.
  slope() {
    if (!this.fn) return 'No function to read.';
    const x = this.tracing ? this.x : this.free.x;
    const about = this.fn.compiled || this.fn.graph ? '' : 'about ';
    const { slope, left, right, jump } = this.slopeAt(x);
    if (jump) return `At x = ${exact(x)}: no single slope, the curve jumps here.`;
    if (slope !== null) return `At x = ${exact(x)}: ${slopeWords(slope, about)}.`;
    if (left === null && right === null) return `At x = ${exact(x)}: no slope, there is no point here.`;
    if (left === null || right === null) return `At x = ${exact(x)}: the curve ${left === null ? 'starts' : 'ends'} here; from the ${left === null ? 'right' : 'left'}, ${slopeWords(left ?? right, about)}.`;
    return `At x = ${exact(x)}: no single slope, a corner. From the left, ${slopeWords(left, about)}; from the right, ${slopeWords(right, about)}.`;
  }

  describe() {
    // Functions with their formula are described afresh, numbers rounded as Settings asks;
    // a stored description (a student copy, a PDF graph) has its numbers rounded the same way.
    const span = this.span;
    const own = this.functions.filter((f) => f.compiled);
    const hiddenKinds = new Set(this.graph.hidden || []);
    const hide = Object.keys(HIDEABLE).filter((k) => HIDEABLE[k].kinds.every((kind) => hiddenKinds.has(kind)));
    const words = own.length
      ? `${own.map((f) => { const p = describeFunction(f.compiled, span.x, hide); return `${f.label}${p.length ? `: ${p.join('; ')}` : ''}`; }).join('. ')}. Shown for x from ${say(span.x[0])} to ${say(span.x[1])} and y from ${say(span.y[0])} to ${say(span.y[1])}.`
      : roundWords(this.graph.summary || '');
    const parts = [words];
    if (this.verticals.length) parts.push(`${this.verticals.length} vertical ${this.verticals.length === 1 ? 'line is' : 'lines are'} not traced, because a vertical line is not a function of x.`);
    this.speak(parts.join(' ').trim() || 'No description.');
  }

  // The same actions from the Graph menu (for mouse users, and to find them by name).
  command(name) {
    const keys = { play: ' ', next: '.', previous: ',', describe: 'i', read: 'v', step: 'f', function: 'Tab', close: 'Escape', slope: 's', limits: 'l', slopeSound: 'd' };
    this.root.focus();
    this.key({ key: keys[name], shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} });
  }

  key(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    const handled = () => e.preventDefault();
    if (k === 'Escape') { handled(); this.close(); return; }
    if (k === 'k' || k === 'K') { handled(); this.pause(false); this.tracing = true; this.traceTo(this.onGrid(this.x) + this.step, false); return; }
    if (k === 'j' || k === 'J') { handled(); this.pause(false); this.tracing = true; this.traceTo(this.onGrid(this.x) - this.step, false); return; }
    if (k === 'ArrowRight') { handled(); this.moveFree(1, 0); return; }
    if (k === 'ArrowLeft') { handled(); this.moveFree(-1, 0); return; }
    if (k === 'ArrowUp') { handled(); this.moveFree(0, 1); return; }
    if (k === 'ArrowDown') { handled(); this.moveFree(0, -1); return; }
    if (k === ' ') { handled(); this.play(); return; }
    if (k === 'Tab') {
      handled();
      if (!this.functions.length) return;
      this.pause(false);
      this.index = (this.index + (e.shiftKey ? this.functions.length - 1 : 1)) % this.functions.length;
      const keepX = this.tracing ? this.x : this.free.x;
      this.prepareFunction(false);
      this.x = this.onGrid(Math.max(this.lo, Math.min(this.hi, keepX)));
      this.tracing = true;
      this.speak(`${this.fn.label}. ${this.where()}`);
      this.draw();
      return;
    }
    if (k === 'c' || k === 'C') {
      handled(); this.pause(false);
      this.x = this.onGrid(Math.max(this.lo, Math.min(this.hi, this.tracing ? this.x : this.free.x)));
      this.tracing = true; this.traceTo(this.x, false); return;
    }
    if (k === 'v' || k === 'V' || k === 'Enter') { handled(); this.speak(this.where()); return; }
    if (k === 'i' || k === 'I') { handled(); this.describe(); return; }
    if (k === 's' || k === 'S') { handled(); this.pause(false); this.speak(this.slope()); return; }
    if (k === 'l' || k === 'L') { handled(); this.pause(false); this.speak(this.limits()); return; }
    if (k === 'd' || k === 'D') {
      handled();
      this.slopeSound = !this.slopeSound;
      this.prevSlope = null;
      this.speak(this.slopeSound ? 'Slope sound on: after each note, a soft second note for the slope. High is rising, the middle note is flat, low is falling.' : 'Slope sound off.');
      return;
    }
    if (k === '.') { handled(); this.jumpLandmark(1); return; }
    if (k === ',') { handled(); this.jumpLandmark(-1); return; }
    if (k === 'Home') { handled(); this.pause(false); this.tracing = true; this.traceTo(this.lo, false); return; }
    if (k === 'End') { handled(); this.pause(false); this.tracing = true; this.traceTo(this.hi, false); return; }
    if (k === 'f' || k === 'F') {
      handled();
      this.step = STEPS[(STEPS.indexOf(this.step) + (e.shiftKey ? STEPS.length - 1 : 1)) % STEPS.length];
      this.speak(`Step ${exact(this.step)}.`);
      return;
    }
    if (k === '?' || k === 'h' || k === 'H') {
      handled();
      this.speak('K or J: step along the function, forward or back. Arrow keys: move freely; a tone plays when you land on a curve. '
        + 'C: put the cursor back on the function. Space: play or stop with the bass line; stopping reads the point. '
        + 'Tab and Shift+Tab: next or previous function. Period and comma: next or previous point of interest. '
        + 'Home and End: ends of the function. V: read the point. I: describe the graph. S: the slope here. L: the limits from the left and the right. '
        + 'D: slope sound on or off. F: step size. Escape: back to the document.');
    }
  }

  // A picture for sighted helpers; hidden from screen readers.
  draw() {
    const svg = this.root.querySelector('svg');
    if (!svg) return;
    const [x0, x1] = this.span.x, [y0, y1] = this.span.y;
    const W = 600, H = 400;
    const px = (x) => ((x - x0) / (x1 - x0)) * W, py = (y) => H - ((y - y0) / (y1 - y0)) * H;
    const paths = this.functions.map((f, n) => {
      let d = '', pen = false, prev = null;
      const room = (y1 - y0) * 0.5;
      for (let i = 0; i <= 600; i += 1) {
        const x = x0 + (x1 - x0) * i / 600, l = f.limitAt(x);
        // The pen lifts at a jump or an asymptote, so no false line joins the two sides
        // (where two rows of a piecewise function meet at the same height, it carries on).
        const joined = prev !== null && (f.graph ? f.graph.isContinuousBetween(prev.x, x) || Math.abs(l.y - prev.y) < (y1 - y0) * 0.02
          : !f.piece || f.piece(prev.x) === f.piece(x));
        if (l.defined && l.y >= y0 - room && l.y <= y1 + room) { d += `${pen && joined ? 'L' : 'M'}${px(x).toFixed(1)},${py(l.y).toFixed(1)}`; pen = true; } else pen = false;
        prev = l.defined ? { x, y: l.y } : null;
      }
      return `<path d="${d}" fill="none" stroke="${n === this.index ? 'var(--accent)' : 'var(--muted)'}" stroke-width="${n === this.index ? 3 : 1.5}"/>`;
    }).join('');
    const cx = this.tracing ? this.x : this.free.x;
    const cy = this.tracing ? this.fn?.limitAt(this.x).y : this.free.y;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    // Axis numbers at whole steps (about ten of them), so a sighted helper can read the picture.
    const ticks = (lo, hi) => { const step = 10 ** Math.floor(Math.log10((hi - lo) / 2)) * ([1, 2, 5].find((m) => (hi - lo) / (10 ** Math.floor(Math.log10((hi - lo) / 2)) * m) <= 12) || 10); const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toPrecision(10))); return out; };
    const axisY = Math.min(H - 4, Math.max(12, py(0))), axisX = Math.min(W - 24, Math.max(4, px(0)));
    // (No number right at the edge, where it would be cut off.)
    const inside = (lo, hi) => (v) => v !== 0 && v > lo + (hi - lo) * 0.03 && v < hi - (hi - lo) * 0.03;
    const labels = ticks(x0, x1).filter(inside(x0, x1)).map((v) => `<text x="${px(v)}" y="${axisY + 14}" text-anchor="middle">${v}</text><line x1="${px(v)}" y1="${axisY - 3}" x2="${px(v)}" y2="${axisY + 3}" stroke="var(--muted)"/>`).join('')
      + ticks(y0, y1).filter(inside(y0, y1)).map((v) => `<text x="${axisX + 6}" y="${py(v) + 4}">${v}</text><line x1="${axisX - 3}" y1="${py(v)}" x2="${axisX + 3}" y2="${py(v)}" stroke="var(--muted)"/>`).join('');
    // A formula's own holes ((x^2-4)/(x-2) at 2) and ends that are left out are open circles too.
    const own = (this.shapes || []).filter((l) => (l.kind === 'open-point' && !this.dots.some((d) => Math.abs(d.x - l.x) < 1e-9)) || (l.kind === 'endpoint' && !l.included));
    const dots = [...(this.dots || []), ...own.map((l) => ({ kind: 'open-point', x: l.x, y: l.y }))].map((d) => `<circle cx="${px(d.x)}" cy="${py(d.y)}" r="4.5" fill="${d.kind === 'open-point' ? 'var(--bg)' : 'var(--text)'}" stroke="var(--text)" stroke-width="1.5"/>`).join('');
    svg.innerHTML = `<line x1="${px(0)}" y1="0" x2="${px(0)}" y2="${H}" stroke="var(--line)"/><line x1="0" y1="${py(0)}" x2="${W}" y2="${py(0)}" stroke="var(--line)"/>${labels}${paths}${dots}`
      + (Number.isFinite(cy) ? `<circle cx="${px(cx)}" cy="${py(cy)}" r="7" fill="none" stroke="var(--check-line)" stroke-width="3"/>` : '');
  }
}
