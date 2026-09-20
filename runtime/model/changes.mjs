const supported = entity => entity.validity === 'current' && entity.sourceRefs.length > 0;
const fingerprint = entity => JSON.stringify([
  entity.label, entity.kind, entity.parentId, entity.qualifiedName, entity.basis,
  entity.sourceRefs.map(ref => [ref.artifactId, ref.hash]),
]);
const sameScheme = (a, b) => a && b && a.extractor === b.extractor &&
  a.version === b.version && a.identityVersion === b.identityVersion;

export function compareCheckpoint(baseline, current, checkpointId) {
  const before = new Map(baseline.entities.map(entity => [entity.id, entity]));
  const oldCertificates = new Map((baseline.coverage?.enumerations ?? []).map(cert => [cert.artifactId, cert]));
  const certificates = new Map((current.coverage?.enumerations ?? []).map(cert => [cert.artifactId, cert]));
  const result = {
    checkpointId, fromRevision: baseline.revision, toRevision: current.revision,
    fromSequence: baseline.sequence, toSequence: current.sequence,
    discoveries: [], creations: [], modifications: [], removals: [], invalidations: [],
  };
  for (const entity of current.entities) {
    const old = before.get(entity.id);
    if (!old) {
      if (entity.validity === 'retracted') continue;
      const a = oldCertificates.get(entity.artifactId), b = certificates.get(entity.artifactId);
      const priorAbsence = a?.complete && b?.complete && sameScheme(a, b) &&
        a.hash !== b.hash && a.generation < b.generation &&
        baseline.coverage?.lineage?.id === current.coverage?.lineage?.id;
      const creation = entity.createdAtSequence > baseline.sequence || (current.activity ?? []).some(event =>
        event.creation && event.sequence > baseline.sequence && event.entityIds?.includes(entity.id) &&
        event.sourceRefs?.some(ref => entity.sourceRefs.some(support =>
          ref.artifactId === support.artifactId && ref.hash === support.hash && ref.generation === support.generation)));
      result[supported(entity) && (priorAbsence || creation) ? 'creations' : 'discoveries'].push(entity);
    } else if (old.validity !== 'retracted' && entity.validity === 'retracted') {
      result.removals.push(entity);
    } else if (old.validity === 'current' && entity.validity === 'stale') {
      result.invalidations.push(entity);
    } else if (entity.validity === 'current' && fingerprint(old) !== fingerprint(entity)) {
      result.modifications.push({ before: old, after: entity });
    }
  }
  // Missing retained records may have been evicted by capacity, so only explicit
  // retraction above is a deletion. Baselines remain usable after journal trim.
  return result;
}
