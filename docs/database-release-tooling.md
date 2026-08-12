# Database bootstrap, schema contract, and migration preflight

Checked-in migrations remain the authority for upgrades. None of these tools
run during build or application startup, and none should be invoked against
Production during ordinary validation.

## Brand-new empty database bootstrap

`lib/db/bootstrap/0004_baseline.sql` is a baseline snapshot generated from the
repository's `main` Drizzle declarations at
`95ae528e171b211745d54fe7a6d5e7ec0e1e5539`. It contains the schema state that
historical migrations 0000-0004 expect, including `qa_reviews`, AI controls,
and action audit objects. Historical migrations were not changed.

The bootstrap command:

- requires an exact non-Production acknowledgement;
- requires `DATABASE_ENVIRONMENT` to be `test`, `development`, `staging`, or
  `preview`;
- requires the database name to contain a disposable/staging marker;
- refuses any user table, sequence, view, or migration ledger already present;
- creates the baseline in one transaction;
- verifies every baseline table/index and the important historical columns;
- records exact hashes/timestamps for migrations 0000-0004 only after their
  expected objects exist;
- optionally applies 0005-0011 through the normal Drizzle migrator and verifies
  the full schema contract.

PowerShell example for a newly created disposable database:

```powershell
$env:DATABASE_ENVIRONMENT='staging'
$env:EMPTY_DATABASE_BOOTSTRAP_ACK='I_ACKNOWLEDGE_THIS_IS_EMPTY_AND_NON_PRODUCTION'
$env:DATABASE_URL='<injected staging URL>'
pnpm run db:bootstrap-empty -- --apply-migrations
pnpm run db:verify-schema-contract
```

Never use bootstrap for the existing Production database. Its upgrade command
remains `pnpm --filter @workspace/db run migrate` after backup and preflight.
A repeated bootstrap intentionally refuses the now non-empty database; repeat
verification uses `db:verify-schema-contract` and the migration ledger.

## Migration-owned schema contract

`lib/db/schema-contract.json` lists every required object from 0005-0011,
including its type, owning migration, parent table/function, purpose, expected
definition fragments, and whether Drizzle represents it. Intentional raw-SQL
objects include:

- `api_rate_limits_updated_idx`;
- action-audit immutability functions/triggers;
- the attendance parser/synchronizer functions and trigger;
- the attendance partial index and consistency check;
- the AI reservation status check.

Run:

```powershell
$env:DATABASE_URL='<injected isolated URL>'
pnpm run db:verify-schema-contract
pnpm run db:verify-schema-contract -- --json
```

The verifier queries PostgreSQL catalogs, checks parent attachment and
normalized definitions, and fails on missing or mismatched objects. Drizzle
declarations are appropriate for application typing and supported declarative
objects; migration/catalog verification is authoritative for raw SQL. Do not
use `push-force` as release validation.

## Non-destructive migration preflight

Preflight starts a read-only transaction, refuses Production indicators, never
prints a connection string or row contents, and reports PostgreSQL version,
relation estimates/sizes, index sizes, locks, long transactions, connection
utilization, database size, attendance backfill counts, migration ledger and
existing target objects.

```powershell
$env:DATABASE_ENVIRONMENT='staging'
$env:DATABASE_URL='<injected staging URL>'
pnpm run db:preflight -- --mode=staging
pnpm run db:preflight -- --mode=staging --json
```

Explicit NO-GO thresholds:

- PostgreSQL major version below 14;
- any ungranted lock on `phone_calls`, `pbx_missed_calls`, or
  `attendance_records`;
- any transaction older than 300 seconds;
- connection use at or above 80 percent;
- a required relation missing.

Warnings requiring a measured low-write window:

- at least 250,000 attendance rows need backfill;
- a relevant table is at least 2 GiB;
- free disk evidence is not available through PostgreSQL. Confirm free space
  externally, with at least twice the estimated index-scan bytes available for
  index/WAL headroom.

Recommended session controls are `lock_timeout = '5s'`,
`statement_timeout = '30min'` for 0008, and `statement_timeout = '20min'` for 0010. Apply these only in the controlled migration session, not globally.

### Migration 0008 monitoring

It creates non-concurrent indexes, so it takes `ShareLock` on each indexed table
and blocks writes while scanning. Monitor `pg_stat_activity`, `pg_locks`, WAL,
database disk, and index creation duration. Abort before migration on a lock
wait, a transaction older than five minutes, connection use at 80 percent, or
insufficient disk headroom.

### Migration 0010 monitoring

It briefly locks `attendance_records` for column/trigger/check DDL, updates each
valid legacy date (row locks and WAL), and builds a non-concurrent partial
index. Record backfill-eligible and invalid-preserved counts before migration;
afterward confirm that eligible becomes zero, invalid rows remain null in the
shadow column, the trigger synchronizes a synthetic staging insert, and the
schema contract passes.

On transactional failure, inspect the Drizzle ledger and target objects before
retrying. Do not delete ledger rows or partially guessed objects. Since Drizzle
runs the pending PostgreSQL migrations in a transaction, repair the prerequisite
or operational condition and rerun the same migration command.
