// Actual B measurements from .graphlin/jev-live-evaluation-kinds-1789856512629.json.
// Report SHA-256: 617c8969019d9835ed24b715694403af09ebe290994815a9661c4fa62fc61cf4.
// Both exact candidates passed A (sensitivity .04, relevance .94).
// Unlisted choices were exactly zero. Offline replay preserves the two semantic
// failures; it does not predict v6 behavior. The separate function timeout has
// no B judgment: A took 1934 ms, B 67 ms under the shared 2000 ms deadline.
export const v5KindFailures = [
  {
    caseId: 'kind-member-alias',
    repeat: 1,
    status: 'abstained',
    judgments: [{
      name: 'Store',
      expectedRole: 'module',
      support: 0.96,
      choice: 'datastore',
      confidence: 0.77,
      probabilities: { datastore: 0.79, module: 0.21000000000000002 },
    }],
  },
  {
    caseId: 'kind-member-alias',
    repeat: 2,
    status: 'accepted',
    judgments: [{
      name: 'Store',
      expectedRole: 'module',
      support: 0.96,
      choice: 'datastore',
      confidence: 0.78,
      probabilities: { datastore: 0.8, module: 0.19, package: 0.01 },
    }],
  },
];
