import { HttpError } from './errors.js';

export function validateRequest(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 500) throw new HttpError(400, 'messages must contain 1–500 entries');
  for (const key of ['tools', 'tool_choice', 'functions', 'function_call', 'response_format', 'stop', 'seed', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logprobs']) {
    if (body[key] !== undefined) throw new HttpError(400, `${key} is not verified for this website protocol`);
  }
  if (body.n !== undefined && body.n !== 1) throw new HttpError(400, 'Only n=1 is supported');
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (body[key] !== undefined) throw new HttpError(400, `${key}: server-side output limits are not verified. Use the output probe to measure behavior, or omit this option.`);
  }
  for (const key of ['stream', 'thinking', 'web_search']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new HttpError(400, `${key} must be a boolean`);
  if (body.reasoning_effort !== undefined && typeof body.reasoning_effort !== 'string') throw new HttpError(400, 'reasoning_effort must be a string');
}

export function reasoningOptions(body, model) {
  const caps = model.attr?.capabilities || {};
  const effort = body.reasoning_effort || '';
  if (effort && !(caps.reasoningEfforts || []).includes(effort)) throw new HttpError(400, 'The website does not declare this reasoning level. Parameter was not silently discarded.');
  if (body.thinking === true && !caps.thinking && !effort) throw new HttpError(400, 'Thinking control is not declared for this model. Use a reasoning probe to test acceptance.');
  return { thinking: effort ? effort !== 'none' : Boolean(body.thinking), reasoningEffort: effort };
}

export function buildTaijiInput(messages) {
  const normalized = messages.map((m, index) => {
    if (!m || !['user', 'assistant', 'system', 'developer'].includes(m.role)) throw new HttpError(400, `Invalid message role at ${index}`);
    if (m.tool_calls) throw new HttpError(400, 'Tool calls are not supported');
    if (typeof m.content === 'string') return { role: m.role, text: m.content, files: [] };
    if (!Array.isArray(m.content)) throw new HttpError(400, 'Message content must be text or content parts');
    const text = [], files = [];
    for (const part of m.content) {
      if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
      else if (part?.type === 'image_url' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(part.image_url?.url || '')) {
        if (m.role !== 'user') throw new HttpError(400, 'Images are only supported in user messages');
        files.push({ name: `message-${index + 1}-image-${files.length + 1}.png`, data: part.image_url.url });
      } else throw new HttpError(400, 'Only text and base64 image data URLs are supported. Remote images are not fetched.');
    }
    return { role: m.role, text: text.join('\n'), files };
  });
  const files = normalized.flatMap(m => m.files);
  if (files.length > 5) throw new HttpError(400, 'At most five images are supported');
  const text = normalized.length === 1 && normalized[0].role === 'user' ? normalized[0].text :
    '请根据以下对话继续回复最后一条用户消息。只输出助手回复正文。\n\n' + normalized.map(m => `【${{ system: '系统', developer: '开发者', user: '用户', assistant: '助手' }[m.role]}】\n${m.text}`).join('\n\n');
  if (!text.trim()) throw new HttpError(400, 'A non-empty text prompt is required');
  return { text, files };
}

export class ThinkSplitter {
  constructor() { this.buffer = ''; this.thinking = false; }
  push(text, final = false) {
    this.buffer += text;
    const result = [];
    while (this.buffer) {
      const tag = this.thinking ? '</think>' : '<think>';
      const pos = this.buffer.indexOf(tag);
      if (pos >= 0) {
        if (pos) result.push(this.part(this.buffer.slice(0, pos)));
        this.buffer = this.buffer.slice(pos + tag.length);
        this.thinking = !this.thinking;
      } else {
        let hold = 0;
        if (!final) for (let n = 1; n < tag.length; n++) if (this.buffer.endsWith(tag.slice(0, n))) hold = n;
        const value = this.buffer.slice(0, this.buffer.length - hold);
        if (value) result.push(this.part(value));
        this.buffer = hold ? this.buffer.slice(-hold) : '';
        break;
      }
    }
    return result;
  }
  part(text) { return { [this.thinking ? 'reasoning_content' : 'content']: text }; }
}
