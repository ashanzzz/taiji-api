import { HttpError } from './errors.js';
import { randomBytes } from 'node:crypto';

export function createToolBridge(body, model, config) {
  if (body.tools === undefined) return null;
  if (!config.experimentalToolBridge) {
    throw new HttpError(400, 'Experimental tool bridge is disabled. Enable it only for local Codex testing. This upstream has no native Function Calling.');
  }
  if (!config.toolBridgeAllowedModels.includes(model.value)) {
    throw new HttpError(400, `Experimental tool bridge is not enabled for ${model.value}`);
  }
  const tools = normalizeTools(body.tools, config.toolBridgeMaxTools);
  validateChoice(body.tool_choice, tools);
  return { tools, maxCalls: config.toolBridgeMaxCalls };
}

export function buildToolPrompt(bridge) {
  if (!bridge) return '';
  return `【本地实验性工具桥接】\n你不是原生 Function Calling 模型。你只能用文本表达工具意图。\n可用工具定义如下：\n${JSON.stringify(bridge.tools, null, 2)}\n\n如需工具，只能输出一个 JSON 对象，格式严格如下：\n{"tool_calls":[{"name":"工具名称","arguments":{"参数":"值"}}]}\n禁止 Markdown、解释或额外文本。每轮最多 ${bridge.maxCalls} 个工具调用。\n工具执行由客户端 Codex 完成。工具返回后，请根据返回结果继续普通回答。\n\n`;
}

export function validateToolHistory(messages, bridge) {
  if (!bridge) {
    if (messages.some((message) => message.role === 'tool' || message.tool_calls)) {
      throw new HttpError(400, 'Tool history requires the experimental tool bridge');
    }
    return new Map();
  }
  const allowedNames = new Set(bridge.tools.map((tool) => tool.function.name));
  const calls = new Map();
  for (const message of messages) {
    if (message.tool_calls) {
      if (!Array.isArray(message.tool_calls)) throw new HttpError(400, 'tool_calls must be an array');
      for (const call of message.tool_calls) {
        const name = call?.function?.name;
        const id = call?.id;
        if (!id || !allowedNames.has(name)) throw new HttpError(400, 'Tool-call history contains an unapproved tool');
        calls.set(id, name);
      }
    }
    if (message.role === 'tool') {
      if (!calls.has(message.tool_call_id)) throw new HttpError(400, 'Tool result has no matching tool_call_id');
      if (message.name && message.name !== calls.get(message.tool_call_id)) throw new HttpError(400, 'Tool result name does not match tool_call_id');
    }
  }
  return calls;
}

export function extractBridgeToolCalls(text, bridge) {
  if (!bridge || !text) return null;
  const candidate = jsonCandidate(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed.tool_calls) || !parsed.tool_calls.length || parsed.tool_calls.length > bridge.maxCalls) return null;
    const allowedNames = new Set(bridge.tools.map((tool) => tool.function.name));
    const calls = parsed.tool_calls.map((call) => toOpenAiCall(call, allowedNames));
    return calls.every(Boolean) ? calls : null;
  } catch {
    return null;
  }
}

function normalizeTools(value, maximum) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) {
    throw new HttpError(400, `tools must contain 1–${maximum} function definitions`);
  }
  const names = new Set();
  return value.map((tool) => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !fn || typeof fn.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(fn.name)) {
      throw new HttpError(400, 'Each tool requires a safe function name');
    }
    if (names.has(fn.name)) throw new HttpError(400, 'Tool function names must be unique');
    names.add(fn.name);
    if (fn.parameters !== undefined && (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters))) {
      throw new HttpError(400, 'Tool parameters must be a JSON Schema object');
    }
    return { type: 'function', function: { name: fn.name, description: String(fn.description || '').slice(0, 2000), parameters: fn.parameters || { type: 'object', properties: {} } } };
  });
}

function validateChoice(choice, tools) {
  if (choice === undefined || choice === 'auto' || choice === 'required') return;
  if (choice === 'none') throw new HttpError(400, 'tool_choice:none should omit tools instead');
  const name = choice?.function?.name;
  if (choice?.type !== 'function' || !tools.some((tool) => tool.function.name === name)) {
    throw new HttpError(400, 'tool_choice must reference a submitted function');
  }
}

function jsonCandidate(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const source = (fenced ? fenced[1] : text).trim();
  const marker = source.indexOf('"tool_calls"');
  if (marker < 0) return null;
  const start = source.lastIndexOf('{', marker);
  const end = matchingBrace(source, start);
  return start >= 0 && end >= start ? source.slice(start, end + 1) : null;
}

function toOpenAiCall(call, names) {
  const name = call?.name || call?.function?.name;
  const rawArguments = call?.arguments ?? call?.function?.arguments ?? {};
  if (!names.has(name)) return null;
  let argumentsText;
  try {
    const value = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    argumentsText = JSON.stringify(value);
  } catch {
    return null;
  }
  return { id: `call_${randomBytes(9).toString('hex')}`, type: 'function', function: { name, arguments: argumentsText } };
}

function matchingBrace(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}' && --depth === 0) return index;
  }
  return -1;
}
