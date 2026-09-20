import { randomBytes } from "node:crypto";
import { HttpError } from "./errors.js";
import { assertJsonSchema, validateJsonSchema } from "./schema-validator.js";

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SCHEMA_CHARS = 131072;
const MAX_TOOL_PAYLOAD_CHARS = 1048576;

export function createToolBridge(body, model, config) {
  if (body.tools === undefined) return null;
  if (!Array.isArray(body.tools)) throw new HttpError(400, "tools must be an array");
  if (body.tools.length === 0) {
    const choice = normalizeToolChoice(body.tool_choice, []);
    if (!["auto", "none"].includes(choice.mode)) throw new HttpError(400, "tool_choice requires at least one submitted tool");
    return null;
  }
  if (!config.experimentalToolBridge) {
    throw new HttpError(400, "Experimental tool bridge is disabled. Enable it only for local testing. This upstream has no native Function Calling.");
  }
  if (!config.toolBridgeAllowedModels.includes(model.value)) {
    throw new HttpError(400, `Experimental tool bridge is not enabled for ${model.value}`);
  }

  const tools = normalizeTools(body.tools, config.toolBridgeMaxTools);
  const choice = normalizeToolChoice(body.tool_choice, tools);
  const configuredMaxCalls = config.toolBridgeMaxCalls || 1;
  const maxCalls = body.parallel_tool_calls === false || choice.mode === "forced"
    ? 1
    : configuredMaxCalls;

  return {
    tools,
    choice,
    maxCalls,
    parallelToolCalls: body.parallel_tool_calls !== false,
    maxRepairAttempts: config.toolBridgeMaxRepairAttempts ?? 1,
  };
}

export function normalizeToolChoice(choice, tools) {
  if (choice === undefined || choice === "auto") return { mode: "auto" };
  if (choice === "none") return { mode: "none" };
  if (choice === "required") return { mode: "required" };

  if (choice?.type === "allowed_tools") {
    const block = choice.allowed_tools && typeof choice.allowed_tools === "object" ? choice.allowed_tools : choice;
    const mode = block.mode;
    const submitted = new Set(tools.map((tool) => tool.function.name));
    if (!["auto", "required"].includes(mode) || !Array.isArray(block.tools) || block.tools.length === 0) {
      throw new HttpError(400, "allowed_tools requires mode auto|required and a non-empty tools list");
    }
    const names = [];
    const seen = new Set();
    for (const item of block.tools) {
      const name = item?.name ?? item?.function?.name;
      if (item?.type !== "function" || typeof name !== "string" || !submitted.has(name)) {
        throw new HttpError(400, "allowed_tools may only reference submitted function tools");
      }
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return { mode: "allowed", names, requireCall: mode === "required" };
  }

  const name = choice?.function?.name ?? choice?.name;
  if (choice?.type === "function" && typeof name === "string" && tools.some((tool) => tool.function.name === name)) {
    return { mode: "forced", name };
  }
  throw new HttpError(400, "tool_choice must be auto, none, required, allowed_tools, or reference a submitted function");
}

export function validateToolHistory(messages, bridge = null) {
  const calls = new Map();
  for (const message of messages) {
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new HttpError(400, "tool_calls must be an array");
      for (const call of message.tool_calls) {
        const name = call?.function?.name;
        const id = call?.id;
        if (call?.type !== undefined && call.type !== "function") throw new HttpError(400, "Only function tool-call history is supported");
        if (typeof id !== "string" || !id || typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
          throw new HttpError(400, "Tool-call history contains an invalid function call");
        }
        if (calls.has(id)) throw new HttpError(400, `Duplicate tool_call_id: ${id}`);
        calls.set(id, name);
      }
    }
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !calls.has(message.tool_call_id)) {
        throw new HttpError(400, "Tool result has no matching tool_call_id");
      }
      if (message.name && message.name !== calls.get(message.tool_call_id)) {
        throw new HttpError(400, "Tool result name does not match tool_call_id");
      }
    }
  }
  return calls;
}

export function buildToolPrompt(bridge) {
  if (!bridge) return "";
  if (bridge.choice?.mode === "none") {
    return "【工具兼容层】\n本轮对话已禁用工具调用。不要输出任何工具调用标记、工具 JSON 或工具指令，直接用普通文本回答。\n\n";
  }

  const toolDefs = JSON.stringify(bridge.tools, null, 2);
  let choiceInstruction = "可自行决定是否调用工具。如果不需要工具，直接回复普通文本。";
  if (bridge.choice?.mode === "required") {
    choiceInstruction = "本轮对话你必须调用至少一个工具，不能直接给出最终文本回答。";
  } else if (bridge.choice?.mode === "forced") {
    choiceInstruction = `本轮必须且只能调用工具 \"${bridge.choice.name}\"，并且只能调用一次。`;
  } else if (bridge.choice?.mode === "allowed") {
    const names = bridge.choice.names.join(", ");
    choiceInstruction = bridge.choice.requireCall
      ? `本轮必须调用至少一个工具，并且只能从以下工具中选择：${names}。`
      : `本轮只能调用以下工具：${names}。如不需要工具，可以直接回复普通文本。`;
  }

  return `【工具兼容层】
上游模型没有原生 Function Calling。你必须使用下面的统一协议表达工具调用意图。
可用工具定义：
${toolDefs}

${choiceInstruction}
需要调用工具时，只输出下面的结构。工具调用必须完整包含在 <TOOL_CALL> 和 </TOOL_CALL> 之间：
<TOOL_CALL>
{"tool_calls":[{"name":"工具名称","arguments":{"参数名":"参数值"}}]}
</TOOL_CALL>
标记内部只能包含 JSON，不要使用 Markdown 代码块，不要添加解释。每轮最多 ${bridge.maxCalls} 个工具调用。arguments 必须符合对应 parameters JSON Schema。函数 strict=true 时同样必须严格满足其 Schema。
工具由客户端执行。客户端返回工具结果后，再根据结果继续回答。\n\n`;
}

export function buildRepairPrompt(reason, bridge) {
  let targetRule = "";
  if (bridge.choice?.mode === "forced") {
    targetRule = `必须且只能调用工具 \"${bridge.choice.name}\"。`;
  } else if (bridge.choice?.mode === "required") {
    targetRule = "必须调用至少一个可用工具。";
  } else if (bridge.choice?.mode === "allowed") {
    targetRule = `只能调用这些工具：${bridge.choice.names.join(", ")}。${bridge.choice.requireCall ? "至少调用一个。" : ""}`;
  }
  return `【系统提示：工具调用修复】
上一条回复试图调用工具，但没有通过协议校验：
${reason}

请重新输出正确的工具调用。
1. 必须完全包裹在 <TOOL_CALL> 和 </TOOL_CALL> 之间。
2. 内部必须是纯 JSON：{"tool_calls":[{"name":"工具名称","arguments":{...}}]}
3. arguments 必须符合对应工具的 JSON Schema。
4. 不要添加解释、Markdown 代码块或额外文本。${targetRule ? `\n5. ${targetRule}` : ""}`;
}

export function analyzeBridgeOutput(text, bridge) {
  if (!bridge) return { status: "text", text: text || "" };
  const source = text || "";

  if (bridge.choice?.mode === "none") {
    const sanitized = source.replace(/<TOOL_CALL>[\s\S]*?<\/TOOL_CALL>/gi, "").trim();
    return { status: "text", text: sanitized };
  }

  const hasIntent = detectToolIntent(source);
  if (!hasIntent) {
    if (choiceRequiresCall(bridge.choice)) {
      return { status: "error", reason: `tool_choice ${describeChoice(bridge.choice)} requires a tool call, but the model returned plain text` };
    }
    return { status: "text", text: source };
  }

  const payload = extractToolPayload(source);
  if (!payload) return { status: "error", reason: "Detected tool intent, but could not extract JSON payload" };
  if (payload.length > MAX_TOOL_PAYLOAD_CHARS) return { status: "error", reason: "Tool payload exceeds parser size limit" };

  const parseResult = tryParseJson(payload);
  if (!parseResult.success) return { status: "error", reason: `Invalid JSON in tool payload: ${parseResult.error}` };

  const data = parseResult.data;
  const rawCalls = data?.tool_calls || (Array.isArray(data) ? data : null);
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return { status: "error", reason: "tool_calls must be a non-empty array" };
  if (rawCalls.length > (bridge.maxCalls || 1)) {
    return { status: "error", reason: `Number of tool calls (${rawCalls.length}) exceeds maximum allowed (${bridge.maxCalls || 1})` };
  }

  const toolMap = new Map(bridge.tools.map((tool) => [tool.function.name, tool]));
  const calls = [];
  for (const rawCall of rawCalls) {
    const result = toOpenAiCall(rawCall, toolMap, bridge);
    if (result.error) return { status: "error", reason: result.error };
    calls.push(result.call);
  }
  return { status: "calls", calls };
}

export function extractBridgeToolCalls(text, bridge) {
  const analysis = analyzeBridgeOutput(text, bridge);
  return analysis.status === "calls" ? analysis.calls : null;
}

export function validateSchema(value, schema) {
  return validateJsonSchema(value, schema);
}

function normalizeTools(value, maximum) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) {
    throw new HttpError(400, `tools must contain 1–${maximum} function definitions`);
  }
  const names = new Set();
  return value.map((tool) => {
    const fn = tool?.function;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string" || !TOOL_NAME_RE.test(fn.name)) {
      throw new HttpError(400, "Each tool requires a function name containing only letters, numbers, underscores, or hyphens (max 64 chars)");
    }
    if (names.has(fn.name)) throw new HttpError(400, "Tool function names must be unique");
    names.add(fn.name);
    if (fn.strict !== undefined && typeof fn.strict !== "boolean") throw new HttpError(400, `Tool ${fn.name} strict must be boolean`);

    const parameters = fn.parameters ?? { type: "object", properties: {} };
    try {
      assertJsonSchema(parameters);
    } catch (error) {
      throw new HttpError(400, `Invalid JSON Schema for tool ${fn.name}: ${error.message}`);
    }
    let schemaText;
    try { schemaText = JSON.stringify(parameters); }
    catch { throw new HttpError(400, `Tool ${fn.name} parameters must be JSON-serializable`); }
    if (schemaText.length > MAX_SCHEMA_CHARS) throw new HttpError(400, `Tool ${fn.name} parameters schema is too large`);

    const normalized = {
      type: "function",
      function: {
        name: fn.name,
        description: String(fn.description || "").slice(0, 4000),
        parameters,
      },
    };
    if (fn.strict !== undefined) normalized.function.strict = fn.strict;
    return normalized;
  });
}

function choiceRequiresCall(choice) {
  return choice?.mode === "required" || choice?.mode === "forced" || (choice?.mode === "allowed" && choice.requireCall);
}

function describeChoice(choice) {
  if (choice?.mode === "forced") return `forced(${choice.name})`;
  if (choice?.mode === "allowed") return `allowed_tools(${choice.requireCall ? "required" : "auto"})`;
  return choice?.mode || "auto";
}

function detectToolIntent(text) {
  if (!text) return false;
  if (/<TOOL_CALL>/i.test(text)) return true;
  if (/"tool_calls"\s*:/i.test(text)) return true;
  if (/\`\`\`(?:json)?\s*\{[\s\S]*?"tool_calls"[\s\S]*?\}\s*\`\`\`/i.test(text)) return true;
  return false;
}

function extractToolPayload(text) {
  const markerMatch = /<TOOL_CALL>\s*([\s\S]*?)(?:<\/TOOL_CALL>|$)/i.exec(text);
  if (markerMatch?.[1]?.trim()) return cleanPayload(markerMatch[1]);

  const fencedMatch = /\`\`\`(?:json)?\s*(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*\`\`\`/i.exec(text);
  if (fencedMatch?.[1]?.trim()) return cleanPayload(fencedMatch[1]);

  const markerIndex = text.indexOf('"tool_calls"');
  if (markerIndex >= 0) {
    const range = enclosingJsonObject(text, markerIndex);
    if (range) return cleanPayload(text.slice(range.start, range.end));
  }
  return null;
}

function enclosingJsonObject(text, markerIndex) {
  for (let start = markerIndex; start >= 0; start--) {
    if (text[start] !== "{") continue;
    const end = matchingJsonEnd(text, start);
    if (end !== null && end > markerIndex) return { start, end: end + 1 };
  }
  return null;
}

function matchingJsonEnd(text, start) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index++) {
    const ch = text[index];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (!stack.length || stack.pop() !== ch) return null;
      if (!stack.length) return index;
    }
  }
  return null;
}

function cleanPayload(raw) {
  return raw.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/i, "").trim();
}

function tryParseJson(text) {
  try {
    return { success: true, data: JSON.parse(text) };
  } catch (error) {
    try {
      return { success: true, data: JSON.parse(repairJsonText(text)) };
    } catch {
      return { success: false, error: error.message };
    }
  }
}

function repairJsonText(text) {
  let repaired = text.replace(/,\s*([\]}])/g, "$1");
  let inString = false;
  let escape = false;
  let out = "";
  const stack = [];

  for (let index = 0; index < repaired.length; index++) {
    const ch = repaired[index];
    if (escape) { escape = false; out += ch; continue; }
    if (ch === "\\") { escape = true; out += ch; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (!inString) {
      if (ch === "{") { stack.push("}"); out += ch; }
      else if (ch === "[") { stack.push("]"); out += ch; }
      else if (ch === "}" || ch === "]") {
        if (stack.length && stack.at(-1) === ch) { stack.pop(); out += ch; }
        else if (ch === "}" && stack.length && stack.at(-1) === "]" && stack.includes("}")) {
          while (stack.length && stack.at(-1) === "]") { out += "]"; stack.pop(); }
          if (stack.length && stack.at(-1) === "}") { stack.pop(); out += "}"; }
        } else out += ch;
      } else out += ch;
    } else out += ch;
  }

  if (inString) out += '"';
  while (stack.length) out += stack.pop();
  return out;
}

function toOpenAiCall(call, toolMap, bridge) {
  const name = call?.name || call?.function?.name;
  if (typeof name !== "string") return { error: "Tool call missing function name" };
  const tool = toolMap.get(name);
  if (!tool) return { error: `Tool \"${name}\" is not in the submitted tools list` };
  if (bridge.choice?.mode === "forced" && name !== bridge.choice.name) {
    return { error: `Tool \"${name}\" does not match forced tool \"${bridge.choice.name}\"` };
  }
  if (bridge.choice?.mode === "allowed" && !bridge.choice.names.includes(name)) {
    return { error: `Tool \"${name}\" is not permitted by allowed_tools` };
  }

  const rawArguments = call?.arguments ?? call?.function?.arguments ?? {};
  let args;
  if (typeof rawArguments === "string") {
    try { args = JSON.parse(rawArguments); }
    catch {
      try { args = JSON.parse(repairJsonText(rawArguments)); }
      catch { return { error: `Tool \"${name}\" arguments is not a valid JSON string` }; }
    }
  } else if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    args = rawArguments;
  } else {
    return { error: `Tool \"${name}\" arguments must be an object` };
  }

  const validation = validateJsonSchema(args, tool.function.parameters || { type: "object", properties: {} });
  if (!validation.valid) return { error: `Tool \"${name}\" arguments validation failed: ${validation.error}` };

  return {
    call: {
      id: `call_${randomBytes(9).toString("hex")}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  };
}
