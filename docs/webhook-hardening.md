# Webhook verification, replay protection, and reliable processing

## Scope and non-regression result

- Branch: `hardening/06-webhooks`
- Base: tested `hardening/05-login-sessions` at `7b3a4d33d385853f11f28f4409fa5482ab22c33c`
- Routes: `POST /api/quo/webhook` and the existing `POST /api/openphone/webhook` compatibility alias
- No branch was pushed, merged, force-pushed, or deployed. `main` was not checked out or modified.
- Valid `call.ringing`, `call.answered`, and `call.completed` events retain their existing interpretation. The completed-call upsert fields, status thresholds, duration calculations, and dashboard KPI formulas are unchanged.
- Other valid event types retain the existing acknowledged/no-dashboard-write behavior. They are now recorded with a minimized durable envelope rather than message bodies, transcripts, recordings, contacts, or full customer records.
- The existing successful webhook response remains `{ "ok": true }`.

No real webhook secret, signature, phone number, transcript, token, customer record, or production data was used in implementation, tests, logs, or this report.

## Exact signature method

The application mounts `express.raw({ type: "application/json" })` for both webhook paths before the global JSON parser. Verification therefore receives the exact request bytes; it never verifies a reserialized JavaScript object.

The handler parses the documented `openphone-signature` value as:

```text
hmac;1;<timestamp>;<base64 HMAC-SHA256 digest>
```

Verification performs these steps:

1. Require scheme `hmac` and version `1`.
2. Parse the provider timestamp in Unix milliseconds, while accepting Unix seconds for compatibility.
3. Reject past or future timestamps outside 300 seconds by default.
4. Decode `QUO_WEBHOOK_SECRET` from base64 to binary bytes.
5. Compute HMAC-SHA256 over the byte sequence `timestamp + "." + exactRawBodyBytes`.
6. Decode the supplied digest and compare the 32-byte values with `crypto.timingSafeEqual`.

`QUO_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` can set a trusted server-side tolerance from 30 through 900 seconds; invalid configuration falls back to 300. Comma-separated signature candidates are accepted for provider signature-version rollover, but only `hmac;1` candidates are currently supported. Missing, malformed, unsupported, modified, expired, future-dated, or mismatched signatures return `401` without logging the header or digest.

This exact-byte implementation follows the provider's binary-body example and the task's explicit raw-byte requirement. The provider specification and retry behavior are documented at <https://support.quo.com/core-concepts/integrations/webhooks>.

## Idempotency, persistence, and processing

The provider's stable top-level event `id` is required. The idempotency key is:

```text
openphone:<provider-event-id>
```

The additive `0006_webhook_inbox.sql` migration creates `webhook_inbox` with:

- primary-key uniqueness on `idempotency_key`;
- a second unique index on `(provider, provider_event_id)`;
- event type and final object/call identity;
- a canonical SHA-256 payload hash for same-ID collision detection;
- a durable JSON payload for the call events the application processes;
- a minimized metadata-only payload for ignored transcript, message, recording, summary, and contact events;
- `received`, `processing`, `processed`, `ignored`, and `failed` statuses enforced by a database check;
- attempt count, first/last receipt time, processing lease time, completion time, and a bounded sanitized error code.

Processing follows this order:

1. Verify the signature and timestamp against exact body bytes.
2. Parse and validate the provider envelope and stable event ID.
3. Insert the durable inbox row before business processing.
4. Atomically claim `received` or `failed` work. A 30-second database lease permits recovery after a process crash.
5. Apply the established live-call transition or completed-call upsert.
6. Mark the inbox row `processed` or `ignored` before returning `200`.

A processed retry returns the same `200 { "ok": true }` without running business logic again. A concurrent delivery receives `503` plus `Retry-After: 5` while the first worker owns the lease. A database or processing failure is marked `failed` when possible and returns `503`, preserving Quo retry behavior. If business data was written but the final inbox update failed, the retry repeats the existing primary-key upsert for the same call ID, so it cannot add another call row or inflate totals. A stale `processing` record can be reclaimed after 30 seconds.

The live-call map remains only a low-latency display input. Durable event receipt and completed calls do not depend on process memory, while the existing `/api/quo/live` provider polling and database fallback remain unchanged. A delayed ringing/answered event checks the durable inbox and cannot resurrect a call whose completion was already processed.

## Response and retry matrix

| Condition | Response | Provider behavior and server result |
| --- | ---: | --- |
| Valid new event, processing succeeds | `200 { ok: true }` | Inbox terminal status is durable before success. |
| Valid duplicate already processed/ignored | `200 { ok: true }` | No repeated business processing. |
| Valid delivery already being processed | `503`, `Retry-After: 5` | Provider retries; no concurrent duplicate write. |
| Database receipt or processing failure | `503`, `Retry-After: 5` | Provider retries; sanitized failure status is recorded when the database is available. |
| Same provider event ID with a different semantic payload | `409` | Collision is not processed; provider retry remains enabled. |
| Missing/invalid/modified/expired signature | `401` | Nothing is stored or processed. |
| Signed malformed event envelope | `400` | Nothing is stored or processed. |
| Non-JSON media type | `415` | Nothing is stored or processed. |
| Verification secret absent | `503` | Fails closed and remains retryable. |

The two webhook paths remain intentionally public only to bearer-token middleware because Quo cannot use browser authentication. They are not unauthenticated entry points: both apply identical signature, freshness, envelope, inbox, and retry controls.

## Compatibility tests

All fixtures use invented identifiers and non-phone reference strings.

| Case | Result |
| --- | --- |
| Exact raw body and valid signature | Accepted. |
| Invalid signature | Rejected. |
| JSON body modified after signing | Rejected even when the parsed JSON remains valid. |
| Timestamp older/newer than five minutes | Rejected. |
| Provider retry with a fresh signature timestamp | Same stable event key; accepted. |
| Same event delivered three times | Processor ran once; later deliveries were terminal duplicates. |
| Same ID with changed semantic payload | Collision; processor did not run again. |
| Concurrent duplicate | Busy/retry outcome; processor did not run again. |
| Failure after the call upsert but before inbox completion | Retry succeeded; call map/table identity remained singular. |
| Database receipt failure | Business processor did not run; HTTP runtime returned `503` with `Retry-After`. |
| Completion followed by late ringing | Durable completion check prevented the live call from being recreated. |
| Ignored transcript payload | Durable record retained identity metadata but not dialogue or customer identifier content. |

The disposable PostgreSQL HTTP test verified both real route aliases' shared handler through `/api/quo/webhook`. It applied the new migration to an isolated database, delivered a sanitized completed-call fixture, redelivered it with a new valid timestamp/signature, tested late ringing, bad/modified/stale signatures, and then closed the pool to test database failure.

| KPI projection | After first delivery | After duplicate delivery |
| --- | ---: | ---: |
| Total calls | 1 | 1 |
| Connected calls | 1 | 1 |
| Missed calls | 0 | 0 |
| Inbox rows for provider event | 1 | 1 |
| Completed-call processing attempts | 1 | 1 |

The production completed-call status rules remain the same: outgoing post-answer thresholds remain 60 and 20 seconds; incoming answered/voicemail handling and no-answer ring-duration handling are unchanged. Existing database conflict updates still target the call ID and write the same response-independent fields.

## Verification commands and results

### Pre-change baseline

| Command | Result before phase-6 changes |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; 587 workspace packages linked from the existing lockfile/store. |
| `pnpm run typecheck` | Passed across libraries, API, dashboard, scripts, and mockup sandbox. |
| `pnpm run test:security` | 45 passed: 7 frontend and 38 API. |
| `pnpm run test` | 57/57 passed. |
| `pnpm run test:baseline` | 5/5 deterministic response-contract and KPI tests passed. |
| `pnpm run build` | Passed with the existing UI sourcemap and large-chunk warnings. |
| Lint | No lint script exists in workspace/package configuration. |

### Final checks

| Command | Result |
| --- | --- |
| `pnpm run typecheck` | Passed. |
| `pnpm run test:security` | 56 passed: 7 frontend and 49 API; the opt-in PostgreSQL case was skipped in the environment-free run. |
| `pnpm --filter @workspace/api-server run test:webhooks:integration` | 1/1 passed against disposable PostgreSQL with the opt-in flag. |
| `pnpm run test` | 57/57 passed. |
| `pnpm run test:baseline` | 5/5 passed. |
| `pnpm run test:smoke` | No failure; the live smoke case skipped because no live application URL/password was supplied. |
| `pnpm run build` | Passed; only the same existing sourcemap and large-chunk warnings remained. |
| `git diff --check` | Passed. |

## Existing failures and untested external behavior

- The inherited clean-database migration chain fails in `0003_anthropic_controls.sql` before reaching this phase because it alters `qa_reviews`, which `0000` does not create. This was reproduced before applying `0006` independently and was not caused or rewritten by this phase.
- The inherited `0000` migration also lacks the current `phone_calls.post_answer_seconds` and `phone_calls.ring_duration_seconds` columns. Those current-schema columns were added only to the disposable database so the webhook runtime test could exercise the existing upsert. No shared or production database was changed.
- A real Quo delivery was not triggered because no production webhook configuration, secret, or customer event was used. Signature compatibility was verified from the published method with locally generated sanitized requests.
- The credentialed live dashboard/browser smoke was not rerun because no isolated dashboard user/database fixture was provided. No frontend, dashboard API response, filter, download, authentication, or authorization code changed; the deterministic baseline contracts and full build passed.
- No new test, typecheck, build, route, KPI, database-inbox, or HTTP integration failure remains.

## Files changed

- Raw body configuration: `.env.example`, `artifacts/api-server/src/app.ts`
- Signature and envelope policy: `artifacts/api-server/src/lib/openPhoneWebhook.ts`
- Durable processing orchestration: `artifacts/api-server/src/lib/durableWebhook.ts`
- Database inbox operations: `artifacts/api-server/src/lib/webhookInboxStore.ts`
- Webhook route processing: `artifacts/api-server/src/routes/quoWebhook.ts`
- Inbox schema and migration: `lib/db/src/schema/webhookInbox.ts`, schema export, `0006_webhook_inbox.sql`, migration journal
- Tests and command: `webhooks.test.ts`, `webhooks.integration.test.ts`, API package script
- Report: `docs/webhook-hardening.md`

## Local commits

- `5851d70 feat: harden OpenPhone webhook processing`
- `606dfd9 fix: preserve webhook enrichment behavior`

The documentation commit is recorded in the final handoff after it is created. Nothing was pushed, merged, deployed, or applied to `main`.
