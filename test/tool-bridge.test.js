import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolBridge,
  extractBridgeToolCalls,
  analyzeBridgeOutput,
  buildToolPrompt,
  validateSchema,
  validateToolHistory,
} from '../src/tool-bridge.js';
import { buildTaijiInput } from '../src/chat-format.js';

const baseConfig = {
  experimentalToolBridge: true,
  toolBridgeAllowedModels: ['demo'],
  toolBridgeMaxTools: 8,
  toolBridgeMaxCalls: 1,
};

test('tool bridge accepts only configured functions and validates tool names', () => {
  const tools = [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, baseConfig);
  const calls = extractBridgeToolCalls('{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"dir"}}]}', bridge);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'exec_command');
  assert.equal(calls[0].function.arguments, '{"cmd":"dir"}');
  assert.throws(() => createToolBridge({ tools }, { value: 'demo' }, {
    ...baseConfig,
    experimentalToolBridge: false,
  }), /disabled/);
  assert.equal(extractBridgeToolCalls('{"tool_calls":[{"name":"not_allowed","arguments":{}}]}', bridge), null);
});

test('tool_choice=none disables tool calls and instructs model accordingly', () => {
  const tools = [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }];
  const bridge = createToolBridge({ tools, tool_choice: 'none' }, { value: 'demo' }, baseConfig);
  assert.equal(bridge.choice.mode, 'none');
  const prompt = buildToolPrompt(bridge);
  assert.match(prompt, /本轮对话已禁用工具调用/);
  // Even if model outputs <TOOL_CALL>, it should be stripped/ignored in none mode
  const res = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"exec_command","arguments":{}}}</TOOL_CALL>Plain reply', bridge);
  assert.equal(res.status, 'text');
  assert.equal(extractBridgeToolCalls('<TOOL_CALL>{"tool_calls":[{"name":"exec_command","arguments":{}}}</TOOL_CALL>', bridge), null);
});

test('tool_choice=required requires at least one valid tool call', () => {
  const tools = [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }];
  const bridge = createToolBridge({ tools, tool_choice: 'required' }, { value: 'demo' }, baseConfig);
  assert.equal(bridge.choice.mode, 'required');
  const prompt = buildToolPrompt(bridge);
  assert.match(prompt, /本轮对话你必须调用至少一个工具/);

  // Plain text without tool intent fails with error status
  const resText = analyzeBridgeOutput('I am just replying with plain text', bridge);
  assert.equal(resText.status, 'error');
  assert.match(resText.reason, /required/);

  // Valid tool call succeeds
  const resCall = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"exec_command","arguments":{}}}</TOOL_CALL>', bridge);
  assert.equal(resCall.status, 'calls');
  assert.equal(resCall.calls.length, 1);
});

test('tool_choice=forced enforces calling the specified function', () => {
  const tools = [
    { type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } },
  ];
  const bridge = createToolBridge({ tools, tool_choice: { type: 'function', function: { name: 'read_file' } } }, { value: 'demo' }, baseConfig);
  assert.equal(bridge.choice.mode, 'forced');
  assert.equal(bridge.choice.name, 'read_file');

  // Calling exec_command instead of read_file fails
  const wrongCall = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"exec_command","arguments":{}}}</TOOL_CALL>', bridge);
  assert.equal(wrongCall.status, 'error');
  assert.match(wrongCall.reason, /forced/);

  // Calling read_file succeeds
  const correctCall = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"read_file","arguments":{}}}</TOOL_CALL>', bridge);
  assert.equal(correctCall.status, 'calls');
  assert.equal(correctCall.calls[0].function.name, 'read_file');
});

test('JSON Schema validation enforces types, required properties, and additionalProperties', () => {
  const schema = {
    type: 'object',
    properties: {
      cmd: { type: 'string' },
      timeout: { type: 'integer', minimum: 1 },
    },
    required: ['cmd'],
    additionalProperties: false,
  };
  // Valid args
  assert.equal(validateSchema({ cmd: 'dir' }, schema).valid, true);
  assert.equal(validateSchema({ cmd: 'dir', timeout: 5 }, schema).valid, true);

  // Wrong type: cmd is number
  const wrongType = validateSchema({ cmd: 123 }, schema);
  assert.equal(wrongType.valid, false);
  assert.match(wrongType.error, /must be of type string/);

  // Missing required cmd
  const missingReq = validateSchema({ timeout: 5 }, schema);
  assert.equal(missingReq.valid, false);
  assert.match(missingReq.error, /Missing required property "cmd"/);

  // additionalProperties false rejects unexpected properties
  const extraProp = validateSchema({ cmd: 'dir', evil: true }, schema);
  assert.equal(extraProp.valid, false);
  assert.match(extraProp.error, /Additional property "evil" not allowed/);

  // Integrated through analyzeBridgeOutput
  const tools = [{ type: 'function', function: { name: 'exec_command', parameters: schema } }];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, baseConfig);

  const resWrong = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"exec_command","arguments":{"cmd": 123}}}</TOOL_CALL>', bridge);
  assert.equal(resWrong.status, 'error');
  assert.match(resWrong.reason, /must be of type string/);

  const resExtra = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"dir","evil":true}}}</TOOL_CALL>', bridge);
  assert.equal(resExtra.status, 'error');
  assert.match(resExtra.reason, /Additional property "evil" not allowed/);
});

test('extracts JSON arguments containing } and escaped quotes without truncation', () => {
  const tools = [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, baseConfig);

  // Arguments containing } character inside string
  const textWithBrace = '<TOOL_CALL>\n{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"echo } hi"}}]}\n</TOOL_CALL>';
  const resBrace = analyzeBridgeOutput(textWithBrace, bridge);
  assert.equal(resBrace.status, 'calls');
  assert.equal(JSON.parse(resBrace.calls[0].function.arguments).cmd, 'echo } hi');

  // Arguments containing escaped quotes
  const textWithQuotes = '<TOOL_CALL>\n{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"echo \\"hello\\""}}]}\n</TOOL_CALL>';
  const resQuotes = analyzeBridgeOutput(textWithQuotes, bridge);
  assert.equal(resQuotes.status, 'calls');
  assert.equal(JSON.parse(resQuotes.calls[0].function.arguments).cmd, 'echo "hello"');
});

test('supports multiple tool calls up to maxCalls and rejects excess calls', () => {
  const tools = [
    { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
  ];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, { ...baseConfig, toolBridgeMaxCalls: 2 });

  const twoCalls = '<TOOL_CALL>\n{"tool_calls":[\n  {"name":"get_weather","arguments":{"city":"Tokyo"}},\n  {"name":"get_weather","arguments":{"city":"London"}}\n]}\n</TOOL_CALL>';
  const resTwo = analyzeBridgeOutput(twoCalls, bridge);
  assert.equal(resTwo.status, 'calls');
  assert.equal(resTwo.calls.length, 2);
  assert.notEqual(resTwo.calls[0].id, resTwo.calls[1].id);

  // 3 calls exceeds maxCalls (2)
  const threeCalls = '<TOOL_CALL>\n{"tool_calls":[\n  {"name":"get_weather","arguments":{"city":"Tokyo"}},\n  {"name":"get_weather","arguments":{"city":"London"}},\n  {"name":"get_weather","arguments":{"city":"Paris"}}\n]}\n</TOOL_CALL>';
  const resThree = analyzeBridgeOutput(threeCalls, bridge);
  assert.equal(resThree.status, 'error');
  assert.match(resThree.reason, /exceeds maximum allowed/);
});

test('validates tool history and detects duplicate tool_call_id', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, { ...baseConfig, toolBridgeMaxCalls: 2 });

  // Duplicate tool_call_id throws
  assert.throws(() => validateToolHistory([
    { role: 'assistant', tool_calls: [
      { id: 'call_dup', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
      { id: 'call_dup', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
    ] },
  ], bridge), /Duplicate tool_call_id/);

  // Tool result with unmatched id throws
  assert.throws(() => validateToolHistory([
    { role: 'assistant', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_unknown', content: 'sunny' },
  ], bridge), /Tool result has no matching tool_call_id/);

  // Tool result with mismatched name throws
  assert.throws(() => validateToolHistory([
    { role: 'assistant', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', name: 'other_tool', content: 'sunny' },
  ], bridge), /Tool result name does not match/);
});

test('buildTaijiInput preserves tool_call_id and distinguishes parallel tool calls', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, { ...baseConfig, toolBridgeMaxCalls: 2 });

  const messages = [
    { role: 'user', content: 'What is the weather in Tokyo and London?' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'call_tokyo', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
        { id: 'call_london', type: 'function', function: { name: 'get_weather', arguments: '{"city":"London"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_tokyo', name: 'get_weather', content: 'sunny' },
    { role: 'tool', tool_call_id: 'call_london', name: 'get_weather', content: 'rainy' },
  ];

  const input = buildTaijiInput(messages, bridge);
  assert.match(input.text, /tool_call_id: call_tokyo/);
  assert.match(input.text, /tool_call_id: call_london/);
  assert.match(input.text, /result:\nsunny/);
  assert.match(input.text, /result:\nrainy/);
});


test('parallel_tool_calls=false limits a turn to one call', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const bridge = createToolBridge({ tools, parallel_tool_calls: false }, { value: 'demo' }, { ...baseConfig, toolBridgeMaxCalls: 4 });
  assert.equal(bridge.maxCalls, 1);
  assert.equal(bridge.parallelToolCalls, false);
  const result = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"get_weather","arguments":{"city":"Tokyo"}},{"name":"get_weather","arguments":{"city":"Paris"}}]}</TOOL_CALL>', bridge);
  assert.equal(result.status, 'error');
  assert.match(result.reason, /exceeds maximum allowed/);
});

test('allowed_tools restricts callable subset and supports required mode', () => {
  const tools = [
    { type: 'function', function: { name: 'search', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } },
  ];
  const bridge = createToolBridge({
    tools,
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read_file' }] },
  }, { value: 'demo' }, baseConfig);
  assert.equal(bridge.choice.mode, 'allowed');
  assert.equal(bridge.choice.requireCall, true);
  assert.deepEqual(bridge.choice.names, ['read_file']);
  assert.equal(analyzeBridgeOutput('plain text', bridge).status, 'error');
  const denied = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"search","arguments":{}}]}</TOOL_CALL>', bridge);
  assert.equal(denied.status, 'error');
  assert.match(denied.reason, /allowed_tools/);
  const allowed = analyzeBridgeOutput('<TOOL_CALL>{"tool_calls":[{"name":"read_file","arguments":{}}]}</TOOL_CALL>', bridge);
  assert.equal(allowed.status, 'calls');
});

test('schema validator supports const, combinators, local refs, uniqueItems, and multipleOf', () => {
  const schema = {
    type: 'object',
    $defs: { mode: { enum: ['fast', 'safe'] } },
    properties: {
      kind: { const: 'job' },
      mode: { $ref: '#/$defs/mode' },
      value: { oneOf: [{ type: 'string', minLength: 2 }, { type: 'integer', multipleOf: 2 }] },
      tags: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    },
    required: ['kind', 'mode', 'value'],
    additionalProperties: false,
  };
  assert.equal(validateSchema({ kind: 'job', mode: 'fast', value: 4, tags: ['a', 'b'] }, schema).valid, true);
  assert.equal(validateSchema({ kind: 'nope', mode: 'fast', value: 4 }, schema).valid, false);
  assert.equal(validateSchema({ kind: 'job', mode: 'bad', value: 4 }, schema).valid, false);
  assert.equal(validateSchema({ kind: 'job', mode: 'fast', value: 3 }, schema).valid, false);
  assert.equal(validateSchema({ kind: 'job', mode: 'safe', value: 'ok', tags: ['a', 'a'] }, schema).valid, false);
});

test('strict metadata is preserved and OpenAI-compatible digit-leading names are accepted', () => {
  const tools = [{ type: 'function', function: { name: '7zip_extract', strict: true, parameters: { type: 'object', properties: {} } } }];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, baseConfig);
  assert.equal(bridge.tools[0].function.strict, true);
  assert.equal(bridge.tools[0].function.name, '7zip_extract');
});

test('tool history can be replayed even when current turn submits no tools', () => {
  const messages = [
    { role: 'user', content: 'check weather' },
    { role: 'assistant', tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] },
    { role: 'tool', tool_call_id: 'call_old', content: 'sunny' },
    { role: 'user', content: 'summarize it' },
  ];
  const input = buildTaijiInput(messages, null);
  assert.match(input.text, /tool_call_id: call_old/);
  assert.match(input.text, /result:\nsunny/);
});

test('large tool results are explicitly marked when truncated', () => {
  const longResult = 'x'.repeat(100100);
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'call_big', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_big', content: longResult },
    { role: 'user', content: 'continue' },
  ];
  const input = buildTaijiInput(messages, null);
  assert.match(input.text, /工具结果已截断/);
  assert.match(input.text, /原始 100100 字符/);
});
