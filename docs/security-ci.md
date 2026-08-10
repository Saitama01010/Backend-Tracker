# Security CI policy

Security checks run on pull requests and pushes to `main`; CodeQL, dependency,
OSV, and secret scans also run on a weekly schedule or on demand. Third-party
GitHub Actions are pinned to immutable commit SHAs, downloaded scanner binaries
are pinned to release versions and SHA-256 checksums, and pnpm installs use the
committed lockfile with `--frozen-lockfile`.

Scanner reports are written only below `RUNNER_TEMP`. They are not uploaded as
workflow artifacts and detailed findings are not echoed into public logs. Run
the same scanner locally when a generic CI failure needs investigation, keep
the report outside the repository, and do not paste credential material into
an issue or pull request.

## Gates

- `pnpm run audit:dependencies` fails on high or critical npm advisories while
  keeping detailed advisory records out of CI output.
- OSV-Scanner checks `pnpm-lock.yaml` and fails on any finding that has not been
  reviewed in `osv-scanner.toml`.
- Gitleaks checks every commit introduced by a pull request or push. Scheduled
  and manual runs scan the complete current tree. Full-history investigations
  are performed locally so historical incident details are not published.
- CodeQL uses the `security-extended` JavaScript/TypeScript query suite and
  stores results in GitHub's native code-scanning controls; no SARIF artifact
  is uploaded by these workflows.
- The quality workflow runs lint, type checking, all repository test commands,
  the production build, and the frontend bundle budget.

## Narrow exceptions

- `osv-scanner.toml` contains one time-bounded advisory exception for the
  ExcelJS `uuid` dependency. ExcelJS declares `uuid` 8.x and this repository's
  reachable usage is UUID v4; the affected caller-buffer APIs are UUID v3, v5,
  and v6. A major override is intentionally deferred until ExcelJS supports it.
- `.gitleaksignore` contains only the Git and directory fingerprints for one
  sanitized background-job test fixture. No path-wide, rule-wide, or historical
  credential suppression is present.

Do not add a broad directory, ecosystem, severity, or scanner exclusion. Every
future exception must identify one advisory or exact fingerprint, document why
the code path is not affected, and include an expiry date where supported.
