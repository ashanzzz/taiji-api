# Taiji API implementation plan

## Scope
- Keep Node.js 24. Use native HTTP, fetch-compatible streams, crypto, and tests.
- Add a same-origin admin console. Separate admin and relay keys.
- Save settings and test evidence locally. Encrypt the account password at rest.
- Discover the current origin from the stable entry. Never evaluate website JavaScript.
- Require approval in settings before sending credentials to a newly discovered host.
- Expose OpenAI-style models and text/image Chat Completions. Reject unsupported options explicitly.
- Add serial, bounded context, reasoning, and output probes. Report observations, not guessed model limits.
- Add one persisted daily sign-in attempt within a random Asia/Shanghai time window.
- Publish source to a private GitHub repository and multi-platform images to GHCR.

## Acceptance checks
1. Unit tests cover SSE boundaries, upstream errors, auth, settings, scheduler, and test conclusions.
2. HTTP tests cover admin protection, relay protection, streaming, non-streaming, and cancellation.
3. Browser checks cover login, settings, model search, test reports, and mobile layout.
4. Live probes use synthetic text only and a small request budget.
5. No password, JWT, .env, logs, or research dumps enter Git or the build context.
6. CI tests the code before image publication. Verify the Actions run and package visibility.

## Evidence rules
A successful request does not prove the model identity or its context limit.
An accepted reasoning parameter does not prove that it changes computation.
Output length is observed separately from a verified server-side output cap.
A failed input identifies a channel boundary, not necessarily a model boundary.

## Work sequence
1. Backend: secure configuration, discovery, stream transport, admin API.
2. Frontend: console, settings, models, playground, logs, and tests.
3. Tests and scheduler: bounded jobs, persistent evidence, daily sign-in.
4. Integration: local checks, browser QA, limited live checks.
5. Delivery: private repository, GHCR workflow, operations and upgrade notes.
