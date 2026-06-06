/* One-off: build call-analysis enrichment for May deals. Run with node. */
const fs = require("fs");
const { createRequire } = require("module");
const reqDb = createRequire("/home/runner/workspace/lib/db/index.js");
const reqApi = createRequire("/home/runner/workspace/artifacts/api-server/index.js");
const pg = reqDb("pg");
const OpenAI = reqApi("openai");

const QUO_KEY = process.env.QUO_API_KEY || "";
const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});
const MODEL = process.env.SAMIA_MODEL || "gpt-4.1";

const deals = JSON.parse(fs.readFileSync("/tmp/deals.json", "utf8"));
let phones = [...new Set(deals.map((d) => d._e164).filter(Boolean))];
if (process.env.LIMIT_PHONES) phones = phones.slice(0, parseInt(process.env.LIMIT_PHONES, 10));

const CACHE_PATH = "/tmp/op_cache.json";
const RESULTS_PATH = "/tmp/results.json";
const PHASE = process.env.PHASE || "all"; // fetch | ai | all
const AI_BATCH = process.env.AI_BATCH ? parseInt(process.env.AI_BATCH, 10) : Infinity;
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch {}
let results = {};
try { results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8")); } catch {}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function opFetch(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { Authorization: QUO_KEY } });
      if (r.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(500 * (attempt + 1)); }
  }
  return null;
}

async function getOP(callId) {
  if (cache[callId]) return cache[callId];
  const [sum, tx] = await Promise.all([
    opFetch(`https://api.openphone.com/v1/call-summaries/${callId}`),
    opFetch(`https://api.openphone.com/v1/call-transcripts/${callId}`),
  ]);
  const dialogue = (tx?.data?.dialogue ?? []).map((d) => `${d.identifier ?? "?"}: ${d.content ?? ""}`);
  const summary = (sum?.data?.summary ?? []).join(" ");
  const out = { summary, dialogue };
  cache[callId] = out;
  return out;
}

// pooled async map
async function pool(items, n, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
      if (idx % 50 === 0) process.stdout.write(`.${idx}`);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return ret;
}

function categorize(call) {
  const name = (call.line_name || "").toLowerCase();
  const team = call.line_team || "other";
  if (/onboard/.test(name)) return "onboarding";
  if (team === "nsf") return "nsf";
  if (team === "cs") return "cs";
  if (team === "retention") {
    if (/\bob\b|outbound|\brt ob\b| ob /.test(` ${name} `)) return "retention_ob";
    return "retention_in";
  }
  return "other";
}

(async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const inList = phones.map((_, i) => `$${i + 1}`).join(",");
  const { rows: calls } = await client.query(
    `SELECT id, participant, line_name, line_team, direction, status,
            duration_seconds, post_answer_seconds, agent_name,
            to_char(created_at,'YYYY-MM-DD HH24:MI') AS created_at
     FROM phone_calls WHERE participant IN (${inList}) ORDER BY participant, created_at`,
    phones
  );
  await client.end();
  console.log(`\nloaded ${calls.length} calls`);

  const byPhone = {};
  for (const c of calls) { (byPhone[c.participant] ||= []).push(c); c.cat = categorize(c); }

  if (PHASE === "recount") {
    let n = 0;
    for (const phone of phones) {
      const r = results[phone];
      if (!r) continue;
      const cs = byPhone[phone] || [];
      const completed = cs.filter((c) => c.status === "completed");
      const counts = { retention: 0, nsf: 0, cs: 0, onboarding: 0, other: 0 };
      for (const c of completed) {
        if (c.direction !== "incoming") continue;
        if (c.cat === "retention_in" || c.cat === "retention_ob") counts.retention++;
        else if (c.cat in counts) counts[c.cat]++;
      }
      const retInCompleted = completed.filter((c) => c.cat === "retention_in" && c.direction === "incoming");
      const obCompleted = completed.filter((c) => c.direction === "outgoing");
      const obAttempts = cs.filter((c) => c.direction === "outgoing");
      r.total_calls = cs.length;
      r.completed_calls = completed.length;
      r.retention_completed = counts.retention;
      r.retention_in_completed = retInCompleted.length;
      r.nsf_completed = counts.nsf;
      r.cs_completed = counts.cs;
      r.onboarding_completed = counts.onboarding;
      r.other_completed = counts.other;
      r.ob_completed = obCompleted.length;
      r.ob_attempts = obAttempts.length;
      if (retInCompleted.length === 0 && obAttempts.length > 0) r.ob_done_no_retention = true;
      if (retInCompleted.length > 0) r.ob_done_no_retention = false;
      // Backfill transfer_company from full incoming transcripts if AI left it blank
      if (r.live_call === "Yes" && !r.transfer_company) {
        let a = false, re = false;
        for (const c of completed) {
          if (c.direction !== "incoming") continue;
          const op = cache[c.id];
          if (!op) continue;
          const t = ((op.summary || "") + " " + ((op.dialogue || []).join(" "))).toLowerCase();
          if (/aspire/.test(t)) a = true;
          if (/re-?sync/.test(t)) re = true;
        }
        if (a && !re) r.transfer_company = "Aspire";
        else if (re && !a) r.transfer_company = "Resync";
      }
      n++;
    }
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    console.log(`recount: updated ${n} phones`);
    return;
  }

  // Calls needing OpenPhone enrichment: completed >= 20s
  const enrichIds = calls.filter((c) => c.status === "completed" && (c.duration_seconds ?? 0) >= 20).map((c) => c.id);
  const uniqIds = [...new Set(enrichIds)].filter((id) => !cache[id]);
  console.log(`fetching OpenPhone data for ${uniqIds.length} calls (cached ${enrichIds.length - uniqIds.length})`);
  let fetched = 0;
  await pool(uniqIds, 8, async (id) => { await getOP(id); if (++fetched % 50 === 0) fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  console.log(`\nOpenPhone fetch done`);
  if (PHASE === "fetch") { console.log("fetch phase complete"); return; }

  const dealByPhone = {};
  for (const d of deals) (dealByPhone[d._e164] ||= []).push(d);

  const todo = phones.filter((p) => !results[p]).slice(0, AI_BATCH);
  console.log(`AI phase: ${todo.length} phones to process (${Object.keys(results).length} already done)`);
  let doneCount = 0;
  await pool(todo, 4, async (phone) => {
    const cs = byPhone[phone] || [];
    const completed = cs.filter((c) => c.status === "completed");
    const counts = { retention: 0, nsf: 0, cs: 0, onboarding: 0, other: 0 };
    for (const c of completed) {
      if (c.direction !== "incoming") continue; // team counts = completed INCOMING calls only
      if (c.cat === "retention_in" || c.cat === "retention_ob") counts.retention++;
      else if (c.cat in counts) counts[c.cat]++;
    }
    const retInCompleted = completed.filter((c) => c.cat === "retention_in" && c.direction === "incoming");
    const obCompleted = completed.filter((c) => c.direction === "outgoing");
    const obAttempts = cs.filter((c) => c.direction === "outgoing");

    // Build compact call log + enrichment for AI
    const incomingRet = retInCompleted.filter((c) => (c.duration_seconds ?? 0) >= 20);
    const callLogLines = cs.map((c) => `${c.created_at} | ${c.direction} | ${c.line_name} (${c.cat}) | ${c.status} | ${c.duration_seconds || 0}s | agent:${c.agent_name || "-"}`);

    const enriched = [];
    for (const c of completed) {
      if ((c.duration_seconds ?? 0) < 20) continue;
      const op = cache[c.id];
      if (!op || (!op.summary && (!op.dialogue || !op.dialogue.length))) continue;
      // Feed opening transcript for ALL incoming calls (live transfers land on
      // Onboarding, Retention, or CS lines — not only Retention).
      const snippet = c.direction === "incoming" ? (op.dialogue || []).slice(0, 26).join("\n") : "";
      enriched.push({ when: c.created_at, dir: c.direction, line: c.line_name, cat: c.cat, dur: c.duration_seconds, summary: op.summary, snippet });
    }
    const aspireHit = enriched.some((e) => /aspire|resync|re-?sync/i.test((e.summary || "") + " " + (e.snippet || "")));

    const deal0 = (dealByPhone[phone] || [{}])[0];
    let ai = { live_call: "No", live_call_evidence: "", transfer_source: "", ob_done_no_retention: false, outcome_summary: "" };

    if (cs.length === 0) {
      ai.outcome_summary = "No calls found for this number in the phone system.";
      ai.ob_done_no_retention = false;
    } else {
      const enrText = enriched.map((e, i) =>
        `[#${i + 1}] ${e.when} ${e.dir} on "${e.line}" (${e.cat}) ${e.dur}s\nSummary: ${e.summary || "(none)"}${e.snippet ? `\nOpening transcript:\n${e.snippet}` : ""}`
      ).join("\n\n").slice(0, 14000);

      const sys = `You analyze a debt-relief company's phone call history for ONE customer phone number.
This company receives "live transfers": a partner company representative (from "Aspire" or "Resync", also said as "re-sync") calls IN with the client already on the line, to hand off / transfer the client (usually because the client wants to cancel or has an issue). These come in on ANY inbound line — most often the "Onboarding" line, also "Retention" or "CS Team".
Definitions:
- "Live call" = ANY INCOMING call (on any line: Onboarding, Retention, CS, etc.) where the caller/representative indicates they are from "Aspire" or "Resync"/"re-sync", OR is clearly a partner handing off / transferring this client to your company. Mark "Yes" if any incoming call shows this. Use the opening transcript lines (greeting/intro) as the primary signal. Be inclusive: a mention of Aspire/Resync by an incoming caller, or an explicit "I have a client to transfer", counts. Do NOT count outbound calls your agents made.
- "live_call_evidence" = quote/paraphrase the specific intro line and name the line it came in on, or say why No.
- "transfer_company" = the partner company the client was transferred FROM. Must be EXACTLY "Aspire" or "Resync" (pick whichever the incoming caller states). If the caller clearly is a partner transfer but does not name the company, use "". If it is NOT a live transfer, use "".
- "transfer_agent" = the name the transferring partner rep gave when introducing themselves on the live-transfer call (e.g., from "Hi this is Marcus with Aspire" -> "Marcus"; from "This is Jason, I'm with Eugene here" -> "Jason"). Use their full name if stated. If not a live transfer, or no name was given, use "".
- "transfer_source" = which line/agent/department the live/incoming call came in on or was transferred from (e.g., "Aspire/Resync via Onboarding line", a named agent, or a department). Empty only if there is no incoming call.
- "ob_done_no_retention" = TRUE only if there were outbound (OB) calls/attempts to this customer but ZERO completed incoming calls on the Retention line.
- "Outcome summary" = 2-4 sentence plain-English summary of what happened across ALL the calls (cancellation, retained, payment, onboarding, voicemails, no answer, etc.).
Return STRICT JSON: {"live_call":"Yes|No","live_call_evidence":"...","transfer_company":"Aspire|Resync|","transfer_agent":"...","transfer_source":"...","ob_done_no_retention":true|false,"outcome_summary":"..."}`;

      const user = `Customer: ${deal0.CustomerName || "?"} | Deal status: ${deal0.Status || "?"} | Agent: ${deal0.AgentName || "?"}
Totals: total calls ${cs.length}; completed ${completed.length}; incoming retention-line completed ${retInCompleted.length}; outbound completed ${obCompleted.length}; outbound attempts ${obAttempts.length}.
Department completed-call counts: Retention ${counts.retention}, NSF ${counts.nsf}, CS ${counts.cs}, Onboarding ${counts.onboarding}, Other ${counts.other}.
Aspire/Resync keyword detected in transcripts: ${aspireHit ? "yes" : "no"}.

FULL CALL LOG (chronological):
${callLogLines.join("\n").slice(0, 6000)}

DETAILED CALLS (summaries + retention-call opening transcripts):
${enrText || "(no transcribable conversations)"}`;

      try {
        const comp = await openai.chat.completions.create({
          model: MODEL, temperature: 0.2, response_format: { type: "json_object" },
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        });
        ai = JSON.parse(comp.choices[0]?.message?.content || "{}");
      } catch (e) {
        ai.outcome_summary = `AI error: ${String(e).slice(0, 120)}`;
      }
      // Deterministic OB flag override based on data
      if (retInCompleted.length === 0 && obAttempts.length > 0) ai.ob_done_no_retention = true;
      if (retInCompleted.length > 0) ai.ob_done_no_retention = false;
    }

    results[phone] = {
      total_calls: cs.length,
      completed_calls: completed.length,
      retention_completed: counts.retention,
      retention_in_completed: retInCompleted.length,
      nsf_completed: counts.nsf,
      cs_completed: counts.cs,
      onboarding_completed: counts.onboarding,
      other_completed: counts.other,
      ob_completed: obCompleted.length,
      ob_attempts: obAttempts.length,
      live_call: ai.live_call || "No",
      live_call_evidence: ai.live_call_evidence || "",
      transfer_company: ai.transfer_company || "",
      transfer_agent: ai.transfer_agent || "",
      transfer_source: ai.transfer_source || "",
      ob_done_no_retention: !!ai.ob_done_no_retention,
      outcome_summary: ai.outcome_summary || "",
    };
    if (++doneCount % 10 === 0) fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  });

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\nwrote results for ${Object.keys(results).length} phones total`);
})();
