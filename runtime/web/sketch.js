// Fixed 190 × 104 geometry matching the viewer's fifteen named silhouettes.
// These are local numeric contours, never parsed or constructed from hook text.
const WIDTH = 190;
const HEIGHT = 104;
// Chosen line-study option D, "Tidy sketch". Opacity belongs to the renderer:
// use the second path as a lighter echo (the study uses 0.46).
const TIDY = Object.freeze({ bend: 2.6, join: 0.8, overshoot: 1.65, separation: 0.85 });
const MAX_OFFSET = 5;
const MAX_ID_UNITS = 180;
const MAX_COORDINATE = 1e7;
const KAPPA = 0.5522847498307936;

function line(from, to) {
  return [
    from[0] + (to[0] - from[0]) / 3, from[1] + (to[1] - from[1]) / 3,
    from[0] + (to[0] - from[0]) * 2 / 3, from[1] + (to[1] - from[1]) * 2 / 3,
    ...to,
  ];
}

function polyline(points, closed = true) {
  const ends = closed ? [...points.slice(1), points[0]] : points.slice(1);
  return { start: points[0], curves: ends.map((point, index) => line(points[index], point)), closed };
}

function roundedBox(radius) {
  const r = radius, k = r * KAPPA, w = WIDTH, h = HEIGHT;
  return {
    start: [r, 0], closed: true,
    curves: [
      line([r, 0], [w - r, 0]),
      [w - r + k, 0, w, r - k, w, r],
      line([w, r], [w, h - r]),
      [w, h - r + k, w - r + k, h, w - r, h],
      line([w - r, h], [r, h]),
      [r - k, h, 0, h - r + k, 0, h - r],
      line([0, h - r], [0, r]),
      [0, r - k, r - k, 0, r, 0],
    ],
  };
}

const OUTLINES = Object.freeze({
  rounded_rect: [roundedBox(10)],
  rect: [roundedBox(5)],
  cylinder: [{
    start: [0, 17], closed: true,
    curves: [
      [0, -2, 190, -2, 190, 17],
      line([190, 17], [190, 87]),
      [190, 109, 0, 109, 0, 87],
      line([0, 87], [0, 17]),
    ],
  }],
  cloud: [{
    start: [18, 99], closed: true,
    curves: [
      [-8, 99, -9, 53, 13, 45],
      [-2, 16, 34, 1, 58, 13],
      [76, -7, 132, -5, 145, 16],
      [182, 7, 202, 36, 183, 57],
      [207, 73, 191, 103, 169, 99],
      line([169, 99], [18, 99]),
    ],
  }],
  diamond: [polyline([[95, -12], [204, 52], [95, 116], [-14, 52]])],
  group: [roundedBox(2)],
  browser: [roundedBox(3)],
  component: [
    polyline([[10, 0], [190, 0], [190, 104], [10, 104], [10, 85], [0, 85],
      [0, 68], [10, 68], [10, 35], [0, 35], [0, 18], [10, 18]]),
    // The remaining tab borders preserve the component symbol without drawing
    // the main body's vertical edge through the tabs' canonical fills.
    polyline([[10, 18], [21, 18], [21, 35], [10, 35]], false),
    polyline([[10, 68], [21, 68], [21, 85], [10, 85]], false),
  ],
  queue: [roundedBox(3)],
  hexagon: [polyline([[23, 0], [167, 0], [190, 52], [167, 104], [23, 104], [0, 52]])],
  class_box: [roundedBox(3)],
  interface_box: [roundedBox(3)],
  document: [polyline([[0, 0], [167, 0], [190, 23], [190, 104], [0, 104]])],
  parallelogram: [polyline([[22, 0], [190, 0], [168, 104], [0, 104]])],
  folder: [polyline([[0, 10], [66, 10], [78, 0], [190, 0], [190, 104], [0, 104]])],
});

const DETAILS = Object.freeze({
  cylinder: [{ start: [0, 17], curves: [[0, 37, 190, 37, 190, 17]] }],
  browser: [polyline([[0, 23], [190, 23]], false)],
  queue: [
    polyline([[17, 0], [17, 104]], false),
    polyline([[173, 0], [173, 104]], false),
    polyline([[40, 16], [150, 16]], false),
    polyline([[140, 11], [150, 16], [140, 21]], false),
  ],
  class_box: [
    polyline([[0, 25], [190, 25]], false),
    polyline([[0, 72], [190, 72]], false),
  ],
  interface_box: [polyline([[0, 25], [190, 25]], false)],
  document: [polyline([[167, 0], [167, 23], [190, 23]], false)],
  folder: [polyline([[0, 24], [190, 24]], false)],
});

function seedFor(shape, id) {
  const key = shape + '\0' + (typeof id === 'string' ? id.slice(0, MAX_ID_UNITS) : '');
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function randomFor(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function point(pair, exact = false) {
  return pair.map(value => exact
    ? (Object.is(value, -0) ? '-0' : String(value))
    : String(Math.round(value * 1000) / 1000)).join(' ');
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function unit(vector) {
  const scale = Math.max(...vector.map(Math.abs));
  if (!scale) return null;
  const scaled = vector.map(value => value / scale);
  const length = Math.hypot(...scaled);
  return scaled.map(value => value / length);
}

function endDirection(points) {
  for (let index = 2; index >= 0; index--) {
    const direction = unit(subtract(points[3], points[index]));
    if (direction) return direction;
  }
  return [1, 0];
}

function tangent(points, t) {
  const s = 1 - t;
  const derivative = [0, 1].map(axis =>
    s * s * (points[1][axis] - points[0][axis])
    + 2 * s * t * (points[2][axis] - points[1][axis])
    + t * t * (points[3][axis] - points[2][axis]));
  return unit(derivative) || endDirection(points);
}

// Exact de Casteljau subdivision retains the original curve's silhouette.
// Only the bounded displacement field is interpolated through loose anchors.
function split(points, t) {
  const a = mix(points[0], points[1], t);
  const b = mix(points[1], points[2], t);
  const c = mix(points[2], points[3], t);
  const d = mix(a, b, t), e = mix(b, c, t), f = mix(d, e, t);
  return [[points[0], a, d, f], [f, e, c, points[3]]];
}

function shifted(base, offset) {
  const length = Math.hypot(...offset);
  const scale = length > MAX_OFFSET ? MAX_OFFSET / length : 1;
  return [base[0] + offset[0] * scale, base[1] + offset[1] * scale];
}

function roughCurve(points, random, pass, { pinStart = false, pinEnd = false, strength = 1, exact = false } = {}) {
  const signed = () => random() * 2 - 1;
  const length = points.slice(1).reduce((sum, p, index) =>
    sum + Math.hypot(...subtract(p, points[index])), 0);
  const scale = Math.min(1, length / 150) * strength;
  const stations = [0, .23 + random() * .13, .62 + random() * .14, 1];
  const gesture = signed() < 0 ? -1 : 1;
  const bias = pass ? signed() * TIDY.separation : 0;
  const normalOffsets = [
    signed() * TIDY.join,
    gesture * TIDY.bend * (.58 + random() * .56),
    TIDY.bend * (signed() * .85 - gesture * .12),
    signed() * TIDY.join,
  ];
  const overshoots = [-TIDY.overshoot * (.25 + random() * .75), 0, 0,
    TIDY.overshoot * (.25 + random() * .75)];
  const offsets = stations.map((t, index) => {
    if ((index === 0 && pinStart) || (index === 3 && pinEnd)) return [0, 0];
    const direction = tangent(points, t);
    const normal = (normalOffsets[index] + bias) * scale;
    const along = overshoots[index] * scale;
    return [-direction[1] * normal + direction[0] * along,
      direction[0] * normal + direction[1] * along];
  });
  // With two coincident endpoint controls, the limiting tangent comes from
  // the whole final (or first) piece. Keep that piece canonical rather than
  // allowing its displaced interior anchor to change the third derivative.
  const flatStart = pinStart && points.slice(1, 3).every(p => p.every((value, axis) => value === points[0][axis]));
  const flatEnd = pinEnd && points.slice(1, 3).every(p => p.every((value, axis) => value === points[3][axis]));
  if (flatStart) offsets[1] = [0, 0];
  if (flatEnd) offsets[2] = [0, 0];
  const slopes = offsets.map((offset, index) => {
    if ((index === 0 && pinStart) || (index === 3 && pinEnd)
      || (index === 1 && flatStart) || (index === 2 && flatEnd)) return [0, 0];
    const before = Math.max(0, index - 1), after = Math.min(3, index + 1);
    const interval = stations[after] - stations[before];
    return subtract(offsets[after], offsets[before]).map(value => value / interval);
  });
  const pieces = [];
  let remaining = points, previous = 0;
  for (const station of stations.slice(1, -1)) {
    const [piece, rest] = split(remaining, (station - previous) / (1 - previous));
    pieces.push(piece);
    remaining = rest;
    previous = station;
  }
  pieces.push(remaining);
  const commands = [`M ${point(pinStart ? points[0] : shifted(points[0], offsets[0]), exact)}`];
  for (let index = 0; index < pieces.length; index++) {
    const interval = (stations[index + 1] - stations[index]) / 3;
    const firstOffset = offsets[index].map((value, axis) => value + slopes[index][axis] * interval);
    const secondOffset = offsets[index + 1].map((value, axis) => value - slopes[index + 1][axis] * interval);
    const piece = pieces[index];
    const controls = [shifted(piece[1], firstOffset), shifted(piece[2], secondOffset),
      shifted(piece[3], offsets[index + 1])];
    // Preserve the limiting tangent even when the first derivative is zero.
    // A constant cubic also stays constant; it does not acquire a tiny loop.
    if (index === 0 && pinStart && points[0].every((value, axis) => value === points[1][axis])) controls[1] = piece[2];
    if (index === 2 && pinEnd && points[3].every((value, axis) => value === points[2][axis])) controls[0] = piece[1];
    if (index === 2 && pinEnd) controls[2] = points[3];
    commands.push(`C ${controls.map(control => point(control, exact)).join(' ')}`);
  }
  return commands.join(' ');
}

function twoPasses(kind, id, draw) {
  const seed = seedFor(kind, id);
  return [0, 1].map(pass => draw(randomFor(seed ^ Math.imul(pass + 1, 0x9e3779b9)), pass));
}

function drawContours(contours, random, pass) {
  const strokes = [];
  for (const contour of contours) {
    let from = contour.start;
    for (const curve of contour.curves) {
      strokes.push(roughCurve([from, curve.slice(0, 2), curve.slice(2, 4), curve.slice(4)], random, pass));
      from = curve.slice(4);
    }
  }
  return strokes.join(' ');
}

function knownShape(shapes, shape) {
  return typeof shape === 'string' && shape.length <= 32 && Object.hasOwn(shapes, shape);
}

function connectionPoints(input) {
  // Accept only four own pairs of finite numbers. Accessors, sparse arrays and
  // coercible text are not coordinates. Copy without calling input methods.
  try {
    if (!Array.isArray(input) || Object.getOwnPropertyDescriptor(input, 'length')?.value !== 4) return null;
    const points = [];
    for (let index = 0; index < 4; index++) {
      const row = Object.getOwnPropertyDescriptor(input, index)?.value;
      if (!Array.isArray(row) || Object.getOwnPropertyDescriptor(row, 'length')?.value !== 2) return null;
      const pair = [];
      for (let axis = 0; axis < 2; axis++) {
        const value = Object.getOwnPropertyDescriptor(row, axis)?.value;
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) return null;
        pair.push(value);
      }
      points.push(pair);
    }
    return points;
  } catch {
    return null;
  }
}

/**
 * Return two deterministic, stroke-only SVG path strings for a known shape,
 * or [] for an unknown/non-string shape. Geometry uses fixed 190 × 104 units.
 *
 * D's broad bends, loose joins and slight overshoots are applied to exact
 * subdivisions of the canonical cubics. Each pen stroke uses three cubics;
 * short edges and round corners scale down the gesture. Displacement is
 * bounded by 5px (plus <0.001px numeric rounding) from the canonical curve.
 * Small pen lifts at joins are intentional; do not use these paths as fills.
 * Canonical fills, attachment geometry, and hit targets remain external.
 * IDs seed a bounded hash of their first 180 UTF-16 units. Non-string IDs use
 * the same stable empty-ID fallback, without coercion or property access.
 *
 * No DOM, colors, mutable state or result cache. Each call returns a new array.
 * At most 18 pen strokes / 54 cubics per path, independent of ID length.
 * Render with fill="none", round caps/joins, pointer-events="none" and
 * aria-hidden="true", beneath the clipped title. Secondary opacity: 0.46.
 */
export function sketchOutline(shape, id) {
  if (!knownShape(OUTLINES, shape)) return [];
  return twoPasses(`outline/${shape}`, id, (random, pass) => drawContours(OUTLINES[shape], random, pass));
}

/**
 * Return two seeded stroke-only detail paths, or [] for shapes without details
 * and unknown/non-string shapes. Browser dots stay in the canonical renderer.
 * Component tab borders are already in sketchOutline and are not duplicated.
 * Same seed/ID/bounds contract as sketchOutline; at most 5 strokes / 15 cubics.
 */
export function sketchDetails(shape, id) {
  if (!knownShape(DETAILS, shape)) return [];
  return twoPasses(`details/${shape}`, id, (random, pass) => drawContours(DETAILS[shape], random, pass));
}

/**
 * points: exactly four [x, y] number arrays describing a canonical cubic.
 * Each coordinate must be finite and within ±1e7. Invalid input returns fresh
 * { lines: [], heads: [] }; valid input returns two path strings in each array.
 *
 * Shafts keep both exact ports and their canonical limiting tangents. Heads
 * are two open wings meeting at the exact end, aligned with the final tangent;
 * a constant cubic uses +x. Shaft displacement is <=5px; all head ink lies
 * within 18px of the end, with wing spread <9px, inside the viewer's existing
 * 64px drawing padding / 20px hit width at its normal stroke weight.
 *
 * Each shaft has three cubics and each head six. Finite numeric serialization
 * has a constant output budget even for extreme coordinates or oversized IDs.
 * ID handling and rendering requirements match sketchOutline. No input mutates.
 */
export function sketchConnection(points, id) {
  const canonical = connectionPoints(points);
  if (!canonical) return { lines: [], heads: [] };
  const lines = twoPasses('connection/shaft', id, (random, pass) =>
    roughCurve(canonical, random, pass, { pinStart: true, pinEnd: true, exact: true }));
  const tip = canonical[3], direction = endDirection(canonical);
  const heads = twoPasses('connection/head', id, (random, pass) => [-1, 1].map(side => {
    const length = 13 + (random() - .5) * TIDY.bend * .6;
    const spread = 7 + (random() - .5) * TIDY.bend * .35;
    const tail = [tip[0] - direction[0] * length - direction[1] * side * spread,
      tip[1] - direction[1] * length + direction[0] * side * spread];
    return roughCurve([tail, mix(tail, tip, 1 / 3), mix(tail, tip, 2 / 3), tip], random, pass,
      { pinEnd: true, strength: 1.7, exact: true });
  }).join(' '));
  return { lines, heads };
}
