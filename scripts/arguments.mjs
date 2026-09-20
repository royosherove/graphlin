export function parseArguments(args, { worker = false } = {}) {
  const values = { projectRoot: process.cwd(), allowSource: false, persistEvidence: false, displayEvidence: true,
    background: false };
  const command = worker ? null : args.shift();
  const strings = new Map([['--project', 'projectRoot'], ['--data-dir', 'dataDir']]);
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
    } else if (argument === '--allow-source') values.allowSource = true;
    else if (argument === '--persist-evidence') values.persistEvidence = true;
    else if (argument === '--no-display-evidence') values.displayEvidence = false;
    else if (argument === '--background' && !worker && ['start', 'demo'].includes(command)) values.background = true;
    else throw new Error('unknown_argument');
  }
  return { command, ...values };
}
