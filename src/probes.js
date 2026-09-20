import { abortable } from './cancellation.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';

export class ProbeRunner {
  constructor(client, store, log, gate) {
    Object.assign(this, { client, store, log, gate });
    this.jobs = store.read('tests', []);
    for (const job of this.jobs) if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; job.conclusion = '进程重启，测试未自动重放。'; }
    this.controller = null;
    this.save();
  }

  start(body) {
    if (this.controller) throw new HttpError(409, 'A test is already running');
    if (!['context', 'reasoning', 'output'].includes(body.kind)) throw new HttpError(400, 'Invalid test kind');
    if (typeof body.model !== 'string' || body.model.length > 200) throw new HttpError(400, 'Select a model');
    const budget = body.maxRequests ?? 3;
    if (!Number.isInteger(budget) || budget < 1 || budget > 6) throw new HttpError(400, 'Request budget must be 1–6');
    const steps = body.steps || [1000, 4000, 8000];
    if (!Array.isArray(steps) || !steps.length || steps.length > 6 || steps.some(x => !Number.isInteger(x) || x < 512 || x > 100000)) throw new HttpError(400, 'Context steps must be 512–100000 characters, at most six steps');
    const cap = body.maxOutputTokens ?? 128;
    if (!Number.isInteger(cap) || cap < 16 || cap > 2048) throw new HttpError(400, 'Output probe limit must be 16–2048');
    const release = this.gate.enter(true);
    const job = { id: randomUUID(), kind: body.kind, model: body.model, maxRequests: budget, steps,
      maxOutputTokens: cap, status: 'running', createdAt: new Date().toISOString(), results: [], conclusion: '' };
    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, 100);
    this.controller = new AbortController();
    try { this.save(); } catch (error) {
      this.jobs.shift(); this.controller = null; release(); throw error;
    }
    this.run(job, this.controller.signal).catch(() => {
      job.status = 'failed'; job.error = 'Local persistence failed. Check the data volume.';
      console.error('Probe persistence failed; no upstream request will be replayed.');
    }).finally(() => { this.controller = null; release(); });
    return job;
  }

  cancel(id) {
    if (this.jobs[0]?.id !== id || !this.controller) throw new HttpError(404, 'No running job with this ID');
    this.controller.abort();
    return { ok: true };
  }

  async run(job, signal) {
    try {
      const model = await abortable(this.client.resolveModel(job.model, signal), signal);
      job.declaredCapabilities = model.attr?.capabilities || {};
      const cases = buildCases(job).slice(0, job.maxRequests);
      for (const item of cases) {
        signal.throwIfAborted();
        const result = await this.sample(model, item, signal);
        job.results.push(result);
        this.save();
        signal.throwIfAborted();
        // Stop context growth after the first failure. Do not brute-force a channel limit.
        if (job.kind === 'context' && result.status !== 'passed') break;
        if (job.kind !== 'reasoning' && result.status === 'error') break;
      }
      job.status = 'completed';
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.error = signal.aborted ? 'Cancelled by user' : safeError(error);
    } finally {
      job.finishedAt = new Date().toISOString();
      job.conclusion = conclusion(job);
      this.log.add('test', `测试${job.status}: ${job.kind}`, { id: job.id, model: job.model, requests: job.results.length });
      this.save();
    }
  }

  async sample(model, item, signal) {
    const start = Date.now();
    const result = { inputChars: item.text.length, inputBytes: Buffer.byteLength(item.text), thinking: item.thinking,
      reasoningEffort: item.reasoningEffort, requestedOutputTokens: item.maxTokens || null,
      markerCount: item.markers?.length || 0, matchedMarkers: 0, status: 'error',
      hasThinkTag: false, hasReasoningField: false, returnedPromptTokens: null, returnedCompletionTokens: null };
    let session, answer = '', meta = {}, size = 0;
    try {
      signal.throwIfAborted();
      session = await abortable(this.client.createSession(model), signal, late => this.client.deleteSession(late.id));
      const payload = { sessionId: session.id, text: item.text, files: [], thinking: item.thinking || false,
        reasoningEffort: item.reasoningEffort || '', webSearch: false, nativeTools: [], nativeToolOptions: {} };
      // Probe this candidate explicitly. Its presence does not imply upstream enforcement.
      if (item.maxTokens) payload.max_tokens = item.maxTokens;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
      for await (const event of this.client.chat(payload, deadline)) {
        if (event.kind === 'delta') { answer += event.text; size += event.text.length; }
        else {
          meta = event.data;
          result.hasReasoningField ||= Boolean(meta.reasoning_content || meta.reasoning || meta.reasoningTokens);
        }
        if (size > 24000) throw new HttpError(502, 'Output safety cap reached (24000 characters). Not a model limit.');
      }
      result.hasThinkTag = /<think[>\s]/i.test(answer);
      result.answerPreview = answer.slice(0, 1600);
      result.returnedPromptTokens = meta.promptTokens ?? null;
      result.returnedCompletionTokens = meta.completionTokens ?? null;
      result.outputChars = answer.length;
      result.finishReason = meta.finish_reason || 'not_reported';
      result.matchedMarkers = (item.markers || []).filter(m => answer.includes(m)).length;
      result.status = item.markers?.length ? (result.matchedMarkers === item.markers.length ? 'passed' : 'retrieval_failed') : 'accepted';
      if (item.maxTokens) result.limitEnforcement = meta.completionTokens > item.maxTokens ? 'not_enforced_or_usage_not_comparable' : 'inconclusive';
    } catch (error) {
      result.error = signal.aborted ? 'Cancelled by user' : safeError(error);
      result.status = signal.aborted ? 'cancelled' : 'error';
    } finally {
      result.elapsedMs = Date.now() - start;
      if (session) try { await this.client.deleteSession(session.id); }
      catch { this.log.add('cleanup', 'Test session cleanup failed', { sessionId: session.id }, 'warn'); }
    }
    return result;
  }
  save() { this.store.write('tests', this.jobs); }
}

export function contextSample(chars) {
  const markers = Array.from({ length: 3 }, () => randomBytes(8).toString('hex'));
  const instructions = '\nReturn only the three values labeled CHECKPOINT in order. Do not repeat the document.\n';
  const blocks = markers.map((m, i) => `\nCHECKPOINT_${i + 1}=${m}\n`);
  const remaining = chars - instructions.length - blocks.join('').length;
  let filler = '';
  while (filler.length < remaining) filler += `record:${randomBytes(8).toString('hex')} alpha beta gamma delta epsilon text for retrieval testing.\n`;
  filler = filler.slice(0, remaining);
  const half = Math.floor(filler.length / 2);
  return { text: blocks[0] + filler.slice(0, half) + blocks[1] + filler.slice(half) + blocks[2] + instructions, markers };
}

function buildCases(job) {
  if (job.kind === 'context') return [...new Set(job.steps)].sort((a, b) => a - b).map(contextSample);
  if (job.kind === 'output') return [...new Set([32, job.maxOutputTokens])].map(maxTokens => ({ maxTokens,
    text: 'Return the integers from 1 to 300 in ascending order, separated by commas. Include every integer. No explanation.' }));
  const text = 'Compute 137*149. Return the number and a short verification sentence.';
  return [{ text, thinking: false, reasoningEffort: '' }, { text, thinking: true, reasoningEffort: '' },
    ...['low', 'medium', 'high', 'none'].map(reasoningEffort => ({ text, thinking: reasoningEffort !== 'none', reasoningEffort }))];
}

export function conclusion(job) {
  if (job.kind === 'context') {
    const passed = job.results.filter(r => r.status === 'passed');
    const max = Math.max(0, ...passed.map(r => r.inputChars));
    return max ? `已验证三点检索下限 ${max} 字符。不是 token 上限或模型最大上下文。达到请求预算后停止；失败也可能来自平台限制。` : '尚未建立有效检索下限。错误不等于模型上下文上限。';
  }
  if (job.kind === 'reasoning') return 'accepted 只代表请求被接受。正文解释、延迟及 token 数都不能证明内部推理等级生效。未声明的等级在正式 API 中明确拒绝。';
  return 'max_tokens 是候选字段测试。记录请求上限与平台报告的输出 tokens；未证实服务端强制执行，正式 API 不承诺最大输出控制。';
}
function safeError(error) { return error instanceof HttpError ? error.message.slice(0, 300) : 'Network, timeout, or local test error'; }
