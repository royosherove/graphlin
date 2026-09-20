// Pure browser/Node layout; coordinates are the top-left of each node.
// Only positions are returned. Direction comes from actual edges, never kinds.
export const LAYOUT_ALGORITHMS = Object.freeze([
  'hierarchy', 'dependency', 'grouped', 'circular', 'grid', 'original',
]);

const MAX_NODES = 256;
const MAX_EDGES = 768;
// Bound intake work as well as layout work. Ordinary oversized inputs select
// the lowest IDs/pairs deterministically; pathological arrays fail closed.
const MAX_INPUT_NODES = 4096;
const MAX_INPUT_EDGES = 12288;
const MAX_DIMENSION = 10000;
const SWEEPS = 4;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const numeric = (value, fallback, minimum) => finite(value) && value >= minimum
  ? Math.min(value, MAX_DIMENSION) : fallback;

function compareNodes(a, b) {
  const completeA = a.x !== null && a.y !== null;
  const completeB = b.x !== null && b.y !== null;
  return compare(a.id, b.id) || compare(completeB, completeA) || compare(a.kind, b.kind) ||
    compare(a.x === null, b.x === null) || compare(a.x, b.x) ||
    compare(a.y === null, b.y === null) || compare(a.y, b.y);
}

function prepare(graph) {
  const inputNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const inputEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (inputNodes.length > MAX_INPUT_NODES || inputEdges.length > MAX_INPUT_EDGES) {
    return { nodes: [], edges: [] };
  }
  const byId = new Map();
  for (const raw of inputNodes) {
    if (!record(raw) || !validId(raw.id)) continue;
    const node = {
      id: raw.id,
      kind: typeof raw.kind === 'string' && raw.kind.length > 0 && raw.kind.length <= 80 ? raw.kind : 'unknown',
      x: finite(raw.x) ? raw.x : null,
      y: finite(raw.y) ? raw.y : null,
    };
    const previous = byId.get(node.id);
    if (!previous || compareNodes(node, previous) < 0) byId.set(node.id, node);
  }
  const nodes = [...byId.values()].sort(compareNodes).slice(0, MAX_NODES);
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const pairs = new Map();
  for (const edge of inputEdges) {
    if (!record(edge) || !index.has(edge.source) || !index.has(edge.target)) continue;
    const source = index.get(edge.source), target = index.get(edge.target);
    // A self-loop does not change a node's position. Parallel relations share
    // one structural pair, so relation count does not bias placement.
    if (source !== target) pairs.set(`${source}:${target}`, { source, target });
  }
  return { nodes, edges: [...pairs.values()].sort((a, b) => a.source - b.source || a.target - b.target).slice(0, MAX_EDGES) };
}

function grid(items, size) {
  const columns = Math.max(1, Math.min(items.length,
    Math.ceil(Math.sqrt(items.length * (size.h + size.gy) / (size.w + size.gx)))));
  const positions = new Map(items.map((item, i) => [item, {
    x: (i % columns) * (size.w + size.gx),
    y: Math.floor(i / columns) * (size.h + size.gy),
  }]));
  return {
    positions,
    width: Math.min(columns, items.length) * (size.w + size.gx) - size.gx,
    height: Math.ceil(items.length / columns) * (size.h + size.gy) - size.gy,
  };
}

// Shelf packing keeps disconnected components/kind groups disjoint without
// implying containment, ownership, or relationships between their members.
function pack(blocks, size) {
  if (!blocks.length) return new Map();
  const gapX = Math.max(size.gx * 2, size.w / 2, 16);
  const gapY = Math.max(size.gy * 2, size.h / 2, 16);
  const area = blocks.reduce((sum, block) => sum + (block.width + gapX) * (block.height + gapY), 0);
  const targetWidth = Math.max(...blocks.map(block => block.width), Math.sqrt(area));
  const result = new Map();
  let x = 0, y = 0, rowHeight = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > targetWidth) {
      x = 0; y += rowHeight + gapY; rowHeight = 0;
    }
    for (const [id, point] of block.positions) result.set(id, { x: x + point.x, y: y + point.y });
    x += block.width + gapX;
    rowHeight = Math.max(rowHeight, block.height);
  }
  return result;
}

function grouped(nodes, size) {
  const kinds = new Map();
  for (const node of nodes) {
    if (!kinds.has(node.kind)) kinds.set(node.kind, []);
    kinds.get(node.kind).push(node.id);
  }
  return pack([...kinds.keys()].sort(compare).map(kind => grid(kinds.get(kind), size)), size);
}

function circular(nodes, size) {
  if (nodes.length === 1) return new Map([[nodes[0].id, { x: 0, y: 0 }]]);
  // Adjacent centers are separated by the diagonal of an expanded node.
  // Consequently every pair of axis-aligned node boxes is disjoint, even at
  // the 256-node limit or with extreme aspect ratios. One pixel absorbs error.
  const radius = (Math.hypot(size.w + size.gx, size.h + size.gy) + 1) /
    (2 * Math.sin(Math.PI / nodes.length));
  const points = nodes.map((node, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / nodes.length;
    return [node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }];
  });
  const minX = Math.min(...points.map(([, point]) => point.x));
  const minY = Math.min(...points.map(([, point]) => point.y));
  return new Map(points.map(([id, point]) => [id, { x: point.x - minX, y: point.y - minY }]));
}

function original(nodes, size) {
  const result = new Map(), missing = [];
  for (const node of nodes) {
    if (node.x !== null && node.y !== null) result.set(node.id, { x: node.x, y: node.y });
    else missing.push(node);
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  let next = 0;
  // A fixed box can obstruct at most four cells of this grid. Five cells per
  // node therefore suffice, including cells occupied by earlier fallbacks.
  for (let slot = 0; next < missing.length && slot < MAX_NODES * 5; slot++) {
    const point = { x: (slot % columns) * (size.w + size.gx),
      y: Math.floor(slot / columns) * (size.h + size.gy) };
    const obstructed = [...result.values()].some(other =>
      Math.abs(point.x - other.x) < size.w + size.gx - 1e-8 &&
      Math.abs(point.y - other.y) < size.h + size.gy - 1e-8);
    if (!obstructed) result.set(missing[next++].id, point);
  }
  return result;
}

function stronglyConnected(outgoing) {
  const indices = Array(outgoing.length).fill(-1), low = [], stacked = new Set(), stack = [], groups = [];
  let counter = 0;
  function visit(vertex) {
    indices[vertex] = low[vertex] = counter++;
    stack.push(vertex); stacked.add(vertex);
    for (const target of outgoing[vertex]) {
      if (indices[target] === -1) { visit(target); low[vertex] = Math.min(low[vertex], low[target]); }
      else if (stacked.has(target)) low[vertex] = Math.min(low[vertex], indices[target]);
    }
    if (low[vertex] !== indices[vertex]) return;
    const members = [];
    let member;
    do { member = stack.pop(); stacked.delete(member); members.push(member); } while (member !== vertex);
    groups.push(members.sort((a, b) => a - b));
  }
  // Recursion is bounded by the admitted 256 vertices.
  for (let i = 0; i < outgoing.length; i++) if (indices[i] === -1) visit(i);
  return groups.sort((a, b) => a[0] - b[0]);
}

function condense(nodes, edges, size) {
  const outgoing = nodes.map(() => []);
  for (const { source, target } of edges) outgoing[source].push(target);
  const members = stronglyConnected(outgoing);
  const owner = new Map();
  members.forEach((group, i) => group.forEach(vertex => owner.set(vertex, i)));
  const blocks = members.map(group => grid(group.map(vertex => nodes[vertex].id), size));
  const next = members.map(() => new Set()), previous = members.map(() => new Set());
  for (const edge of edges) {
    const source = owner.get(edge.source), target = owner.get(edge.target);
    if (source !== target) { next[source].add(target); previous[target].add(source); }
  }
  return {
    blocks,
    next: next.map(values => [...values].sort((a, b) => a - b)),
    previous: previous.map(values => [...values].sort((a, b) => a - b)),
  };
}

function weakComponents(next, previous) {
  const seen = new Set(), result = [];
  for (let root = 0; root < next.length; root++) {
    if (seen.has(root)) continue;
    const group = [], queue = [root];
    seen.add(root);
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]; group.push(current);
      for (const neighbor of [...next[current], ...previous[current]]) {
        if (!seen.has(neighbor)) { seen.add(neighbor); queue.push(neighbor); }
      }
    }
    result.push(group.sort((a, b) => a - b));
  }
  return result;
}

function rankedLayers(group, next, previous) {
  const degrees = previous.map(values => values.length), rank = next.map(() => 0);
  const queue = group.filter(vertex => degrees[vertex] === 0);
  while (queue.length) {
    queue.sort((a, b) => a - b);
    const current = queue.shift();
    for (const target of next[current]) {
      rank[target] = Math.max(rank[target], rank[current] + 1);
      if (--degrees[target] === 0) queue.push(target);
    }
  }
  const layers = Array.from({ length: Math.max(...group.map(vertex => rank[vertex])) + 1 }, () => []);
  for (const vertex of group) layers[rank[vertex]].push(vertex);
  return { layers, rank };
}

function rowWidth(row, sizes, gap) {
  return row.reduce((sum, vertex) => sum + sizes[vertex], 0) + Math.max(0, row.length - 1) * gap;
}

function crossCenters(layers, sizes, gap) {
  const centers = new Map();
  for (const row of layers) {
    let offset = -rowWidth(row, sizes, gap) / 2;
    for (const vertex of row) {
      centers.set(vertex, offset + sizes[vertex] / 2);
      offset += sizes[vertex] + gap;
    }
  }
  return centers;
}

function reduceCrossings(initial, rank, next, previous, sizes, gap) {
  const edges = initial.flat().flatMap(source => next[source].map(target => ({ source, target })));
  const bands = new Map();
  for (const edge of edges) {
    const key = `${rank[edge.source]}:${rank[edge.target]}`;
    if (!bands.has(key)) bands.set(key, []);
    bands.get(key).push(edge);
  }
  function quality(layers) {
    const centers = crossCenters(layers, sizes, gap);
    let crossings = 0, span = 0;
    for (const edge of edges) span += Math.abs(centers.get(edge.source) - centers.get(edge.target));
    for (const band of bands.values()) for (let i = 0; i < band.length; i++) {
      for (let j = i + 1; j < band.length; j++) {
        const a = band[i], b = band[j];
        if ((centers.get(a.source) - centers.get(b.source)) *
          (centers.get(a.target) - centers.get(b.target)) < 0) crossings++;
      }
    }
    return { crossings, span };
  }
  let layers = initial.map(row => [...row]), best = layers.map(row => [...row]), score = quality(best);
  // Fixed forward/backward barycenter sweeps, retaining only the best ordering.
  // Comparison uses actual endpoint geometry and does not introduce edges.
  for (let sweep = 0; sweep < SWEEPS; sweep++) for (const forward of [true, false]) {
    let centers = crossCenters(layers, sizes, gap);
    const order = layers.map((_, i) => i);
    if (!forward) order.reverse();
    for (const index of order) {
      const row = layers[index], neighbors = forward ? previous : next;
      const scored = row.map((vertex, oldIndex) => ({
        vertex, oldIndex,
        value: neighbors[vertex].length
          ? neighbors[vertex].reduce((sum, neighbor) => sum + centers.get(neighbor), 0) / neighbors[vertex].length
          : centers.get(vertex),
      }));
      scored.sort((a, b) => a.value - b.value || a.oldIndex - b.oldIndex || a.vertex - b.vertex);
      layers[index] = scored.map(item => item.vertex);
      centers = crossCenters(layers, sizes, gap);
    }
    const candidate = quality(layers);
    if (candidate.crossings < score.crossings ||
      (candidate.crossings === score.crossings && candidate.span < score.span - 1e-8)) {
      score = candidate; best = layers.map(row => [...row]);
    }
  }
  return best;
}

function directed(nodes, edges, size, horizontal) {
  const { blocks, next, previous } = condense(nodes, edges, size);
  const crossSizes = blocks.map(block => horizontal ? block.height : block.width);
  const flowSizes = blocks.map(block => horizontal ? block.width : block.height);
  const crossGap = horizontal ? size.gy : size.gx, flowGap = horizontal ? size.gx : size.gy;
  const components = weakComponents(next, previous).map(group => {
    const ranked = rankedLayers(group, next, previous);
    const layers = reduceCrossings(ranked.layers, ranked.rank, next, previous, crossSizes, crossGap);
    const breadth = Math.max(...layers.map(row => rowWidth(row, crossSizes, crossGap)));
    const positions = new Map();
    let flow = 0;
    for (const row of layers) {
      const depth = Math.max(...row.map(vertex => flowSizes[vertex]));
      let cross = (breadth - rowWidth(row, crossSizes, crossGap)) / 2;
      for (const vertex of row) {
        const offset = flow + (depth - flowSizes[vertex]) / 2;
        for (const [id, point] of blocks[vertex].positions) positions.set(id, {
          x: point.x + (horizontal ? offset : cross),
          y: point.y + (horizontal ? cross : offset),
        });
        cross += crossSizes[vertex] + crossGap;
      }
      flow += depth + flowGap;
    }
    return { positions, width: horizontal ? flow - flowGap : breadth,
      height: horizontal ? breadth : flow - flowGap };
  });
  return pack(components, size);
}

/**
 * Return a fresh Map<id, {x,y}> in ID order without modifying graph/options.
 * Algorithms: hierarchy (default, top-down), dependency (left-right), grouped
 * (kind only), circular, grid, original. Unknown algorithms use hierarchy.
 * Generated layouts do not overlap; original intentionally preserves finite
 * coordinate pairs, including existing overlaps, and fills missing pairs.
 * Dimensions: finite [1, 10000], gaps [0, 10000]; invalid values use defaults.
 * Layout admits 256 unique nodes and 768 distinct directed endpoint pairs.
 * Inputs above 4096 nodes or 12288 edges return an empty Map (bounded intake).
 */
export function layoutGraph(graph, options = {}) {
  const settings = record(options) ? options : {};
  const size = {
    w: numeric(settings.nodeWidth, 190, 1), h: numeric(settings.nodeHeight, 104, 1),
    gx: numeric(settings.gapX, 80, 0), gy: numeric(settings.gapY, 80, 0),
  };
  const { nodes, edges } = prepare(graph);
  if (!nodes.length) return new Map();
  const algorithm = LAYOUT_ALGORITHMS.includes(settings.algorithm) ? settings.algorithm : 'hierarchy';
  let positions;
  if (algorithm === 'grid') positions = grid(nodes.map(node => node.id), size).positions;
  else if (algorithm === 'original') positions = original(nodes, size);
  else if (algorithm === 'grouped') positions = grouped(nodes, size);
  else if (algorithm === 'circular') positions = circular(nodes, size);
  else positions = directed(nodes, edges, size, algorithm === 'dependency');
  return new Map(nodes.map(node => [node.id, positions.get(node.id)]));
}
