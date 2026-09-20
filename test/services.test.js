import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, AuditLog } from '../src/store.js';
import { loadConfig, Settings } from '../src/config.js';
import { publicAddress, discoverOrigin } from '../src/network.js';
import { Gate, SignScheduler, nextSignTime } from '../src/scheduler.js';
import { contextSample, ProbeRunner, conclusion } from '../src/probes.js';

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'taiji-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true })); return new Store(path);
}
function config() { return loadConfig({ PROXY_API_KEY: 'a-strong-test-api-key' }); }
test('settings encrypt password and never return it', t => {
  const store = temporary(t), settings = new Settings(config(), store);
  settings.update({ account: 'test@example.com', password: 'secret123' });
  assert.equal(settings.public().password, undefined);
  assert.equal(settings.public().hasPassword, true);
  assert.doesNotMatch(readFileSync(join(store.directory, 'settings.json'), 'utf8'), /secret123/);
  assert.equal(new Settings(config(), store).config.password, 'secret123');
  settings.update({ password: '' }); assert.equal(settings.config.password, 'secret123');
});
test('settings validate URL and scheduler bounds', t => {
  const settings = new Settings(config(), temporary(t));
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com:8443']) assert.throws(() => settings.update({ publicUrl: url }));
  assert.throws(() => settings.update({ schedule: { enabled: true, startHour: 20, endHour: 9, timeZone: 'Asia/Shanghai' } }));
});
test('private network origins are blocked', () => {
  for (const ip of ['127.0.0.1', '192.168.8.11', '10.1.2.3', '172.16.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('1.1.1.1'), true);
});
test('discovery follows redirects and dd without eval', async () => {
  const dd = `12345${Buffer.from('new.example.com').toString('base64')}67890`;
  const pages = [new Response('', { status: 302, headers: { location: 'https://landing.example.com/' } }), new Response(`<script>window.aiSiteInfo={"dd":"${dd}"}</script>`), new Response('<title>ready</title>')];
  const urls = [];
  const origin = await discoverOrigin({ publicUrl: 'https://entry.example.com' }, async url => { urls.push(url); return pages.shift(); });
  assert.equal(origin, 'https://new.example.com'); assert.equal(urls.length, 3);
});
test('scheduler random window persists and prevents duplicate POST', async t => {
  const store = temporary(t), now = Date.parse('2026-09-20T12:00:00+08:00');
  const cfg = { schedule: { enabled: true, startHour: 9, endHour: 20 } };
  let posts = 0;
  const client = { async requestJson(_path, opts) { if (opts?.method === 'POST') { posts++; return { integral: 1 }; } return []; } };
  const scheduler = new SignScheduler(client, cfg, store, new AuditLog(store), new Gate(), () => now);
  scheduler.plan();
  assert.ok(Date.parse(scheduler.state.nextAt) > now);
  assert.ok(Date.parse(scheduler.state.nextAt) < Date.parse('2026-09-20T20:00:00+08:00'));
  await scheduler.sign(); await scheduler.sign(); assert.equal(posts, 1);
  const restarted = new SignScheduler(client, cfg, store, new AuditLog(store), new Gate(), () => now);
  await restarted.sign(); assert.equal(posts, 1);
});
test('unknown sign-in result is not retried automatically', async t => {
  const store = temporary(t); let calls = 0;
  const client = { requestJson: async (_path, opts) => { if (opts?.method !== 'POST') return []; calls++; throw new Error('offline'); } };
  const s = new SignScheduler(client, { schedule: { enabled: false } }, store, new AuditLog(store), new Gate());
  await s.sign(); await s.sign(); assert.equal(calls, 1); assert.equal(s.state.lastResult.status, 'failed_or_unknown');
});
test('daily window rolls to tomorrow when missed', () => {
  const next = nextSignTime(Date.parse('2026-09-20T21:00:00+08:00'), { startHour: 9, endHour: 20 }, null, start => start);
  assert.equal(next, '2026-09-21T01:00:00.000Z');
});
test('context probes have exact character budgets and three random markers', () => {
  const a = contextSample(4000), b = contextSample(4000);
  assert.equal(a.text.length, 4000); assert.equal(a.markers.length, 3); assert.notDeepEqual(a.markers, b.markers);
  assert.match(conclusion({ kind: 'context', results: [{ status: 'passed', inputChars: 4000 }] }), /不是 token/);
});
test('test runner rejects excess budgets and isolates test jobs', t => {
  const store = temporary(t), gate = new Gate();
  const runner = new ProbeRunner({}, store, new AuditLog(store), gate);
  assert.throws(() => runner.start({ kind: 'context', model: 'demo', maxRequests: 100 }));
  assert.throws(() => runner.start({ kind: 'context', model: 'demo', steps: [1000000] }));
});

test('atomic rename retries transient sync-client locks but fails permanent errors', async () => {
  const { renameWithRetry } = await import('../src/store.js');
  let calls = 0;
  renameWithRetry('source', 'target', () => { if (++calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' }); }, () => {});
  assert.equal(calls, 3);
  assert.throws(() => renameWithRetry('source', 'target', () => { throw Object.assign(new Error('bad'), { code: 'ENOENT' }); }, () => {}));
});

test('new trusted host requires fresh credentials', t => {
  const settings = new Settings(config(), temporary(t));
  settings.update({ password: 'dummy' });
  assert.throws(() => settings.update({ trustedHosts: ['evil.example'] }), /Re-enter/);
  assert.ok(!settings.config.trustedHosts.includes('evil.example'));
});
test('failed initial job persistence releases gate', () => {
  let calls = 0;
  const store = { read: () => [], write: () => { if (++calls > 1) throw new Error('disk full'); } };
  const gate = new Gate(), runner = new ProbeRunner({}, store, { add() {} }, gate);
  assert.throws(() => runner.start({ kind: 'context', model: 'demo', maxRequests: 1 }));
  assert.equal(gate.active, 0); assert.equal(gate.exclusive, false); assert.equal(runner.controller, null);
});
test('cancelled last probe is not marked completed', async t => {
  const store = temporary(t), gate = new Gate();
  const runner = new ProbeRunner({ resolveModel: async () => ({}) }, store, new AuditLog(store), gate);
  runner.sample = async (_model, _item, signal) => {
    runner.controller.abort();
    return { status: signal.aborted ? 'cancelled' : 'passed' };
  };
  const job = runner.start({ kind: 'context', model: 'demo', maxRequests: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(job.status, 'cancelled'); assert.equal(gate.active, 0);
});
test('failed sign-in preflight is manually retryable', async t => {
  const store = temporary(t); let calls = 0;
  const client = { requestJson: async () => { calls++; throw new Error('offline'); } };
  const scheduler = new SignScheduler(client, { schedule: { enabled: false } }, store, new AuditLog(store), new Gate());
  await scheduler.sign(); await scheduler.sign();
  assert.equal(calls, 2); assert.equal(scheduler.state.lastDay, null); assert.equal(scheduler.state.lastResult.status, 'preflight_failed');
});
