# Isolated Vercel staging handoff

The current Preview environment is not acceptable for authenticated testing
because it shares Production data and privileged credentials. An operator must
complete this checklist without copying or displaying any Production value.

## Required environment separation

| Variable                                   | Staging required                  | Must differ from Production   | Read-only or mock allowed                  | Minimum staging privilege                              | Value-safe validation                                                                                             |
| ------------------------------------------ | --------------------------------- | ----------------------------- | ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                             | Yes                               | Yes                           | No; use a dedicated writable staging DB    | Schema migration and synthetic application data only   | Pull Preview env into an ignored temporary directory and compare a one-way hash in memory; print only `DIFFERENT` |
| `OLD_DATABASE_URL`                         | No; remove if unused              | Yes when present              | Dedicated staging fallback only            | Same as staging DB                                     | Confirm absent, or hash-compare as `DIFFERENT`                                                                    |
| `TEST_DATABASE_URL`                        | Only guarded test runners         | Yes                           | Dedicated disposable DB                    | Tests may create/delete synthetic fixtures             | Verify database name contains `test`; print only host class and database name                                     |
| `SESSION_SECRET`                           | Yes                               | Yes                           | No                                         | Issue Preview-only sessions                            | Compare hashes in memory; print only `DIFFERENT`                                                                  |
| `RATE_LIMIT_HASH_SECRET`                   | Recommended                       | Yes                           | No                                         | HMAC limiter scopes only                               | Confirm minimum approved length without printing it                                                               |
| `CRON_SECRET`                              | Yes                               | Yes                           | No                                         | Invoke only the staging `/api/jobs/cron`               | Send wrong bearer expecting 401, then exact staging bearer expecting 200; never put it in a query string          |
| `ANTHROPIC_API_KEY`                        | For live AI staging only          | Yes                           | A mock is preferred until final live check | Separate account/project with low spend and rate caps  | Submit one minimal synthetic prompt and inspect usage in the staging billing scope                                |
| `QUO_API_KEY`                              | For live Quo read validation only | Yes                           | Read-only key or mock preferred            | Read approved synthetic/staging calls; no live write   | Read a known staging call ID and confirm unauthorized IDs fail                                                    |
| `QUO_WEBHOOK_SECRET`                       | For webhook staging               | Yes                           | Synthetic secret                           | Sign only synthetic events to the Preview target       | Valid/invalid/replay requests against isolated DB                                                                 |
| `OB_IMPORT_SECRET`                         | If import is tested               | Yes                           | Synthetic secret                           | Import sanitized staging fixtures only                 | Wrong secret 401/403, exact secret accepted for a disposable fixture                                              |
| `GOOGLE_SERVICE_ACCOUNT_JSON`              | If Sheets is tested               | Yes                           | Mock or restricted account                 | Read only specifically approved synthetic spreadsheets | Attempt approved and unapproved IDs; expect success and 403 respectively                                          |
| `READYMODE_USERNAME`, `READYMODE_PASSWORD` | Only for live portal staging      | Yes                           | Mock/sandbox preferred                     | Staging tenant read and approved queue actions only    | Authentication failure test first; never run a Production queue action                                            |
| `VOSLOGIC_EMAIL`, `VOSLOGIC_PASSWORD`      | Only for live PBX staging         | Yes                           | Mock/read-only account preferred           | Read staging/synthetic call history                    | Bounded date read; confirm sanitized failure output                                                               |
| `FRONTEND_ORIGIN`, `PUBLIC_APP_ORIGIN`     | Recommended                       | Preview URL differs naturally | No secret                                  | Exact Preview origin                                   | Allowed-origin OPTIONS 204                                                                                        |
| `CORS_ORIGIN`                              | Recommended                       | Yes                           | No secret                                  | Exact approved Preview origins only                    | Untrusted-origin OPTIONS 403                                                                                      |
| `INTERNAL_API_BASE_URL`                    | When internal calls need it       | Yes                           | No secret                                  | Fixed Preview origin; never derived from Host          | Static config inspection plus same-origin health request                                                          |
| `TRUST_PROXY_HOPS`                         | No on Vercel                      | N/A                           | N/A                                        | Vercel code path fixes trust proxy to one hop          | Confirm `VERCEL=1`; do not override unless topology changes                                                       |

Also configure the AI model allowlist, input/output limits, timeout,
per-user limits, reservation retention and cleanup batch bounds explicitly for
staging. No Production phone number, transcript, webhook delivery, spreadsheet,
session cookie, or customer record may enter staging.

## Vercel Preview procedure

1. Create or select a dedicated non-Production PostgreSQL database. Populate
   synthetic data only.
2. In Vercel Project Settings → Environment Variables, add branch-specific
   Preview values for `hardening/14-final-validation`. Do not select Production.
3. Remove or replace any shared Production/Preview value that could reach
   Production systems. A branch-specific `DATABASE_URL` is insufficient while
   `OLD_DATABASE_URL` or integration credentials still fall back to Production.
4. Generate independent Preview session, rate-limit, cron, webhook, and import
   secrets. Never copy Production values.
5. Use sandbox, mock, or least-privilege read-only integration identities.
6. Add separate Anthropic usage monitoring, concurrency/rate caps, and a small
   staging spend limit.
7. Redeploy the exact approved SHA to Preview. Do not promote it.
8. Pull Preview and Production metadata/values into an ignored temporary
   directory, compare sensitive values in memory, print only `SAME`, `DIFFERENT`,
   `MISSING`, and delete the files immediately. Every privileged value above
   must be `DIFFERENT` or intentionally `MISSING` in Preview.
9. Bootstrap a brand-new empty staging DB only with the guarded command in
   `database-release-tooling.md`; otherwise run ordinary migrations 0005-0011.
10. Run the schema contract and preflight, then the full synthetic browser,
    authentication, authorization, download, integration and cron matrix.

Safe CLI shape for adding a Preview-only value interactively:

```powershell
vercel env add DATABASE_URL preview hardening/14-final-validation --sensitive
vercel env add SESSION_SECRET preview hardening/14-final-validation --sensitive
vercel env add CRON_SECRET preview hardening/14-final-validation --sensitive
```

Repeat for each required secret; enter values only at Vercel's protected
prompt. Verify with `vercel env list preview hardening/14-final-validation`—the
listing exposes names and scopes, not values.

Staging remains incomplete until an operator selects a high-frequency scheduler
strategy and validates the exact endpoint with the staging-only cron secret.
