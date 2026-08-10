# Login, session, and API abuse-protection report

## Scope and non-regression result

- Branch: `hardening/05-login-sessions`
- Base: tested `hardening/04-sensitive-workflows` at `627a8679e3b5f2c583a714a9aee6429ae82a8213`
- No branch was pushed, merged, force-pushed, or deployed. `main` was not checked out or modified.
- Successful login and `/auth/me` responses retain the baseline `{ token, user }` shape and existing user fields.
- Existing passwords remain valid. The stronger password policy applies only when an account is created or its password is changed.
- Dashboard formulas, KPI fields, API data shapes, integrations, exports, permissions, and database records outside the disposable fake-account test database were not changed.

## Authentication and session behavior

| Control | Implementation | Compatibility behavior |
| --- | --- | --- |
| Access token | Signed JWT, 15-minute default lifetime configurable with `AUTH_ACCESS_TOKEN_TTL` | The frontend renews once and retries the original private request before emitting the existing unauthorized event. |
| Refresh session | 256-bit random token; only its SHA-256 digest is stored in `auth_sessions` | HttpOnly cookie, `Secure` in production, `SameSite=Lax`, `/api/auth` path, 30-day default lifetime capped at 90 days. |
| Legacy token transition | Existing JWTs without a session ID remain accepted while valid | The first successful `/auth/me` transparently creates a refresh session and returns the same response shape with a shorter-lived access token. |
| Session revocation | Access tokens carry a server-side session ID checked on every authenticated request | Logout revokes the refresh session; password changes, deactivation, and admin password resets revoke every session for that user. Deleted users are rejected and their sessions cascade-delete. |
| Active-user check | The current portal user is loaded for every private request and refresh | Deactivated or missing users receive `401` immediately; authorization fields still come from the current database record. |
| Browser renewal | One in-flight refresh is shared across concurrent `401` responses | JSON, file/blob, headers, methods, request bodies, and same-origin credentials are preserved on the retry. Tokens are still refused for third-party URLs. |
| Logout | Public only to bearer middleware because it validates/clears the scoped refresh cookie | Works even when the access token has expired and returns `{ ok: true }`. |

The additive `0005_login_sessions.sql` migration creates `auth_sessions` and `api_rate_limits`. It must be applied through the normal migration workflow before this branch can run in an environment; it was applied only to the disposable local test database during verification.

## Login and action throttles

All limiter keys are HMAC hashes using `RATE_LIMIT_HASH_SECRET` or `SESSION_SECRET`; usernames, IP addresses, and user IDs are not stored in the limiter table.

| Surface | Limit | Scope |
| --- | --- | --- |
| Login requests | 30 per 15 minutes | Source IP |
| Failed login attempts | 5 per 15 minutes | Independent normalized account key, including unknown usernames |
| Session refresh | 60 per 5 minutes | Source IP |
| Account create/password change | 10 per hour | Authenticated administrator |
| Quo sync / PBX refresh / onboarding and live-transfer refresh | 12 per 5 minutes | Authenticated user; existing authorization still runs first |
| ReadyMode session reset | 6 per 10 minutes | Authenticated user; existing admin policy still runs first |
| ReadyMode upload | 10 per 10 minutes | Authenticated user |
| QA evaluation/process actions | 20 per 10 minutes | Authenticated user |
| Attendance import/auto-mark | 12 per 10 minutes | Authenticated user |
| Samia chat | 30 per 5 minutes | Authenticated user |

Limiter storage failures fail closed with a sanitized `503` for authenticated expensive actions. `429` responses include `Retry-After`. Login responses for a wrong password, unknown user, and inactive user use the same `401 { error: "Invalid credentials" }` result and a dummy bcrypt comparison prevents the missing-user fast path.

## Password and administrative controls

- New or changed passwords must be 12-128 characters, use at least three of lowercase, uppercase, number, and symbol, and must not contain the username.
- Existing hashes are not re-evaluated or invalidated during login.
- Password whitespace is preserved by the frontend instead of being silently trimmed.
- Administrators cannot deactivate, demote, or delete their own account.
- The final active administrator cannot be demoted, deactivated, or deleted.
- The admin setup script and the opt-in boot password reset enforce the new policy and revoke existing sessions after a reset.

## Logging controls

- Removed login diagnostics that disclosed account existence, role, password-match results, password-hash prefixes, and database connection metadata.
- HTTP logging serializes only request ID, method, path without query parameters, and status.
- Pino redaction covers authorization headers, cookies, `Set-Cookie`, passwords, password hashes, tokens, and common authorization/cookie fields.
- Authentication failures log only a generic event. No raw username, password, token, cookie, authorization header, or limiter scope input is logged.

## Verification

### Pre-change baseline

| Command | Result before phase-5 changes |
| --- | --- |
| `pnpm run typecheck` | Passed |
| `pnpm run test:security` | Frontend 5/5 passed; API had one pre-existing date-clock failure because a July 15 fixture did not inject its clock |
| `pnpm run test` | 57/57 passed |
| `pnpm run build` | Passed with the existing sourcemap and large-chunk warnings |
| Lint | No lint script exists in the workspace configuration |

The pre-existing clock failure was fixed by allowing the existing date-policy helper to receive the fixture clock; no runtime authorization behavior changed.

### Final automated checks

| Command | Result |
| --- | --- |
| `pnpm run test:security` | 45 passed: 7 frontend and 38 API |
| `pnpm run typecheck` | Passed across libraries, API, dashboard, scripts, and mockup sandbox |
| `pnpm run test:baseline` | 5/5 deterministic KPI and response-contract tests passed |
| `pnpm run test` | 57/57 passed |
| `pnpm run build` | Passed; the same sourcemap and large-chunk warnings remain |
| `git diff --check` | Passed |

An initial new security-test organization imported the database package without an environment and failed before assertions. Pure access-token, cookie, and action-policy logic was separated from database-backed enforcement; the standard environment-free security command then passed.

### Disposable runtime matrix

A local PostgreSQL container and fake accounts were used. No production or shared database was migrated or mutated.

| Case | Result |
| --- | --- |
| Successful admin and ordinary-user login | `200`; role and `{ token, user }` shape preserved |
| Wrong password and unknown user | Matching `401` bodies |
| Weak new password | `400` |
| Ordinary user calling admin users route | `403` |
| Five-second test access token after expiry | Private request `401`; cookie refresh `200`; next navigation request `200` |
| Browser navigation after expiry | Internal CS remained rendered after automatic renewal |
| Browser reload after another expiry | Authenticated dashboard restored through refresh and `/auth/me` |
| Logout | Login screen rendered; refresh with the prior cookie returned `401` |
| Deactivated fake user | Existing access token and refresh both returned `401` |
| Repeated failed login | `429` with `Retry-After` |

The browser smoke used the built dashboard and a five-second access-token lifetime to force renewal. It verified login, authenticated navigation, renewal, page reload restoration, and logout without an application crash or framework error overlay.

## Files changed

- Frontend renewal and logout: `artifacts/agent-dashboard/src/App.tsx`, `artifacts/agent-dashboard/src/lib/api.ts`, and `api.test.ts`.
- Authentication/session implementation: `accessToken.ts`, `authUser.ts`, `sessionToken.ts`, `sessionStore.ts`, `auth.ts`, `authCore.ts`, and the API policy entries.
- Abuse protection: `rateLimitStore.ts`, `abusePolicy.ts`, `abuseProtection.ts`, and router mounting.
- Account policy and administration: `passwordPolicy.ts`, `users.ts`, `index.ts`, and `setup-admin.mjs`.
- Logging/proxy configuration: `logger.ts`, `app.ts`, and `.env.example`.
- Database: `0005_login_sessions.sql`, `authSessions.ts`, `apiRateLimits.ts`, schema exports, and migration journal.
- Tests: frontend API tests, `loginSessions.test.ts`, public-route/auth-core/authorization compatibility tests.

## Remaining limitations

- Google Sheets smoke remains dependent on configured approved sheet fixtures and was not rerun for this authentication-only phase. The deterministic sheet authorization tests and the prior phase-4 authenticated workflow verification remain unchanged.
- Live third-party sync, refresh, import, upload, QA generation, Samia model requests, and production data mutations were not invoked. Their route selection and rate-limit policies are covered by deterministic tests.
- No deployment or production migration was performed, so production cookie/proxy behavior remains a deployment-time verification item.
