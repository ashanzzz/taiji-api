import { abortable } from './cancellation.js';
import { HttpError } from './errors.js';
import { safeFetch, discoverOrigin } from './network.js';
import { parseSse } from './sse.js';
export { parseSse } from './sse.js';

export class TaijiClient {
  constructor(config, fetchImpl = safeFetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.reset();
  }

  reset() {
    this.revision = (this.revision || 0) + 1;
    this.origin = this.config.fixedOrigin || null;
    this.originAt = this.origin ? Date.now() : 0;
    this.token = null;
    this.loginPromise = null;
    this.discoveryPromise = null;
    this.modelCache = null;
  }

  async getModels(signal) {
    const revision = this.revision;
    if (this.modelCache?.expiresAt > Date.now()) return this.modelCache.value;
    const template = await abortable(this.requestJson('/chat/tmpl', { signal }), signal);
    const value = { defaultModel: this.config.defaultModel || template.defModel, models: template.models || [] };
    if (revision !== this.revision) throw new HttpError(409, 'Settings changed during model discovery');
    this.modelCache = { value, expiresAt: Date.now() + this.config.modelCacheTtlMs };
    return value;
  }

  async resolveModel(requested, signal) {
    const catalog = await this.getModels(signal);
    const id = requested || catalog.defaultModel;
    const exact = catalog.models.find(m => m.value === id);
    if (exact) return exact;
    const matches = catalog.models.filter(m => m.value.split('::').at(-1) === id);
    if (matches.length === 1) return matches[0];
    throw new HttpError(400, `Unsupported or ambiguous model: ${id}`);
  }

  createSession(model, signal) {
    this.pendingCreations = (this.pendingCreations || 0) + 1;
    return this.requestJson('/chat/session', { method: 'POST', body: { model: model.value }, signal: signal || AbortSignal.timeout(30000) })
      .finally(() => { this.pendingCreations--; });
  }

  deleteSession(id) { return this.requestJson(`/chat/session/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) }); }

  async *chat(payload, signal) {
    let response = await this.openChatStream(payload, signal);
    if (response.authExpired) {
      this.token = null;
      throw new HttpError(401, 'Upstream login expired. Generation was not replayed.');
    }
    let done = false, received = false;
    for await (const event of parseSse(response.body)) {
      if (!event.data) continue;
      if (event.data === '[DONE]') { done = true; break; }
      let parsed;
      try { parsed = JSON.parse(event.data); } catch { throw new HttpError(502, 'Malformed upstream SSE data'); }
      if (parsed.code !== 0) throw new HttpError(502, safeMessage(parsed.err || parsed.msg), { code: parsed.code });
      if (typeof parsed.data === 'string') { received = true; yield { kind: 'delta', text: parsed.data }; }
      else if (parsed.data && typeof parsed.data === 'object') yield { kind: 'meta', data: parsed.data };
    }
    if (!done) throw new HttpError(502, 'Upstream stream ended without [DONE]');
    if (!received) throw new HttpError(502, 'Upstream returned no text');
  }

  async requestJson(path, options = {}, authRetry = true) {
    const revision = this.revision;
    const { method = 'GET', body, auth = true, signal } = options;
    const origin = await this.getOrigin();
    if (auth) await abortable(this.ensureLogin(), signal);
    signal?.throwIfAborted();
    if (revision !== this.revision) throw new HttpError(409, 'Settings changed during request');
    let response;
    try {
      response = await this.fetch(`${origin}/api${path}`, {
        method, headers: this.headers(auth, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combine(signal, this.config.requestTimeoutMs),
      });
    } catch (error) {
      if (!this.config.fixedOrigin) this.originAt = 0;
      if (signal?.aborted) throw error;
      // A failed POST may already have been processed. Never replay it automatically.
      throw new HttpError(502, 'Upstream network error. Request was not replayed.');
    }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `Upstream HTTP ${response.status}`); }
    let result;
    try { result = await response.json(); } catch { throw new HttpError(502, 'Upstream returned invalid JSON'); }
    if (result.code === 2 && auth) {
      this.token = null;
      if (authRetry && method === 'GET') return this.requestJson(path, options, false);
    }
    if (result.code !== 0) throw new HttpError(result.code === 2 ? 401 : 502, safeMessage(result.msg), { code: result.code });
    return result.data;
  }

  async ensureLogin() {
    if (this.token) return;
    if (!this.loginPromise) this.loginPromise = this.login().finally(() => { this.loginPromise = null; });
    await this.loginPromise;
  }

  async login() {
    const revision = this.revision;
    if (!this.config.account || !this.config.password) throw new HttpError(503, 'Set your upstream account and password in settings');
    const data = await this.requestJson('/user/login', {
      method: 'POST', auth: false,
      body: { account: this.config.account, password: this.config.password, code: '', captcha: '', captchaId: '', invite: '', registrationCode: '', agreement: false },
    }, false);
    if (!data?.token) throw new HttpError(401, 'Login returned no token');
    if (revision !== this.revision) throw new HttpError(409, 'Settings changed during login');
    this.token = data.token;
  }

  async getOrigin(force = false) {
    const revision = this.revision;
    if (this.config.fixedOrigin) { this.origin = new URL(this.config.fixedOrigin).origin; this.requireTrusted(); return this.origin; }
    if (!force && this.origin && Date.now() - this.originAt < 300000) { this.requireTrusted(); return this.origin; }
    if (!this.discoveryPromise) this.discoveryPromise = (async () => {
      const origin = await discoverOrigin(this.config, this.fetch);
      if (revision !== this.revision) throw new HttpError(409, 'Settings changed during discovery');
      if (origin !== this.origin) this.token = null;
      this.origin = origin;
      this.originAt = Date.now();
      this.requireTrusted();
      return origin;
    })().finally(() => { this.discoveryPromise = null; });
    return this.discoveryPromise;
  }

  requireTrusted() {
    const host = new URL(this.origin).hostname;
    if (!this.config.trustedHosts.includes(host)) throw new HttpError(409, `New origin ${host}: add it to trustedHosts before sending credentials`);
  }

  async openChatStream(payload, signal) {
    const origin = await this.getOrigin();
    await abortable(this.ensureLogin(), signal);
    signal?.throwIfAborted();
    const response = await this.fetch(`${origin}/api/chat/completions`, {
      method: 'POST', headers: { ...this.headers(true, true), Accept: 'text/event-stream' },
      body: JSON.stringify(payload), signal: combine(signal, this.config.requestTimeoutMs),
    });
    const type = response.headers.get('content-type') || '';
    if (type.startsWith('application/json')) {
      const result = await response.json();
      if (result.code === 2) return { authExpired: true };
      throw new HttpError(502, safeMessage(result.err || result.msg));
    }
    if (!response.ok || !type.startsWith('text/event-stream')) {
      await response.body?.cancel();
      throw new HttpError(502, `Upstream HTTP ${response.status}: expected an SSE stream`);
    }
    return { body: response.body };
  }

  headers(auth, json) {
    const origin = this.origin || (this.config.fixedOrigin ? new URL(this.config.fixedOrigin).origin : "https://ai.txg2024.xyz");
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      "Accept": json ? "application/json, text/plain, */*" : "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "Origin": origin,
      "Referer": `${origin}/chat`,
      "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "X-APP-VERSION": this.config.appVersion,
      "X-Locale": "zh-CN",
      ...(auth && this.token ? { Authorization: this.token } : {})
    };
  }
}

function combine(signal, timeout) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

function safeMessage(value) {
  return typeof value === 'string' ? value.replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]').slice(0, 300) : 'Upstream rejected the request';
}
