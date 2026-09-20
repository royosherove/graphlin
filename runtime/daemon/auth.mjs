import { randomBytes, createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

export function createAuth({ origin, instanceId, now = Date.now }) {
  const tokens = new Map(), sessions = new Map();
  const cookieName = `graphlin_${instanceId.replaceAll('-', '').slice(0, 16)}`;
  function prune(map) {
    for (const [key, expires] of map) if (expires <= now()) map.delete(key);
    while (map.size >= 16) map.delete(map.keys().next().value);
  }
  return {
    cookieName,
    validRequest(req, { mutation = false } = {}) {
      const hosts = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host');
      if (hosts.length !== 1 || req.headers.host !== new URL(origin).host) return false;
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
      if (mutation) return req.headers.origin === origin;
      return req.headers.origin === undefined || req.headers.origin === origin;
    },
    launchToken() {
      prune(tokens);
      const token = secret(); tokens.set(digest(token), now() + 60_000);
      return token;
    },
    exchange(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const key = digest(token), expires = tokens.get(key);
      tokens.delete(key);
      if (!expires || expires <= now()) return null;
      prune(sessions);
      const session = secret(); sessions.set(digest(session), now() + 8 * 60 * 60 * 1000);
      return `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
    },
    authorized(req) {
      const raw = req.headers.cookie;
      if (typeof raw !== 'string' || raw.length > 8192) return false;
      const values = raw.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
      if (values.length !== 1) return false;
      const token = values[0].slice(cookieName.length + 1);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const key = digest(token), expires = sessions.get(key);
      if (!expires || expires <= now()) { sessions.delete(key); return false; }
      return true;
    },
    clear() { tokens.clear(); sessions.clear(); },
  };
}
