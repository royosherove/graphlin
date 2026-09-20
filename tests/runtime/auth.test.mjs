import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../../runtime/daemon/auth.mjs';
const ORIGIN = 'http://127.0.0.1:12345';
const request = (headers = {}) => ({ rawHeaders: ['Host', '127.0.0.1:12345'],
  headers: { host: '127.0.0.1:12345', ...headers }, socket: { remoteAddress: '127.0.0.1' } });

test('launch tokens are one-use and expire; cookies are HttpOnly, SameSite, daemon scoped', () => {
  let now = 0;
  const auth = createAuth({ origin: ORIGIN, instanceId: 'one', now: () => now });
  const token = auth.launchToken(), cookie = auth.exchange(token);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\//);
  assert.equal(auth.exchange(token), null);
  assert.equal(auth.authorized(request({ cookie: cookie.split(';')[0] })), true);
  assert.equal(auth.authorized(request({ cookie: `${cookie.split(';')[0]}; ${cookie.split(';')[0]}` })), false);
  const next = auth.launchToken(); now = 60_001; assert.equal(auth.exchange(next), null);
  now = 9 * 3600_000; assert.equal(auth.authorized(request({ cookie: cookie.split(';')[0] })), false);
  assert.notEqual(auth.cookieName, createAuth({ origin: ORIGIN, instanceId: 'two' }).cookieName);
});

test('Host, Origin, source address, and browser fetch context are checked independently', () => {
  const auth = createAuth({ origin: ORIGIN, instanceId: 'one' });
  assert.equal(auth.validRequest(request()), true);
  assert.equal(auth.validRequest(request(), { mutation: true }), false);
  assert.equal(auth.validRequest(request({ origin: ORIGIN }), { mutation: true }), true);
  for (const headers of [{ host: 'evil.example' }, { host: 'localhost:12345' },
    { origin: 'null' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal(auth.validRequest(request(headers)), false);
  }
  const duplicate = request(); duplicate.rawHeaders.push('Host', '127.0.0.1:12345');
  assert.equal(auth.validRequest(duplicate), false);
  const remote = request(); remote.socket.remoteAddress = '192.0.2.1';
  assert.equal(auth.validRequest(remote), false);
});
