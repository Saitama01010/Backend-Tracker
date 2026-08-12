# AI privacy and write-tool safety

This phase preserves the existing Samia, QA, live-transfer, and onboarding workflows while reducing data disclosed to AI providers and making AI-triggered state changes deterministic.

## Provider and data inventory

Anthropic Messages is the only runtime AI provider. No OpenAI or OpenRouter implementation is present.

| Feature | Provider and configured model | Data required by the feature | Data withheld or transformed |
| --- | --- | --- | --- |
| Samia chat and dashboard analysis | Anthropic; `ANTHROPIC_SAMIA_MODEL` (default `claude-sonnet-5`) | Authenticated user's question, bounded conversation history, authorized dashboard aggregates, relevant employee/team metrics, and verified call evidence when specifically requested | Phone numbers and email addresses are replaced with per-request references before transmission and restored only in the authorized response; call/sheet/tool/history data is fenced as untrusted; unrelated dashboard sources are not loaded in lightweight mode |
| QA evaluation | Anthropic; `ANTHROPIC_QA_MODEL` (default `claude-haiku-4-5`) | Department, direction, duration, bounded QUO summary, next steps, and transcript needed for the scorecard | System employee identity is replaced with `[AUTHORIZED_EMPLOYEE]`; phone numbers, email addresses, and government-ID patterns are redacted |
| Live-transfer classification | Anthropic; `ANTHROPIC_LT_MODEL` (default `claude-haiku-4-5`) | First 4,000 characters of an in-scope incoming-call opening, including a partner or transferring-agent name when classification requires it | Phone and email identifiers are redacted; only the opening is sent; low-signal calls are filtered before an AI request |
| Onboarding classification | Anthropic; `ANTHROPIC_OB_MODEL` (default `claude-haiku-4-5`) | Bounded onboarding transcript, direction, and names spoken in the transcript where customer/closer extraction is the feature | System onboarding-agent identity is replaced; phone and email identifiers are redacted |
| One-off deal call report | Anthropic; `ANTHROPIC_OB_MODEL` | Bounded call counts, statuses, line categories, summaries, and relevant incoming openings | Customer and employee identities are replaced, contact data is redacted, batch size defaults to 100 and is capped at 500 |

The API key remains server-only. Provider logs contain model, request ID, sanitized status/error code, and token counts, not prompts, transcripts, phone numbers, signatures, keys, or raw upstream bodies.

## Authentication and authorization

| Route or execution path | Rule |
| --- | --- |
| `/api/samia/*` | Bearer-authenticated administrator |
| `/api/qa/evaluate`, `/api/qa/biweekly-run`, `/api/qa/process`, `/api/qa/runs/latest`, `/api/qa/assign-weekly` | Bearer-authenticated administrator |
| `/api/qa/stats`, downloads, reviews, tasks, and agents | Bearer authentication plus the existing server-side team/agent/date policy |
| `/api/qa/biweekly-run` GET | Server-to-server `CRON_SECRET`; not browser authentication |
| `/api/live-transfers/refresh` and `/api/ob-report/refresh` | Bearer-authenticated administrator with a durable per-user request limit |
| Live-transfer/onboarding status and downloads | Bearer authentication plus the existing server-side workflow scope |
| `/api/ob-report/import` | Independently authenticated server-to-server import using `OB_IMPORT_SECRET` |

Authorization is checked by the server after a capability name and final arguments are resolved. Model output cannot grant a role, permission, confirmation, route, or arbitrary executor.

## Untrusted-data boundary

The shared AI policy treats user questions, uploaded images, history, transcripts, summaries, spreadsheet-derived values, external responses, and tool results as evidence only. Each text data block is bounded and placed inside a server-created `untrusted_ai_data` envelope. Injected closing tags are filtered so data cannot escape its envelope.

Tool results are serialized, minimized, pseudonymized, and reintroduced as untrusted data. Raw internal error responses are not sent back to the model.

## Read and write tools

The capability registry classifies every capability as `read` or `write`. Only bounded read capabilities are exposed to the Anthropic tool loop. Known write requests are detected before the provider call and executed by fixed server functions after strict argument validation and authorization.

Read capabilities do not trigger sync, refresh, queue, or persistence side effects. Existing explicit refresh and sync controls remain available through their authenticated administrator workflows.

The following actions require a separate explicit confirmation command:

- Bulk attendance auto-marking
- Attendance note changes
- Replacement of an existing attendance status
- Starting a QA run
- Forced QA re-evaluation of a call
- Resolving a manager QA task

An instruction embedded in a transcript, sheet cell, summary, tool result, or longer user question cannot satisfy confirmation because the deterministic parser accepts only an exact action command with a leading or trailing confirmation term.

Every attempted Samia AI-assisted operational write records the authenticated user, capability, target, success, instruction reference, and sanitized before/after metadata. Migration `0007_immutable_ai_action_audit.sql` adds database triggers that reject updates and deletes of those audit rows.

## Spending and reliability controls

- Model allowlist: `ANTHROPIC_MODEL_ALLOWLIST`
- Maximum prompt text: `ANTHROPIC_MAX_INPUT_CHARS` (default 24,000; hard maximum 50,000)
- Maximum output: `ANTHROPIC_MAX_OUTPUT_TOKENS` (default 1,200; hard maximum 4,096)
- Provider timeout: `ANTHROPIC_REQUEST_TIMEOUT_MS` (default 30 seconds; range 5–60 seconds)
- Samia: durable per-user minute/day limits and one concurrent generation per user
- Manual QA: durable per-user limits; shared QA runs use a database lease
- Live-transfer/onboarding refreshes: durable per-user trigger limits, global database leases, and worker concurrency capped at four
- One-off report: bounded batch and concurrency

Provider and external failures are represented by stable error codes. Raw provider messages and raw upstream bodies are not stored in workflow state or returned through Samia tool results.

## Internal requests

Samia internal API requests use `INTERNAL_API_BASE_URL` when explicitly configured, otherwise a loopback origin derived only from the validated server `PORT`. Request `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` headers never select the destination. Only same-origin `/api/` paths receive the caller's bearer token.
