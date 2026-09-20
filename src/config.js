import { randomBytes } from 'node:crypto';
import { HttpError } from './errors.js';

export function loadConfig(env = process.env) {
  if (!env.PROXY_API_KEY || env.PROXY_API_KEY.length < 16) throw new Error('PROXY_API_KEY requires at least 16 characters');
  return {
    port: Number(env.PORT || 3000), host: env.HOST || '0.0.0.0',
    proxyApiKey: env.PROXY_API_KEY, adminKey: env.ADMIN_KEY || '',
    dataDir: env.DATA_DIR || './data', secureCookies: env.SECURE_COOKIES === 'true',
    account: env.TAIJI_ACCOUNT || '', password: env.TAIJI_PASSWORD || '',
    publicUrl: env.TAIJI_PUBLIC_URL || 'https://www.taijiai666.com/',
    fixedOrigin: env.TAIJI_ORIGIN || '', defaultModel: env.DEFAULT_MODEL || '',
    appVersion: env.TAIJI_APP_VERSION || '3.4.0', modelCacheTtlMs: 300_000,
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS || 180000), deleteTempSessions: true,
    trustedHosts: ['www.taijiai666.com', 'taijiai666.com', 'ai.txg2024.xyz'],
    schedule: { enabled: false, startHour: 9, endHour: 20, timeZone: 'Asia/Shanghai' },
  };
}

export class Settings {
  constructor(config, store) {
    this.store = store;
    const saved = store.read('settings', null);
    this.config = { ...config, ...(saved || {}) };
    if (saved) this.config.password = store.decrypt(saved.passwordEncrypted);
    delete this.config.passwordEncrypted;
    if (!config.adminKey) {
      const auth = store.read('auth', null) || { key: randomBytes(32).toString('base64url') };
      store.write('auth', auth);
      this.config.adminKey = auth.key;
    }
    // Deployment secrets cannot be replaced by the saved settings file.
    this.config.proxyApiKey = config.proxyApiKey;
    if (config.adminKey) this.config.adminKey = config.adminKey;
  }

  public() {
    const c = this.config;
    return Object.fromEntries([...FIELDS.map(key => [key, c[key]]), ['hasPassword', Boolean(c.password)]]);
  }

  update(body) {
    const next = { ...this.config };
    for (const key of FIELDS) if (body[key] !== undefined) next[key] = body[key];
    if (body.password) next.password = body.password;
    validate(next);
    const addedHost = next.trustedHosts.some(host => !this.config.trustedHosts.includes(host));
    if (addedHost && !body.password) throw new HttpError(400, 'Re-enter the upstream password when approving a new trusted host. Saved credentials are not forwarded to new destinations.');
    const saved = Object.fromEntries(FIELDS.map(key => [key, next[key]]));
    saved.passwordEncrypted = this.store.encrypt(next.password || '');
    this.store.write('settings', saved);
    Object.assign(this.config, next);
    return this.public();
  }
}

const FIELDS = ['account', 'publicUrl', 'fixedOrigin', 'defaultModel', 'appVersion',
  'requestTimeoutMs', 'deleteTempSessions', 'trustedHosts', 'schedule'];

function validate(c) {
  for (const key of ['account', 'defaultModel', 'appVersion']) {
    if (typeof c[key] !== 'string' || c[key].length > 300) throw new HttpError(400, `Invalid ${key}`);
  }
  for (const key of ['publicUrl', 'fixedOrigin']) {
    if (key === 'fixedOrigin' && !c[key]) continue;
    let url;
    try { url = new URL(c[key]); } catch { throw new HttpError(400, `Invalid ${key}`); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      throw new HttpError(400, 'Upstream requires HTTPS on port 443 without URL credentials');
    }
    if (url.search || url.hash || (key === 'fixedOrigin' && url.pathname !== '/')) throw new HttpError(400, `Invalid ${key} path`);
  }
  if (typeof c.password !== 'string' || c.password.length > 500) throw new HttpError(400, 'Invalid password');
  if (!Array.isArray(c.trustedHosts) || c.trustedHosts.length > 20 || c.trustedHosts.some(h => typeof h !== 'string' || !/^[a-z0-9.-]+$/i.test(h))) {
    throw new HttpError(400, 'trustedHosts must be a list of hostnames');
  }
  if (!Number.isInteger(c.requestTimeoutMs) || c.requestTimeoutMs < 10000 || c.requestTimeoutMs > 600000) throw new HttpError(400, 'Timeout must be 10000–600000 ms');
  if (typeof c.deleteTempSessions !== 'boolean') throw new HttpError(400, 'Invalid cleanup setting');
  const s = c.schedule;
  if (!s || typeof s.enabled !== 'boolean' || s.timeZone !== 'Asia/Shanghai' || !Number.isInteger(s.startHour) || !Number.isInteger(s.endHour) || s.startHour < 0 || s.endHour > 24 || s.endHour <= s.startHour) {
    throw new HttpError(400, 'Use an Asia/Shanghai schedule with 0 <= startHour < endHour <= 24');
  }
}
