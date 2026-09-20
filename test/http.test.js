import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server.js';
import { AdminAuth } from '../src/auth.js';
import { Gate } from '../src/scheduler.js';

async function setup(t, adapter = {}) {
  const config = { proxyApiKey: 'test-relay-key-123456', adminKey: 'test-admin-key-123456' };
  const auth = new AdminAuth(config);
  const admin = { auth, gate: new Gate(), log: { add() {} }, route(path, method, body, req, res) {
    if (path === '/admin/login') return auth.login(body.key, req, res);
    return { settings: {} };
  } };
  const server = createApiServer(config, adapter, admin);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, config };
}
test('health public, admin and relay separated, CSRF blocked', async t => {
  const { url, config } = await setup(t);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/admin/state`)).status, 401);
  assert.equal((await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${config.adminKey}` } })).status, 401);
  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: config.adminKey }) };
  assert.equal((await fetch(`${url}/admin/login`, { ...post, headers: { ...post.headers, Origin: 'https://evil.example' } })).status, 403);
  const res = await fetch(`${url}/admin/login`, post);
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/);
  assert.equal((await fetch(`${url}/admin/state`, { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
});
test('stream returns chunks and proper content type', async t => {
  const { url, config } = await setup(t, { async stream(_body, _signal, write) { await write('data: {"choices":[]}\n\n'); await write('data: [DONE]\n\n'); } });
  const res = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.proxyApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true }) });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/); assert.match(await res.text(), /\[DONE\]/);
});

test('downstream disconnect aborts the upstream signal', async t => {
  let aborted;
  const seenAbort = new Promise(resolve => { aborted = resolve; });
  const { url, config } = await setup(t, { async stream(_body, signal, write) {
    await write('data: {"choices":[]}\n\n');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted();
  } });
  const res = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.proxyApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true }) });
  const reader = res.body.getReader(); await reader.read(); await reader.cancel();
  await Promise.race([seenAbort, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not cancelled')), 2000).unref())]);
});

test('initial streaming error preserves HTTP status', async t => {
  const { HttpError } = await import('../src/errors.js');
  const { url, config } = await setup(t, { async stream() { throw new HttpError(400, 'unsupported'); } });
  const res = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.proxyApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true }) });
  assert.equal(res.status, 400); assert.equal((await res.json()).error.message, 'unsupported');
});
