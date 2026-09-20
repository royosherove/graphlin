import test from 'node:test';
import assert from 'node:assert/strict';
import { sketchOutline } from '../../runtime/web/sketch.js';

const SHAPES = [
  'rounded_rect', 'rect', 'cylinder', 'cloud', 'diamond', 'group', 'browser', 'component',
  'queue', 'hexagon', 'class_box', 'interface_box', 'document', 'parallelogram', 'folder',
];
const ROUND_RADII = { rounded_rect: 10, rect: 5, group: 2, browser: 3, queue: 3, class_box: 3, interface_box: 3 };
const POLYGONS = {
  diamond: [[95, -12], [204, 52], [95, 116], [-14, 52]],
  component: [[10, 0], [190, 0], [190, 104], [10, 104], [10, 85], [0, 85],
    [0, 68], [10, 68], [10, 35], [0, 35], [0, 18], [10, 18]],
  hexagon: [[23, 0], [167, 0], [190, 52], [167, 104], [23, 104], [0, 52]],
  document: [[0, 0], [167, 0], [190, 23], [190, 104], [0, 104]],
  parallelogram: [[22, 0], [190, 0], [168, 104], [0, 104]],
  folder: [[0, 10], [66, 10], [78, 0], [190, 0], [190, 104], [0, 104]],
};

// Parse the intentionally small public output grammar. No SVG renderer or
// production geometry helpers are involved in these contract checks.
function parse(path) {
  assert.equal(typeof path, 'string');
  assert.ok(path.length <= 2048, 'each outline has a bounded byte budget');
  const tokens = path.match(/[MCZ]|-?\d+(?:\.\d+)?/g) || [];
  assert.equal(tokens.join(' '), path, 'only explicit finite numeric M/C/Z commands are permitted');
  const contours = [];
  let index = 0, contour;
  const coordinate = () => {
    assert.match(tokens[index] || '', /^-?\d+(?:\.\d+)?$/);
    const value = Number(tokens[index++]);
    assert.ok(Number.isFinite(value));
    return value;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') {
      contour = { start: [coordinate(), coordinate()], curves: [], closed: false };
      contours.push(contour);
    } else if (command === 'C') {
      assert.ok(contour && !contour.closed);
      contour.curves.push(Array.from({ length: 6 }, coordinate));
    } else {
      assert.equal(command, 'Z');
      assert.ok(contour && !contour.closed);
      assert.deepEqual(contour.curves.at(-1).slice(4), contour.start, 'closing the contour must not insert a jumping segment');
      contour.closed = true;
    }
  }
  assert.ok(contours.length >= 1 && contours.length <= 3);
  assert.ok(contours[0].closed);
  assert.ok(contours.reduce((sum, item) => sum + item.curves.length, 0) <= 18);
  return contours;
}

function cubic(start, curve, t) {
  const s = 1 - t;
  return [0, 1].map(axis => s ** 3 * start[axis] + 3 * s ** 2 * t * curve[axis] +
    3 * s * t ** 2 * curve[axis + 2] + t ** 3 * curve[axis + 4]);
}

function segmentDistance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

function roundedDistance([x, y], radius) {
  // Signed-distance geometry of the canonical rounded rectangle.
  const qx = Math.abs(x - 95) - (95 - radius);
  const qy = Math.abs(y - 52) - (52 - radius);
  return Math.abs(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius);
}

function checkSilhouette(shape, contours) {
  const outer = contours[0];
  const vertices = POLYGONS[shape];
  if (vertices) {
    assert.deepEqual(outer.start, vertices[0]);
    assert.deepEqual(outer.curves.map(curve => curve.slice(4)), [...vertices.slice(1), vertices[0]]);
  }
  if (ROUND_RADII[shape]) {
    const r = ROUND_RADII[shape];
    assert.deepEqual(outer.start, [r, 0]);
    assert.deepEqual(outer.curves.map(curve => curve.slice(4)),
      [[190 - r, 0], [190, r], [190, 104 - r], [190 - r, 104], [r, 104], [0, 104 - r], [0, r], [r, 0]]);
  }
  let from = outer.start;
  for (let index = 0; index < outer.curves.length; index++) {
    const curve = outer.curves[index];
    for (const t of [.1, .25, .5, .75, .9]) {
      const point = cubic(from, curve, t);
      if (vertices) {
        assert.ok(segmentDistance(point, from, curve.slice(4)) <= 3, `${shape} exceeds its jitter envelope`);
      } else if (ROUND_RADII[shape]) {
        assert.ok(roundedDistance(point, ROUND_RADII[shape]) <= 3, `${shape} leaves its rounded silhouette`);
      }
    }
    from = curve.slice(4);
  }
  if (shape === 'component') {
    assert.equal(contours.length, 3);
    for (const [index, top] of [[1, 18], [2, 68]]) {
      assert.equal(contours[index].closed, false, 'tab detail must not restore the body stroke through the tab fill');
      assert.deepEqual(contours[index].start, [10, top]);
      assert.deepEqual(contours[index].curves.map(curve => curve.slice(4)), [[21, top], [21, top + 17], [10, top + 17]]);
    }
  } else assert.equal(contours.length, 1);
}

test('all fifteen finite shapes produce two distinct, connected, stroke-only outlines', () => {
  for (const shape of SHAPES) {
    const outlines = sketchOutline(shape, 'entity-id');
    assert.equal(outlines.length, 2);
    assert.notEqual(outlines[0], outlines[1]);
    for (const path of outlines) checkSilhouette(shape, parse(path));
  }
});

test('outlines are deterministic, independent of call order, and isolated from caller mutation', () => {
  const expected = SHAPES.map(shape => sketchOutline(shape, 'stable-id'));
  for (const shape of SHAPES.toReversed()) sketchOutline(shape, 'unrelated-id');
  SHAPES.forEach((shape, index) => {
    assert.deepEqual(sketchOutline(shape, 'stable-id'), expected[index]);
    assert.notDeepEqual(sketchOutline(shape, 'another-id'), expected[index]);
    const returned = sketchOutline(shape, 'stable-id');
    returned[0] = '<script>';
    returned.push('bad path');
    assert.deepEqual(sketchOutline(shape, 'stable-id'), expected[index]);
  });
  assert.notDeepEqual(sketchOutline('browser', 'same-id'), sketchOutline('queue', 'same-id'), 'shape participates in the seed even when outer geometry is shared');
});

test('two strokes remain visibly separated on long edges at the demo’s 110px node width', () => {
  const fitScale = 110 / 190;
  for (const shape of ['rect', 'class_box']) {
    const gaps = [];
    for (let index = 0; index < 500; index++) {
      const passes = sketchOutline(shape, `node-${index}`).map(path => parse(path)[0]);
      // Compare the normal separation at each long side's midpoint, excluding
      // movement along the same clean line and the intentionally quiet corners.
      const maximum = Math.max(...[0, 2, 4, 6].map(segment => {
        const axis = segment % 4 === 0 ? 1 : 0;
        const midpoints = passes.map(contour => cubic(
          segment === 0 ? contour.start : contour.curves[segment - 1].slice(4), contour.curves[segment], .5,
        ));
        return Math.abs(midpoints[0][axis] - midpoints[1][axis]) * fitScale;
      }));
      gaps.push(maximum);
    }
    gaps.sort((a, b) => a - b);
    assert.ok(gaps[250] >= .75, `${shape}: median separation ${gaps[250]}px disappears at normal fit`);
    assert.ok(gaps[50] >= .4, `${shape}: too many IDs still resemble a clean single stroke`);
  }
});

test('unknown shapes fail closed and invalid or oversized IDs cannot introduce path grammar', () => {
  const hostile = { [Symbol.toPrimitive]() { throw new Error('must not coerce input'); } };
  for (const shape of [undefined, null, 0, {}, hostile, 'constructor', '__proto__', 'toString', 'RECT', '<path>', '', 'rect'.repeat(250_000)]) {
    assert.deepEqual(sketchOutline(shape, 'id'), []);
  }
  for (const id of [undefined, null, {}, hostile, Symbol('id'), 1n, Infinity]) {
    assert.deepEqual(sketchOutline('rect', id), sketchOutline('rect', ''));
  }
  const prefix = 'id'.repeat(90);
  assert.deepEqual(sketchOutline('rect', prefix + 'x'.repeat(1_000_000)), sketchOutline('rect', prefix));
  assert.deepEqual(sketchOutline('rect', prefix + 'different suffix'), sketchOutline('rect', prefix));
  for (const path of sketchOutline('cloud', '"><script>alert(1)</script> M NaN Infinity Z')) parse(path);
});

test('curved contours retain their canonical endpoints and keep control-point displacement below 3px', () => {
  const curves = {
    cylinder: {
      start: [0, 17], anchors: [[190, 17], [190, 87], [0, 87], [0, 17]],
      controls: { 0: [0, -2, 190, -2], 2: [190, 109, 0, 109] },
    },
    cloud: {
      start: [18, 99], anchors: [[13, 45], [58, 13], [145, 16], [183, 57], [169, 99], [18, 99]],
      controls: {
        0: [-8, 99, -9, 53], 1: [-2, 16, 34, 1], 2: [76, -7, 132, -5],
        3: [182, 7, 202, 36], 4: [207, 73, 191, 103],
      },
    },
  };
  for (let id = 0; id < 100; id++) for (const [shape, expected] of Object.entries(curves)) {
    for (const path of sketchOutline(shape, `curved-${id}`)) {
      const [contour] = parse(path);
      assert.deepEqual(contour.start, expected.start);
      assert.deepEqual(contour.curves.map(curve => curve.slice(4)), expected.anchors);
      for (const [index, controls] of Object.entries(expected.controls)) {
        const actual = contour.curves[index];
        for (const offset of [0, 2]) assert.ok(Math.hypot(actual[offset] - controls[offset], actual[offset + 1] - controls[offset + 1]) <= 3);
      }
    }
  }
});

test('stronger strokes keep every small rounded corner within its chord-length/8 control cap', () => {
  const kappa = 4 * (Math.sqrt(2) - 1) / 3;
  for (let id = 0; id < 500; id++) for (const [shape, r] of Object.entries(ROUND_RADII)) {
    const k = r * kappa;
    const canonicalControls = {
      1: [190 - r + k, 0, 190, r - k],
      3: [190, 104 - r + k, 190 - r + k, 104],
      5: [r - k, 104, 0, 104 - r + k],
      7: [0, r - k, r - k, 0],
    };
    for (const path of sketchOutline(shape, `corner-${id}`)) {
      const [contour] = parse(path);
      for (const [index, controls] of Object.entries(canonicalControls)) {
        const curve = contour.curves[index];
        for (const offset of [0, 2]) {
          assert.ok(Math.hypot(curve[offset] - controls[offset], curve[offset + 1] - controls[offset + 1]) <= Math.SQRT2 * r / 8);
        }
      }
    }
  }
});

test('500 nodes across every shape stay finite, bounded, deterministic, and within the silhouette envelope', () => {
  const results = new Map();
  for (let index = 0; index < 500; index++) for (const shape of SHAPES) {
    const id = `node-${index}`;
    const paths = sketchOutline(shape, id);
    results.set(`${shape}/${id}`, paths);
    assert.equal(paths.length, 2);
    for (const path of paths) {
      const contours = parse(path);
      checkSilhouette(shape, contours);
      const [minX, maxX, minY, maxY] = shape === 'diamond' ? [-14, 204, -12, 116]
        : shape === 'cloud' ? [-9, 207, -7, 103]
          : shape === 'cylinder' ? [0, 190, -2, 109] : [0, 190, 0, 104];
      for (const contour of contours) {
        const pairs = [contour.start, ...contour.curves.flatMap(curve => [curve.slice(0, 2), curve.slice(2, 4), curve.slice(4)])];
        for (const [x, y] of pairs) {
          assert.ok(Number.isFinite(x) && Number.isFinite(y));
          assert.ok(x >= minX - 3 && x <= maxX + 3);
          assert.ok(y >= minY - 3 && y <= maxY + 3);
          assert.ok(x >= -18 && x <= 212 && y >= -16 && y <= 120);
        }
      }
    }
  }
  for (let index = 499; index >= 0; index--) for (const shape of SHAPES.toReversed()) {
    assert.deepEqual(sketchOutline(shape, `node-${index}`), results.get(`${shape}/node-${index}`));
  }
});
