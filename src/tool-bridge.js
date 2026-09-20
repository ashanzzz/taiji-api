import { HttpError } from "./errors.js";
import { randomBytes } from "node:crypto";

export function createToolBridge(body, model, config) {
  if (body.tools === undefined) return null;
  if (!config.experimentalToolBridge) {
    throw new HttpError(400, "Experimental tool bridge is disabled. Enable it only for local Codex testing. This upstream has no native Function Calling.");
  }
  if (!config.toolBridgeAllowedModels.includes(model.value)) {
    throw new HttpError(400, `Experimental tool bridge is not enabled for ${model.value}`);
  }
  const tools = normalizeTools(body.tools, config.toolBridgeMaxTools);
  const choice = normalizeToolChoice(body.tool_choice, tools);
  return {
    tools,
    choice,
    maxCalls: config.toolBridgeMaxCalls,
    maxRepairAttempts: config.toolBridgeMaxRepairAttempts ?? 1,
  };
}

export function normalizeToolChoice(choice, tools) {
  if (choice === undefined || choice === "auto") return { mode: "auto" };
  if (choice === "none") return { mode: "none" };
  if (choice === "required") return { mode: "required" };
  const name = choice?.function?.name;
  if (choice?.type === "function" && typeof name === "string" && tools.some((t) => t.function.name === name)) {
    return { mode: "forced", name };
  }
  throw new HttpError(400, "tool_choice must be \"auto\", \"none\", \"required\", or reference a submitted function");
}

export function validateToolHistory(messages, bridge) {
  if (!bridge) {
    if (messages.some((message) => message.role === "tool" || message.tool_calls)) {
      throw new HttpError(400, "Tool history requires the experimental tool bridge");
    }
    return new Map();
  }
  const allowedNames = new Set(bridge.tools.map((tool) => tool.function.name));
  const calls = new Map();
  for (const message of messages) {
    if (message.tool_calls) {
      if (!Array.isArray(message.tool_calls)) throw new HttpError(400, "tool_calls must be an array");
      for (const call of message.tool_calls) {
        const name = call?.function?.name;
        const id = call?.id;
        if (!id || !allowedNames.has(name)) throw new HttpError(400, "Tool-call history contains an unapproved tool");
        if (calls.has(id)) throw new HttpError(400, `Duplicate tool_call_id: ${id}`);
        calls.set(id, name);
      }
    }
    if (message.role === "tool") {
      if (!calls.has(message.tool_call_id)) throw new HttpError(400, "Tool result has no matching tool_call_id");
      if (message.name && message.name !== calls.get(message.tool_call_id)) throw new HttpError(400, "Tool result name does not match tool_call_id");
    }
  }
  return calls;
}

export function buildToolPrompt(bridge) {
  if (!bridge) return "";
  if (bridge.choice?.mode === "none") {
    return "【本地实验性工具桥接】\n本轮对话已禁用工具调用。你严禁输出任何工具调用标记、JSON 或工具指令，必须直接以普通文本回复用户。\n\n";
  }

  const toolDefs = JSON.stringify(bridge.tools, null, 2);
  let choiceInstruction = "如需调用工具，必须输出 <TOOL_CALL> 指令；若无需工具，请直接回复普通文本。";
  if (bridge.choice?.mode === "required") {
    choiceInstruction = "【特别要求】本轮对话你必须调用至少一个工具，严禁直接输出普通文本回答。必须输出 <TOOL_CALL> 指令。";
  } else if (bridge.choice?.mode === "forced") {
    choiceInstruction = `【特别要求】本轮对话你必须且仅能调用工具 "${bridge.choice.name}"，严禁调用其他工具，严禁直接输出普通文本回答。必须输出 <TOOL_CALL> 指令。`;
  }

  return `【本地实验性工具桥接】
你不是原生 Function Calling 模型。你只能用统一标记表达工具调用意图。
可用工具定义如下：
${toolDefs}

${choiceInstruction}
如需工具，必须严格输出如下格式，包含在 <TOOL_CALL> 和 </TOOL_CALL> 之间：
<TOOL_CALL>
{"tool_calls":[{"name":"工具名称","arguments":{"参数名":"参数值"}}]}
</TOOL_CALL>
禁止在标记内添加 Markdown 代码块或额外解释。每轮最多 ${bridge.maxCalls} 个工具调用，参数必须严格符合工具的 parameters JSON Schema。
工具执行由客户端完成。工具返回后，请根据返回结果继续普通回答。\n\n`;
}

export function buildRepairPrompt(reason, bridge) {
  let targetRule = "";
  if (bridge.choice?.mode === "forced") {
    targetRule = `必须且只能调用工具 "${bridge.choice.name}"。`;
  } else if (bridge.choice?.mode === "required") {
    targetRule = "必须调用至少一个可用工具。";
  }
  return `【系统提示：工具调用格式或参数修复】
你上一条回复试图调用工具，但未能通过协议校验，具体原因：
${reason}

请重新输出正确的工具调用。严格遵循以下规则：
1. 必须完全包裹在 <TOOL_CALL> 和 </TOOL_CALL> 之间。
2. 内部必须是纯 JSON 对象，格式为：{"tool_calls":[{"name":"工具名称","arguments":{...}}]}
3. 参数必须严格符合工具的 JSON Schema 定义。
4. 严禁添加任何解释、Markdown 代码块或多余文本。${targetRule ? "\n5. " + targetRule : ""}`;
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
    if (bridge.choice?.mode === "required") {
      return { status: "error", reason: "tool_choice is \"required\", but model returned plain text without tool calls" };
    }
    if (bridge.choice?.mode === "forced") {
      return { status: "error", reason: `tool_choice forced "${bridge.choice.name}", but model returned plain text without tool calls` };
    }
    return { status: "text", text: source };
  }

  const payload = extractToolPayload(source);
  if (!payload) {
    return { status: "error", reason: "Detected tool intent, but could not extract JSON payload" };
  }

  const parseResult = tryParseJson(payload);
  if (!parseResult.success) {
    return { status: "error", reason: `Invalid JSON in tool payload: ${parseResult.error}` };
  }

  const data = parseResult.data;
  const rawCalls = data?.tool_calls || (Array.isArray(data) ? data : null);
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
    return { status: "error", reason: "tool_calls must be a non-empty array" };
  }

  const maxCalls = bridge.maxCalls || 1;
  if (rawCalls.length > maxCalls) {
    return { status: "error", reason: `Number of tool calls (${rawCalls.length}) exceeds maximum allowed (${maxCalls})` };
  }

  const toolMap = new Map(bridge.tools.map((t) => [t.function.name, t]));
  const calls = [];

  for (const rawCall of rawCalls) {
    const res = toOpenAiCall(rawCall, toolMap, bridge);
    if (res.error) {
      return { status: "error", reason: res.error };
    }
    calls.push(res.call);
  }

  return { status: "calls", calls };
}

export function extractBridgeToolCalls(text, bridge) {
  const analysis = analyzeBridgeOutput(text, bridge);
  return analysis.status === "calls" ? analysis.calls : null;
}

export function validateSchema(value, schema, path = "") {
  if (!schema || typeof schema !== "object") return { valid: true };

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const match = types.some((type) => checkType(value, type));
    if (!match) {
      return { valid: false, error: `${path || "value"} must be of type ${types.join(" or ")}, got ${actualType(value)}` };
    }
  }

  if (value === null) return { valid: true };

  if (Array.isArray(schema.enum)) {
    const match = schema.enum.some((item) => deepEqual(item, value));
    if (!match) {
      return { valid: false, error: `${path || "value"} must be one of ${JSON.stringify(schema.enum)}` };
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return { valid: false, error: `${path || "string"} length ${value.length} is less than minLength ${schema.minLength}` };
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return { valid: false, error: `${path || "string"} length ${value.length} is greater than maxLength ${schema.maxLength}` };
    }
    if (typeof schema.pattern === "string") {
      if (!new RegExp(schema.pattern).test(value)) {
        return { valid: false, error: `${path || "string"} does not match pattern ${schema.pattern}` };
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return { valid: false, error: `${path || "number"} ${value} is less than minimum ${schema.minimum}` };
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return { valid: false, error: `${path || "number"} ${value} is greater than maximum ${schema.maximum}` };
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      return { valid: false, error: `${path || "number"} ${value} must be strictly greater than ${schema.exclusiveMinimum}` };
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      return { valid: false, error: `${path || "number"} ${value} must be strictly less than ${schema.exclusiveMaximum}` };
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return { valid: false, error: `${path || "array"} length ${value.length} is less than minItems ${schema.minItems}` };
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return { valid: false, error: `${path || "array"} length ${value.length} is greater than maxItems ${schema.maxItems}` };
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemRes = validateSchema(value[i], schema.items, `${path}[${i}]`);
        if (!itemRes.valid) return itemRes;
      }
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value) || value[req] === undefined) {
          return { valid: false, error: `Missing required property "${req}"` };
        }
      }
    }

    const properties = schema.properties || {};

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          return { valid: false, error: `Additional property "${key}" not allowed` };
        }
      }
    } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          const addRes = validateSchema(value[key], schema.additionalProperties, path ? `${path}.${key}` : key);
          if (!addRes.valid) return addRes;
        }
      }
    }

    for (const [propKey, propSchema] of Object.entries(properties)) {
      if (propKey in value && value[propKey] !== undefined) {
        const propRes = validateSchema(value[propKey], propSchema, path ? `${path}.${propKey}` : propKey);
        if (!propRes.valid) return propRes;
      }
    }
  }

  return { valid: true };
}

function normalizeTools(value, maximum) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) {
    throw new HttpError(400, `tools must contain 1–${maximum} function definitions`);
  }
  const names = new Set();
  return value.map((tool) => {
    const fn = tool?.function;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(fn.name)) {
      throw new HttpError(400, "Each tool requires a safe function name");
    }
    if (names.has(fn.name)) throw new HttpError(400, "Tool function names must be unique");
    names.add(fn.name);
    if (fn.parameters !== undefined && (!fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters))) {
      throw new HttpError(400, "Tool parameters must be a JSON Schema object");
    }
    return {
      type: "function",
      function: {
        name: fn.name,
        description: String(fn.description || "").slice(0, 2000),
        parameters: fn.parameters || { type: "object", properties: {} },
      },
    };
  });
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
  if (markerMatch && markerMatch[1].trim()) {
    return cleanPayload(markerMatch[1]);
  }
  const fencedMatch = /\`\`\`(?:json)?\s*(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*\`\`\`/i.exec(text);
  if (fencedMatch && fencedMatch[1].trim()) {
    return cleanPayload(fencedMatch[1]);
  }
  const markerIdx = text.indexOf(`"tool_calls"`);
  if (markerIdx >= 0) {
    const start = text.lastIndexOf("{", markerIdx);
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return cleanPayload(text.slice(start, end + 1));
    }
  }
  return null;
}

function cleanPayload(raw) {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/i, "").trim();
  return cleaned;
}

function tryParseJson(text) {
  try {
    return { success: true, data: JSON.parse(text) };
  } catch (err) {
    try {
      const repaired = repairJsonText(text);
      return { success: true, data: JSON.parse(repaired) };
    } catch {
      return { success: false, error: err.message };
    }
  }
}

function repairJsonText(text) {
  let repaired = text.replace(/,\s*([\]}])/g, "$1");
  let inString = false;
  let escape = false;
  let out = "";
  const stack = [];

  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escape) {
      escape = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      out += ch;
      continue;
    }
    if (ch === `"`) {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString) {
      if (ch === "{") {
        stack.push("}");
        out += ch;
      } else if (ch === "[") {
        stack.push("]");
        out += ch;
      } else if (ch === "}" || ch === "]") {
        if (stack.length && stack[stack.length - 1] === ch) {
          stack.pop();
          out += ch;
        } else if (ch === "}" && stack.length && stack[stack.length - 1] === "]" && stack.includes("}")) {
          while (stack.length && stack[stack.length - 1] === "]") {
            out += "]";
            stack.pop();
          }
          if (stack.length && stack[stack.length - 1] === "}") {
            stack.pop();
            out += "}";
          }
        } else {
          out += ch;
        }
      } else {
        out += ch;
      }
    } else {
      out += ch;
    }
  }

  if (inString) out += `"`;
  while (stack.length) {
    out += stack.pop();
  }
  return out;
}

function toOpenAiCall(call, toolMap, bridge) {
  const name = call?.name || call?.function?.name;
  if (typeof name !== "string") return { error: "Tool call missing function name" };
  const tool = toolMap.get(name);
  if (!tool) return { error: `Tool "${name}" is not in the allowed tools list` };
  if (bridge.choice?.mode === "forced" && name !== bridge.choice.name) {
    return { error: `Tool "${name}" does not match forced tool "${bridge.choice.name}"` };
  }

  const rawArguments = call?.arguments ?? call?.function?.arguments ?? {};
  let argObj;
  if (typeof rawArguments === "string") {
    try {
      argObj = JSON.parse(rawArguments);
    } catch {
      try {
        argObj = JSON.parse(repairJsonText(rawArguments));
      } catch {
        return { error: `Tool "${name}" arguments is not valid JSON string` };
      }
    }
  } else if (typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)) {
    argObj = rawArguments;
  } else {
    return { error: `Tool "${name}" arguments must be an object` };
  }

  const schema = tool.function.parameters || { type: "object", properties: {} };
  const valResult = validateSchema(argObj, schema);
  if (!valResult.valid) {
    return { error: `Tool "${name}" arguments validation failed: ${valResult.error}` };
  }

  return {
    call: {
      id: `call_${randomBytes(9).toString("hex")}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(argObj),
      },
    },
  };
}

function checkType(val, type) {
  switch (type) {
    case "string": return typeof val === "string";
    case "number": return typeof val === "number" && Number.isFinite(val);
    case "integer": return typeof val === "number" && Number.isInteger(val);
    case "boolean": return typeof val === "boolean";
    case "null": return val === null;
    case "array": return Array.isArray(val);
    case "object": return typeof val === "object" && val !== null && !Array.isArray(val);
    default: return true;
  }
}

function actualType(val) {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!keysB.includes(k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}
