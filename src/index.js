import { loadConfig, Settings } from './config.js';
import { Store, AuditLog } from './store.js';
import { TaijiClient } from './taiji-client.js';
import { OpenAiAdapter } from './openai-adapter.js';
import { AdminAuth } from './auth.js';
import { AdminApi } from './admin-api.js';
import { ProbeRunner } from './probes.js';
import { Gate, SignScheduler } from './scheduler.js';
import { createApiServer } from './server.js';

try {
  try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const initial = loadConfig();
  const store = new Store(initial.dataDir);
  const settings = new Settings(initial, store);
  const config = settings.config;
  const log = new AuditLog(store), gate = new Gate();
  const client = new TaijiClient(config);
  const adapter = new OpenAiAdapter(client, config, log);
  const auth = new AdminAuth(config);
  const probes = new ProbeRunner(client, store, log, gate);
  const scheduler = new SignScheduler(client, config, store, log, gate);
  const admin = new AdminApi({ settings, log, gate, client, auth, probes, scheduler });
  const server = createApiServer(config, adapter, admin);
  server.listen(config.port, config.host, () => {
    log.add('startup', 'Taiji API started', { version: '0.2.0', port: config.port });
    console.log(`Taiji API listening on ${config.host}:${config.port}`);
    console.log('Admin key: set ADMIN_KEY or read the local data/auth.json file. Never publish this file.');
    scheduler.start();
  });
  server.on('error', error => { console.error(error.code || 'Server error'); process.exitCode = 1; });
  const shutdown = () => {
    scheduler.stop(); probes.controller?.abort();
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => process.exit(0), 15000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) { console.error(error.message); process.exitCode = 1; }
