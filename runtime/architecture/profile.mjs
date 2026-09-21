import { freeze } from '../core/common.mjs';

export const ARCHITECTURE_NAMESPACE = 'graphlin.architecture';
export const ARCHITECTURE_VERSION = 'source-boundaries-v5';
export const ROLE_PROFILE_ID = 'graphlin.architecture.roles';
export const MEMBERSHIP_PROFILE_ID = 'graphlin.architecture.membership';

const boolean = (question, focus, yes, no) => ({
  type: 'boolean', instructions: { question, focus },
  criteria: { true: yes, false: no }, requiredMetrics: ['probability'],
});
const rules = 'Evidence entries are separate contiguous fragments of the same source file, in source order. '
  + 'Module is a generic context label, not an architectural judgment. Entries can omit intervening lines; '
  + 'never assume adjacency or invent missing bodies. Use only visible source. '
  + 'Names, directories, documentation, imports alone, and co-occurrence '
  + 'do not establish an architectural boundary. An application has visible executable bootstrap or '
  + 'composition of a user-facing program, server or worker. A component has a coherent responsibility '
  + 'and an implemented interface; an incidental helper, constant, type or external dependency is not '
  + 'automatically a component. Classify what this code implements when invoked, never claim it ran.';

/** Register this source profile with the existing decision service; it cannot bypass A. */
export const ARCHITECTURE_PROFILES = freeze([
  {
    id: ROLE_PROFILE_ID, version: ARCHITECTURE_VERSION, scope: 'bundle',
    questions: {
      kind: {
        type: 'choice', requiredMetrics: ['probabilities', 'confidence'],
        instructions: {
          question: 'What does this source file locally implement in `evidence`?', focus: rules,
        },
        criteria: {
          application: 'Visible executable bootstrap or composition that starts an application, server or worker when invoked.',
          component: 'A cohesive implemented API with visible operation bodies, beyond an incidental helper.',
          unknown: 'Only imports, declarations, stubs, constants or incidental helpers; no such local responsibility is established.',
        },
      },
      supported: boolean(
        'Does `evidence` directly show implemented behavior for this source file?',
        'Judge implementation presence, independently of the architectural role. Actual startup statements or '
          + 'operation bodies show implementation. Imports, signatures, empty bodies, placeholder throws, comments '
          + 'and a name alone do not. External callers, deployment manifests, imported collaborator internals '
          + 'and runtime execution are not prerequisites for recognizing visible local implementation.',
        'Executable statements directly implement startup or operations in this file.',
        'Only imports, declarations, scalar constants, empty bodies or placeholders are visible.',
      ),
      missing_context: boolean(
        'Is a local statement or definition absent from `evidence` that prevents identifying what this file implements?',
        'This is only about classifying the visible file as application, component or unknown. '
          + 'Missing context requires an omitted/truncated body or unresolved local operation that prevents that decision. '
          + 'A visible server construction and listen call suffice for application startup. Visible class or function '
          + 'operation bodies can establish a component. Standard library internals, implementation of imported collaborators, '
          + 'upstream callers, deployment configuration and runtime execution are not required to identify the file’s own role. '
          + 'A fully visible constant or helper can conclusively be unknown without missing context.',
        'A necessary local body or statement is absent, so the file’s implemented responsibility cannot be identified.',
        'Visible code suffices to support or reject an application/component role for this file.',
      ),
    },
  },
]);
