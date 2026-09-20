// Fixed 190 × 104 geometry matching the viewer's fifteen named silhouettes.
// These are local numeric contours, never parsed or constructed from hook text.
const WIDTH = 190;
const HEIGHT = 104;
const NOMINAL_JITTER = 1.9;
const MAX_JITTER = 3;
const PASS_STRENGTHS = [0.9, 1.1];
const MAX_ID_UNITS = 180;
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

function bounded(value, minimum, maximum) {
  return Math.round(Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0)) * 1000) / 1000;
}

function point(x, y) {
  // Control points, including the cloud and diamond's negative coordinates,
  // fit inside this fixed envelope even after the permitted perturbation.
  return `${bounded(x, -18, 212)} ${bounded(y, -16, 120)}`;
}

function jitter(x, y, limit, random, strength) {
  const angle = random() * Math.PI * 2;
  // Reserve enough room for rounding both coordinates to three decimals.
  const cap = Math.max(0, Math.min(MAX_JITTER, limit) - 0.001);
  const radius = Math.min(cap, NOMINAL_JITTER * strength * (0.5 + random()));
  return point(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
}

function draw(contours, random, strength) {
  const commands = [];
  for (const contour of contours) {
    let from = contour.start;
    commands.push(`M ${point(...from)}`);
    for (const curve of contour.curves) {
      const [x1, y1, x2, y2, x, y] = curve;
      // Keep small rounded corners gentle. Endpoints never move, so the
      // silhouette's corners and adjoining segments stay connected.
      const limit = Math.hypot(x - from[0], y - from[1]) / 8;
      commands.push(`C ${jitter(x1, y1, limit, random, strength)} ${jitter(x2, y2, limit, random, strength)} ${point(x, y)}`);
      from = [x, y];
    }
    if (contour.closed) commands.push('Z');
  }
  return commands.join(' ');
}

/**
 * Return two deterministic, stroke-only SVG path strings for a known shape,
 * or [] for an unknown/non-string shape. Geometry uses fixed 190 × 104 units.
 *
 * Only cubic control points wobble (nominally 1.9px, capped below 3px after
 * rounding). The two passes use 0.9×/1.1× strengths to separate their strokes
 * at normal fit. Short corners retain the chord-length/8 cap, and endpoints
 * stay exact; canonical fills, attachment geometry, and hit targets are separate.
 * IDs seed a bounded hash of their first 180 UTF-16 units. Non-string IDs use
 * the same stable empty-ID fallback, without coercion or property access.
 *
 * No DOM, colors, state, or result cache. The renderer owns any bounded cache
 * (at most 512 entries, keyed by shape/ID) and may reuse paths across metadata,
 * theme, layout, and removal-animation updates. Render with fill="none",
 * pointer-events="none" and aria-hidden="true", beneath the clipped title.
 */
export function sketchOutline(shape, id) {
  if (typeof shape !== 'string' || shape.length > 32 || !Object.hasOwn(OUTLINES, shape)) return [];
  const seed = seedFor(shape, id);
  return PASS_STRENGTHS.map((strength, pass) =>
    draw(OUTLINES[shape], randomFor(seed ^ Math.imul(pass + 1, 0x9e3779b9)), strength));
}
