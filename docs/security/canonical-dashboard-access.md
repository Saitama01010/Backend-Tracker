# Canonical Dashboard Access

Migration `0014_canonical_dashboard_access` introduces the canonical Portal access model without converting existing accounts. `portal_users.access_role IS NULL` is the explicit legacy transition state; the existing `role`, team, tab, agent, and date fields remain authoritative for those accounts until an administrator migrates one manually.

For canonical accounts, `access_role` is authoritative. The legacy `role` value is compatibility-only: Agent and Manager use `view`, while Admin uses `admin`. The server resolves the current Portal account, linked roster identity, active state, primary team, normalized team grants, normalized tab grants, and permissions for every authenticated request.

## Effective scope

- Agent: the linked `team_agents.id` only. A team grant, including a grant for the Agent's own team, adds full-team visibility.
- Manager: every roster identity in `primary_team`, including inactive historical identities, plus every explicitly granted team.
- Admin: unrestricted.
- Legacy: unchanged transitional behavior.

Roster activity controls whether a linked Agent may authenticate. It does not remove the roster identity or hide that identity's historical records from an authorized Manager or Admin.

## Server enforcement inventory

Canonical identity and team scope are applied to:

- Quo statistics, completed calls, and live calls
- VoS/PBX statistics, live calls, missed/no-callback data, missed tables, breakdowns, and callback review
- ReadyMode statistics
- Google Sheets-derived dashboard data
- Agent Roster reads
- attendance, attendance call logs, attendance contacts, and attendance mutations
- breaks
- violations and verification records
- QA statistics, reviews, tasks, downloads, and agent lists
- the NSF ReadyMode queue

Provider records that are name-based are authorized only after the provider identity resolves to a canonical roster record. Unknown or ambiguous provider identities fail closed for canonical users. Historical roster rows are not filtered by current `team_agents.active` state.

## Explicit fail-closed exception

Onboarding report, onboarding analytics, and live-transfer export/status datasets do not currently expose a reliable canonical roster identity on every row. Canonical Agent and Manager requests to those endpoints are therefore denied, even if the onboarding tab was granted. Canonical Admin and intentionally unmigrated legacy behavior remain unchanged. These endpoints must not be enabled for canonical non-admins until their source contract supports authoritative row scoping.

## Password and session behavior

New and reset passwords require at least 15 characters and at most 72 UTF-8 bytes. Passwords are hashed with the existing `bcryptjs` implementation. A password reset or Portal-account deactivation revokes all sessions. Roster deactivation revokes sessions for the linked Portal account while preserving both the Portal account and `team_agent_id` linkage.
