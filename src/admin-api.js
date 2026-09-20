import { HttpError } from './errors.js';

export class AdminApi {
  constructor(services) { Object.assign(this, services); }
  async route(path, method, body, request, response) {
    if (path === '/admin/login' && method === 'POST') return this.auth.login(body.key, request, response);
    this.auth.require(request);
    if (path === '/admin/logout' && method === 'POST') return this.auth.logout(request, response);
    if (path === '/admin/state' && method === 'GET') return {
      settings: this.settings.public(), schedule: this.scheduler.state,
      status: { origin: this.client.origin, modelCount: this.client.modelCache?.value.models.length || 0,
        version: '0.2.0', busy: this.gate.active, upstreamAuthenticated: Boolean(this.client.token) },
      tests: this.probes.jobs, logs: this.log.items.slice(0, 40),
    };
    if (path === '/admin/settings' && method === 'PUT') {
      if (this.client.pendingCreations) throw new HttpError(409, 'Wait for pending session creation cleanup before changing settings');
      const release = this.gate.enter(true);
      try {
        const oldAccount = this.settings.config.account;
        const result = this.settings.update(body);
        this.client.reset();
        if (oldAccount !== this.settings.config.account) {
          this.scheduler.state = { nextAt: null, lastDay: null, lastResult: null };
        }
        this.scheduler.reconfigure();
        this.log.add('settings', 'Settings saved. Login and model caches reset.');
        return result;
      } finally { release(); }
    }
    if (path === '/admin/models' && method === 'GET') return this.lock(() => this.client.getModels());
    if (path === '/admin/discover' && method === 'POST') return this.lock(async () => ({ origin: await this.client.getOrigin(true) }));
    if (path === '/admin/checkin' && method === 'POST') return this.scheduler.sign();
    if (path === '/admin/tests' && method === 'GET') return { tests: this.probes.jobs };
    if (path === '/admin/tests' && method === 'POST') return this.probes.start(body);
    const cancel = /^\/admin\/tests\/([a-f0-9-]+)\/cancel$/.exec(path);
    if (cancel && method === 'POST') return this.probes.cancel(cancel[1]);
    if (path === '/admin/logs' && method === 'GET') return { logs: this.log.items };
    throw new HttpError(404, 'Not found');
  }
  async lock(fn) { const release = this.gate.enter(); try { return await fn(); } finally { release(); } }
}
