import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';

export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = join(this.directory, 'master.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid data/master.key. Restore the original key.');
  }

  read(name, fallback) {
    const path = join(this.directory, `${name}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  }

  write(name, value) {
    const path = join(this.directory, `${name}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameWithRetry(`${path}.tmp`, path);
  }

  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  decrypt(value) {
    if (!value) return '';
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
}

export class AuditLog {
  constructor(store) {
    this.store = store;
    this.items = store.read('logs', []);
  }

  add(event, message, details = {}, level = 'info') {
    // Only callers' allowlisted metadata belongs here. Never store prompts or upstream records.
    this.items.unshift({ at: new Date().toISOString(), level, event, message, details });
    this.items = this.items.slice(0, 300);
    this.store.write('logs', this.items);
  }
}

export function renameWithRetry(source, target, rename = renameSync, sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, target); return; }
    catch (error) {
      // Windows sync clients can hold the destination briefly after a write.
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
      sleep(25 * (attempt + 1));
    }
  }
}
