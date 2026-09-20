// This entry point has no output, no persistence, no daemon startup, and no
// remote transport. An outer guarded launcher also covers import/runtime errors.
import { collect, readHook } from '../runtime/collector/index.mjs';
const deadline = setTimeout(() => process.exit(0), 350);
try {
  if (Number(process.versions.node.split('.')[0]) >= 22) {
    const payload = await readHook();
    if (payload) await collect(payload, { host: process.argv[2] || 'claude' });
  }
} catch { /* Passive hooks always fail open. */ }
finally { clearTimeout(deadline); process.exit(0); }
