import { abortable } from './cancellation.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { extractBridgeToolCalls } from './tool-bridge.js';

export class ProbeRunner {
  constructor(client, store, log, gate) {
    Object.assign(this, { client, store, log, gate });
    this.jobs = store.read('tests', []);
    for (const job of this.jobs) {
      if (['queued', 'running'].includes(job.status)) {
        job.status = 'interrupted';
        job.conclusion = '进程重启，测试未自动重放。';
      }
    }
    this.controller = null;
    this.save();
  }

  start(body) {
    if (this.controller) throw new HttpError(409, 'A test is already running');
    if (!['context', 'reasoning', 'output', 'tools'].includes(body.kind)) throw new HttpError(400, 'Invalid test kind');
    if (typeof body.model !== 'string' || body.model.length > 200) throw new HttpError(400, 'Select a model');
    const budget = body.maxRequests ?? 3;
    if (!Number.isInteger(budget) || budget < 1 || budget > 6) throw new HttpError(400, 'Request budget must be 1–6');
    const steps = body.steps || [1000, 4000, 8000];
    if (!Array.isArray(steps) || !steps.length || steps.length > 6 || steps.some((step) => !Number.isInteger(step) || step < 512 || step > 100000)) {
      throw new HttpError(400, 'Context steps must be 512–100000 characters, at most six steps');
    }
    const maxOutputTokens = body.maxOutputTokens ?? 128;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 16 || maxOutputTokens > 2048) {
      throw new HttpError(400, 'Output probe limit must be 16–2048');
    }
    const release = this.gate.enter(true);
    const job = newJob(body, budget, steps, maxOutputTokens);
    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, 100);
    this.controller = new AbortController();
    try {
      this.save();
    } catch (error) {
      this.jobs.shift();
      this.controller = null;
      release();
      throw error;
    }
    this.run(job, this.controller.signal)
      .catch(() => {
        job.status = 'failed';
        job.error = 'Local persistence failed. Check the data volume.';
      })
      .finally(() => {
        this.controller = null;
        release();
      });
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
        if (job.kind === 'context' && result.status !== 'passed') break;
        if (['context', 'output'].includes(job.kind) && result.status === 'error') break;
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
    const startedAt = Date.now();
    const result = baseResult(item, model);
    let session;
    let answer = '';
    let meta = {};
    try {
      session = await abortable(this.client.createSession(model), signal, (late) => this.client.deleteSession(late.id));
      const payload = upstreamPayload(session.id, item);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
      for await (const event of this.client.chat(payload, deadline)) {
        if (event.kind === 'delta') {
          answer += event.text;
          if (answer.length > 24000) throw new HttpError(502, 'Output safety cap reached (24000 characters). Not a model limit.');
        } else {
          meta = event.data;
          result.hasReasoningField ||= Boolean(meta.reasoning_content || meta.reasoning || meta.reasoningTokens);
        }
      }
      finishResult(result, item, answer, meta);
    } catch (error) {
      result.error = signal.aborted ? 'Cancelled by user' : safeError(error);
      result.status = signal.aborted ? 'cancelled' : 'error';
    } finally {
      result.elapsedMs = Date.now() - startedAt;
      if (session) {
        try { await this.client.deleteSession(session.id); }
        catch { this.log.add('cleanup', 'Test session cleanup failed', { sessionId: session.id }, 'warn'); }
      }
    }
    return result;
  }

  save() { this.store.write('tests', this.jobs); }
}

export function contextSample(chars) {
  const markers = Array.from({ length: 3 }, () => randomBytes(8).toString('hex'));
  const suffix = '\nReturn only the three values labeled CHECKPOINT in order. Do not repeat the document.\n';
  const markerBlocks = markers.map((marker, index) => `\nCHECKPOINT_${index + 1}=${marker}\n`);
  const remaining = chars - suffix.length - markerBlocks.join('').length;
  let filler = '';
  while (filler.length < remaining) filler += `record:${randomBytes(8).toString('hex')} alpha beta gamma delta epsilon text for retrieval testing.\n`;
  filler = filler.slice(0, remaining);
  const half = Math.floor(filler.length / 2);
  return { text: markerBlocks[0] + filler.slice(0, half) + markerBlocks[1] + filler.slice(half) + markerBlocks[2] + suffix, markers };
}

function newJob(body, maxRequests, steps, maxOutputTokens) {
  return {
    id: randomUUID(),
    kind: body.kind,
    model: body.model,
    maxRequests,
    steps,
    maxOutputTokens,
    status: 'running',
    createdAt: new Date().toISOString(),
    results: [],
    conclusion: '',
  };
}

function buildCases(job) {
  if (job.kind === 'context') return [...new Set(job.steps)].sort((left, right) => left - right).map(contextSample);
  if (job.kind === 'reasoning') return reasoningCases();
  if (job.kind === 'output') return [...new Set([32, job.maxOutputTokens])].map((maxTokens) => ({
    maxTokens,
    text: 'Return the integers from 1 to 300 in ascending order, separated by commas. Include every integer. No explanation.',
  }));
  return toolCases();
}

function reasoningCases() {
  const text = 'Compute 137*149. Return the number and a short verification sentence.';
  return [
    { text, thinking: false, reasoningEffort: '' },
    { text, thinking: true, reasoningEffort: '' },
    ...['low', 'medium', 'high', 'none'].map((reasoningEffort) => ({ text, thinking: reasoningEffort !== 'none', reasoningEffort })),
  ];
}

function toolCases() {
  const tools = [{
    type: 'function',
    function: {
      name: 'get_current_weather',
      description: 'Get current weather for a city',
      parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
    },
  }];
  return [
    {
      toolMode: 'native',
      text: 'Call get_current_weather for Tokyo. Do not answer with weather text.',
      upstreamTools: tools,
      toolChoice: 'required',
    },
    {
      toolMode: 'bridge',
      text: `You have this tool definition:\n${JSON.stringify(tools)}\n\nCall it for Tokyo. Output only valid JSON: {"tool_calls":[{"name":"get_current_weather","arguments":{"location":"Tokyo"}}]}.`,
      bridgeTools: tools,
    },
  ];
}

function upstreamPayload(sessionId, item) {
  const payload = {
    sessionId,
    text: item.text,
    files: [],
    thinking: item.thinking || false,
    reasoningEffort: item.reasoningEffort || '',
    webSearch: false,
    nativeTools: [],
    nativeToolOptions: {},
  };
  if (item.maxTokens) payload.max_tokens = item.maxTokens;
  if (item.upstreamTools) {
    payload.tools = item.upstreamTools;
    payload.tool_choice = item.toolChoice;
  }
  return payload;
}

function baseResult(item, model) {
  return {
    inputChars: item.text.length,
    inputBytes: Buffer.byteLength(item.text),
    thinking: item.thinking,
    reasoningEffort: item.reasoningEffort,
    requestedOutputTokens: item.maxTokens || null,
    toolMode: item.toolMode || null,
    platformDeclaresTools: Boolean(model.attr?.capabilities?.tools),
    nativeToolsParameterSent: Boolean(item.upstreamTools),
    nativeToolCallsObserved: false,
    bridgeToolCallsParsed: false,
    markerCount: item.markers?.length || 0,
    matchedMarkers: 0,
    status: 'error',
    hasThinkTag: false,
    hasReasoningField: false,
    returnedPromptTokens: null,
    returnedCompletionTokens: null,
  };
}

function finishResult(result, item, answer, meta) {
  result.hasThinkTag = /<think[>\s]/i.test(answer);
  result.answerPreview = answer.slice(0, 1600);
  result.returnedPromptTokens = meta.promptTokens ?? null;
  result.returnedCompletionTokens = meta.completionTokens ?? null;
  result.outputChars = answer.length;
  result.finishReason = meta.finish_reason || 'not_reported';
  result.matchedMarkers = (item.markers || []).filter((marker) => answer.includes(marker)).length;
  if (item.toolMode === 'native') {
    result.nativeToolCallsObserved = Boolean(extractBridgeToolCalls(answer, { tools: item.upstreamTools || item.bridgeTools, maxCalls: 1 }));
    result.status = result.nativeToolCallsObserved ? 'native_signal_observed' : 'native_unsupported';
    return;
  }
  if (item.toolMode === 'bridge') {
    result.bridgeToolCallsParsed = Boolean(extractBridgeToolCalls(answer, { tools: item.upstreamTools || item.bridgeTools, maxCalls: 1 }));
    result.status = result.bridgeToolCallsParsed ? 'bridge_only' : 'bridge_failed';
    return;
  }
  result.status = item.markers?.length ? (result.matchedMarkers === item.markers.length ? 'passed' : 'retrieval_failed') : 'accepted';
  if (item.maxTokens) result.limitEnforcement = meta.completionTokens > item.maxTokens ? 'not_enforced_or_usage_not_comparable' : 'inconclusive';
}

export function conclusion(job) {
  if (job.kind === 'context') {
    const passed = job.results.filter((result) => result.status === 'passed');
    const max = Math.max(0, ...passed.map((result) => result.inputChars));
    return max ? `已验证三点检索下限 ${max} 字符。不是 token 上限或模型最大上下文。达到请求预算后停止；失败也可能来自平台限制。` : '尚未建立有效检索下限。错误不等于模型上下文上限。';
  }
  if (job.kind === 'reasoning') return 'accepted 只代表请求被接受。正文解释、延迟及 token 数都不能证明内部推理等级生效。未声明的等级在正式 API 中明确拒绝。';
  if (job.kind === 'tools') {
    const native = job.results.find((result) => result.toolMode === 'native');
    const bridge = job.results.find((result) => result.toolMode === 'bridge');
    if (native?.nativeToolCallsObserved) return '检测到文本形式的 tool_calls 信号，但上游未提供原生结构化 tool_calls 事件。仍需人工审核，不能直接作为 Codex 原生工具后端。';
    if (bridge?.bridgeToolCallsParsed) return '原生 tools 参数未产生可验证的 Function Calling；模型可按提示生成 JSON 工具意图。这只是文本协议桥接，不是安全或可靠的 Codex 原生 Function Calling。';
    return '未观察到原生或文本桥接工具调用。不要把该模型配置为 Codex 工具后端。';
  }
  return 'max_tokens 是候选字段测试。记录请求上限与平台报告的输出 tokens；未证实服务端强制执行，正式 API 不承诺最大输出控制。';
}

function safeError(error) {
  return error instanceof HttpError ? error.message.slice(0, 300) : 'Network, timeout, or local test error';
}
