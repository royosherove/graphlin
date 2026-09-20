import test from 'node:test';
import assert from 'node:assert/strict';
import { sketchOutline, sketchDetails, sketchConnection } from '../../runtime/web/sketch.js';

const SHAPES = [
  'rounded_rect', 'rect', 'cylinder', 'cloud', 'diamond', 'group', 'browser', 'component',
  'queue', 'hexagon', 'class_box', 'interface_box', 'document', 'parallelogram', 'folder',
];
const RADII = { rounded_rect: 10, rect: 5, group: 2, browser: 3, queue: 3, class_box: 3, interface_box: 3 };
const POLYGONS = {
  diamond: [[95, -12], [204, 52], [95, 116], [-14, 52]],
  component: [[10, 0], [190, 0], [190, 104], [10, 104], [10, 85], [0, 85],
    [0, 68], [10, 68], [10, 35], [0, 35], [0, 18], [10, 18]],
  hexagon: [[23, 0], [167, 0], [190, 52], [167, 104], [23, 104], [0, 52]],
  document: [[0, 0], [167, 0], [190, 23], [190, 104], [0, 104]],
  parallelogram: [[22, 0], [190, 0], [168, 104], [0, 104]],
  folder: [[0, 10], [66, 10], [78, 0], [190, 0], [190, 104], [0, 104]],
};
const CURVES = {
  cylinder: { start: [0, 17], curves: [[0, -2, 190, -2, 190, 17],
    [190, 40, 190, 64, 190, 87], [190, 109, 0, 109, 0, 87], [0, 64, 0, 40, 0, 17]] },
  cloud: { start: [18, 99], curves: [[-8, 99, -9, 53, 13, 45], [-2, 16, 34, 1, 58, 13],
    [76, -7, 132, -5, 145, 16], [182, 7, 202, 36, 183, 57],
    [207, 73, 191, 103, 169, 99], [119, 99, 68, 99, 18, 99]] },
};
const DETAILS = {
  cylinder: [{ start: [0, 17], curves: [[0, 37, 190, 37, 190, 17]] }],
  browser: [[[0, 23], [190, 23]]],
  queue: [[[17, 0], [17, 104]], [[173, 0], [173, 104]],
    [[40, 16], [150, 16]], [[140, 11], [150, 16], [140, 21]]],
  class_box: [[[0, 25], [190, 25]], [[0, 72], [190, 72]]],
  interface_box: [[[0, 25], [190, 25]]],
  document: [[[167, 0], [167, 23], [190, 23]]],
  folder: [[[0, 24], [190, 24]]],
};

// Read only the small public output grammar. Production never parses SVG.
function parse(path, { bytes = 12000, strokes = 18, cubics = 54 } = {}) {
  assert.equal(typeof path, 'string');
  assert.ok(path.length > 0 && path.length <= bytes, 'constant path size budget');
  const tokens = path.match(/[MC]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || [];
  assert.equal(tokens.join(' '), path, 'explicit, finite numeric M/C commands only');
  let index = 0, current;
  const result = [];
  const read = () => {
    const token = tokens[index++];
    assert.match(token || '', /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i);
    const value = Number(token);
    assert.ok(Number.isFinite(value));
    return value;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') {
      current = { start: [read(), read()], curves: [] };
      result.push(current);
    } else {
      assert.equal(command, 'C');
      assert.ok(current);
      current.curves.push(Array.from({ length: 6 }, read));
    }
  }
  assert.ok(result.length > 0 && result.length <= strokes);
  assert.ok(result.every(item => item.curves.length > 0));
  assert.ok(result.reduce((sum, item) => sum + item.curves.length, 0) <= cubics);
  return result;
}

function cubic(start, curve, t) {
  const s = 1 - t;
  return [0, 1].map(axis => s ** 3 * start[axis] + 3 * s ** 2 * t * curve[axis]
    + 3 * s * t ** 2 * curve[axis + 2] + t ** 3 * curve[axis + 4]);
}

function sampled(contour, steps = 8) {
  const points = [contour.start];
  let from = contour.start;
  for (const curve of contour.curves) {
    for (let i = 1; i <= steps; i++) points.push(cubic(from, curve, i / steps));
    from = curve.slice(4);
  }
  return points;
}

function distance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], square = dx * dx + dy * dy;
  const t = square ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / square)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

function segments(paths) {
  return paths.flatMap(points => points.slice(1).map((point, index) => [points[index], point]));
}

function near(point, edges) {
  return Math.min(...edges.map(([a, b]) => distance(point, a, b)));
}

function rounded(radius) {
  const points = [];
  for (const [cx, cy, start] of [[190 - radius, radius, -90], [190 - radius, 104 - radius, 0],
    [radius, 104 - radius, 90], [radius, radius, 180]]) {
    for (let angle = start; angle <= start + 90; angle += 7.5) {
      points.push([cx + radius * Math.cos(angle * Math.PI / 180), cy + radius * Math.sin(angle * Math.PI / 180)]);
    }
  }
  return [...points, points[0]];
}

function canonical(shape) {
  if (RADII[shape]) return [rounded(RADII[shape])];
  if (CURVES[shape]) return [sampled(CURVES[shape], 32)];
  const points = POLYGONS[shape];
  const result = [[...points, points[0]]];
  if (shape === 'component') result.push([[10, 18], [21, 18], [21, 35], [10, 35]],
    [[10, 68], [21, 68], [21, 85], [10, 85]]);
  return result;
}

function checkSilhouette(paths, references, label) {
  const referenceEdges = segments(references);
  for (const path of paths) {
    const actual = parse(path).map(stroke => sampled(stroke));
    const actualEdges = segments(actual);
    for (const point of actual.flat()) {
      assert.ok(near(point, referenceEdges) <= 5.05, `${label}: ink strays beyond the 5px silhouette envelope`);
    }
    for (const [a, b] of referenceEdges) for (const t of [0, .5, 1]) {
      const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      assert.ok(near(point, actualEdges) <= 5.1, `${label}: a canonical feature is missing`);
    }
  }
}

test('all 15 outlines retain complete silhouettes, including rounded corners, cloud lobes and cylinder rims', () => {
  for (const shape of SHAPES) for (let id = 0; id < 4; id++) {
    const paths = sketchOutline(shape, `silhouette-${id}`);
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
    checkSilhouette(paths, canonical(shape), shape);
  }
});

test('D has broad bends, imperfect joins and visible doubled lines at normal diagram size', () => {
  const separations = [], bends = [], joins = [];
  for (let id = 0; id < 48; id++) {
    const paths = sketchOutline('rect', `pen-${id}`).map(path => parse(path));
    const sides = paths.map(strokes => strokes.filter(stroke => Math.abs(stroke.start[0] - stroke.curves.at(-1)[4]) > 100));
    const top = sides.map(strokes => sampled(strokes[0], 12));
    const nearMiddle = top.map(points => points.filter(([x]) => x > 45 && x < 145));
    bends.push(Math.max(...nearMiddle[0].map(([, y]) => Math.abs(y))));
    separations.push(Math.max(...nearMiddle[0].map(point => near(point, segments([top[1]])))) * 110 / 190);
    joins.push(Math.hypot(paths[0][0].start[0] - 5, paths[0][0].start[1]));
    assert.ok(paths[0][0].curves.length > 1, 'a long edge has broad adjoining curves, not tiny control noise');
  }
  const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  assert.ok(median(bends) >= 1.5 && median(bends) <= 3.2, 'D has a gentle but noticeable bend');
  assert.ok(median(separations) >= .65, 'the second line remains visible when the diagram is scaled down');
  assert.ok(median(joins) >= .4 && median(joins) <= 2.2, 'D loosens corners without large gaps');
});

test('details cover only the requested internal marks and never duplicate component tabs or browser dots', () => {
  for (const shape of SHAPES) {
    const paths = sketchDetails(shape, 'detail-id');
    if (!DETAILS[shape]) {
      assert.deepEqual(paths, []);
      continue;
    }
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
    const references = DETAILS[shape].map(item => Array.isArray(item) ? item : sampled(item, 32));
    checkSilhouette(paths, references, `${shape} details`);
    for (const path of paths) parse(path, { bytes: 4000, strokes: 5, cubics: 15 });
  }
  assert.deepEqual(sketchDetails('component', 'detail-id'), []);
  for (const path of sketchDetails('browser', 'detail-id')) {
    const strokes = parse(path);
    assert.equal(strokes.length, 1, 'only the toolbar is sketched; no dot paths');
    assert.ok(sampled(strokes[0]).every(([, y]) => y > 18 && y < 28));
  }
});

test('shape/detail paths are deterministic, call-order independent, bounded and safe to mutate', () => {
  for (let id = 0; id < 12; id++) for (const shape of SHAPES) {
    for (const draw of [sketchOutline, sketchDetails]) {
      const expected = draw(shape, `stable-${id}`);
      draw('cloud', 'unrelated');
      assert.deepEqual(draw(shape, `stable-${id}`), expected);
      if (expected.length) assert.notDeepEqual(draw(shape, `other-${id}`), expected);
      const returned = draw(shape, `stable-${id}`);
      returned[0] = '<script>';
      returned.push('bad');
      assert.deepEqual(draw(shape, `stable-${id}`), expected);
      for (const path of expected) for (const stroke of parse(path)) {
        const coordinates = [stroke.start, ...stroke.curves.flatMap(curve => [curve.slice(0, 2), curve.slice(2, 4), curve.slice(4)])];
        for (const [x, y] of coordinates) assert.ok(x >= -19.01 && x <= 212.01 && y >= -17.01 && y <= 121.01);
      }
    }
  }
  assert.notDeepEqual(sketchOutline('browser', 'same'), sketchOutline('queue', 'same'));
});

const STRAIGHT = [[10, 20], [110, 20], [210, 20], [310, 20]];
const ARC = [[12.34567891, 21.23456789], [80, -190], [230, 290], [350.12345678, 65.98765432]];
const end = stroke => stroke.curves.at(-1).slice(4);
const direction = (from, to) => {
  const delta = [to[0] - from[0], to[1] - from[1]], scale = Math.max(...delta.map(Math.abs));
  if (!scale) return null;
  const normalized = delta.map(value => value / scale), length = Math.hypot(...normalized);
  return normalized.map(value => value / length);
};
function canonicalDirection(points) {
  return direction(points[2], points[3]) || direction(points[1], points[3]) || direction(points[0], points[3]) || [1, 0];
}
function shaftDirection(stroke) {
  const tip = end(stroke), last = stroke.curves.at(-1);
  const lastStart = stroke.curves.length > 1 ? stroke.curves.at(-2).slice(4) : stroke.start;
  return direction(last.slice(2, 4), tip) || direction(last.slice(0, 2), tip) || direction(lastStart, tip);
}

test('connections retain their exact ports and final tangent while gently following the canonical cubic', () => {
  for (const points of [STRAIGHT, ARC, [[0, 0], [0, -200], [260, -200], [0, 0]]]) {
    const reference = sampled({ start: points[0], curves: [points.slice(1).flat()] }, 128);
    for (let id = 0; id < 12; id++) {
      const result = sketchConnection(points, `edge-${id}`);
      assert.equal(result.lines.length, 2);
      assert.equal(result.heads.length, 2);
      assert.notEqual(result.lines[0], result.lines[1]);
      assert.notEqual(result.heads[0], result.heads[1]);
      for (const path of result.lines) {
        const [shaft] = parse(path, { bytes: 2500, strokes: 1, cubics: 3 });
        assert.deepEqual(shaft.start, points[0]);
        assert.deepEqual(end(shaft), points[3]);
        const actualDirection = shaftDirection(shaft), expectedDirection = canonicalDirection(points);
        assert.ok(Math.hypot(...actualDirection.map((value, axis) => value - expectedDirection[axis])) < 1e-10);
        for (const point of sampled(shaft, 24)) assert.ok(near(point, segments([reference])) <= 5.05);
      }
      for (const path of result.heads) {
        const wings = parse(path, { bytes: 4500, strokes: 2, cubics: 6 });
        assert.equal(wings.length, 2, 'an open arrowhead consists of two separate wings');
        const tangent = canonicalDirection(points), tip = points[3];
        const cross = point => (point[0] - tip[0]) * -tangent[1] + (point[1] - tip[1]) * tangent[0];
        assert.ok(cross(wings[0].start) * cross(wings[1].start) < 0, 'wings straddle the final tangent');
        for (const wing of wings) {
          assert.deepEqual(end(wing), tip);
          for (const point of sampled(wing, 12)) {
            assert.ok(Math.hypot(point[0] - tip[0], point[1] - tip[1]) <= 18);
            assert.ok(Math.abs(cross(point)) < 9, 'wing spread fits the 20px hit width with normal stroke weight');
          }
          const back = (wing.start[0] - tip[0]) * tangent[0] + (wing.start[1] - tip[1]) * tangent[1];
          assert.ok(back < -10 && back > -16, 'head points along the canonical final tangent');
        }
      }
    }
  }
});

test('parallel lanes and rotated/translated routes keep independent positions and the same seeded gestures', () => {
  const original = sketchConnection(ARC, 'parallel');
  for (const transform of [
    ([x, y]) => [x + 16000, y - 24000],
    ([x, y]) => [-y, x],
    ([x, y]) => [x, y + 42],
  ]) {
    const moved = sketchConnection(ARC.map(transform), 'parallel');
    for (const field of ['lines', 'heads']) {
      for (let pass = 0; pass < 2; pass++) {
        const pairs = path => parse(path).flatMap(stroke => [stroke.start,
          ...stroke.curves.flatMap(curve => [curve.slice(0, 2), curve.slice(2, 4), curve.slice(4)])]);
        const expected = pairs(original[field][pass]).map(transform), actual = pairs(moved[field][pass]);
        assert.equal(actual.length, expected.length);
        actual.forEach((point, index) => assert.ok(Math.hypot(point[0] - expected[index][0], point[1] - expected[index][1]) < 1e-8));
      }
    }
  }
  assert.notDeepEqual(sketchConnection(ARC, 'different-edge'), original);
});

test('stationary endpoints, zero curves and tiny finite coordinates have stable, meaningful arrow directions', () => {
  const cases = [
    [[0, 0], [100, 0], [100, 100], [100, 100]],
    [[0, 0], [100, 100], [100, 100], [100, 100]],
    [[7, -4], [7, -4], [7, -4], [7, -4]],
    [[0, 0], [0, 0], [0, 0], [Number.MIN_VALUE, Number.MIN_VALUE]],
    [[-0, 1e-100], [1e-90, 2e-100], [2e-90, 2e-100], [3e-90, -0]],
  ];
  for (const points of cases) {
    const result = sketchConnection(points, 'degenerate');
    assert.deepEqual(sketchConnection(points, 'degenerate'), result);
    for (const path of result.lines) {
      const [shaft] = parse(path);
      assert.deepEqual(shaft.start, points[0]);
      assert.deepEqual(end(shaft), points[3]);
      if (points === cases[2]) assert.ok(sampled(shaft).every(point => Math.abs(point[0] - 7) < 1e-12 && Math.abs(point[1] + 4) < 1e-12));
    }
    const tangent = canonicalDirection(points);
    for (const path of result.heads) for (const wing of parse(path)) {
      assert.deepEqual(end(wing), points[3]);
      const tail = [wing.start[0] - points[3][0], wing.start[1] - points[3][1]];
      assert.ok(tail[0] * tangent[0] + tail[1] * tangent[1] < -10);
      assert.ok(Math.hypot(...tail) < 18);
    }
  }
  for (const points of cases.slice(0, 2)) for (const path of sketchConnection(points, 'stationary').lines) {
    const actual = shaftDirection(parse(path)[0]), expected = canonicalDirection(points);
    assert.ok(Math.hypot(...actual.map((value, axis) => value - expected[axis])) < 1e-10);
  }
});

test('large valid routes stay finite, within a fixed output budget and close to their canonical control hull', () => {
  for (const points of [
    [[-1e7, -1e7], [1e7, -1e7], [-1e7, 1e7], [1e7, 1e7]],
    [[1e7, 1e7], [1e7, 1e7], [1e7, 1e7], [1e7, 1e7]],
  ]) {
    const result = sketchConnection(points, 'large');
    for (const path of [...result.lines, ...result.heads]) for (const stroke of parse(path, { bytes: 4500 })) {
      const values = [stroke.start, ...stroke.curves.flatMap(curve => [curve.slice(0, 2), curve.slice(2, 4), curve.slice(4)])];
      assert.ok(values.flat().every(value => Math.abs(value) <= 1e7 + 18));
    }
    result.lines[0] = '<script>';
    result.heads.push('bad');
    assert.equal(sketchConnection(points, 'large').heads.length, 2);
  }
  const frozen = Object.freeze(ARC.map(point => Object.freeze([...point])));
  assert.deepEqual(sketchConnection(frozen, 'frozen'), sketchConnection(ARC, 'frozen'));
});

test('invalid coordinates fail closed without coercion, parsing text, invoking accessors or reusing arrays', () => {
  const hostile = { [Symbol.toPrimitive]() { throw new Error('must not coerce'); } };
  let getterCalls = 0;
  const accessor = [...STRAIGHT];
  Object.defineProperty(accessor, '1', { get() { getterCalls++; return [0, 0]; } });
  const coordinateAccessor = [[0, 0], ...STRAIGHT.slice(1)];
  Object.defineProperty(coordinateAccessor[0], '0', { get() { getterCalls++; return 0; } });
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const invalid = [undefined, null, hostile, 'M 0 0 C 1 1 2 2 3 3', {}, [], new Array(4), STRAIGHT.slice(1),
    [...STRAIGHT, [1, 2]], [0, 1, 2, 3], accessor, coordinateAccessor, revoked.proxy];
  for (const value of [NaN, Infinity, -Infinity, 1e7 + 1, -1e7 - 1, '10', null, undefined, 1n, hostile]) {
    invalid.push([[value, 0], ...STRAIGHT.slice(1)]);
  }
  invalid.push([[0], ...STRAIGHT.slice(1)], [[0, 1, 2], ...STRAIGHT.slice(1)],
    [new Float64Array([0, 1]), ...STRAIGHT.slice(1)]);
  for (const points of invalid) {
    const result = sketchConnection(points, 'invalid');
    assert.deepEqual(result, { lines: [], heads: [] });
    result.lines.push('changed');
    assert.deepEqual(sketchConnection(points, 'invalid'), { lines: [], heads: [] });
  }
  assert.equal(getterCalls, 0);
});

test('all exports bound ID seeds, ignore non-string IDs and cannot embed arbitrary text in paths', () => {
  const hostile = { [Symbol.toPrimitive]() { throw new Error('must not coerce input'); } };
  for (const draw of [sketchOutline, sketchDetails]) {
    for (const shape of [undefined, null, 0, {}, hostile, Symbol('shape'), 'constructor', '__proto__', 'toString', 'RECT', '<path>', '', 'rect'.repeat(10000)]) {
      assert.deepEqual(draw(shape, 'id'), []);
    }
  }
  const draws = [
    id => sketchOutline('cloud', id),
    id => sketchDetails('queue', id),
    id => Object.values(sketchConnection(ARC, id)).flat(),
  ];
  for (const draw of draws) {
    for (const id of [undefined, null, {}, hostile, Symbol('id'), 1n, Infinity]) assert.deepEqual(draw(id), draw(''));
    const prefix = 'id'.repeat(90);
    assert.deepEqual(draw(prefix + 'x'.repeat(100000)), draw(prefix));
    assert.deepEqual(draw(prefix + 'different suffix'), draw(prefix));
    for (const path of draw('\"><script>alert(1)</script> M NaN Infinity Z')) parse(path);
  }
});
