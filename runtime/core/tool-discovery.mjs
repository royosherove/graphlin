import path from 'node:path';
import { LIMITS, plain } from './common.mjs';

const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_OUTPUT_LINES = 256;

const pathValue = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);

function filePath(value) {
  if (!plain(value)) return value;
  return value.filePath ?? value.file_path ?? value.path ?? value.filename ??
    (typeof value.file === 'string' ? value.file : undefined);
}

// This recognizes a small command grammar; it never executes or expands shell
// text. A plain grep exclusion only removes listing lines. Other compound
// commands and output transformations are intentionally omitted.
function listingCommand(command) {
  if (typeof command !== 'string' || command.length > 8192) return null;
  const filter = /\s*\|\s*(?:(?:\/usr)?\/bin\/)?grep\s+-v\s+(?:"[A-Za-z0-9_./][A-Za-z0-9_./-]*"|'[A-Za-z0-9_./][A-Za-z0-9_./-]*'|[A-Za-z0-9_./][A-Za-z0-9_./-]*)\s*$/.exec(command);
  if (filter) command = command.slice(0, filter.index);
  if (/[\u0000-\u001f\u007f`$\\;&|<>#]/.test(command)) return null;
  command = command.trim();
  const word = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/y;
  const words = [];
  let offset = 0;
  while (offset < command.length && words.length < 128) {
    word.lastIndex = offset;
    const match = word.exec(command);
    if (!match) return null;
    words.push(match[1] ?? match[2] ?? match[3]);
    offset = word.lastIndex;
  }
  if (offset !== command.length) return null;
  const program = /^(?:(?:\/usr)?\/bin\/|\/opt\/homebrew\/bin\/)?(ls|find|rg)$/.exec(words.shift() ?? '')?.[1];
  if (!program) return null;

  if (program === 'ls') {
    const operands = [];
    let options = true;
    for (const value of words) {
      if (options && value === '--') { options = false; continue; }
      if (options && value.startsWith('-')) {
        if (!/^-[1aAF]+$/.test(value) && value !== '--color=never') return null;
      } else {
        if (!value || /[*?[\]{}]/.test(value)) return null;
        operands.push(value);
      }
    }
    // Multiple directory listings have headings and ambiguous relative names.
    if (operands.length > 1) return null;
    const operand = operands[0] ?? '.';
    return { prefix: operand, operand };
  }

  if (program === 'find') {
    let predicates = false;
    for (let index = 0; index < words.length; index++) {
      const value = words[index];
      if (!predicates && value && !value.startsWith('-')) continue;
      predicates = true;
      if (['-print', '-prune', '-o', '-or', '-a', '-and', '-not', '!'].includes(value)) continue;
      if (['-type', '-name', '-iname', '-path', '-ipath', '-maxdepth', '-mindepth'].includes(value) &&
          typeof words[index + 1] === 'string' && words[index + 1].length > 0) { index++; continue; }
      return null;
    }
    return { prefix: '.' };
  }

  if (!words.includes('--files')) return null;
  for (let index = 0; index < words.length; index++) {
    const value = words[index];
    if (!value.startsWith('-') || [
      '--files', '--hidden', '--no-ignore', '--no-ignore-vcs', '--follow',
      '-L', '-u', '-uu', '-uuu', '--color=never', '--sort=path',
    ].includes(value)) continue;
    if (['-g', '--glob', '-t', '--type', '-T', '--type-not'].includes(value) &&
        typeof words[index + 1] === 'string' && words[index + 1].length > 0) { index++; continue; }
    if (/^(?:--glob|--type|--type-not)=.+$/.test(value)) continue;
    return null;
  }
  return { prefix: '.' };
}

function looksLikeFile(value) {
  // Whitespace, control sequences, URLs, source lines and prose are not file
  // listings. Paths with spaces remain supported by structured result fields.
  return pathValue(value) && /^[\p{L}\p{N}_./@+,[\]-]+$/u.test(value) &&
    /(?:^|\/)(?:[^/]+\.[\p{L}\p{N}_-]{1,16}|Dockerfile|Containerfile|Makefile|Procfile|Gemfile|Rakefile)$/u.test(value);
}

// A deliberately small, read-only shell grammar. No expansion, command
// substitution, pipelines, redirection, or source output is interpreted.
function readCommandPaths(command) {
  if (typeof command !== 'string' || command.length > 8192 ||
      /[\u0000-\u001f\u007f`$\\;&|<>#]/.test(command)) return [];
  command = command.trim();
  const word = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/y;
  const words = [];
  let offset = 0;
  while (offset < command.length && words.length < 128) {
    word.lastIndex = offset;
    const match = word.exec(command);
    if (!match) return [];
    words.push(match[1] ?? match[2] ?? match[3]);
    offset = word.lastIndex;
  }
  if (offset !== command.length) return [];
  const program = /^(?:(?:\/usr)?\/bin\/|\/opt\/homebrew\/bin\/)?(cat|head|tail|sed)$/.exec(words.shift() ?? '')?.[1];
  if (!program) return [];
  if (program === 'sed') {
    if (words.shift() !== '-n' || !/^\d+(?:,\d+)?p$/.test(words.shift() ?? '')) return [];
  }
  const paths = [];
  let options = true;
  for (let index = 0; index < words.length; index++) {
    const value = words[index];
    if (options && value === '--') { options = false; continue; }
    if (options && value.startsWith('-')) {
      if (program === 'cat' && /^-[benstuvAE]+$/.test(value)) continue;
      if (['head', 'tail'].includes(program)) {
        if (/^-(?:[nc]?\d+|[qv])$/.test(value)) continue;
        if (['-n', '-c'].includes(value) && /^\d+$/.test(words[index + 1] ?? '')) { index++; continue; }
      }
      return [];
    }
    if (!pathValue(value) || value === '-' || /[*?[\]{}~]/.test(value)) return [];
    paths.push(value);
  }
  return paths.slice(0, LIMITS.paths);
}

export function toolActivityTargets({ toolCategory, input = {} } = {}) {
  if (toolCategory === 'shell') {
    const paths = readCommandPaths(input.command ?? input.cmd);
    return paths.length ? { operation: 'read', paths } : { paths: [] };
  }
  const operation = toolCategory === 'read' ? 'read'
    : ['write', 'edit'].includes(toolCategory) ? 'edit' : null;
  if (!operation) return { paths: [] };
  const paths = new Set();
  const add = value => { if (paths.size < LIMITS.paths && pathValue(value)) paths.add(value); };
  for (const value of [input.file_path, input.filePath, input.path, input.filename]) add(value);
  for (const key of ['paths', 'files']) {
    for (const value of Array.isArray(input[key]) ? input[key].slice(0, LIMITS.paths) : []) add(filePath(value));
  }
  // Kiro's fs_read/fs_write tool_input nests targets in an operations[] array,
  // each carrying a path (docs: features/hooks). Other hosts omit it.
  for (const value of Array.isArray(input.operations) ? input.operations.slice(0, LIMITS.paths) : []) add(filePath(value));
  if (toolCategory === 'edit') {
    const patch = input.patch ?? input.input;
    if (typeof patch === 'string' && patch.length <= LIMITS.rawChars) {
      for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): ([^\r\n]+)$/gm)) add(match[1]);
    }
  }
  const ranges = [];
  if (operation === 'read' && paths.size === 1) {
    const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
    const start = input.start_line ?? input.startLine ?? input.line_start ?? input.offset;
    const explicitEnd = input.end_line ?? input.endLine ?? input.line_end;
    const end = explicitEnd ?? (positive(start) && positive(input.limit) ? start + input.limit - 1 : null);
    if (positive(start) && positive(end) && end >= start) {
      ranges.push({ path: [...paths][0], startLine: start, endLine: end });
    }
  }
  return { operation, paths: [...paths], ranges };
}

export function toolResultPaths(result, { toolCategory, input = {} } = {}) {
  if (!plain(result) || result.interrupted === true || result.isImage === true) return [];
  const paths = new Set();
  const add = value => { if (paths.size < LIMITS.paths && pathValue(value)) paths.add(value); };
  for (const value of [result.filePath, result.file_path, result.path]) add(value);
  if (plain(result.file)) add(filePath(result.file));
  for (const key of ['paths', 'files', 'changed_files', 'filenames']) {
    if (Array.isArray(result[key])) {
      for (const value of result[key].slice(0, LIMITS.paths)) add(filePath(value));
    }
  }
  if (toolCategory === 'search' && Array.isArray(result.matches)) {
    for (const match of result.matches.slice(0, LIMITS.paths)) if (plain(match)) add(filePath(match));
  }
  if (toolCategory !== 'shell' || typeof result.stdout !== 'string') return [...paths];
  const command = listingCommand(input.command ?? input.cmd);
  if (!command) return [...paths];
  let output = result.stdout.slice(0, MAX_OUTPUT_CHARS);
  // Never turn a truncated fragment into a filename.
  if (result.stdout.length > MAX_OUTPUT_CHARS) output = output.slice(0, output.lastIndexOf('\n') + 1);
  for (const line of output.split('\n', MAX_OUTPUT_LINES)) {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (paths.size >= LIMITS.paths) break;
    // ls echoes an explicit file operand. Other returned names are children of
    // its directory operand, including directories whose names contain dots.
    if (looksLikeFile(value)) add(value === command.operand || command.prefix === '.' || path.isAbsolute(value)
      ? value : path.join(command.prefix, value));
  }
  return [...paths];
}
