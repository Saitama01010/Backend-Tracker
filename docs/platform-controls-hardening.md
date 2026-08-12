# Platform controls hardening

## Scope and non-regression result

- Branch: `hardening/08-platform-controls`
- Base: tested `hardening/07-ai-privacy` at `423fb675f53ef4d29676418581f9f58288b35bc0`
- No branch was pushed, merged, force-pushed, or deployed. `main` was not checked out or modified.
- Successful route bodies, dashboard calculations, API contracts, authentication, authorization, webhook interpretation, and workbook formats are unchanged.
- Error responses now add a stable error code and request ID. Server and upstream diagnostics are retained only in redacted server logs.

## Middleware order

The application installs platform middleware in this order:

1. Generate or validate a bounded `X-Request-ID` and echo it on the response.
2. Apply Helmet security headers and the production CSP.
3. Start structured request logging with the same request ID.
4. Apply the explicit CORS origin policy.
5. Enable response compression with download and event-stream exclusions.
6. Wrap JSON error responses with the stable error contract.
7. Apply private, no-store cache headers to `/api` responses.
8. Parse Samia's bounded screenshot body.
9. Parse Quo/OpenPhone webhook paths as exact raw bytes.
10. Parse all other JSON and form bodies with explicit limits.
11. Run authentication, authorization, rate limiting, and route handlers.
12. Return a stable API 404 and pass unhandled errors to the terminal sanitized handler.

The raw webhook parser remains ahead of the general JSON parser. Signature verification therefore continues to cover the exact provider bytes.

## Stable errors and request IDs

All JSON responses with an HTTP status of 400 or greater use this additive shape:

```json
{
  "error": "Safe public message",
  "code": "STABLE_ERROR_CODE",
  "requestId": "request-correlation-id"
}
```

Existing safe error fields are retained. Statuses and provider retry headers are preserved. Statuses of 500 or greater never return stack traces, database messages, upstream bodies, secrets, or internal paths. Body-parser errors map to stable `PAYLOAD_TOO_LARGE`, `INVALID_JSON`, `UNSUPPORTED_CONTENT_ENCODING`, or `REQUEST_ABORTED` codes.

The server accepts an incoming request ID only when it is 1-128 characters from a bounded safe character set. Otherwise it creates a UUID. The same value is returned in `X-Request-ID`, included in errors, and used by the structured request logger.

## Logging redaction

Pino redacts authorization headers, cookies, set-cookie values, passwords, password hashes, access and refresh tokens, API keys, secrets, and webhook signatures. Both top-level and common nested field names are covered.

The error serializer removes request/response bodies and headers before logging. It retains diagnostic type, message, and stack information after masking bearer values, credential assignments, and configured secret environment values. Raw webhook bodies, raw transcripts, and raw upstream response bodies are not added to request logs.

## HTTP headers and CSP

Helmet supplies the API response-header set. `vercel.json` now supplies the
equivalent browser boundary for static HTML/assets that never pass through
Express. The static CSP permits only the resources used by the current built
dashboard:

- scripts, connections, forms, and base URLs from the same origin;
- inline styles required by current React components;
- the existing Google Fonts stylesheet and font host;
- same-origin/data images and same-origin workers;
- no objects, no framing, and no inline script attributes.

Vercel HTTPS responses receive HSTS and `upgrade-insecure-requests`; local
development avoids forced HTTPS. The frontend API client permits only
same-origin requests, Google Sheets are read through `/api/sheet`, and no
third-party `connect-src` is allowed. Remote Preview verification is restricted
to the unauthenticated page and response headers until isolated staging exists.

## CORS

Browser origins are exact normalized HTTP(S) origins from:

- `FRONTEND_ORIGIN`
- `CORS_ORIGIN`
- `PUBLIC_APP_ORIGIN`
- trusted platform values `RENDER_EXTERNAL_URL` or `VERCEL_URL`

Comma-separated values are supported. Development additionally trusts the configured local dashboard port on `localhost` and `127.0.0.1`. The request `Host` and forwarded-host headers never grant CORS trust. Requests without an `Origin` remain available to signed webhooks, cron jobs, health probes, and other server-to-server callers. An untrusted browser origin receives `403 CORS_ORIGIN_DENIED`.

## Request, response, and rate controls

| Control                          |                    Default | Compatibility rule                                              |
| -------------------------------- | -------------------------: | --------------------------------------------------------------- |
| General JSON body                |                    100 KiB | Makes the prior Express default explicit.                       |
| URL-encoded form body            | 100 KiB / 1,000 parameters | Makes the prior size default explicit.                          |
| Quo/OpenPhone raw webhook        |                      1 MiB | Preserves the phase-6 raw-body limit and exact bytes.           |
| Samia screenshots                |                      8 MiB | Preserves the existing two-screenshot route allowance.          |
| Complete request receive timeout |                120 seconds | Limits slow request bodies, not report generation.              |
| Complete header receive timeout  |                 15 seconds | Rejects incomplete headers before routing.                      |
| Keep-alive idle timeout          |                  5 seconds | Matches the established Node default.                           |
| Maximum incoming header count    |                        100 | Bounds header parsing.                                          |
| Response inactivity timeout      |                   Disabled | Prevents long workbook generation/streaming from being cut off. |

Normal compressible responses larger than 1 KiB may use gzip/deflate/Brotli according to the client's `Accept-Encoding`. Excel attachments, `text/event-stream`, and any response with `no-transform` are never compressed. Private workbook names, MIME types, columns, ZIP bytes, and download disposition are unchanged. Private APIs use `private, no-store, max-age=0`; downloads additionally use `no-transform`.

The existing database-backed per-user rate limiter still protects sync, refresh, AI, bulk import, and password operations. This phase adds bounded rules for:

- QA, onboarding report, onboarding analytics, and live-transfer downloads: 30 per 10 minutes;
- ReadyMode probe: 20 per 10 minutes;
- PBX diagnostic calls/proxy: 20 per 10 minutes.

Ordinary dashboard statistics, charts, filters, and table reads are not rate-limited by these new rules.

## Verification

Automated platform tests cover successful JSON compatibility, compressed JSON, uncompressed event streams and Excel files, allowed/rejected CORS origins, large and malformed requests, application/database/upstream errors, exact webhook raw bytes, login/dashboard wiring, security headers/CSP, logging redaction, server timeouts, private caches, and costly-route selection.

The complete typecheck, security suite, application suite, baseline KPI/contract suite, and production builds pass. The live credentialed baseline smoke test remains opt-in and was skipped because no isolated database URL and smoke credentials were supplied. The database-backed webhook delivery test likewise remains skipped without an isolated migrated test database. No production data or credentials were used.
