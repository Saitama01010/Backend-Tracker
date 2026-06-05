---
name: Long batch jobs in this sandbox
description: How to run multi-minute offline scripts (LLM passes, scrapes) that exceed the 2-min shell limit
---

# Long-running batch scripts

Bash backgrounding (`nohup ... &`, `disown`) does NOT survive: detached processes are
killed when the bash tool call returns. Do not rely on it for multi-minute jobs.

**Why:** the sandbox tears down child processes spawned by a shell command once that
command completes; a detached node job died within seconds with no output.

**Preferred approach — run as a temporary console workflow.** Workflows persist beyond
a single tool call, so a multi-minute LLM/scrape pass can run to completion there while
you poll its logs. Remove the temp workflow when done.

**Fallback — resumable foreground batches.** If a workflow isn't convenient, make the
script idempotent and run it in FOREGROUND chunks each under the ~120s shell timeout:
- Persist expensive results to disk frequently (every N items), keyed by id; skip
  already-done items on restart so re-runs are cheap.
- Split phases (e.g. fetch/cache vs. compute) and cap per-invocation work via an env
  var (batch size / phone limit); loop by re-issuing the command until done.
- Wrap with `timeout <sec> env VAR=… node script` so the call returns cleanly before
  the tool's own timeout, then re-invoke to continue.

**Regardless of approach:** add a resumable cache, per-request fetch timeouts + retry,
and trade concurrency for retries when hitting the AI proxy / external APIs (429s).
