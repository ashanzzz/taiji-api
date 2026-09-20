import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { buildTaijiInput, reasoningOptions, validateRequest, ThinkSplitter } from '../src/chat-format.js';
import { parseSse } from '../src/sse.js';
import { OpenAiAdapter } from '../src/openai-adapter.js';
import { TaijiClient } from '../src/taiji-client.js';

const stream = chunks => Readable.toWeb(Readable.from(chunks.map(c => Buffer.from(c))));

test('messages retain roles and base64 images', () => {
  const input = buildTaijiInput([{ role: 'system', content: 'concise' }, { role: 'user', content: [
    { type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ] }]);
  assert.match(input.text, /【系统】\nconcise/);
  assert.equal(input.files.length, 1);
});
test('remote image URLs are explicitly rejected instead of becoming text', () => {
  assert.throws(() => buildTaijiInput([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://localhost/x' } }] }]), /base64/);
});
test('unsupported parameters are not silently discarded', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }] };
  for (const key of ['max_tokens', 'temperature', 'tools']) assert.throws(() => validateRequest({ ...body, [key]: 1 }));
  assert.throws(() => reasoningOptions({ reasoning_effort: 'high' }, {}), /not silently discarded/);
  assert.deepEqual(reasoningOptions({ reasoning_effort: 'high' }, { attr: { capabilities: { reasoningEfforts: ['high'] } } }), { thinking: true, reasoningEffort: 'high' });
});


test('parallel_tool_calls must be boolean', () => {
  assert.throws(() => validateRequest({ messages: [{ role: 'user', content: 'hello' }], parallel_tool_calls: 'false' }), /must be a boolean/);
});

test('SSE supports CRLF split at every byte including Unicode', async () => {
  const input = Buffer.from('data: {"data":"你好"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const body = Readable.toWeb(Readable.from([...input].map(b => Buffer.from([b]))));
  const events = [];
  for await (const event of parseSse(body)) events.push(event.data);
  assert.deepEqual(events, ['{"data":"你好"}', '[DONE]']);
});
test('SSE multiline and comments', async () => {
  const events = [];
  for await (const event of parseSse(stream([': heartbeat\ndata: a\ndata: b\n\n']))) events.push(event.data);
  assert.deepEqual(events, ['a\nb']);
});
test('think tags survive chunk boundaries', () => {
  const parser = new ThinkSplitter();
  const parts = ['<thi', 'nk>brief', '</th', 'ink>answer'].flatMap(x => parser.push(x));
  assert.deepEqual(parts, [{ reasoning_content: 'brief' }, { content: 'answer' }]);
});
function fakeClient(events) {
  return { deleted: [], resolveModel: async () => ({ value: 'demo' }), createSession: async () => ({ id: 42 }),
    async *chat() { for (const e of events) { if (e instanceof Error) throw e; yield e; } },
    async deleteSession(id) { this.deleted.push(id); } };
}
test('adapter creates and cleans sessions for non-stream and stream', async () => {
  const client = fakeClient([{ kind: 'delta', text: 'OK' }, { kind: 'meta', data: { promptTokens: 3, completionTokens: 1, useTokens: 4 } }]);
  const adapter = new OpenAiAdapter(client, { deleteTempSessions: true });
  const body = { messages: [{ role: 'user', content: 'test' }] };
  const result = await adapter.complete(body);
  assert.equal(result.choices[0].message.content, 'OK');
  assert.equal(result.usage.total_tokens, 4);
  let output = '';
  await adapter.stream({ ...body, stream_options: { include_usage: true } }, undefined, async x => { output += x; });
  assert.match(output, /chat.completion.chunk/); assert.match(output, /\[DONE\]/); assert.match(output, /"choices":\[\],"usage"/);
  assert.deepEqual(client.deleted, [42, 42]);
});
test('adapter cleans session on upstream failure', async () => {
  const client = fakeClient([new Error('fail')]);
  await assert.rejects(() => new OpenAiAdapter(client, { deleteTempSessions: true }).complete({ messages: [{ role: 'user', content: 'test' }] }));
  assert.deepEqual(client.deleted, [42]);
});
function upstream(fetcher) {
  const client = new TaijiClient({ fixedOrigin: 'https://example.com', trustedHosts: ['example.com'], requestTimeoutMs: 10000 }, fetcher);
  client.token = 'test-token'; return client;
}
test('upstream JSON error does not become a null body error', async () => {
  const client = upstream(async () => Response.json({ code: 1, msg: 'denied' }));
  await assert.rejects(async () => { for await (const _ of client.chat({})) {} }, /denied/);
});
test('upstream premature EOF is a failure', async () => {
  const client = upstream(async () => new Response(stream(['data: {"code":0,"data":"partial"}\n\n']), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(async () => { for await (const _ of client.chat({})) {} }, /without \[DONE\]/);
});
test('failed POST is never replayed', async () => {
  let calls = 0;
  const client = upstream(async () => { calls++; throw new Error('network'); });
  await assert.rejects(() => client.createSession({ value: 'demo' })); assert.equal(calls, 1);
});

test('authentication failure never replays a POST', async () => {
  let calls = 0;
  const client = upstream(async () => { calls++; return Response.json({ code: 2, msg: 'expired' }); });
  await assert.rejects(() => client.requestJson('/gift_sign', { method: 'POST' }));
  assert.equal(calls, 1); assert.equal(client.token, null);
});
test('multiline SSE events have a cumulative size cap', async () => {
  await assert.rejects(async () => {
    for await (const _ of parseSse(stream(Array.from({ length: 6 }, () => `data: ${'a'.repeat(800000)}\n`)))) {}
  }, /event too large/);
});
test('cancelled session creation releases caller and cleans late session', async () => {
  const controller = new AbortController(); let resolveSession;
  const client = fakeClient([]);
  client.createSession = () => new Promise(resolve => { resolveSession = resolve; });
  const adapter = new OpenAiAdapter(client, { deleteTempSessions: true });
  const work = adapter.complete({ messages: [{ role: 'user', content: 'test' }] }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
  await assert.rejects(() => work);
  resolveSession({ id: 42 });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(client.deleted, [42]);
});

test('adapter stream emits tool_calls with index', async () => {
  const toolJson = '<TOOL_CALL>\n{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"dir"}}]}\n</TOOL_CALL>';
  const client = fakeClient([
    { kind: 'delta', text: toolJson },
    { kind: 'meta', data: { promptTokens: 5, completionTokens: 10, useTokens: 15 } },
  ]);
  const adapter = new OpenAiAdapter(client, {
    experimentalToolBridge: true,
    toolBridgeAllowedModels: ['demo'],
    toolBridgeMaxTools: 8,
    toolBridgeMaxCalls: 2,
    deleteTempSessions: true,
  });
  const body = {
    model: 'demo',
    messages: [{ role: 'user', content: 'run dir' }],
    tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
  };
  let output = '';
  await adapter.stream(body, undefined, async (chunk) => { output += chunk; });
  assert.match(output, /"index":0/);
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.match(output, /\[DONE\]/);
});

test('adapter complete returns tool_calls and finish_reason', async () => {
  const toolJson = '<TOOL_CALL>\n{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"dir"}}]}\n</TOOL_CALL>';
  const client = fakeClient([
    { kind: 'delta', text: toolJson },
    { kind: 'meta', data: { promptTokens: 5, completionTokens: 10, useTokens: 15 } },
  ]);
  const adapter = new OpenAiAdapter(client, {
    experimentalToolBridge: true,
    toolBridgeAllowedModels: ['demo'],
    toolBridgeMaxTools: 8,
    toolBridgeMaxCalls: 2,
    deleteTempSessions: true,
  });
  const body = {
    model: 'demo',
    messages: [{ role: 'user', content: 'run dir' }],
    tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
  };
  const res = await adapter.complete(body);
  assert.equal(res.choices[0].finish_reason, 'tool_calls');
  assert.equal(res.choices[0].message.content, null);
  assert.equal(res.choices[0].message.tool_calls.length, 1);
  assert.equal(res.choices[0].message.tool_calls[0].function.name, 'exec_command');
});

test('explicit tool intent with invalid syntax triggers repair and succeeds if repaired', async () => {
  const invalidJson = '<TOOL_CALL>\n{"tool_calls":[{"name":"exec_command","arguments":{"cmd":123}}]}\n</TOOL_CALL>';
  const validJson = '<TOOL_CALL>\n{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"dir"}}]}\n</TOOL_CALL>';

  let turns = 0;
  const client = {
    deleted: [],
    resolveModel: async () => ({ value: 'demo' }),
    createSession: async () => ({ id: 42 }),
    async *chat() {
      turns++;
      const text = turns === 1 ? invalidJson : validJson;
      yield { kind: 'delta', text };
      yield { kind: 'meta', data: { promptTokens: 5, completionTokens: 10, useTokens: 15 } };
    },
    async deleteSession(id) { this.deleted.push(id); },
  };
  const adapter = new OpenAiAdapter(client, {
    experimentalToolBridge: true,
    toolBridgeAllowedModels: ['demo'],
    toolBridgeMaxTools: 8,
    toolBridgeMaxCalls: 2,
    deleteTempSessions: true,
  });
  const body = {
    model: 'demo',
    messages: [{ role: 'user', content: 'run dir' }],
    tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
  };
  const res = await adapter.complete(body);
  assert.equal(turns, 2);
  assert.equal(res.choices[0].finish_reason, 'tool_calls');
  assert.equal(res.choices[0].message.tool_calls[0].function.arguments, '{"cmd":"dir"}');
});

test('explicit tool intent fails with 502 tool_parse_error when unrepairable', async () => {
  const invalidJson = '<TOOL_CALL>not json at all</TOOL_CALL>';
  const client = fakeClient([
    { kind: 'delta', text: invalidJson },
    { kind: 'meta', data: {} },
  ]);
  const adapter = new OpenAiAdapter(client, {
    experimentalToolBridge: true,
    toolBridgeAllowedModels: ['demo'],
    toolBridgeMaxTools: 8,
    toolBridgeMaxCalls: 2,
    toolBridgeMaxRepairAttempts: 0,
    deleteTempSessions: true,
  });
  const body = {
    model: 'demo',
    messages: [{ role: 'user', content: 'run dir' }],
    tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
  };
  await assert.rejects(() => adapter.complete(body), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.details?.code, 'tool_parse_error');
    return true;
  });
});


test('tool_choice=none strips accidental tool-call markers from returned content', async () => {
  const raw = '<TOOL_CALL>{"tool_calls":[{"name":"exec_command","arguments":{}}]}</TOOL_CALL>Safe plain reply';
  const client = fakeClient([{ kind: 'delta', text: raw }, { kind: 'meta', data: {} }]);
  const adapter = new OpenAiAdapter(client, {
    experimentalToolBridge: true,
    toolBridgeAllowedModels: ['demo'],
    toolBridgeMaxTools: 8,
    toolBridgeMaxCalls: 2,
    deleteTempSessions: true,
  });
  const res = await adapter.complete({
    model: 'demo',
    messages: [{ role: 'user', content: 'answer without tools' }],
    tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
    tool_choice: 'none',
  });
  assert.equal(res.choices[0].message.content, 'Safe plain reply');
  assert.equal(res.choices[0].finish_reason, 'stop');
});
