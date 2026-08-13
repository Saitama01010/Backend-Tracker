# Agent Roster identity Production reconciliation

Date: 2026-08-13

Production application baseline before the operation:
`ba5731d94f5f25d235e78c0f210cc52d21e7e523`.

## Approved duplicate correction

The business owner confirmed that `team_agents.id = 29` and
`team_agents.id = 30` represented the same person, Max Francis. ID 29 was
retained as the canonical record because its shift and provider footprint match
the historical attendance and calling activity. The accidental shift-7 row,
ID 30, was removed in a guarded `SERIALIZABLE` Production transaction.

Before deletion, the transaction locked both rows, verified their exact field
values, confirmed that no foreign key or persisted roster-ID relationship
needed repointing, and checked the historical name-based counts. It deleted
exactly ID 30 through exact predicates and `DELETE ... RETURNING`. The
transaction committed only after ID 29 remained as the sole normalized
`max francis` identity and the historical counts were unchanged.

| Historical source | Before | After |
| --- | ---: | ---: |
| `phone_calls.agent_name` | 840 | 840 |
| `qa_reviews.agent_name` | 203 | 203 |
| `manager_qa_tasks.agent_name` | 203 | 203 |
| `readymode_uploads.agent_name` | 5 | 5 |
| `attendance_members.name` | 2 | 2 |

The post-reconciliation roster contained 44 agents and had no normalized
English-name, Arabic-name, or email conflict groups and no invalid English
identity. All 44 legacy agents still lacked email; no email was inferred or
backfilled.

## Migration result

Neon Backup & Restore showed a six-hour history-retention window before the
operation. The Production-specific preflight found no waiting roster locks, no
transaction older than five minutes, and low connection utilization. Migration
`0013_canonical_agent_roster_identity.sql` then applied through the checked-in
Drizzle migration process.

Post-migration catalog verification confirmed:

- `name_normalized` is populated for all 44 agents and is `NOT NULL`;
- Arabic name and email identity columns remain nullable;
- global normalized-English uniqueness is enforced;
- normalized-Arabic and normalized-email uniqueness is enforced only for
  non-null values;
- all three normalization/pairing check constraints are validated;
- ID 29 remains unchanged apart from the migration-owned normalized and email
  columns, while ID 30 is absent;
- historical name-based counts remain unchanged.

The running pre-feature Production application remained compatible with the
additive schema. Health, login, authorization, Agent Roster reads, dashboard
HTML, Quo, Google Sheets, ReadyMode, attendance, and QA/reporting succeeded.
VoS/PBX continued to return the pre-existing upstream login `401`; it was not
caused by the roster reconciliation or schema migration.
