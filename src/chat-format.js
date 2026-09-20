import { HttpError } from "./errors.js";
import { buildToolPrompt, validateToolHistory } from "./tool-bridge.js";

export function validateRequest(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 500) {
    throw new HttpError(400, "messages must contain 1–500 entries");
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new HttpError(400, "tools must be an array");
  if (body.tool_choice !== undefined && body.tools === undefined) throw new HttpError(400, "tool_choice requires tools");
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") throw new HttpError(400, "parallel_tool_calls must be a boolean");
  for (const key of ["functions", "function_call"]) {
    if (body[key] !== undefined) throw new HttpError(400, "Legacy function calling is not supported. Use tools only with the explicitly enabled experimental bridge.");
  }
  for (const key of ["response_format", "stop", "seed", "temperature", "top_p", "presence_penalty", "frequency_penalty", "logprobs"]) {
    if (body[key] !== undefined) throw new HttpError(400, `${key} is not verified for this website protocol`);
  }
  if (body.n !== undefined && body.n !== 1) throw new HttpError(400, "Only n=1 is supported");
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (body[key] !== undefined) throw new HttpError(400, `${key}: server-side output limits are not verified. Use the output probe to measure behavior, or omit this option.`);
  }
  for (const key of ["stream", "thinking", "web_search"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") throw new HttpError(400, `${key} must be a boolean`);
  }
  if (body.reasoning_effort !== undefined && typeof body.reasoning_effort !== "string") throw new HttpError(400, "reasoning_effort must be a string");
}

export function reasoningOptions(body, model) {
  const caps = model.attr?.capabilities || {};
  const effort = body.reasoning_effort || "";
  if (effort && !(caps.reasoningEfforts || []).includes(effort)) throw new HttpError(400, "The website does not declare this reasoning level. Parameter was not silently discarded.");
  if (body.thinking === true && !caps.thinking && !effort) throw new HttpError(400, "Thinking control is not declared for this model. Use a reasoning probe to test acceptance.");
  return { thinking: effort ? effort !== "none" : Boolean(body.thinking), reasoningEffort: effort };
}

export function buildTaijiInput(messages, bridge = null) {
  const calls = validateToolHistory(messages, bridge);
  const normalized = messages.map((message, index) => normalizeMessage(message, index, calls));
  const files = normalized.flatMap((message) => message.files);
  if (files.length > 5) throw new HttpError(400, "At most five images are supported");
  const labels = { system: "系统", developer: "开发者", user: "用户", assistant: "助手", tool: "工具结果" };
  const transcript = normalized.map((message) => `【${labels[message.role]}】\n${message.text}`).join("\n\n");
  const text = `${buildToolPrompt(bridge)}请根据以下对话继续回复最后一条用户消息。只输出助手回复正文或实验性工具桥接指令。\n\n${transcript}`;
  if (!text.trim()) throw new HttpError(400, "A non-empty text prompt is required");
  return { text, files };
}

export class ThinkSplitter {
  constructor() { this.buffer = ""; this.thinking = false; }
  push(text, final = false) {
    this.buffer += text;
    const parts = [];
    while (this.buffer) {
      const tag = this.thinking ? "</think>" : "<think>";
      const position = this.buffer.indexOf(tag);
      if (position >= 0) {
        if (position) parts.push(this.part(this.buffer.slice(0, position)));
        this.buffer = this.buffer.slice(position + tag.length);
        this.thinking = !this.thinking;
        continue;
      }
      const hold = final ? 0 : tagPrefixLength(this.buffer, tag);
      const value = this.buffer.slice(0, this.buffer.length - hold);
      if (value) parts.push(this.part(value));
      this.buffer = hold ? this.buffer.slice(-hold) : "";
      break;
    }
    return parts;
  }
  part(text) { return { [this.thinking ? "reasoning_content" : "content"]: text }; }
}

function normalizeMessage(message, index, calls) {
  if (!message || !["user", "assistant", "system", "developer", "tool"].includes(message.role)) {
    throw new HttpError(400, `Invalid message role at ${index}`);
  }
  if (message.role === "tool") {
    const name = calls.get(message.tool_call_id);
    if (!name) throw new HttpError(400, "Tool result has no matching tool_call_id");
    const text = [
      `tool_call_id: ${message.tool_call_id}`,
      `name: ${name}`,
      "result:",
      textContent(message.content),
    ].join("\n");
    return { role: "tool", text, files: [] };
  }
  if (message.tool_calls) {
    const parts = [];
    if (message.content && typeof message.content === "string" && message.content.trim()) {
      parts.push(message.content.trim());
    }
    for (const call of message.tool_calls) {
      const id = call.id || "";
      const name = call.function?.name || call.name || "";
      const rawArgs = call.function?.arguments ?? call.arguments;
      const argsText = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs || {});
      parts.push([
        "【工具调用】",
        `tool_call_id: ${id}`,
        `name: ${name}`,
        "arguments:",
        argsText,
      ].join("\n"));
    }
    return { role: "assistant", text: parts.join("\n\n"), files: [] };
  }
  if (typeof message.content === "string") return { role: message.role, text: message.content, files: [] };
  if (!Array.isArray(message.content)) throw new HttpError(400, "Message content must be text or content parts");
  const text = [], files = [];
  for (const part of message.content) {
    if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part?.type === "image_url" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(part.image_url?.url || "")) {
      if (message.role !== "user") throw new HttpError(400, "Images are only supported in user messages");
      files.push({ name: `message-${index + 1}-image-${files.length + 1}.png`, data: part.image_url.url });
    } else throw new HttpError(400, "Only text and base64 image data URLs are supported. Remote images are not fetched.");
  }
  return { role: message.role, text: text.join("\n"), files };
}

function textContent(value) {
  const limit = 100000;
  let text;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[工具结果已截断：原始 ${text.length} 字符，仅保留前 ${limit} 字符]`;
}

function tagPrefixLength(text, tag) {
  for (let length = tag.length - 1; length > 0; length--) if (text.endsWith(tag.slice(0, length))) return length;
  return 0;
}
