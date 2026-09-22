import path from 'node:path';
import { freeze, hash as contentHash, isHash, isId, opaque, plain } from '../core/common.mjs';
import { excluded, safeLabel, privateText, safeText } from '../core/privacy.mjs';
import { loadParser } from './parser.mjs';

export const IDENTITY_VERSION = 'source-scope-v1';
export const EXTRACTOR_VERSION = 'structure-v1';
export const STRUCTURE_LIMITS = Object.freeze({
  fileBytes: 256 * 1024, entities: 2048, imports: 512, bindings: 128, nodes: 50000, depth: 128, milliseconds: 100,
});
const LANGUAGES = { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.py': 'python', '.pyi': 'python' };
export const sourceLanguage = relativePath => LANGUAGES[path.posix.extname(relativePath).toLowerCase()] ?? null;
const DECLARATIONS = {
  class_declaration: 'class', abstract_class_declaration: 'class', class_definition: 'class',
  function_declaration: 'function', generator_function_declaration: 'function',
  function_definition: 'function', function_signature: 'function',
  method_definition: 'method', method_signature: 'method', abstract_method_signature: 'method',
  interface_declaration: 'interface', internal_module: 'namespace', module: 'namespace',
  enum_declaration: 'enum', type_alias_declaration: 'type_alias',
};
const FUNCTIONS = new Set(['arrow_function', 'function_expression', 'generator_function', 'function']);
const field = (node, name) => node.childForFieldName(name);
const lines = node => ({ startLine: node.startPosition.row + 1, endLine: Math.max(node.startPosition.row + 1,
  node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1)) });
const simpleName = node => node && ['identifier', 'property_identifier', 'private_property_identifier',
  'type_identifier', 'dotted_name', 'nested_identifier'].includes(node.type) ? node.text : null;

function budget(options = {}) {
  options = plain(options) ? options : {};
  return Object.fromEntries(Object.entries(STRUCTURE_LIMITS).map(([key, max]) =>
    [key, Number.isSafeInteger(options[key]) && options[key] > 0 ? Math.min(max, options[key]) : max]));
}
function literal(node) {
  if (!node || node.type !== 'string' || node.hasError) return null;
  const text = node.text;
  // Escaped/interpolated/dynamic module specifiers require a resolver. Do not
  // turn their source spelling into a claimed literal target.
  return text.length > 2 && text[0] === text.at(-1) && !/[\\\r\n]/.test(text.slice(1, -1)) ? text.slice(1, -1) : null;
}

/**
 * Extract local structure from an already-authorized immutable capture.
 * No source I/O, transmission, classification, or runtime claims occur here.
 * `complete:false` is mandatory for caller-truncated captures/windows.
 */
export async function extractStructure({
  artifactId, relativePath, text, hash, generation, complete = true, limits: options, signal,
} = {}) {
  if (!isId(artifactId) || typeof relativePath !== 'string' || !relativePath || path.posix.isAbsolute(relativePath) ||
      relativePath.split('/').some(part => !part || part === '..' || part === '.') || /[\\\0\r\n]/.test(relativePath) ||
      !Number.isSafeInteger(generation) || generation < 1 || !isHash(hash)) throw new TypeError('INVALID_STRUCTURE_INPUT');
  const limits = budget(options);
  const language = sourceLanguage(relativePath);
  const scopeId = opaque('entity', IDENTITY_VERSION, artifactId, language, 'module');
  const omissions = [];
  const omit = reason => { if (!omissions.includes(reason)) omissions.push(reason); };
  const entities = [], relations = [], imports = [];
  const enumeration = {
    complete: false, extractor: 'file-level', version: '1', scopeId, omissions, artifactId, hash, generation,
    identityVersion: IDENTITY_VERSION, capability: language ? 'lexical' : 'unsupported', coveredRanges: [],
  };
  const result = () => freeze({ entities, relations, imports, enumeration });
  if (excluded(relativePath) || !safeText(relativePath, 4096)) { omit('excluded_path'); return result(); }
  const label = path.posix.basename(relativePath);
  if (!safeLabel(label)) { omit('unsafe_label'); return result(); }
  // File identity is metadata; without usable source there are no declaration
  // spans or ownership edges. The host still owns the display/persistence grant.
  entities.push({ id: scopeId, label, kind: 'module', parentId: null, artifactId,
    startLine: 1, endLine: 1, qualifiedName: relativePath });
  if (!language) { omit('unsupported_language'); return result(); }
  if (typeof text !== 'string') { omit('source_unavailable'); return result(); }
  if (text.length > limits.fileBytes || Buffer.byteLength(text, 'utf8') > limits.fileBytes) {
    omit('file_bytes'); return result();
  }
  if (text.includes('\0') || privateText(text)) { omit('source_filtered'); return result(); }
  if (contentHash(text) !== hash) { omit('hash_mismatch'); return result(); }
  if (complete !== true) omit('partial_capture');
  if (signal?.aborted) { omit('aborted'); return result(); }
  entities[0].endLine = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

  let parser, tree, loaded;
  try {
    loaded = await loadParser(language);
    if (signal?.aborted) { omit('aborted'); return result(); }
    parser = new loaded.Parser();
    parser.setLanguage(loaded.grammar);
    const deadline = performance.now() + limits.milliseconds;
    tree = parser.parse(text, null, { progressCallback: () => signal?.aborted || performance.now() >= deadline });
    if (!tree) { omit(signal?.aborted ? 'aborted' : 'parse_timeout'); return result(); }
    enumeration.extractor = 'tree-sitter';
    enumeration.version = `${EXTRACTOR_VERSION}/${loaded.version}`;
    enumeration.capability = 'parsed';
    if (tree.rootNode.hasError) omit('parse_error');
    const counts = new Map();
    const add = (name, kind, node, owner) => {
      if (!safeLabel(name)) { omit('unsafe_label'); return null; }
      if (entities.length >= limits.entities) { omit('entity_limit'); return null; }
      const key = JSON.stringify([owner.id, kind, name]);
      const ordinal = counts.get(key) ?? 0;
      counts.set(key, ordinal + 1);
      const id = opaque('entity', IDENTITY_VERSION, artifactId, language, owner.id, kind, name, ordinal);
      const entity = { id, label: name, kind, parentId: owner.id, artifactId, ...lines(node),
        qualifiedName: `${owner.qualifiedName}::${name}${ordinal ? `#${ordinal + 1}` : ''}` };
      entities.push(entity);
      relations.push({ id: opaque('relation', 'contains', owner.id, id), source: owner.id, target: id, kind: 'contains' });
      return entity;
    };
    const importCounts = new Map();
    const addImport = (specifier, bindings, node, owner, kind = 'import') => {
      if (!specifier || !safeText(specifier, 512) || /[\r\n]/.test(specifier)) { omit('unresolved_import'); return; }
      if (imports.length >= limits.imports) { omit('import_limit'); return; }
      if (bindings.length > limits.bindings) omit('binding_limit');
      const boundedBindings = bindings.slice(0, limits.bindings);
      const valid = boundedBindings
        .filter(binding => safeLabel(binding.local) && (binding.imported === '*' || safeLabel(binding.imported)));
      if (valid.length !== boundedBindings.length) omit('unsafe_import_binding');
      const key = JSON.stringify([owner.id, kind, specifier, valid]);
      const ordinal = importCounts.get(key) ?? 0;
      importCounts.set(key, ordinal + 1);
      imports.push({ id: opaque('import', IDENTITY_VERSION, artifactId, language, key, ordinal),
        artifactId, ownerId: owner.id, specifier, bindings: valid, ...lines(node), kind, resolved: false });
    };
    const stack = [{ node: tree.rootNode, owner: entities[0], depth: 0, skipDeclaration: false }];
    let visited = 0;
    while (stack.length) {
      if (++visited > limits.nodes) { omit('node_limit'); break; }
      if (signal?.aborted || performance.now() >= deadline) { omit(signal?.aborted ? 'aborted' : 'extraction_timeout'); break; }
      const { node, owner, depth, skipDeclaration } = stack.pop();
      if (depth > limits.depth) { omit('depth_limit'); continue; }
      // Error recovery can preserve valid siblings, but never establishes the
      // lexical parent of a declaration hidden inside an error subtree.
      if (node.isError || node.isMissing) { omit('parse_error'); continue; }
      let childOwner = owner, skipValue = null;
      let kind = DECLARATIONS[node.type], name = simpleName(field(node, 'name'));
      if (node.type === 'module' && language === 'python') kind = null;
      if (node.type === 'function_definition' && owner.kind === 'class') kind = 'method';
      if (node.type === 'variable_declarator') {
        name = simpleName(field(node, 'name'));
        const value = field(node, 'value');
        kind = value && FUNCTIONS.has(value.type) ? 'function' : value?.type === 'class' ? 'class' : 'variable';
        if (value && (FUNCTIONS.has(value.type) || ['class', 'object'].includes(value.type))) skipValue = value.id;
      } else if (['pair', 'public_field_definition', 'field_definition'].includes(node.type)) {
        const value = field(node, 'value');
        if (value && (FUNCTIONS.has(value.type) || value.type === 'object' || value.type === 'class')) {
          name = simpleName(field(node, 'key') ?? field(node, 'property') ?? field(node, 'name'));
          kind = FUNCTIONS.has(value.type) ? 'method' : value.type === 'class' ? 'class' : 'variable';
          skipValue = value.id;
        }
      }
      if (!skipDeclaration && kind) {
        if (!name) {
          // Binding patterns, computed names, and anonymous declarations cannot
          // be assigned an invented stable owner.
          omit('unsupported_declaration'); continue;
        }
        if (node.hasError) { omit('parse_error'); continue; }
        childOwner = add(name, kind, node, owner);
        if (!childOwner) continue;
      } else if (!skipDeclaration && (FUNCTIONS.has(node.type) || ['class', 'lambda', 'object'].includes(node.type))) {
        omit('anonymous_scope'); continue;
      }
      if (language === 'python' && ['import_statement', 'import_from_statement'].includes(node.type) && !node.hasError) {
        const module = field(node, 'module_name')?.text;
        const names = node.namedChildren.filter(child => child.id !== field(node, 'module_name')?.id);
        if (node.type === 'import_from_statement') {
          const bindings = names.map(child => child.type === 'aliased_import'
            ? { imported: field(child, 'name').text, local: field(child, 'alias').text }
            : { imported: child.text, local: child.text });
          addImport(module, bindings, node, owner);
        } else {
          for (const child of names) {
            const specifier = child.type === 'aliased_import' ? field(child, 'name').text : child.text;
            addImport(specifier, [{ imported: '*', local: field(child, 'alias')?.text ?? specifier.split('.')[0] }], node, owner);
          }
        }
      } else if (language !== 'python' && ['import_statement', 'export_statement'].includes(node.type) && !node.hasError) {
        const requireClause = node.namedChildren.find(child => child.type === 'import_require_clause');
        const source = field(node, 'source') ?? (requireClause && field(requireClause, 'source'));
        if (source) {
          const bindings = [];
          const clause = node.namedChildren.find(child => child.type === 'import_clause');
          for (const child of clause?.namedChildren ?? []) {
            if (child.type === 'identifier') bindings.push({ imported: 'default', local: child.text });
            else if (child.type === 'namespace_import') bindings.push({ imported: '*', local: child.namedChildren[0].text });
            else if (child.type === 'named_imports') for (const specifier of child.namedChildren) {
              bindings.push({ imported: field(specifier, 'name')?.text, local: (field(specifier, 'alias') ?? field(specifier, 'name'))?.text });
            }
          }
          if (requireClause) bindings.push({ imported: '*', local: requireClause.namedChildren[0].text });
          const exports = node.namedChildren.find(child => child.type === 'export_clause');
          for (const specifier of exports?.namedChildren ?? []) {
            bindings.push({ imported: field(specifier, 'name')?.text, local: (field(specifier, 'alias') ?? field(specifier, 'name'))?.text });
          }
          const namespace = node.namedChildren.find(child => child.type === 'namespace_export');
          if (namespace) bindings.push({ imported: '*', local: namespace.namedChildren[0].text });
          addImport(literal(source), bindings, node, owner, node.type === 'export_statement' ? 'reexport' : 'import');
        } else if (node.type === 'import_statement') omit('unresolved_import');
      } else if (node.type === 'call_expression' && field(node, 'function')?.type === 'import') {
        const source = field(node, 'arguments')?.namedChildren[0];
        addImport(literal(source), [], node, owner, 'dynamic_import');
      } else if (node.type === 'call_expression' && field(node, 'function')?.text === 'require') {
        // A call spelled `require` can be shadowed. Preserve only the syntactic
        // reference; a binding resolver must establish that it loads a module.
        addImport(literal(field(node, 'arguments')?.namedChildren[0]), [], node, owner, 'require_reference');
        omit('require_resolution');
      }
      // Limit traversal width as well as the total number of nodes. Iterating
      // children in reverse preserves source order without recursive JS calls.
      if (node.namedChildCount + stack.length > limits.nodes) { omit('node_limit'); break; }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        stack.push({ node: child, owner: childOwner, depth: depth + 1, skipDeclaration: child.id === skipValue });
      }
    }
    enumeration.complete = omissions.length === 0;
    if (enumeration.complete) enumeration.coveredRanges = [{ startLine: 1, endLine: entities[0].endLine }];
    return result();
  } catch {
    // Dependency/grammar failures leave a visibly limited file-level fallback.
    // Fixed diagnostics avoid retaining source text or local filesystem paths.
    entities.splice(1); relations.length = 0; imports.length = 0;
    enumeration.capability = 'lexical';
    enumeration.extractor = 'file-level';
    enumeration.version = '1';
    enumeration.coveredRanges = [];
    omit('parser_unavailable');
    return result();
  } finally {
    tree?.delete();
    parser?.delete();
  }
}
