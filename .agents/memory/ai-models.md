---
name: AI models for Samia & QA
description: Which LLM provider/model the Samia assistant and QA call-scoring use, and why.
---

# AI models: Samia & QA

**Samia** runs on **OpenAI `gpt-4.1`** (default). **QA** call scoring still runs
on **OpenRouter DeepSeek** (`deepseek/deepseek-chat`) to save credits.

**Why Samia is NOT on DeepSeek:** DeepSeek is unreliable at agentic tool-calling
in Samia's full multi-tool context — it FABRICATED call/transcript data (wrong
agent names + times for calls that didn't exist in the DB) and never actually
invoked `analyze_calls`. For a coaching tool that managers use to correct real
employees, hallucinated call logs are dangerous, so the user chose to pay more
for `gpt-4.1`'s reliable grounding. (Lowering temperature fixed coherence but NOT
the fabrication — the model simply skipped the tool and made data up.)

**How model→client routing works:** `SAMIA_MODEL` env (default `gpt-4.1`).
`samiaClient = SAMIA_MODEL.includes("/") ? openrouter : openai` — a slash-style id
(e.g. `deepseek/deepseek-chat`) routes through the OpenRouter client, anything
else through the OpenAI client. `QA_MODEL` env controls QA (still DeepSeek).
Both `AI_INTEGRATIONS_OPENAI_*` and `AI_INTEGRATIONS_OPENROUTER_*` envs are
auto-provisioned — never edit.

**Samia temperature (`SAMIA_TEMPERATURE`, default 0.8):** balance of personality
vs coherence. Note from the DeepSeek era: ~1.3 caused incoherent multilingual
token soup + tool skipping; gpt-4.1 is far more robust but 0.8 is a safe default.

**DeepSeek-via-OpenRouter gotchas (still relevant for QA / any DeepSeek use):**
JSON mode (`response_format` json_object) and multi-round tool calling both work,
but tool-calling RELIABILITY is poor under many-tool/large-context loads (see
above). OpenRouter expects `max_tokens`, not OpenAI's `max_completion_tokens`.
Model names are not guessable — list with OpenRouter `/api/v1/models`.
