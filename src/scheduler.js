import { randomInt } from 'node:crypto';
import { HttpError } from './errors.js';

export class SignScheduler {
  constructor(client, config, store, log, gate, clock = () => Date.now()) {
    Object.assign(this, { client, config, store, log, gate, clock });
    this.state = store.read('schedule', { nextAt: null, lastDay: null, lastResult: null });
    this.running = false;
  }
  start() { this.plan(); this.timer = setInterval(() => this.tick().catch(() => {}), 30000); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  save() { this.store.write('schedule', this.state); }
  reconfigure() { this.state.nextAt = null; this.plan(); }

  plan() {
    if (!this.config.schedule.enabled) { this.state.nextAt = null; this.save(); return; }
    if (this.state.nextAt && Date.parse(this.state.nextAt) > this.clock()) return;
    // A failed preflight is manually retryable, but do not keep waking the upstream automatically.
    const attemptedDay = this.state.lastResult?.day || this.state.lastDay;
    this.state.nextAt = nextSignTime(this.clock(), this.config.schedule, attemptedDay);
    this.save();
  }
  async tick() {
    if (!this.config.schedule.enabled || this.running || this.gate.active) return;
    if (!this.state.nextAt) { this.plan(); return; }
    if (Date.parse(this.state.nextAt) > this.clock()) return;
    const hour = new Date(this.clock() + 8 * 3600000).getUTCHours();
    if (hour < this.config.schedule.startHour || hour >= this.config.schedule.endHour) { this.state.nextAt = null; this.plan(); return; }
    await this.sign();
  }

  async sign() {
    if (this.running) throw new HttpError(409, 'Sign-in is already running');
    const day = shanghaiDay(this.clock());
    if (this.state.lastDay === day) return this.state.lastResult;
    const release = this.gate.enter(true);
    this.running = true;
    let postAttempted = false;
    try {
      const [year, month] = day.split('-').map(Number);
      const records = await this.client.requestJson(`/gift_sign?year=${year}&month=${month}`);
      if (records !== null && !Array.isArray(records)) throw new HttpError(502, 'Unexpected sign-in calendar format');
      const today = records?.find(r => String(r.ymd).replaceAll('-', '') === day.replaceAll('-', ''));
      let data = today;
      if (!today) {
        this.state.lastDay = day;
        this.state.lastResult = { status: 'pending', day, at: new Date(this.clock()).toISOString() };
        this.save();
        postAttempted = true;
        data = await this.client.requestJson('/gift_sign', { method: 'POST' });
      }
      this.state.lastDay = day;
      this.state.lastResult = { status: today ? 'already_signed' : 'signed', day, integral: data?.integral ?? null, at: new Date(this.clock()).toISOString() };
      this.log.add('checkin', today ? '今天已签到' : '签到完成', this.state.lastResult);
    } catch (error) {
      if (!postAttempted) this.state.lastDay = null;
      this.state.lastResult = { status: postAttempted ? 'failed_or_unknown' : 'preflight_failed', day,
        error: error instanceof HttpError ? error.message : 'Network or storage error', at: new Date(this.clock()).toISOString() };
      this.log.add('checkin', postAttempted ? '签到结果未知；今天不自动重试' : '签到查询失败；可手动重试', this.state.lastResult, 'warn');
    } finally {
      this.running = false;
      release();
      this.state.nextAt = null;
      this.plan(); this.save();
    }
    return this.state.lastResult;
  }
}

export function shanghaiDay(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
export function nextSignTime(now, settings, lastDay, choose = randomInt) {
  const day = shanghaiDay(now);
  const midnight = Date.parse(`${day}T00:00:00+08:00`);
  let start = midnight + settings.startHour * 3600000;
  let end = midnight + settings.endHour * 3600000;
  if (day === lastDay || now >= end) { start += 86400000; end += 86400000; }
  start = Math.max(start, now + 1000);
  return new Date(start >= end ? end : choose(start, end)).toISOString();
}

export class Gate {
  constructor() { this.active = 0; this.exclusive = false; }
  enter(exclusive = false) {
    if (this.exclusive || (exclusive && this.active) || this.active >= 2) throw new HttpError(429, 'Service busy. Try later.');
    this.active++;
    if (exclusive) this.exclusive = true;
    return () => { this.active--; if (exclusive) this.exclusive = false; };
  }
}
