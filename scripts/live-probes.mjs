import { readFileSync } from 'node:fs';
const base = process.env.TEST_BASE || 'http://127.0.0.1:3108';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const key = process.env.ADMIN_KEY || JSON.parse(readFileSync('data/auth.json', 'utf8')).key;
const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
if (!login.ok) throw new Error('Admin login failed');
const cookie = login.headers.get('set-cookie').split(';')[0];
async function api(path, body) {
  const res = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error?.message || `HTTP ${res.status}`);
  return value;
}
for (const options of [
  { kind: 'reasoning', maxRequests: 6 },
  { kind: 'context', maxRequests: 3, steps: [4000, 12000, 24000] },
  { kind: 'output', maxRequests: 2, maxOutputTokens: 128 },
]) {
  const job = await api('/admin/tests', { model: 'openai::gpt-6-astra', ...options });
  console.log(`Started ${job.kind} ${job.id}`);
  let current;
  do {
    await new Promise(resolve => setTimeout(resolve, 3000));
    current = (await api('/admin/tests')).tests.find(t => t.id === job.id);
  } while (current.status === 'running');
  console.log(JSON.stringify(current, null, 2));
}
