# Architecture

## Modules
- `index.js` creates services and starts the HTTP server and scheduler.
- `config.js` validates editable settings and separates deployment secrets.
- `store.js` writes atomic JSON snapshots and encrypts the account password.
- `network.js` validates public HTTPS destinations and pins DNS results per connection.
- `taiji-client.js` owns authentication, discovery, sessions, and upstream SSE.
- `chat-format.js` validates compatibility and translates message content.
- `openai-adapter.js` translates streams and cleans request-owned sessions.
- `auth.js` handles independent relay keys and short-lived admin cookies.
- `admin-api.js` exposes settings, model information, logs, and test jobs.
- `probes.js` runs serial, budgeted tests and persists observations.
- `scheduler.js` runs one daily sign-in attempt within a random time window.
- `public/` contains the same-origin browser console.

## State and ownership
Run one process and one replica per data volume. JSON files do not support multi-process locking.
The operation gate blocks settings changes during active requests and isolates probe jobs.
The scheduler shares the gate. It waits when another operation is active.
Only sessions created by a request or test are deleted.

## Discovery
Use the stable entry URL. Follow at most six redirects.
Parse the public `dd` field without eval. Do not execute upstream scripts.
Cache the origin for five minutes. A change clears the login token.
Send credentials only to explicit trusted hostnames.
A newly discovered hostname requires admin approval in settings.
Reject private IPs, HTTP URLs, credentials in URLs, and nonstandard ports.
Pin the validated DNS address for the HTTPS connection.

## Compatibility limits
The website accepts a text field, not OpenAI messages.
Multi-turn and system messages become a labeled transcript. Role isolation is not equivalent to native OpenAI roles.
Remote images are rejected. Base64 image inputs are supported only when the model declares image input.
Tool calling, structured outputs, sampling controls, and verified output token caps are not implemented.
Unsupported options return HTTP 400. Reasoning levels are never silently discarded.
Thinking tags become `reasoning_content`. This is presentation, not proof of internal model reasoning.
When the website omits finish_reason, the adapter uses stop after [DONE]. It cannot detect hidden upstream truncation.

## Upgrade process
1. Capture public protocol changes without credentials or account records.
2. Add a sanitized fixture and failing unit test.
3. Change the smallest responsible module.
4. Run checks and tests. Use bounded live probes if needed.
5. Review the browser and API behavior together.
6. Push to the private repository. Confirm CI before deployment.
7. Back up the data volume and deploy a commit-tagged image.

## Future work
- Verify native role semantics before advertising full Chat Completions compatibility.
- Add a tokenizer only after identifying a reliable upstream tokenizer contract.
- Add a verified output cap mapping when the website exposes one.
- Use SQLite or a shared store before adding multiple replicas.
- Add multi-account isolation only with separate credentials, quotas, and schedulers.
