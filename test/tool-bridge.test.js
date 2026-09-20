import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolBridge, extractBridgeToolCalls } from '../src/tool-bridge.js';

test('tool bridge accepts only configured functions and validates tool names', () => {
  const tools = [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }];
  const bridge = createToolBridge({ tools }, { value: 'demo' }, {
    experimentalToolBridge: true,
    toolBridgeAllowedModels: ['demo'],
    toolBridgeMaxTools: 8,
    toolBridgeMaxCalls: 1,
  });
  const calls = extractBridgeToolCalls('{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"dir"}}]}', bridge);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'exec_command');
  assert.equal(calls[0].function.arguments, '{"cmd":"dir"}');
  assert.throws(() => createToolBridge({ tools }, { value: 'demo' }, {
    experimentalToolBridge: false,
    toolBridgeAllowedModels: ['demo'],
    toolBridgeMaxTools: 8,
    toolBridgeMaxCalls: 1,
  }), /disabled/);
  assert.equal(extractBridgeToolCalls('{"tool_calls":[{"name":"not_allowed","arguments":{}}]}', bridge), null);
});
