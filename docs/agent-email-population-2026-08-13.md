# Agent email population - 2026-08-13

## Scope and baseline

- Source: business-owner workbook `Backend Tracker.xlsx`, sheet `Sheet1` (25 data rows). The workbook was audited read-only and was not added to the repository.
- Production and `origin/main` baseline: `ed3ac5ab5f069f2114a1ea78973b5a9404c7fa20`.
- Canonical roster migration: `0013_canonical_agent_roster_identity.sql` was present as Production ledger row 15 with the expected hash; the normalized-name, normalized-email, and active-roster constraints were validated before the write.
- Pre-import roster: 44 total agents (28 active, 16 inactive), all 44 with no email.

## Import result

The workbook contained 25 valid, unique email addresses. A Production dry run used the deployed English-name, Arabic-name, and email normalization rules and required an exact canonical roster match plus compatible shift data.

- 22 active-agent rows matched unambiguously and received normalized emails in one guarded `SERIALIZABLE` transaction.
- No inactive-agent email was populated or changed.
- Three rows were skipped because the workbook shift did not agree with Production: Nora Adam (workbook shift 4, Production shift 6), Kayla Navarro (3 versus 4), and Ryan Henderson (FT versus 4).
- No source row was unmatched, malformed, or in conflict with an existing email; no duplicate normalized English name, Arabic name, or email was created.
- Post-import roster: 44 total, 28 active, 16 inactive; 22 active agents have an email, six active agents remain without one, and all 16 inactive agents remain without one.
- Active agents still missing email: Nora Adam, Andrew Gomez, Kayla Navarro, Ryan Henderson, Zeiad, and Zeiad Fouad-Zack Ford.
- Max Francis remains the single inactive canonical row at ID 29; legacy duplicate ID 30 remains absent.

Only `team_agents.email` and `team_agents.email_normalized` were updated. Names, Arabic aliases, shifts, teams, active status, IDs, timestamps, and historical records were not changed.

## Inactive-access decision

Inactive portal access was not changed. Production has no deterministic `portal_users` to `team_agents` relationship: `portal_users` has no roster foreign key, most non-admin usernames do not exactly match canonical agent names, some accounts are team/shared accounts, and `allowed_agents` is an authorization scope rather than an identity link. String matching would risk disabling the wrong account.

The minimal follow-up is a nullable `portal_users.team_agent_id` foreign key to `team_agents.id`, populated only from authoritative business mappings and left null for admin, shared, and non-agent accounts. Whether it is unique depends on the business rule for one versus multiple accounts per agent. Once mapped, login, refresh, protected-request resolution, and roster deactivation can enforce active-agent status centrally and revoke linked sessions.

## Verification

- Database invariants passed after the transaction: no normalized identity conflicts, no malformed email pairs, and no inactive email changes.
- Historical name-based attribution remained present across attendance, manager QA tasks, phone calls, QA reviews, and ReadyMode uploads.
- Production HTTP smoke checks passed for health, dashboard, login, current user, team agents, Quo stats/live, Google Sheets, ReadyMode, attendance, QA stats, and QA reviews. The existing VoS provider login failure remained isolated to VoS endpoints.
- Live browser verification showed 44 roster rows, 28 active controls, 16 inactive controls, 22 populated roster emails, 22 missing roster emails, and exactly one Max Francis row.
- Regression tests: 29 passed, 0 failed (27 API/auth tests and two frontend roster-identity tests).
- Vercel returned no error-level Production logs in the one-hour post-import query.

No application/authentication code was changed and no Production deployment was created. The repository's Git integration created its normal docs-only PR Preview after publication. This record does not contain the source workbook or email values.
