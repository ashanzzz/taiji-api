import { randomUUID } from "node:crypto";
import { abortable } from "./cancellation.js";
import { HttpError } from "./errors.js";
import { validateRequest, reasoningOptions, buildTaijiInput, ThinkSplitter } from "./chat-format.js";
import { createToolBridge, analyzeBridgeOutput, buildRepairPrompt } from "./tool-bridge.js";
export { buildTaijiInput } from "./chat-format.js";

export class OpenAiAdapter {
  constructor(client, config, log) { this.client = client; this.config = config; this.log = log; }

  async listModels() {
    const catalog = await this.client.getModels();
    return { object: "list", data: catalog.models.map((model) => ({
      id: model.value, object: "model", created: 0, owned_by: model.attr?.providerKey || "taiji",
    })) };
  }

  async prepare(body, signal) {
    validateRequest(body);
    signal?.throwIfAborted();
    const model = await abortable(this.client.resolveModel(body.model, signal), signal);
    const bridge = createToolBridge(body, model, this.config);
    const input = buildTaijiInput(body.messages, bridge);
    if (input.files.length && !model.attr?.capabilities?.imageInput) throw new Error("This model does not declare image input");
    const session = await abortable(this.client.createSession(model), signal, (late) => this.cleanup(late.id));
    return {
      id: `chatcmpl-${randomUUID()}`,
      model: model.value,
      sessionId: session.id,
      bridge,
      payload: {
        text: input.text,
        sessionId: session.id,
        files: input.files,
        ...reasoningOptions(body, model),
        webSearch: Boolean(body.web_search),
        nativeTools: [],
        nativeToolOptions: {},
      },
    };
  }

  async complete(body, signal) {
    const request = await this.prepare(body, signal);
    try {
      const { output, analysis } = await this.collectAndResolve(request, signal);
      return completionResponse(request, output, analysis);
    } finally {
      await this.cleanup(request.sessionId);
    }
  }

  async stream(body, signal, write) {
    const request = await this.prepare(body, signal);
    const base = envelope(request, "chat.completion.chunk");
    try {
      if (request.bridge) {
        const { output, analysis } = await this.collectAndResolve(request, signal);
        await emitBufferedBridge(write, base, output, analysis, body.stream_options?.include_usage);
      } else {
        await emitNativeTextStream(this.client.chat(request.payload, signal), write, base, body.stream_options?.include_usage);
      }
      await write("data: [DONE]\n\n");
    } finally {
      await this.cleanup(request.sessionId);
    }
  }

  async collectAndResolve(request, signal) {
    let output = await this.collect(request, signal);
    if (!request.bridge) {
      return { output, analysis: { status: "text", text: output.parts.content } };
    }

    let analysis = analyzeBridgeOutput(output.parts.content, request.bridge);
    if (analysis.status === "error" && request.bridge.maxRepairAttempts > 0) {
      this.log?.add("tool-bridge", "Tool call validation failed, attempting 1 repair", {
        reason: analysis.reason,
        content: output.parts.content.slice(0, 300),
      }, "warn");

      try {
        const repairPrompt = buildRepairPrompt(analysis.reason, request.bridge);
        const repairPayload = {
          ...request.payload,
          text: repairPrompt,
          files: [],
        };
        const repairOutput = await this.collect({ ...request, payload: repairPayload }, signal);
        const repairAnalysis = analyzeBridgeOutput(repairOutput.parts.content, request.bridge);
        if (repairAnalysis.status === "calls") {
          output = repairOutput;
          analysis = repairAnalysis;
        } else if (repairAnalysis.status === "text" && request.bridge.choice?.mode === "auto") {
          output = repairOutput;
          analysis = repairAnalysis;
        } else {
          const finalReason = repairAnalysis.reason || analysis.reason;
          throw new HttpError(502, `Tool bridge failed after repair: ${finalReason}`, { code: "tool_parse_error" });
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `Tool bridge failed: ${analysis.reason}`, { code: "tool_parse_error" });
      }
    } else if (analysis.status === "error") {
      throw new HttpError(502, `Tool bridge failed: ${analysis.reason}`, { code: "tool_parse_error" });
    }

    return { output, analysis };
  }

  async collect(request, signal) {
    const parts = { content: "", reasoning_content: "" };
    let meta = {};
    const splitter = new ThinkSplitter();
    for await (const event of this.client.chat(request.payload, signal)) {
      if (event.kind === "meta") meta = event.data;
      else for (const part of splitter.push(event.text)) append(parts, part);
    }
    for (const part of splitter.push("", true)) append(parts, part);
    return { parts, meta };
  }

  async cleanup(sessionId) {
    if (!this.config.deleteTempSessions) return;
    try { await this.client.deleteSession(sessionId); }
    catch { this.log?.add("cleanup", "Temporary session cleanup failed", { sessionId }, "warn"); }
  }
}

function completionResponse(request, output, analysis) {
  const isCalls = analysis.status === "calls";
  const message = { role: "assistant", content: isCalls ? null : output.parts.content };
  if (isCalls) message.tool_calls = analysis.calls;
  if (output.parts.reasoning_content) message.reasoning_content = output.parts.reasoning_content;
  return {
    ...envelope(request, "chat.completion"),
    choices: [{ index: 0, message, finish_reason: isCalls ? "tool_calls" : finishReason(output.meta) }],
    usage: usage(output.meta),
  };
}

async function emitBufferedBridge(write, base, output, analysis, includeUsage) {
  const emit = (delta, reason = null) => write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  await emit({ role: "assistant", content: "" });
  if (output.parts.reasoning_content) await emit({ reasoning_content: output.parts.reasoning_content });
  if (analysis.status === "calls") {
    const streamedCalls = analysis.calls.map((call, index) => ({
      index,
      ...call,
    }));
    await emit({ tool_calls: streamedCalls });
    await emit({}, "tool_calls");
  } else {
    await emit({ content: output.parts.content });
    await emit({}, finishReason(output.meta));
  }
  if (includeUsage) await write(`data: ${JSON.stringify({ ...base, choices: [], usage: usage(output.meta) })}\n\n`);
}

async function emitNativeTextStream(events, write, base, includeUsage) {
  const splitter = new ThinkSplitter();
  let meta = {};
  let opened = false;
  const emit = (delta, reason = null) => write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  for await (const event of events) {
    if (event.kind === "meta") { meta = event.data; continue; }
    if (!opened) { await emit({ role: "assistant", content: "" }); opened = true; }
    for (const part of splitter.push(event.text)) await emit(part);
  }
  if (!opened) await emit({ role: "assistant", content: "" });
  for (const part of splitter.push("", true)) await emit(part);
  await emit({}, finishReason(meta));
  if (includeUsage) await write(`data: ${JSON.stringify({ ...base, choices: [], usage: usage(meta) })}\n\n`);
}

function append(target, source) { for (const [key, value] of Object.entries(source)) target[key] += value; }
function envelope(request, object) { return { id: request.id, object, created: Math.floor(Date.now() / 1000), model: request.model }; }
function finishReason(meta) { return ["stop", "length", "content_filter"].includes(meta.finish_reason) ? meta.finish_reason : "stop"; }
function usage(meta) { return { prompt_tokens: Number(meta.promptTokens || 0), completion_tokens: Number(meta.completionTokens || 0), total_tokens: Number(meta.useTokens || 0) }; }
