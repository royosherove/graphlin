export function parseArguments(args, { worker = false } = {}) {
  const guided = !worker && (!args.length || args[0].startsWith('-'));
  args = [...args];
  const values = { projectRoot: process.cwd(), allowSource: worker ? false : undefined,
    persistEvidence: worker ? false : undefined, displayEvidence: worker ? true : undefined, background: false };
  const command = worker ? null : args[0] && !args[0].startsWith('-') ? args.shift() : 'start';
  const strings = new Map([['--project', 'projectRoot'], ['--data-dir', 'dataDir']]);
  if (!worker && (command === 'init' || command === 'uninstall' || guided)) strings.set('--host', 'host');
  if (!worker && command === 'logs') strings.set('--file', 'file');
  if (worker) strings.set('--mode', 'mode');
  const seen = new Set();
  while (args.length) {
    const argument = args.shift();
    if (seen.has(argument)) throw new Error('duplicate_argument');
    seen.add(argument);
    if (strings.has(argument)) {
      const value = args.shift();
      if (!value || value.startsWith('--') || value.length > 4096) throw new Error('invalid_argument');
      values[strings.get(argument)] = value;
    } else if (argument === '--port') {
      const value = args.shift();
      if (!/^\d{1,5}$/.test(value ?? '') || Number(value) > 65535) throw new Error('invalid_port');
      values.port = Number(value);
    } else if (argument === '--local-source') {
      if (seen.has('--allow-source') || seen.has('--no-source')) throw new Error('conflicting_arguments');
      values.allowSource = false;
      values.localSource = true;
    } else if (argument === '--allow-source' || argument === '--no-source' && !worker) {
      if (seen.has('--local-source') || seen.has(argument === '--allow-source' ? '--no-source' : '--allow-source')) throw new Error('conflicting_arguments');
      values.allowSource = argument === '--allow-source';
    }
    else if (argument === '--persist-evidence') values.persistEvidence = true;
    else if (argument === '--no-display-evidence') values.displayEvidence = false;
    else if (argument === '--background' && !worker && ['start', 'demo'].includes(command)) values.background = true;
    else if (argument === '--no-open' && !worker && ['start', 'demo', 'open'].includes(command)) values.openBrowser = false;
    else if (argument === '--replace-key' && !worker && command === 'init') values.replaceKey = true;
    else throw new Error('unknown_argument');
  }
  if (values.host !== undefined && !['claude', 'codex', 'both'].includes(values.host)) throw new Error('invalid_host');
  return { command, ...(!worker ? { guided: Boolean(guided) } : {}), ...values };
}
