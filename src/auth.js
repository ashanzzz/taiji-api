import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

export class AdminAuth {
  constructor(config) { this.config = config; this.sessions = new Map(); this.attempts = new Map(); }
  login(key, request, response) {
    const now = Date.now();
    for (const [id, expires] of this.sessions) if (expires < now) this.sessions.delete(id);
    for (const [ip, state] of this.attempts) if (state.until < now) this.attempts.delete(ip);
    const ip = request.socket.remoteAddress;
    const state = this.attempts.get(ip) || { count: 0, until: now + 600000 };
    if (state.count >= 10) throw new HttpError(429, 'Too many login attempts. Wait 10 minutes.');
    state.count++;
    this.attempts.set(ip, state);
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value);
    if (!equal(key, this.config.adminKey)) throw new HttpError(401, 'Invalid admin key');
    this.attempts.delete(ip);
    const id = randomBytes(32).toString('base64url');
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(id, now + 8 * 3600000);
    response.setHeader('Set-Cookie', this.cookie(id, 28800));
    return { ok: true };
  }
  require(request) {
    const token = cookieToken(request);
    if ((this.sessions.get(token) || 0) < Date.now()) { this.sessions.delete(token); throw new HttpError(401, 'Admin login required'); }
  }
  logout(request, response) { this.sessions.delete(cookieToken(request)); response.setHeader('Set-Cookie', this.cookie('', 0)); return { ok: true }; }
  cookie(value, age) { return `taiji_admin=${value}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${age}${this.config.secureCookies ? '; Secure' : ''}`; }
}

export function authorizeRelay(request, config) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !equal(header.slice(7), config.proxyApiKey)) throw new HttpError(401, 'Invalid API key');
}
export function checkOrigin(request) {
  const origin = request.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Invalid Origin'); }
    if (host !== request.headers.host) throw new HttpError(403, 'Cross-origin admin requests are not allowed');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed');
}
function cookieToken(request) { return /(?:^|;\s*)taiji_admin=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || '')?.[1] || ''; }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
