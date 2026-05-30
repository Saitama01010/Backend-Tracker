---
name: AI models for Samia & QA
description: Which LLM provider/model the Samia assistant and QA call-scoring use, and why.
---

# AI models: Samia & QA

Both the Samia assistant and QA call scoring run through the **OpenRouter**
AI-integrations client on **DeepSeek** (`deepseek/deepseek-chat`) instead of
GPT-4.1 / GPT-4.1-mini.

**Why:** user explicitly wanted lower per-call credit usage for Samia and QA.

**How to apply / override:** model is env-driven — `SAMIA_MODEL` and `QA_MODEL`.
Clients use the auto-provisioned `AI_INTEGRATIONS_OPENROUTER_*` env (never edit).
To revert, set those envs back to `gpt-4.1` / `gpt-4.1-mini` and point the client
at `AI_INTEGRATIONS_OPENAI_*`.

**Samia temperature band (`SAMIA_TEMPERATURE`, default 0.8):** DeepSeek is
sensitive here. ~0.2 = flat/no wit; ~1.3 = degenerates into incoherent
multilingual token soup mid-answer AND stops calling tools reliably (e.g. refuses
to call analyze_calls, lectures about terminology instead). Keep within ~0.7–0.9.
**Why:** raising to 1.3 to restore humor broke real tool-loop answers in
production. Don't chase personality past ~0.9 on DeepSeek.

**Gotchas confirmed on DeepSeek via OpenRouter:** JSON mode (`response_format`
json_object, used by QA) and multi-round tool/function calling (Samia) both work.
OpenRouter expects `max_tokens`, not OpenAI's `max_completion_tokens`. Model names
are not guessable — list with the OpenRouter `/api/v1/models` endpoint.
