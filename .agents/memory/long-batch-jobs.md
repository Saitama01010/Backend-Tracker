---
name: Long batch jobs over the agent bash tool
description: How to run multi-minute batch processing (e.g. transcript+LLM enrichment over thousands of rows) reliably in this environment.
---

# Running long batch jobs reliably

The agent's `bash` tool SIGTERMs the whole process group when each command returns,
and also caps command runtime (~120s, often killed earlier under memory pressure).
Backgrounding with `nohup`/`setsid`/`disown` is UNRELIABLE — sometimes an orphan
survives and keeps writing, sometimes it dies immediately. Trivial commands even
get 143-killed when orphaned `node` processes pile up and cause memory pressure.

**Reliable pattern: run the batch as a temporary console Workflow.**
- `configureWorkflow({ name, command: "bash -lc 'cd … && node script.mjs'", outputType: "console", autoStart: true })`
- Workflows are Replit-managed and run to completion independent of the bash tool.
- Poll progress with `getWorkflowStatus({name, maxScrollbackLines})`; the script's own
  stdout (progress lines) is visible there. State goes `running` → `finished` on exit.
- `removeWorkflow({name})` when done. (Don't leave extra workflows around.)

**Make the script resumable + chunk-safe regardless of mechanism:**
- Cache every result to a JSON file (flush every ~20 items). On restart, skip cached ids.
- Add an AbortController timeout to EVERY `fetch` (transcript AND LLM) — hung connections
  with no timeout stall workers and tank throughput to ~0.
- Support a `MAXSEC` env budget for the bash-chunk fallback, but the workflow path lets you
  just run to completion.

**Why:** discovered the hard way — bash-chunking 2600 LLM-classified calls kept getting
killed mid-run; the workflow ran the same script start-to-finish without intervention.

**How to apply:** any enrichment/scrape/LLM pass over hundreds+ rows → resumable cached
script + temporary console workflow, not bash backgrounding.

## AI Integrations OpenAI proxy throughput
High concurrency against `${AI_INTEGRATIONS_OPENAI_BASE_URL}/chat/completions` causes a large
fraction of calls to fail (rate-limited / aborted) if retries are stingy. At CONC=6 with
2 retries × 20s, ~70% of a 2600-call batch came back unclassified; re-running at CONC=3 with
5 retries × 45s dropped failures to ~3%. Rate at CONC=3 ≈ 0.6/s. **Trade concurrency for
generous retry budget** on LLM classification passes; mark residual hard-fails for manual review.

## OpenPhone transcript fetch quirk
`GET /call-transcripts/{callId}` is fast serially (~150–300ms) but parallel requests can HANG
(OpenPhone stalls the connection instead of returning a quick 429). Always pass an
AbortController timeout so hung ones abort and retry instead of freezing a worker.
Transcript shape: `data.dialogue[]` of `{identifier, content}`; identifier === the line's own
E.164 number = the agent, anything else = the customer.
