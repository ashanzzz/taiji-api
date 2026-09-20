# Tool bridge compatibility update — 2026-09-20

This update hardens the local OpenAI-compatible function tool bridge while keeping Taiji web transport independent from tool execution.

Implemented:

- `parallel_tool_calls=false` enforcement.
- `tool_choice`: `auto`, `none`, `required`, forced function, and `allowed_tools` (`auto` / `required`).
- `strict` metadata preservation.
- Expanded JSON Schema validation with local `$ref`, `$defs`, `const`, `enum`, `allOf`, `anyOf`, `oneOf`, `not`, conditional schemas, object constraints, array constraints, string constraints, and numeric constraints.
- Function names compatible with the OpenAI `[A-Za-z0-9_-]` naming surface up to 64 characters.
- Tool-call history replay independent of the current tool set.
- Explicit tool-result truncation marker at 100,000 characters.
- Sanitized `tool_choice=none` output is now returned instead of the raw upstream marker text.
- Existing indexed streaming tool calls and bounded repair behavior retained.

Not implemented:

- OpenAI `custom` tools.
- Built-in OpenAI-hosted tools or Responses API MCP objects.
- Native upstream structured tool state.
- Full formal implementation of every JSON Schema draft keyword or remote `$ref`; the bridge intentionally supports local refs and the common function-schema surface.

The external `llm-tool-capability` project solves a very similar problem for standard OpenAI-compatible upstreams. This repository keeps the bridge integrated because the Taiji transport uses custom sessions, authentication, and SSE semantics.
