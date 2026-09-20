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
