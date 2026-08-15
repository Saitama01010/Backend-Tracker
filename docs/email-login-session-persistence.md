# Email login and role-scoped browser sessions

Portal authentication first uses an explicitly assigned `portal_users.email_normalized`. When a canonical Agent has no Portal override, authentication uses the linked authoritative `team_agents.email_normalized` identity. Login failures remain generic and retain the independent per-IP and normalized-account rate limits.

## Browser persistence

- Administrators receive the existing persistent HttpOnly refresh cookie. Their access token and public user profile are stored in `localStorage`, and the application may hand the submitted email and password to the browser Credential Management API. The application never stores an administrator password itself.
- Agents and managers receive a session-only HttpOnly refresh cookie. Their access token, public user profile, and a separate refresh binding are stored only in `sessionStorage`.
- The server stores only a SHA-256 hash of the combined non-admin cookie token and tab binding. The cookie cannot refresh a session without the binding, so reopening the site after the tab or browser closes requires a new login.
- Existing persistent non-admin refresh sessions are rejected and revoked on their next refresh. They are not silently converted into a new tab session.
- Password changes, deactivation, email changes, and transitions across the admin/non-admin persistence boundary revoke all existing sessions.

Browser password saving is intentionally requested only after the server returns an administrator role. Login fields disable generic form autocomplete so the application does not request password-manager storage for agents or managers. Browser extensions and user-configured password managers ultimately control their own behavior.

## Account administration

Canonical Agents may use their linked Agent Roster email or an explicit Portal override. Managers, administrators, and legacy/unlinked accounts require a unique explicit Portal email. Active accounts cannot lose their final login email, and inactive accounts cannot be reactivated without one. Existing active legacy accounts without an email remain visible in User Management but cannot authenticate until an administrator assigns one.

No database migration is required: the normalized unique email columns, canonical roster link, and session table already exist. Before deployment, verify that every active account has either an explicit Portal email or a linked roster email.
