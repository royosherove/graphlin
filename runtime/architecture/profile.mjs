import { freeze } from '../core/common.mjs';

export const ARCHITECTURE_NAMESPACE = 'graphlin.architecture';
export const ARCHITECTURE_VERSION = 'source-boundaries-v2';
export const ROLE_PROFILE_ID = 'graphlin.architecture.roles';
export const MEMBERSHIP_PROFILE_ID = 'graphlin.architecture.membership';

const boolean = (question, focus, yes, no) => ({
  type: 'boolean', instructions: { question, focus },
  criteria: { true: yes, false: no }, requiredMetrics: ['probability'],
});
const rules = 'Use only visible source. Names, directories, documentation, imports alone, and co-occurrence '
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
          question: 'What architectural boundary, if any, is implemented by this source scope '
            + 'in `evidence`, containing the named declarations in `entities`?', focus: rules,
        },
        criteria: {
          application: 'Visible executable bootstrap or composition of an application, server or worker.',
          component: 'A cohesive implemented responsibility with an interface inside an application.',
          unknown: 'No such boundary is established, or the needed implementation is not visible.',
        },
      },
      supported: boolean(
        'Does the code in `evidence` contain an implemented application entrypoint or cohesive component?',
        'Judge this file’s visible implementation. An application entrypoint constructs and starts a server, '
          + 'worker or user-facing program. A component implements a cohesive responsibility through callable operations '
          + 'or a class interface, such as a business service with input validation and state operations. Class/function syntax '
          + 'or a name alone does not suffice, but visible operation bodies do. External callers, deployment manifests, '
          + 'other source files and runtime execution are not prerequisites for recognizing that local implementation.',
        'Visible statements implement executable application startup or a cohesive component responsibility.',
        'There is no such implementation: only incidental helpers, constants, declarations, names or placeholders.',
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
