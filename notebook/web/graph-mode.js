// Graph mode: explore a graph by sound, using Sound Lab's engine and math.
// J/K trace the selected function; arrow keys move freely (no bass) and the curve's
// tone plays when the cursor lands on it; Space plays with the bass and reads the
// coordinate when it stops; Tab switches functions.
import { CalculusSoundEngine } from '/sound/sound-engine.js';
import { compileEquation, detectLandmarks, findStepEvents, formatNumber } from '/sound/graph-math.js';
import { compileFunction, landmarksOf } from './graphs.js';

const STEPS = [0.1, 0.25, 0.5, 1];
const say = (n) => formatNumber(Math.abs(n) < 1e-9 ? 0 : n).replace('-', 'minus ');

// A function made from the exact points the PDF reader found (straight pieces or samples).
function sampledFunction(curve) {
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
    limitAt(x) {
      const pts = pieces.find((s) => x >= s[0].x - 1e-9 && x <= s.at(-1).x + 1e-9);
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
      if (curve.kind !== 'curve') {
        const c = curve.corners || [];
        for (let i = 1; i < c.length - 1; i += 1) {
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
  return { label: f.label, lo: -Infinity, hi: Infinity, limitAt: (x) => f.graph.limitAt(x), graph: f.graph };
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

  // Settings > Graph sound (the values Sound Lab and GTool used to set on their own).
  applySettings(s) {
    this.settings = { sound_profile: 'gentle', bass_mode: 'x-and-y', step: 0.5, play_speed_ms: 400, cues: true,
      volume: 0.25, bass_volume: 0.35, free_move_tones: true, dot_sounds: 'new', ...this.settings, ...s };
    const v = this.settings;
    this.sound.setSoundProfile(v.sound_profile);
    this.sound.setBassOutlineMode(v.bass_mode);
    this.sound.setCuesEnabled(v.cues);
    this.sound.setVolume(v.volume);
    this.sound.setBassOutlineVolume(v.bass_volume);
    this.sound.setStepDelayMs(v.play_speed_ms);
    this.sound.setDotSounds(v.dot_sounds);
  }

  // graph: { title, summary, span: {x:[a,b], y:[c,d]}, curves: [...], points: [...], equations: [...] }
  open(graph) {
    this.graph = graph;
    const span = graph.span || { x: [-5, 5], y: [-5, 5] };
    this.span = span;
    this.sound.setWindow(span);
    this.boundary = Math.max(Math.abs(span.x[0]), Math.abs(span.x[1]), 1);
    this.functions = [
      ...(graph.curves || []).filter((c) => !(c.kind !== 'curve' && c.corners?.length === 2 && c.corners[0][0] === c.corners[1][0])).map(sampledFunction),
      ...(graph.equations || []).map(equationFunction),
      ...(graph.functions || []).map(latexFunction),
    ];
    // Every function's holes and open ends, for the picture.
    this.shapes = this.functions.flatMap((f) => (f.graph ? landmarksOf(f.graph, this.boundary) : []));
    this.verticals = (graph.curves || []).filter((c) => c.kind !== 'curve' && c.corners?.length === 2 && c.corners[0][0] === c.corners[1][0]);
    this.dots = (graph.points || []).map((p) => ({ kind: p.kind === 'open dot' ? 'open-point' : 'solid-point', x: p.coordinate[0], y: p.coordinate[1],
      label: p.label || `${p.kind} at ${say(p.coordinate[0])}, ${say(p.coordinate[1])}`, owner: p.function ?? null }));
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
      : Math.abs((f.limitAt(d.x).y ?? NaN) - d.y) < 0.15 || !f.limitAt(d.x).defined));
    // A student copy can keep some points of interest for the student to find.
    const hidden = new Set(this.graph.hidden || []);
    this.landmarks = [...own, ...onCurve].filter((l) => !hidden.has(l.kind) && l.x >= lo - 1e-9 && l.x <= hi + 1e-9).sort((a, b) => a.x - b.x);
    if (start) this.x = this.onGrid(Math.max(lo, Math.min(hi, 0)));
    this.prevY = null;
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
      return `x ${say(this.free.x)}, y ${say(this.free.y)}${on.length ? `, on ${on.map((f) => f.label).join(' and ')}` : ''}`;
    }
    const lim = this.fn.limitAt(this.x);
    if (lim.defined) return `x ${say(this.x)}, y ${say(lim.y)}`;
    if (lim.hole) return `x ${say(this.x)}: a hole; the curve approaches y ${say(lim.y)}`;
    return `x ${say(this.x)}: no point on ${this.fn.label} here`;
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

  describe() {
    const parts = [this.graph.summary || ''];
    if (this.verticals.length) parts.push(`${this.verticals.length} vertical ${this.verticals.length === 1 ? 'line is' : 'lines are'} not traced, because a vertical line is not a function of x.`);
    this.speak(parts.join(' ').trim() || 'No description.');
  }

  // The same actions from the Graph menu (for mouse users, and to find them by name).
  command(name) {
    const keys = { play: ' ', next: '.', previous: ',', describe: 'i', read: 'v', step: 'f', function: 'Tab', close: 'Escape' };
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
    if (k === '.') { handled(); this.jumpLandmark(1); return; }
    if (k === ',') { handled(); this.jumpLandmark(-1); return; }
    if (k === 'Home') { handled(); this.pause(false); this.tracing = true; this.traceTo(this.lo, false); return; }
    if (k === 'End') { handled(); this.pause(false); this.tracing = true; this.traceTo(this.hi, false); return; }
    if (k === 'f' || k === 'F') {
      handled();
      this.step = STEPS[(STEPS.indexOf(this.step) + (e.shiftKey ? STEPS.length - 1 : 1)) % STEPS.length];
      this.speak(`Step ${say(this.step)}.`);
      return;
    }
    if (k === '?' || k === 'h' || k === 'H') {
      handled();
      this.speak('K or J: step along the function, forward or back. Arrow keys: move freely; a tone plays when you land on a curve. '
        + 'C: put the cursor back on the function. Space: play or stop with the bass line; stopping reads the point. '
        + 'Tab and Shift+Tab: next or previous function. Period and comma: next or previous point of interest. '
        + 'Home and End: ends of the function. V: read the point. I: describe the graph. F: step size. Escape: back to the document.');
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
        const joined = prev !== null && (!f.graph || f.graph.isContinuousBetween(prev.x, x) || Math.abs(l.y - prev.y) < (y1 - y0) * 0.02);
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
