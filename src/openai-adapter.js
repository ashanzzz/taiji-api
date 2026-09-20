import { abortable } from './cancellation.js';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { validateRequest, reasoningOptions, buildTaijiInput, ThinkSplitter } from './chat-format.js';
export { buildTaijiInput } from './chat-format.js';

export class OpenAiAdapter {
  constructor(client, config, log) { this.client = client; this.config = config; this.log = log; }

  async listModels() {
    const catalog = await this.client.getModels();
    return { object: 'list', data: catalog.models.map(m => ({ id: m.value, object: 'model', created: 0, owned_by: m.attr?.providerKey || 'taiji' })) };
  }

  async prepare(body, signal) {
    validateRequest(body);
    signal?.throwIfAborted();
    const model = await abortable(this.client.resolveModel(body.model, signal), signal);
    const reasoning = reasoningOptions(body, model);
    const input = buildTaijiInput(body.messages);
    if (input.files.length && !model.attr?.capabilities?.imageInput) throw new HttpError(400, 'This model does not declare image input');
    signal?.throwIfAborted();
    // Do not abort session creation: obtain the ID so cancellation can still clean it up.
    const session = await abortable(this.client.createSession(model), signal, late => this.cleanup(late.id));
    return { id: `chatcmpl-${randomUUID()}`, model: model.value, sessionId: session.id,
      payload: { text: input.text, sessionId: session.id, files: input.files, ...reasoning,
        webSearch: Boolean(body.web_search), nativeTools: [], nativeToolOptions: {} } };
  }

  async complete(body, signal) {
    const prepared = await this.prepare(body, signal);
    const parts = { content: '', reasoning_content: '' };
    let meta = {};
    const splitter = new ThinkSplitter();
    try {
      for await (const event of this.client.chat(prepared.payload, signal)) {
        if (event.kind === 'meta') { meta = event.data; continue; }
        for (const part of splitter.push(event.text)) for (const [key, value] of Object.entries(part)) parts[key] += value;
      }
      for (const part of splitter.push('', true)) for (const [key, value] of Object.entries(part)) parts[key] += value;
      const message = { role: 'assistant', content: parts.content };
      if (parts.reasoning_content) message.reasoning_content = parts.reasoning_content;
      return { ...base(prepared, false), choices: [{ index: 0, message, finish_reason: finish(meta) }], usage: usage(meta) };
    } finally { await this.cleanup(prepared.sessionId); }
  }

  async stream(body, signal, write) {
    const prepared = await this.prepare(body, signal);
    const envelope = base(prepared, true);
    const emit = (delta, reason = null) => write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    const splitter = new ThinkSplitter();
    let meta = {};
    try {
      // Open the upstream before the first downstream byte so initial errors keep HTTP status.
      for await (const event of this.client.chat(prepared.payload, signal)) {
        if (!envelope.started) { await emit({ role: 'assistant', content: '' }); Object.defineProperty(envelope, 'started', { value: true }); }
        if (event.kind === 'meta') { meta = event.data; continue; }
        for (const part of splitter.push(event.text)) await emit(part);
      }
      for (const part of splitter.push('', true)) await emit(part);
      await emit({}, finish(meta));
      if (body.stream_options?.include_usage) await write(`data: ${JSON.stringify({ ...envelope, choices: [], usage: usage(meta) })}\n\n`);
      await write('data: [DONE]\n\n');
    } finally { await this.cleanup(prepared.sessionId); }
  }

  async cleanup(id) {
    if (!this.config.deleteTempSessions) return;
    try { await this.client.deleteSession(id); }
    catch { this.log?.add('cleanup', 'Temporary session cleanup failed', { sessionId: id }, 'warn'); }
  }
}

function base(p, stream) {
  return { id: p.id, model: p.model, object: stream ? 'chat.completion.chunk' : 'chat.completion', created: Math.floor(Date.now() / 1000) };
}
function finish(meta) { return ['stop', 'length', 'content_filter'].includes(meta.finish_reason) ? meta.finish_reason : 'stop'; }
function usage(meta) {
  return { prompt_tokens: Number(meta.promptTokens || 0), completion_tokens: Number(meta.completionTokens || 0), total_tokens: Number(meta.useTokens || 0) };
}
