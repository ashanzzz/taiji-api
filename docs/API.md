# API reference

## Public endpoints
GET /healthz reports process liveness. It does not check the upstream account.
GET / serves the admin console. All admin data requires a separate login.

## Relay endpoints
Use `Authorization: Bearer <PROXY_API_KEY>`.
- GET /v1/models returns model IDs from the current account catalog.
- POST /v1/chat/completions accepts model, messages, stream, and stream_options.include_usage.
- Optional thinking and reasoning_effort require matching declared capabilities.
- Optional web_search maps to the website search flag.
- Tools, sampling controls, stop, and output token caps return 400 because their semantics are unverified.

Use complete model IDs such as openai::gpt-6-astra. Unique suffixes also work.
Omit model to use the configured default model, then the website default.
Base64 images use the image_url content-part format. Remote URLs are not fetched.
The maximum HTTP request size is 8 MiB. This is not the model context window.
Two relay operations may run concurrently. An exclusive test returns 429 to other operations.

## Admin endpoints
POST /admin/login accepts {"key":"<ADMIN_KEY>"} and sets an eight-hour HttpOnly cookie.
POST /admin/logout removes the session.
Mutations require JSON. Cross-origin browser requests are rejected.

- GET /admin/state: editable settings, service status, scheduler state, tests, recent logs.
- PUT /admin/settings: update account, password, stable URL, trusted hosts, origin override, default model, schedule.
- GET /admin/models: full upstream metadata. Metadata is a platform declaration, not a guarantee.
- POST /admin/discover: refresh the current origin.
- POST /admin/playground: same compatibility rules as the relay endpoint.
- GET /admin/logs: last 300 sanitized audit records.
- POST /admin/checkin: one normal website sign-in attempt for today.
- POST /admin/tests: start a bounded job.
- GET /admin/tests: list persisted jobs and observations.
- POST /admin/tests/:id/cancel: abort a running job and clean its temporary session.

### Test request
{"model":"openai::gpt-6-astra","kind":"context","steps":[4000,12000,24000],"maxRequests":3}

Kinds: context, reasoning, output, tools. Maximum request budget: six.
Context sizes are characters, not tokens. Range: 512–100000 characters.
Output probes accept maxOutputTokens from 16 to 2048 and test an unverified max_tokens field.
Reasoning probes test baseline, thinking=true, low, medium, high, and none in that order.
Tool probes first send a native OpenAI tools payload, then run a separate text JSON bridge test. A bridge result is never exposed as native Function Calling.
Jobs stop at their budget. Context growth stops on the first failure.
Each sample has a three-minute timeout and a 24000-character response safety cap.

## Error semantics
400 means invalid or unsupported client options.
401 means invalid credentials or expired admin session.
409 means an untrusted newly discovered host or conflicting state.
429 means a busy service or too many login attempts.
502 means an upstream failure, malformed stream, or unexpected EOF.
Before the first SSE byte, errors preserve HTTP status.
After streaming begins, errors use an SSE error object followed by [DONE].
A network failure never automatically replays a generation POST.

### Tool bridge environment

The optional local bridge reads deployment-only environment variables:

| Variable | Meaning |
| --- | --- |
| `EXPERIMENTAL_TOOL_BRIDGE` | Must be exactly `true` to enable the bridge. Default is `false`. |
| `TOOL_BRIDGE_ALLOWED_MODELS` | Comma-separated full model IDs. The bridge rejects all other models. |
| `TOOL_BRIDGE_MAX_TOOLS` | Maximum submitted function definitions, 1–128. Default 32. |
| `TOOL_BRIDGE_MAX_CALLS_PER_TURN` | Maximum parsed calls per model turn, 1–32. Default 4. `parallel_tool_calls=false` reduces this to 1 for that request. |
| `TOOL_BRIDGE_MAX_REPAIR_ATTEMPTS` | Maximum automatic repair attempts when model returns malformed tool output, 0–1 (default 1). |

The admin UI reports these values but cannot enable the bridge or change its allowlist. Set them on the deployment host. The Tool Capability test performs an upstream-native parameter test and a separate JSON bridge test. It does not execute commands.

### Tool bridge

The upstream does not expose native Function Calling for GPT-6-Astra. The local bridge is disabled by default. If enabled by environment configuration, a request with OpenAI `tools` is converted to a strict text instruction. The model's complete response is buffered, parsed only for allowlisted tool names and JSON-object arguments, then returned as an OpenAI-shaped `tool_calls` response.

The service never runs tools. A client such as Codex or NewAPI must execute them and post a later `role: tool` message with the matching `tool_call_id`. Tool results are capped at 100,000 characters and receive an explicit truncation marker instead of being silently cut. `tool_choice` supports `none`, `auto`, `required`, forced functions, and `allowed_tools`; `parallel_tool_calls=false` is enforced. Function `strict` metadata is preserved. Arguments are validated against a broad practical JSON Schema subset including local `$ref`, `allOf`/`anyOf`/`oneOf`, `not`, `if`/`then`/`else`, `const`, object, array, string, and numeric constraints. Streamed tool calls emit `index` markers. Illegal tool intent does not degrade into ordinary text and triggers up to one automatic repair before failing with HTTP 502 `tool_parse_error`. Multi-turn histories preserve `tool_call_id` mappings, including histories replayed when the current request does not submit tools. Bridge streaming is completion-buffered, not token-by-token. Only function tools are supported.
