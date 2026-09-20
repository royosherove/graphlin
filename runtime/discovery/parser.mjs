import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../core/common.mjs';

export const PARSER_PACKAGE = '@vscode/tree-sitter-wasm';
export const PARSER_VERSION = '0.3.1';
const require = createRequire(import.meta.url);
let runtime;
const languages = new Map();

// Resolve only the runtime's own dependency; never load project configuration,
// project-installed parsers, remote assets, or an executable from PATH.
async function loadRuntime() {
  if (!runtime) runtime = (async () => {
    const dependency = fileURLToPath(new URL('../../node_modules/@vscode/tree-sitter-wasm/', import.meta.url));
    const directory = path.join(dependency, 'wasm');
    const manifest = JSON.parse(await readFile(path.join(dependency, 'package.json'), 'utf8'));
    if (manifest.name !== PARSER_PACKAGE || manifest.version !== PARSER_VERSION) throw new Error('PARSER_VERSION');
    const api = require(path.join(directory, 'tree-sitter.js'));
    await api.Parser.init({ locateFile: name => path.join(directory, name) });
    return { api, directory };
  })();
  return runtime;
}

export async function loadParser(language) {
  if (!['javascript', 'typescript', 'tsx', 'python'].includes(language)) throw new Error('PARSER_LANGUAGE');
  if (!languages.has(language)) languages.set(language, (async () => {
    const { api, directory } = await loadRuntime();
    const bytes = await readFile(path.join(directory, `tree-sitter-${language}.wasm`));
    const grammar = await api.Language.load(bytes);
    return {
      Parser: api.Parser, grammar,
      version: `${PARSER_PACKAGE}@${PARSER_VERSION}/${language}/${hash(bytes)}`,
    };
  })());
  return languages.get(language);
}
