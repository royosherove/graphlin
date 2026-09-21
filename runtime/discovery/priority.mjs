// File names schedule work only. They never establish an architectural role.
const SUPPORT = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|__fixtures__|mocks?|__mocks__|testdata|e2e|benchmarks?|scripts|tools|tooling|examples|docs)(?:\/|$)/i;
const TEST_FILE = /(?:^test[_-]|[_-]tests?\.[^.]+$|\.(?:test|spec)\.[^.]+$)/i;
const ENTRY = /^(?:main|index|app|server|__main__|entry(?:[-_.](?:client|server))?)\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift)$/i;

export function pathPriority(relativePath) {
  if (typeof relativePath !== 'string') return 1;
  const name = relativePath.split('/').at(-1);
  if (SUPPORT.test(relativePath) || TEST_FILE.test(name)) return 2;
  return ENTRY.test(name) ? 0 : 1;
}

/** Select from bounded pending metadata: two priority turns, then oldest work. */
export function selectPrioritized(values, limit, { cursor = 0, priority = value => value.priority } = {}) {
  const queues = [[], [], []], positions = [0, 0, 0], selected = [];
  let index = 0;
  for (const value of values) {
    const rank = priority(value);
    queues[rank === 0 || rank === 2 ? rank : 1].push({ value, index: index++ });
  }
  let turn = cursor % 3;
  while (selected.length < limit) {
    let chosen = -1;
    for (let rank = 0; rank < queues.length; rank++) {
      const head = queues[rank][positions[rank]];
      if (!head) continue;
      if (chosen === -1 || turn === 2 && head.index < queues[chosen][positions[chosen]].index) chosen = rank;
      if (turn !== 2) break;
    }
    if (chosen === -1) break;
    selected.push(queues[chosen][positions[chosen]++].value);
    turn = (turn + 1) % 3;
  }
  return { values: selected, cursor: turn };
}
