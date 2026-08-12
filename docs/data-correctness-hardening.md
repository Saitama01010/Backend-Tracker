# Data correctness hardening baseline

Branch: `hardening/12-data-correctness`
Base: tested `hardening/11-frontend-performance` at `d8c94fbb78a812b532af17164d9496c15ea5d7a9`

This phase is compatibility-first. It does not delete, normalize, or replace historical attendance values. API response fields remain unchanged; the new PostgreSQL date is an internal nullable shadow column.

## Correctness inventory

### Attendance status values

The previously split browser/server vocabulary was:

- Server: `in`, `off`, `late`, `pto`, `absent`, `nsnc`
- Browser: `in`, `off`, `late`, `pto`, `nsnc`, `conf`

The canonical write vocabulary now recognizes all existing values: `in`, `late`, `off`, `pto`, `absent`, `nsnc`, and `conf`. Compatibility aliases accepted at write/import boundaries include `day off`, `no show no call`, and `confirmed`. Unknown free text is rejected on new writes, but existing rows are still returned as stored and their notes remain editable without rewriting the legacy status.

### Dates and timezones

- Business/reporting days: `America/Los_Angeles` by default.
- Staff shift wall times: `Africa/Cairo` by default.
- Historical shift timestamps before `2026-08-10` use the exact former `LA midnight + (shift + 3) hours` calculation, so historical totals do not move.
- On and after the configurable cutover, shifts resolve as Cairo wall times and therefore follow Egypt daylight-saving rules.
- Historical sheet timestamps before the same cutover retain the former fixed UTC+2 interpretation; later rows use `Africa/Cairo` IANA rules.
- Calendar-day ranges use adjacent local midnights. They can be 23, 24, or 25 hours.
- Pre-cutover zoneless PBX timestamps retain the former permanent `-07:00` interpretation; post-cutover timestamps use the configured business timezone and its PST/PDT rules.
- Browser API filters resolve business-day bounds explicitly; they no longer depend on the browser's local timezone or `toISOString()` of a local midnight.

### Operational configuration

Defaults deliberately match the prior hardcoded behavior. Invalid values fail at server startup with sanitized server-side diagnostics. No secret is added to client configuration.

Server configuration:

| Area | Variables |
| --- | --- |
| Timezones/cutovers | `BUSINESS_TIMEZONE`, `STAFF_TIMEZONE`, `ATTENDANCE_SHIFT_TIMEZONE_CUTOVER`, `RETENTION_CUTOVER_DATE` |
| Attendance import | `ATTENDANCE_IMPORT_YEAR`, `ATTENDANCE_IMPORT_SOURCES_JSON`, `ATTENDANCE_MEMBER_ALIASES_JSON` |
| Teams/lines | `QUO_LINE_TEAM_MAP_JSON`, `TRACKED_TEAM_LINE_NAMES`, `RETENTION_MAIN_LINE_ID`, `ONBOARDING_LINE_ID`, `ONBOARDING_LINE_NUMBER`, `ONBOARDING_LINE_LABEL` |
| Sheets | `DASHBOARD_SHEET_SOURCES_JSON`, `READYMODE_SHEET_ID`, `READYMODE_SHEET_GID` |
| AI models | `ANTHROPIC_MODEL_ALLOWLIST`, `ANTHROPIC_SAMIA_MODEL`, `ANTHROPIC_QA_MODEL`, `ANTHROPIC_LT_MODEL`, `ANTHROPIC_OB_MODEL` |

Browser-visible non-secret configuration:

- `VITE_BUSINESS_TIMEZONE`, `VITE_STAFF_TIMEZONE`, `VITE_TIMEZONE_CORRECTNESS_CUTOVER`, `VITE_RETENTION_CUTOVER_DATE`
- `VITE_OLD_RETENTION_SHEET_ID`, `VITE_OLD_RETENTION_SHEET_GID`
- `VITE_NEW_RETENTION_SHEET_ID`, `VITE_NEW_RETENTION_SHEET_GID`
- `VITE_OLD_NSF_SHEET_ID`, `VITE_OLD_NSF_SHEET_GID`
- `VITE_NEW_NSF_SHEET_ID`, `VITE_NEW_NSF_SHEET_GID`
- `VITE_IDP_HANDLED_SHEET_ID`, `VITE_IDP_HANDLED_SHEET_GID`
- `VITE_IDP_CANCEL_RETAINED_SHEET_ID`, `VITE_IDP_CANCEL_RETAINED_SHEET_GID`

Shifts remain database records because they are operational member data. Secrets, credentials, tokens, and service-account details remain server-only environment values.

## Attendance date migration plan

Migration `0010_attendance_date_compatibility.sql` is phase one of a reversible migration:

1. Keep `attendance_records.date` text as the unique key and public response source.
2. Add nullable `attendance_date date`.
3. Backfill only strings that round-trip as real `YYYY-MM-DD` PostgreSQL dates.
4. Leave malformed or unknown legacy text intact with a null shadow date.
5. Synchronize the shadow on inserts and text-date updates.
6. Read `coalesce(attendance_date::text, date)` so valid and legacy records remain visible.
7. Audit null/mismatch counts and historical report equality before considering a later constraint or type swap.

Rollback SQL is in `docs/sql/0010_attendance_date_compatibility.rollback.sql`. It drops only the trigger, check, index, function, and shadow column; the original text field and all records remain intact.

Do not make the shadow column non-null and do not drop the text column until production data has been separately audited and fixed ranges have been approved. That later step is intentionally outside this phase.

## Fixed-range equivalence evidence

Sanitized pre-change fixtures were captured before implementation and asserted after implementation:

| Range | Pre-change result | Post-change result |
| --- | --- | --- |
| 2026-02-28 through 2026-03-09 | 4 total: in 1, late 1, off 1, pto 1 | Equal |
| 2026-10-31 through 2026-11-02 | 3 total: absent 1, nsnc 1, conf 1 | Equal |
| 2026-12-31 through 2027-01-01 | 2 total: in 1, late 1 | Equal |

The PostgreSQL integration test also snapshots every sanitized report row before migration, compares it with the compatibility read after migration, rolls back, and compares the original text rows again.

## Test coverage

- Canonical status values, aliases, and invalid writes.
- Month, year, leap-day, midnight, LA spring-forward, and LA fall-back boundaries.
- Cairo summer/winter shift offsets and historical shift compatibility.
- PBX zoneless timestamps in PST and PDT.
- Browser API ranges in 23-hour and 25-hour business days.
- Valid and invalid startup configuration.
- Additive migration, valid-date backfill, malformed-date preservation, compatibility trigger, API-shape selection, and rollback.
- Fixed historical sanitized report totals.

Run:

```powershell
$env:DATA_CORRECTNESS_DATABASE_URL='postgresql://user:password@localhost:5432/disposable_test_database'
pnpm run test:data-correctness
```

The integration database must be disposable and must not contain production data.

## Pre-existing migration-chain failure

Before this phase, a clean disposable PostgreSQL migration run already stopped in `0003_anthropic_controls.sql` because `qa_reviews` did not exist. The error was recorded separately and this phase does not reorder or rewrite earlier migrations. Migration `0010` was therefore validated independently against a disposable attendance table, including its rollback, while the inherited application, security, baseline, and performance suites were run separately.
