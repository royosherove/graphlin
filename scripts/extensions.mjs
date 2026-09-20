import path from 'node:path';
import { projectPaths, defaultDataDir } from '../runtime/daemon/paths.mjs';
import { createExtensionRegistry, extensionError } from '../runtime/extensions/index.mjs';

/** Parent CLI dispatches its already-parsed extension arguments here. This
 * module neither parses global CLI options nor starts/stops the daemon. */
export async function runExtensions(args, {
  projectRoot, dataDir = defaultDataDir(), signal, transport, output = process.stdout,
  registry: suppliedRegistry,
} = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw extensionError('invalid_extension_arguments');
  const [command = 'list', source, ...rest] = args;
  if (!['list', 'add', 'update', 'remove', 'doctor', 'dev'].includes(command) || rest.length ||
    (['add', 'update', 'remove', 'dev'].includes(command) ? !source : source !== undefined)) {
    throw extensionError('usage_extensions_list_add_update_remove_doctor_dev');
  }
  let registry = suppliedRegistry;
  if (!registry) {
    const paths = await projectPaths(projectRoot ?? process.cwd(), dataDir);
    registry = await createExtensionRegistry({ dataDir: paths.dataDir, projectId: paths.projectId, transport });
  }
  const resolveSource = value => value.startsWith('.') || path.isAbsolute(value)
    ? path.resolve(projectRoot ?? process.cwd(), value) : value;
  let result;
  if (command === 'list') result = await registry.list();
  if (command === 'doctor') result = await registry.doctor();
  if (command === 'remove') result = await registry.remove(source);
  if (command === 'add' || command === 'update') result = await registry.install(resolveSource(source), { signal });
  if (command === 'dev') {
    if (!(source.startsWith('.') || path.isAbsolute(source))) throw extensionError('development_directory_required');
    result = await registry.dev(resolveSource(source), { signal });
  }
  if (output) {
    if (Array.isArray(result)) output.write(result.length ? result.map(row =>
      `${row.id} ${row.version} ${row.digest.slice(0, 12)}${row.development ? ' development' : ''} ${row.grant ? 'granted' : 'approval required'}`
    ).join('\n') + '\n' : 'No visualizer extensions installed.\n');
    else if (command === 'doctor') output.write(`${result.ok ? 'Extension checks passed.' : 'Extension checks failed.'}\n${
      result.results.map(row => `${row.id ?? 'catalogue'}: ${row.code}`).join('\n')}${result.results.length ? '\n' : ''}`);
    else output.write(command === 'remove' ? `Removed ${result.id} and its grants.\n` :
      `Installed ${result.id} ${result.version}${result.development ? ' (development snapshot)' : ''}. ${
        result.grant ? 'Existing digest approval retained.' : 'Project approval is required before data delivery.'}\n`);
  }
  return result;
}
