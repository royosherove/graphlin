// Input is the already sanitized pipeline projection. Export never inherits
// source-excerpt permission from either viewer display or disk persistence.
// The recursive copy covers current, historical, and saved-session graphs,
// including both node and edge references, without mutating viewer state.
export function exportSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot, (key, value) => key === 'excerpt' ? undefined : value));
}
