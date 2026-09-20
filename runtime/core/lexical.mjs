import { LIMITS } from './common.mjs';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DECLARATIONS = new Set(['function', 'class', 'interface', 'def', 'fn', 'func', 'fun', 'struct', 'enum', 'type', 'module', 'namespace', 'trait']);
const FUNCTIONS = new Set(['function', 'def', 'fn', 'func', 'fun']);
const BINDINGS = new Set(['const', 'let', 'var', 'val']);
const BUILTINS = new Set(['this', 'self', 'process', 'console', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'JSON', 'Math', 'Date', 'Error', 'return', 'export', 'import', 'from', 'const', 'let', 'var',
  'true', 'false', 'null', 'undefined', 'async', 'await', 'function', 'class', 'if', 'else', 'new',
  'require', 'super', 'env', 'environ', 'meta', 'Propose', 'Use', 'Add', 'Create', 'Build', 'Update',
  'The', 'A', 'An', 'We', 'I', 'Implement', 'Connect', 'Read', 'Write']);
const TOKEN_LIMIT = 32768;
const ENTITY_LIMIT = 1024;
const PAIR_LIMIT = 1024;

// This is a bounded lexical selector, not a parser or semantic analyzer.
// Offsets always refer to the untouched input. Literal/comment bodies cannot
// contribute identifiers. Template interpolation is conservatively skipped too.
export function tokenize(text) {
  const tokens = [];
  const length = Math.min(text.length, LIMITS.fileBytes);
  let i = 0;
  const add = (kind, start, end, value = text.slice(start, end)) => tokens.push({ kind, start, end, value });
  while (i < length && tokens.length < TOKEN_LIMIT) {
    const ch = text[i], start = i;
    if (/\s/.test(ch)) { i++; continue; }
    if (text.startsWith('//', i) || ch === '#') {
      while (i < length && text[i] !== '\n') i++;
      continue;
    }
    if (text.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2; }
        else if (text.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const delimiter = ch !== '`' && text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      i += delimiter.length;
      while (i < length) {
        if (text[i] === '\\') { i = Math.min(length, i + 2); continue; }
        if (text.startsWith(delimiter, i)) { i += delimiter.length; break; }
        i++;
      }
      add('literal', start, i, '');
      continue;
    }
    // Skip JS regex bodies in expression positions. Ambiguous slash syntax is
    // left as punctuation, without guessing any language-level meaning.
    const previous = tokens.at(-1)?.value;
    if (ch === '/' && (previous === undefined || ['=', '(', '[', '{', ':', ',', 'return', '=>'].includes(previous))) {
      let end = i + 1, characterClass = false;
      while (end < length && text[end] !== '\n') {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '[') characterClass = true;
        else if (text[end] === ']') characterClass = false;
        else if (text[end] === '/' && !characterClass) break;
        end++;
      }
      if (text[end] === '/') {
        i = end + 1;
        while (i < length && /[a-z]/i.test(text[i])) i++;
        add('literal', start, i, '');
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      i++;
      while (i < length && /[\w$]/.test(text[i])) i++;
      add('identifier', start, i);
    } else {
      const pair = text.slice(i, i + 2);
      i += ['=>', '?.', '::', ':='].includes(pair) ? 2 : 1;
      add('punctuation', start, i);
    }
  }
  return tokens;
}

function delimiters(tokens) {
  const matching = new Map(), stack = [];
  const closing = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (['(', '[', '{'].includes(value)) stack.push(i);
    else if (closing[value]) {
      if (tokens[stack.at(-1)]?.value !== closing[value]) continue;
      const start = stack.pop();
      matching.set(start, i);
    }
  }
  return matching;
}
const isName = token => token?.kind === 'identifier' && IDENTIFIER.test(token.value);
const property = (tokens, i) => ['.', '?.', '::'].includes(tokens[i - 1]?.value);

function bareEnvironmentLookup(tokens, start, text) {
  let end;
  if (tokens[start]?.value === 'process' && tokens[start + 1]?.value === '.' &&
      tokens[start + 2]?.value === 'env') end = start + 3;
  else if (tokens[start]?.value === 'import' && tokens[start + 1]?.value === '.' &&
      tokens[start + 2]?.value === 'meta' && tokens[start + 3]?.value === '.' &&
      tokens[start + 4]?.value === 'env') end = start + 5;
  else return false;

  if (tokens[end]?.value === '.' && isName(tokens[end + 1])) end += 2;
  else if (tokens[end]?.value === '[' && ['identifier', 'literal'].includes(tokens[end + 1]?.kind) &&
      tokens[end + 2]?.value === ']') end += 3;
  else return false;

  // Only a complete bare lookup is lexical noise. A following conditional,
  // operator, call, or wrapper can initialize a different named binding.
  const next = tokens[end];
  return !next || [';', ',', ')', ']', '}'].includes(next.value) ||
    (text.slice(tokens[end - 1].end, next.start).includes('\n') &&
      (BINDINGS.has(next.value) || DECLARATIONS.has(next.value) || next.value === 'export'));
}

export function lexicalHints(text) {
  const tokens = tokenize(text), matching = delimiters(tokens);
  const entities = new Map(), scopes = [], constructions = [], pairs = new Map();
  function add(token, rank) {
    if (!isName(token) || BUILTINS.has(token.value) || token.value.length > LIMITS.labelChars) return;
    const old = entities.get(token.value);
    if (old && old.rank <= rank || !old && entities.size >= ENTITY_LIMIT) return;
    entities.set(token.value, { label: token.value, start: token.start, end: token.end, rank });
  }
  function addScope(name, open, end) {
    if (scopes.length < 256 && end !== undefined) scopes.push({ name, start: tokens[open].start, end: tokens[end]?.end ?? text.length });
  }
  function functionScope(name, afterName) {
    // Bounded parameter/type syntax. An unmatched or clipped body supplies no
    // enclosing-function hint instead of attributing later unrelated code.
    for (let i = afterName; i < Math.min(tokens.length, afterName + 128); i++) {
      if (tokens[i].value === '(') {
        const end = matching.get(i);
        if (end === undefined) return;
        i = end;
      } else if (tokens[i].value === '{') {
        addScope(name, i, matching.get(i));
        return;
      } else if (tokens[i].value === ';' || DECLARATIONS.has(tokens[i].value)) return;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!DECLARATIONS.has(token.value) || property(tokens, i)) continue;
    let next = i + 1;
    if (tokens[next]?.value === '*') next++;
    // Go receiver declarations: func (s *Service) SaveNote(...).
    if (token.value === 'func' && tokens[next]?.value === '(') next = (matching.get(next) ?? next) + 1;
    if (!isName(tokens[next])) continue;
    add(tokens[next], 0);
    if (FUNCTIONS.has(token.value)) functionScope(tokens[next].value, next + 1);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!BINDINGS.has(token.value) || property(tokens, i)) continue;
    const name = tokens[i + 1];
    if (name?.value === '{' || name?.value === '[') {
      const end = matching.get(i + 1);
      if (end !== undefined) for (let j = i + 2; j < end; j++) {
        if (tokens[j + 1]?.value !== ':' && !property(tokens, j)) add(tokens[j], 1);
      }
      continue;
    }
    if (!isName(name)) continue;
    let equal = i + 2;
    // Skip a short type annotation before a binding's initializer.
    if (tokens[equal]?.value === ':') {
      while (equal < Math.min(tokens.length, i + 24) && !['=', ';'].includes(tokens[equal].value)) equal++;
    }
    if (tokens[equal]?.value !== '=') { add(name, 1); continue; }
    let rhs = equal + 1;
    if (bareEnvironmentLookup(tokens, rhs, text)) continue;
    add(name, 1);
    if (tokens[rhs]?.value === 'async') rhs++;
    if (tokens[rhs]?.value === 'function') {
      add(name, 0);
      functionScope(name.value, rhs + 1);
    }
    let arrow = rhs;
    if (tokens[arrow]?.value === '(') arrow = (matching.get(arrow) ?? arrow) + 1;
    else if (isName(tokens[arrow])) arrow++;
    if (tokens[arrow]?.value === '=>') {
      add(name, 0);
      const body = arrow + 1;
      if (tokens[body]?.value === '{') addScope(name.value, body, matching.get(body));
      else {
        let end = body;
        while (end + 1 < tokens.length && tokens[end].value !== ';' &&
          !text.slice(tokens[end].end, tokens[end + 1].start).includes('\n')) end++;
        addScope(name.value, body, end);
      }
    }
    const constructor = tokens[rhs]?.value === 'new';
    const target = tokens[rhs + (constructor ? 1 : 0)];
    if (isName(target) && (constructor || tokens[rhs + 1]?.value === '(') && target.value !== name.value) {
      add(target, 3);
      if (constructions.length < PAIR_LIMIT) constructions.push({ source: name.value, target: target.value,
        rank: constructor ? 2 : 3, offset: name.start, kind: 'binding' });
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'import' || property(tokens, i) || tokens[i + 1]?.kind === 'literal') continue;
    // JS default/named/namespace imports and Python import lists. String module
    // paths are optional candidates and are deliberately omitted in this MVP.
    for (let j = i + 1; j < Math.min(tokens.length, i + 128); j++) {
      if (tokens[j].kind === 'literal' || [';', 'from', '='].includes(tokens[j].value) ||
          j > i + 1 && text.slice(tokens[j - 1].end, tokens[j].start).includes('\n') &&
          !['{', ','].includes(tokens[j - 1].value)) break;
      if (['type', 'as'].includes(tokens[j].value) || property(tokens, j)) continue;
      if (tokens[j + 1]?.value === 'as') { add(tokens[j + 2], 2); j += 2; }
      else add(tokens[j], 2);
    }
  }
  function pair(source, target, rank, offset, kind) {
    if (source === target || !entities.has(source) || !entities.has(target)) return;
    const key = JSON.stringify([source, target]), old = pairs.get(key);
    if (old && old.rank <= rank || !old && pairs.size >= PAIR_LIMIT) return;
    pairs.set(key, { source, target, rank, offset, kind });
  }
  const calls = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isName(token) || property(tokens, i) || BUILTINS.has(token.value)) continue;
    let next = i + 1, member = false;
    while (['.', '?.', '::'].includes(tokens[next]?.value) && isName(tokens[next + 1])) { member = true; next += 2; }
    const called = tokens[next]?.value === '(';
    if (member && called) add(token, 3);
    // Retain other-language/type-name fallback only outside literals and
    // property chains. Shouting constants are not inferred component names.
    if (!['as', ':'].includes(tokens[i + 1]?.value) &&
        /^[A-Z][A-Za-z0-9_$]*[a-z][A-Za-z0-9_$]*$/.test(token.value)) add(token, 4);
    if (called && !DECLARATIONS.has(tokens[i - 1]?.value) && calls.length < PAIR_LIMIT) {
      calls.push({ token, member });
    }
  }
  for (const { token, member } of calls) {
    // Innermost lexical function owns the selection hint. This asserts neither
    // an architectural relation nor execution; all relation kinds go to Jev.
    const scope = scopes.filter(s => s.start < token.start && token.end < s.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (scope) pair(scope.name, token.value, member ? 0 : 1, token.start, 'call');
  }
  for (const hint of constructions) pair(hint.source, hint.target, hint.rank, hint.offset, hint.kind);
  return {
    entities: [...entities.values()].sort((a, b) => a.rank - b.rank || a.start - b.start),
    pairs: [...pairs.values()].sort((a, b) => a.rank - b.rank || a.offset - b.offset),
  };
}
