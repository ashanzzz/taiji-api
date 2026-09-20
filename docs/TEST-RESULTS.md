# Test evidence — 2026-09-20

These results describe the third-party Taiji channel, not independently verified OpenAI model identity or limits.
The private runtime keeps full job records in data/tests.json. This document omits account details, JWTs, IPs, and prompts from ordinary chats.

## Model catalog and origin
The stable entry resolved to ai.txg2024.xyz. The account catalog contained 156 entries.
The tested channel was openai::gpt-6-astra.
Declared capabilities included stream=true, thinking=false, autoDetectThinking=true, with no reasoningEfforts list.

## Reasoning probe
All six cases used the same short arithmetic prompt in a fresh session.

| Case | Observed result |
| --- | --- |
| thinking=false, empty effort | Accepted. A think tag appeared in this sample. |
| thinking=true, empty effort | Accepted. No think tag appeared in this sample. |
| low | Rejected: 当前模型不支持推理等级配置 |
| medium | Rejected: 当前模型不支持推理等级配置 |
| high | Rejected: 当前模型不支持推理等级配置 |
| none | Rejected: 当前模型不支持推理等级配置 |

Acceptance does not prove that thinking changes computation.
A visible think tag does not prove a particular reasoning budget.
The production API rejects undeclared reasoning controls instead of silently ignoring them.

## Context retrieval probe
Three random markers appeared near the start, middle, and end of each random document.
All three had to match in the answer. Each sample used a fresh session.

| Input characters | Platform prompt tokens | Markers found |
| ---: | ---: | ---: |
| 4000 | 1190 | 3/3 |
| 12000 | 3234 | 3/3 |
| 24000 | 6280 | 3/3 |

This establishes a 24000-character retrieval lower bound for this sample set.
It does not establish the maximum context. Character counts are not token counts.
The budget stopped growth after three samples. Larger tests remain an explicit admin action.
Prior repeated-character probes are not used as evidence of effective retrieval capacity.

## Output parameter probe
The request asked for integers 1 through 300 and supplied the candidate max_tokens field.

| Requested candidate limit | Platform output tokens | Output characters |
| ---: | ---: | ---: |
| 32 | 902 | 1390 |
| 128 | 902 | 1390 |

The candidate limit was not shown to be enforced. Do not advertise output token control.
The maximum possible output has not been established.
The first job wrote both samples but its final state update hit a Windows sync-client file lock.
The restart labels this job interrupted. Atomic rename retries and job error isolation were added afterward.

## Sign-in
The calendar reported that 2026-09-20 was already signed, with integral=10.
No duplicate sign-in POST was needed. The daily schedule is persisted and uses Asia/Shanghai.

## Validation scope
Unit tests cover transport parsing, error handling, authentication, settings, DNS policy, scheduler behavior, and budget checks.
HTTP tests cover admin login isolation, CSRF, and streaming.
Browser, CI, and deployment outcomes are recorded in the delivery report after completion.

## Extended context probe
The next bounded job tested 48000 and 80000 characters with the same three-marker method.
- 48000 characters: all three markers matched. The platform reported 12425 input tokens.
- 80000 characters: the platform rejected the input with its message-length error.
- 100000 characters: not sent. The job stopped after the first failed step.
The current measured retrieval lower bound is 48000 characters for this corpus.
The precise boundary and the underlying model window remain unknown.

## Persistence retest
After adding finite retries for transient Windows file locks, a new one-request output job completed and persisted successfully.
Its candidate max_tokens=32 again did not constrain the response to that value.
