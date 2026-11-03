const FUNCTIONS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: (x) => (Math.abs(Math.cos(x)) <= 4 * Number.EPSILON ? NaN : Math.tan(x)),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log10,
  ln: Math.log,
  exp: (x) => {
    const result = Math.exp(x);
    return result === 0 ? NaN : result;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  cbrt: Math.cbrt,
};

const finite = (value) => (Number.isFinite(value) ? value : NaN);
const unaryValue = (fn, value) => (Number.isFinite(value) ? finite(fn(value)) : NaN);

function binaryValue(operator, left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
  if (operator === '+') return finite(left + right);
  if (operator === '-') return finite(left - right);
  if (operator === '*') return finite(left * right);
  if (operator === '/') return right === 0 ? NaN : finite(left / right);
  if (operator === '^') {
    if (left === 0 && right === 0) return NaN;
    const result = left < 0 && !Number.isInteger(right) ? oddRootPower(left, right) : left ** right;
    return result === 0 && left !== 0 ? NaN : finite(result);
  }
  return NaN;
}

// Real powers of negative bases: x^(1/3) = cbrt(x), x^(2/3) = cbrt(x)^2.
// JavaScript returns NaN for (-8) ** (1/3); calculus courses expect the real
// odd root. Only exponents that are (numerically) p/q with an odd q qualify.
function oddRootPower(base, exponent) {
  for (let q = 3; q <= 99; q += 2) {
    const p = Math.round(exponent * q);
    if (Math.abs(exponent * q - p) <= 1e-9 * q) {
      const magnitude = Math.abs(base) ** exponent;
      return Math.abs(p) % 2 === 1 ? -magnitude : magnitude;
    }
  }
  return NaN;
}

export function addCoordinate(value, delta) {
  if (delta === 0) return value;
  const sum = value + delta;
  if (Math.abs(sum) <= 4 * Number.EPSILON * (Math.abs(value) + Math.abs(delta))) return 0;
  return Number(sum.toPrecision(15));
}

export function formatNumber(value) {
  if (!Number.isFinite(value)) return 'undefined';
  if (Math.abs(value) <= 1e-12) return '0';
  return Number(value.toPrecision(6)).toString();
}

function tokenize(source) {
  const text = String(source || '')
    .toLowerCase()
    .replaceAll('\u03c0', 'pi')
    .replaceAll('\u2212', '-')
    .replaceAll('\u00d7', '*')
    .replaceAll('\u00f7', '/')
    .replaceAll('\u00b2', '^2')
    .replaceAll('\u00b3', '^3')
    .replace(/arcsin/g, 'asin')
    .replace(/arccos/g, 'acos')
    .replace(/arctan/g, 'atan');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
      continue;
    }
    const number = text.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)?.[0];
    if (number) {
      if (!Number.isFinite(Number(number))) throw new Error('Number is outside the supported range.');
      if (tokens.at(-1)?.type === 'number') throw new Error('Put an operator between numbers.');
      tokens.push({ type: 'number', value: Number(number) });
      index += number.length;
      continue;
    }
    const identifier = text.slice(index).match(/^[a-z]+/i)?.[0];
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier });
      index += identifier.length;
      continue;
    }
    if ('+-*/^(),'.includes(text[index])) {
      tokens.push({ type: text[index], value: text[index] });
      index += 1;
      continue;
    }
    throw new Error(`Unsupported symbol: ${text[index]}`);
  }
  tokens.push({ type: 'end' });
  return tokens;
}

export function compileExpression(source) {
  // Long enough for functions written from LaTeX, which carry many brackets.
  if (String(source || '').length > 400) throw new Error('Expression is too long.');
  const tokens = tokenize(source);
  const variables = new Set();
  const domainChecks = [];
  let hasSteps = false;
  let position = 0;
  const peek = () => tokens[position];
  const take = (type) => {
    if (peek().type !== type) throw new Error(`Expected ${type}.`);
    return tokens[position++];
  };

  function primary() {
    if (peek().type === 'number') {
      const value = take('number').value;
      return () => value;
    }
    if (peek().type === 'identifier') {
      const name = take('identifier').value;
      if (name === 'pi') return () => Math.PI;
      if (name === 'e') return () => Math.E;
      if (name === 'x' || name === 'y') {
        variables.add(name);
        return (scope) => finite(scope[name]);
      }
      const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : null;
      if (!fn) throw new Error(`Unsupported function: ${name}.`);
      take('(');
      const argument = expression();
      take(')');
      if (name === 'tan') {
        domainChecks.push({ kind: 'zero', evaluate: (scope) => unaryValue(Math.cos, argument(scope)) });
      }
      if (['floor', 'ceil', 'round', 'sign'].includes(name)) {
        hasSteps = true;
        domainChecks.push({ kind: 'step', evaluate: (scope) => unaryValue(fn, argument(scope)) });
      }
      return (scope) => unaryValue(fn, argument(scope));
    }
    if (peek().type === '(') {
      take('(');
      const value = expression();
      take(')');
      return value;
    }
    throw new Error('Expected a number, x, function, or parentheses.');
  }

  function power() {
    const left = primary();
    if (peek().type !== '^') return left;
    take('^');
    const right = unary();
    // A negative exponent divides by the base: x^(-1) has a pole where x = 0,
    // exactly like 1/x. Register it so asymptotes are detected and not joined.
    domainChecks.push({
      kind: 'zero',
      evaluate: (scope) => {
        const exponent = right(scope);
        return Number.isFinite(exponent) && exponent < 0 ? left(scope) : 1;
      },
    });
    return (scope) => binaryValue('^', left(scope), right(scope));
  }

  function unary() {
    if (peek().type === '+') {
      take('+');
      return unary();
    }
    if (peek().type === '-') {
      take('-');
      const value = unary();
      return (scope) => unaryValue((x) => -x, value(scope));
    }
    return power();
  }

  function multiplication() {
    let left = unary();
    while (true) {
      const type = peek().type;
      if (type === '*' || type === '/') {
        take(type);
        const right = unary();
        const previous = left;
        if (type === '/') domainChecks.push({ kind: 'zero', evaluate: right });
        left = (scope) => binaryValue(type, previous(scope), right(scope));
      } else if (type === 'number' || type === 'identifier' || type === '(') {
        const right = unary();
        const previous = left;
        left = (scope) => binaryValue('*', previous(scope), right(scope));
      } else {
        break;
      }
    }
    return left;
  }

  function expression() {
    let left = multiplication();
    while (peek().type === '+' || peek().type === '-') {
      const operator = take(peek().type).type;
      const right = multiplication();
      const previous = left;
      left = (scope) => binaryValue(operator, previous(scope), right(scope));
    }
    return left;
  }

  const evaluateRaw = expression();
  if (peek().type !== 'end') throw new Error(`Unexpected ${peek().value || peek().type}.`);

  return {
    variables,
    hasSteps,
    domainChecks,
    isContinuousBetween(first, second) {
      const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      return domainChecks.every((check) => {
        const values = [first, middle, second].map((scope) => check.evaluate(scope));
        if (!values.every(Number.isFinite)) return false;
        return check.kind === 'step'
          ? values.every((v) => v === values[0])
          : values.every((v) => v !== 0 && Math.sign(v) === Math.sign(values[0]));
      });
    },
    evaluate(scope = {}) {
      const value = evaluateRaw(scope);
      return Number.isFinite(value) ? value : NaN;
    },
  };
}

export function compileEquation(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^f\s*\(\s*x\s*\)\s*=/i, 'y=')
    .replace(/^g\s*\(\s*x\s*\)\s*=/i, 'y=');
  if (!cleaned) throw new Error('Enter an equation in x, such as y = x^2 - 4.');
  const pieces = cleaned.split('=');
  if (pieces.length > 2) throw new Error('Use only one equals sign.');
  if (pieces.length === 1) pieces.unshift('y');
  const [leftText, rightText] = pieces.map((p) => p.trim());
  if (!leftText || !rightText) throw new Error('Both sides of the equation are required.');

  const left = compileExpression(leftText);
  const right = compileExpression(rightText);
  const explicit =
    leftText.toLowerCase() === 'y' && !right.variables.has('y')
      ? right
      : rightText.toLowerCase() === 'y' && !left.variables.has('y')
        ? left
        : null;
  if (!explicit) {
    throw new Error('Enter an explicit function of x, such as y = x^2 - 4 or (x^2 - 4)/(x - 2).');
  }
  const functionText = explicit === right ? rightText : leftText;
  return {
    type: 'function',
    label: `y = ${functionText}`,
    equation: `y = ${functionText}`,
    variables: explicit.variables,
    hasSteps: explicit.hasSteps,
    domainChecks: explicit.domainChecks,
    isContinuousBetween(a, b) {
      return explicit.isContinuousBetween({ x: a, y: 0 }, { x: b, y: 0 });
    },
    yAt(x) {
      return explicit.evaluate({ x });
    },
    limitAt(x) {
      const direct = explicit.evaluate({ x });
      if (Number.isFinite(direct)) return { defined: true, y: direct };
      // A hole needs one finite two-sided limit. Checking at two distances
      // separates a hole such as (x^2-4)/(x-2) from a symmetric pole such as
      // 1/x^2, whose two sides agree with each other but grow without bound.
      const near = [1e-6, 1e-4].map((eps) => [explicit.evaluate({ x: x - eps }), explicit.evaluate({ x: x + eps })]);
      const values = near.flat();
      const agree = (a, b) => Math.abs(a - b) <= 1e-3 * (1 + Math.max(Math.abs(a), Math.abs(b)));
      if (values.every(Number.isFinite) && values.every((v) => agree(v, values[0]))) {
        const [leftY, rightY] = near[0];
        return { defined: false, hole: true, y: Number(((leftY + rightY) / 2).toPrecision(10)) };
      }
      return { defined: false, hole: false, y: NaN };
    },
  };
}

function refineZeroOfFn(fn, left, right) {
  let a = left;
  let b = right;
  let fa = fn(a);
  let fb = fn(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return null;
  if (Math.abs(fa) <= 1e-12) return a;
  if (Math.abs(fb) <= 1e-12) return b;
  if (Math.sign(fa) === Math.sign(fb)) return null;
  for (let i = 0; i < 60; i += 1) {
    const mid = (a + b) / 2;
    const fm = fn(mid);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) <= 1e-13 || mid === a || mid === b) return mid;
    if (Math.sign(fa) === Math.sign(fm)) {
      a = mid;
      fa = fm;
    } else {
      b = mid;
      fb = fm;
    }
  }
  const candidate = (a + b) / 2;
  const fc = fn(candidate);
  return Number.isFinite(fc) && Math.abs(fc) <= 1e-5 ? Number(candidate.toPrecision(12)) : null;
}

export function detectLandmarks(graph, boundary = 10, customPoints = []) {
  const landmarks = [];
  const addLandmark = (kind, x, y, label) => {
    if (!Number.isFinite(x) || Math.abs(x) > boundary + 1e-9) return;
    const cleanX = Math.abs(x) <= 1e-10 ? 0 : Number(x.toPrecision(10));
    const cleanY = Number.isFinite(y) ? (Math.abs(y) <= 1e-10 ? 0 : Number(y.toPrecision(10))) : null;
    const existing = landmarks.find((item) => Math.abs(item.x - cleanX) <= 1e-5 && item.kind === kind);
    if (existing) return;
    landmarks.push({ kind, x: cleanX, y: cleanY, label });
  };

  // 1. Detect removable discontinuities (Open Points / Holes) and vertical asymptotes from denominator checks
  const steps = 800;
  const step = (boundary * 2) / steps;
  for (const check of graph.domainChecks || []) {
    if (check.kind !== 'zero') continue;
    const evalDenom = (x) => check.evaluate({ x, y: 0 });
    for (let i = 0; i <= steps; i += 1) {
      const x = addCoordinate(-boundary, i * step);
      const val = evalDenom(x);
      if (Number.isFinite(val) && Math.abs(val) <= 1e-10) {
        const lim = graph.limitAt(x);
        if (lim.hole) {
          addLandmark('open-point', x, lim.y, `Open point (hole) at (${formatNumber(x)}, ${formatNumber(lim.y)})`);
        } else {
          addLandmark('asymptote', x, null, `Vertical asymptote or undefined at x = ${formatNumber(x)}`);
        }
      }
      if (i > 0 && i < steps) {
        // An even-power denominator such as (x-0.31)^2 touches zero without
        // changing sign, so bisection never sees it. Look for |d| bottoming out.
        const before = evalDenom(addCoordinate(-boundary, (i - 1) * step));
        const after = evalDenom(addCoordinate(-boundary, (i + 1) * step));
        if (
          [before, val, after].every(Number.isFinite) &&
          Math.abs(val) > 1e-10 &&
          Math.abs(val) <= Math.abs(before) &&
          Math.abs(val) <= Math.abs(after) &&
          Math.sign(before) === Math.sign(after)
        ) {
          let lo = addCoordinate(-boundary, (i - 1) * step);
          let hi = addCoordinate(-boundary, (i + 1) * step);
          for (let iter = 0; iter < 80; iter += 1) {
            const p = lo + (hi - lo) / 3;
            const q = hi - (hi - lo) / 3;
            if (Math.abs(evalDenom(p)) < Math.abs(evalDenom(q))) hi = q;
            else lo = p;
          }
          const touchX = (lo + hi) / 2;
          const scale = 1 + Math.max(Math.abs(before), Math.abs(after));
          if (Math.abs(evalDenom(touchX)) <= 1e-9 * scale) {
            const cleanTouch = Number(touchX.toPrecision(8));
            const lim = graph.limitAt(cleanTouch);
            if (lim.hole) {
              addLandmark('open-point', cleanTouch, lim.y, `Open point (hole) at (${formatNumber(cleanTouch)}, ${formatNumber(lim.y)})`);
            } else {
              addLandmark('asymptote', cleanTouch, null, `Vertical asymptote or undefined at x = ${formatNumber(cleanTouch)}`);
            }
          }
        }
      }
      if (i < steps) {
        const nextX = addCoordinate(-boundary, (i + 1) * step);
        const zeroX = refineZeroOfFn(evalDenom, x, nextX);
        if (zeroX !== null) {
          const lim = graph.limitAt(zeroX);
          if (lim.hole) {
            addLandmark('open-point', zeroX, lim.y, `Open point (hole) at (${formatNumber(zeroX)}, ${formatNumber(lim.y)})`);
          } else {
            addLandmark('asymptote', zeroX, null, `Vertical asymptote or undefined at x = ${formatNumber(zeroX)}`);
          }
        }
      }
    }
  }

  // 2. Check Origin (0,0) and Y-intercept (x = 0)
  const atZero = graph.limitAt(0);
  if (atZero.defined) {
    if (Math.abs(atZero.y) <= 1e-9) {
      addLandmark('origin', 0, 0, 'Origin (0, 0)');
    } else {
      addLandmark('y-axis', 0, atZero.y, `Y-axis crossing at (0, ${formatNumber(atZero.y)})`);
    }
  } else if (atZero.hole && Math.abs(atZero.y) <= 1e-9) {
    addLandmark('origin', 0, 0, 'Origin (0, 0) (open hole)');
  }

  // 3. Sample for X-intercepts (roots) and Extrema (Peaks & Valleys)
  const samples = Array.from({ length: steps + 1 }, (_, i) => {
    const x = addCoordinate(-boundary, i * step);
    const lim = graph.limitAt(x);
    return { x, y: lim.defined ? lim.y : lim.hole ? lim.y : NaN, defined: lim.defined };
  });

  const allZero = samples.every((s) => s.y === 0);
  if (!allZero && !graph.hasSteps) {
    for (let i = 0; i < steps; i += 1) {
      const a = samples[i];
      const b = samples[i + 1];
      if (!Number.isFinite(a.y) || !Number.isFinite(b.y)) continue;
      if (Math.abs(a.y) <= 1e-10) {
        // A sample that is merely tiny is not a root: e^(-x^2) is about 1e-11
        // near x = 5 but never zero. Accept it only where |y| actually bottoms
        // out between two larger neighbours (a touching root such as x^2), or
        // where y is exactly zero (sign-change roots are refined below).
        const prev = samples[i - 1];
        const touches =
          a.y === 0 ||
          (prev && Number.isFinite(prev.y) && Math.abs(prev.y) > Math.abs(a.y) && Math.abs(b.y) > Math.abs(a.y));
        if (touches && Math.abs(a.x) > 1e-8) {
          addLandmark('x-axis', a.x, 0, `X-axis root at (${formatNumber(a.x)}, 0)`);
        }
      } else if (Math.sign(a.y) !== Math.sign(b.y) && graph.isContinuousBetween(a.x, b.x)) {
        const rootX = refineZeroOfFn((x) => graph.yAt(x), a.x, b.x);
        if (rootX !== null) {
          if (Math.abs(rootX) <= 1e-8) {
            addLandmark('origin', 0, 0, 'Origin (0, 0)');
          } else {
            addLandmark('x-axis', rootX, 0, `X-axis root at (${formatNumber(rootX)}, 0)`);
          }
        }
      }
    }

    for (let i = 1; i < steps; i += 1) {
      const prev = samples[i - 1];
      const curr = samples[i];
      const next = samples[i + 1];
      if (!Number.isFinite(prev.y) || !Number.isFinite(curr.y) || !Number.isFinite(next.y)) continue;
      const isMin = curr.y <= prev.y && curr.y <= next.y && (curr.y < prev.y || curr.y < next.y);
      const isMax = curr.y >= prev.y && curr.y >= next.y && (curr.y > prev.y || curr.y > next.y);
      if (!isMin && !isMax) continue;
      // A peak or valley must lie on one continuous piece. Across a pole the
      // samples only look like a turn (tan(x), 1/(x-a)); that is not an extremum.
      if (!graph.isContinuousBetween(prev.x, curr.x) || !graph.isContinuousBetween(curr.x, next.x)) continue;

      let lo = prev.x;
      let hi = next.x;
      const evalY = (x) => {
        const lim = graph.limitAt(x);
        return lim.defined || lim.hole ? lim.y : NaN;
      };
      for (let iter = 0; iter < 48; iter += 1) {
        const p = lo + (hi - lo) / 3;
        const q = hi - (hi - lo) / 3;
        const yp = evalY(p);
        const yq = evalY(q);
        if (!Number.isFinite(yp) || !Number.isFinite(yq)) break;
        if (isMin ? yp < yq : yp > yq) hi = q;
        else lo = p;
      }
      let rx = (lo + hi) / 2;
      let ry = evalY(rx);
      // Ternary search on a flat top stops a few nanounits away from the
      // true turning point (x^2 gives x = 7e-12). Prefer a rounded x when it
      // is at least as extreme, so the user hears "(0, 0)" not "(7.03e-12, 0)".
      const rounded = Number(rx.toFixed(Math.max(0, 6 - Math.ceil(Math.log10(boundary + 1)))));
      const roundedY = evalY(rounded);
      if (Number.isFinite(roundedY) && (isMin ? roundedY <= ry + 1e-12 * (1 + Math.abs(ry)) : roundedY >= ry - 1e-12 * (1 + Math.abs(ry)))) {
        rx = rounded;
        ry = roundedY;
      }
      // Reject a value that explodes inside one sampling step: a pole hiding
      // between samples (1/(x-a)^2 with a off the grid) is not a peak.
      const neighbourScale = Math.max(Math.abs(prev.y), Math.abs(curr.y), Math.abs(next.y), 1);
      if (Number.isFinite(ry) && Math.abs(ry) <= neighbourScale * 1e4) {
        // Verify slope actually changes sign across rx
        const leftSlope = evalY(rx) - evalY(rx - step * 0.5);
        const rightSlope = evalY(rx + step * 0.5) - evalY(rx);
        if (Number.isFinite(leftSlope) && Number.isFinite(rightSlope) && Math.sign(leftSlope) !== Math.sign(rightSlope)) {
          addLandmark(
            isMax ? 'maximum' : 'minimum',
            rx,
            ry,
            `${isMax ? 'Peak (local max)' : 'Valley (local min)'} at (${formatNumber(rx)}, ${formatNumber(ry)})`
          );
          if (Math.abs(rx) <= 1e-7 && Math.abs(ry) <= 1e-7) {
            addLandmark('origin', 0, 0, 'Origin (0, 0)');
          } else if (Math.abs(ry) <= 1e-7) {
            addLandmark('x-axis', rx, 0, `X-axis root at (${formatNumber(rx)}, 0)`);
          }
        }
      }
    }
  }

  // 4. Add custom solid points and open points
  for (const pt of customPoints) {
    if (!pt || !Number.isFinite(pt.x)) continue;
    const lim = graph.limitAt(pt.x);
    const py = Number.isFinite(pt.y) ? pt.y : lim.y;
    const kind = pt.kind === 'open-point' ? 'open-point' : 'solid-point';
    addLandmark(
      kind,
      pt.x,
      py,
      `${kind === 'open-point' ? 'Open point (hole)' : 'Solid point'} at (${formatNumber(pt.x)}, ${formatNumber(py)})`
    );
  }

  return landmarks.sort((a, b) => a.x - b.x);
}

export function findStepEvents(landmarks, fromX, toX) {
  const eps = 1e-5;
  const lo = Math.min(fromX, toX);
  const hi = Math.max(fromX, toX);
  const passedOver = [];
  const landedOn = [];

  for (const item of landmarks) {
    if (Math.abs(item.x - toX) <= eps) {
      landedOn.push(item);
    } else if (item.x > lo + eps && item.x < hi - eps) {
      passedOver.push(item);
    }
  }

  if (toX < fromX) {
    passedOver.reverse();
  }
  return { passedOver, landedOn };
}

export function sampleFunctionPath(graph, boundary = 10, count = 320) {
  const segments = [];
  let current = [];
  const step = (boundary * 2) / count;
  for (let i = 0; i <= count; i += 1) {
    const x = addCoordinate(-boundary, i * step);
    const y = graph.yAt(x);
    if (Number.isFinite(y) && Math.abs(y) <= boundary * 1.5) {
      if (current.length > 0 && !graph.isContinuousBetween(current.at(-1).x, x)) {
        if (current.length > 1) segments.push(current);
        current = [];
      }
      current.push({ x, y });
    } else {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
