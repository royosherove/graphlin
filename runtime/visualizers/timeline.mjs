// First-party custom renderer. It consumes the same update/dispose lifecycle as
// scene projectors and works when entities and relations are both empty.
export function timelineRows(model, settings = {}) {
  const query = (settings.query || '').toLowerCase();
  const rows = model.activity.filter(event => !settings.session || event.sessionId === settings.session)
    .filter(event => !query || `${event.kind} ${event.toolCategory} ${event.agentId || ''}`.toLowerCase().includes(query))
    .slice(-200).map(event => ({
      id: event.id, sequence: event.sequence, at: event.at ?? event.timestamp,
      lane: event.agentId || event.sessionId || 'Unattributed',
      label: `${event.toolCategory || 'Activity'} · ${(event.kind || 'observation').replaceAll('.', ' ')}`,
      outcome: event.outcome || 'unresolved', attribution: event.attribution || 'unknown',
      toolCallId: event.toolCallId, entityIds: event.entityIds || [],
    })).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  // Pair only explicitly correlated observations. A pending attempt without a
  // terminal event remains unresolved; parallel tool IDs remain separate.
  const outcomes = new Map();
  for (const row of rows) if (row.toolCallId && !['pending', 'unresolved', 'observed'].includes(row.outcome))
    outcomes.set(`${row.lane}:${row.toolCallId}`, row.outcome);
  return rows.map(row => ({ ...row, outcome: row.outcome === 'pending'
    ? outcomes.get(`${row.lane}:${row.toolCallId}`) || 'unresolved' : row.outcome }));
}

export function createTimeline({ root, select = () => {} }) {
  const document = root.ownerDocument;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  let disposed = false, lastSequence = null;
  return {
    update({ model, settings = {} }) {
      if (disposed) throw new Error('extension_disposed');
      const focusedId = document.activeElement?.dataset?.activityId;
      const rows = timelineRows(model, settings);
      const heading = element('p', `${rows.length} ordered observations. Parallel lanes use recorded agent or session attribution.`, 'timeline-note');
      const list = element('ol', undefined, 'timeline-events');
      list.setAttribute('aria-label', 'Agent and tool observations in sequence order');
      let focus;
      for (const row of rows) {
        const item = element('li', undefined, 'timeline-event');
        item.dataset.outcome = row.outcome;
        const time = element('time', Number.isFinite(Date.parse(row.at)) ? new Date(row.at).toLocaleTimeString() : 'Time unknown');
        const button = element('button', row.label);
        button.setAttribute('type', 'button');
        button.dataset.activityId = row.id;
        button.setAttribute('aria-label', `${row.label}. ${row.outcome}. ${row.entityIds.length ? 'Inspect linked evidence' : 'No linked entity'}.`);
        button.addEventListener('click', () => select({ activityId: row.id, entityId: row.entityIds[0] || null }));
        if (focusedId === row.id) focus = button;
        item.append(time, element('span', row.lane, 'timeline-lane'), button,
          element('span', row.outcome, 'timeline-outcome'),
          element('span', `${row.attribution} attribution`, 'timeline-attribution'));
        list.append(item);
      }
      if (!rows.length) list.append(element('li', 'No observations at this position. Select Live to follow captured work.'));
      root.replaceChildren(heading, list);
      focus?.focus({ preventScroll: true });
      if (settings.follow && lastSequence !== null && model.sequence > lastSequence) list.children[list.children.length - 1]?.scrollIntoView({ block: 'nearest' });
      lastSequence = model.sequence;
      return { kind: 'custom', status: 'ready', itemCount: rows.length };
    },
    dispose() { disposed = true; root.replaceChildren(); },
  };
}
export const timeline = { id: 'graphlin.timeline', name: 'Activity timeline', renderer: 'custom', create: createTimeline };
