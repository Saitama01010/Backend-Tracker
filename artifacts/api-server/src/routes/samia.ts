import { Router } from "express";
import OpenAI from "openai";

const router = Router();

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

const SAMIA_SYSTEM = `You are Samia, an intelligent performance analyst assistant embedded in the Backend Tracker dashboard.

Your job is to help the team understand their call center numbers — Retention, Internal CS, and NSF teams.

You have access to live stats that will be injected into each message as a JSON block. Use them to answer questions precisely with actual numbers. Be concise, confident, and direct. When quoting numbers, be specific. Format numbers with commas. Use % for rates. If asked about a metric you don't have data for, say so honestly.

Your personality: professional but warm, sharp, and helpful. You speak like a smart analyst who knows the numbers cold.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

router.post("/samia/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body as { message: string; history: ChatMessage[] };
    if (!message?.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    // Fetch live stats in parallel
    const [vosRes, quoRes] = await Promise.allSettled([
      fetch(`http://localhost:${process.env["PORT"]}/api/vos/stats`).then((r) => r.ok ? r.json() : null),
      fetch(`http://localhost:${process.env["PORT"]}/api/quo/stats?from=${new Date().toISOString().slice(0, 10)}T00:00:00.000Z&to=${new Date().toISOString()}`).then((r) => r.ok ? r.json() : null),
    ]);

    const vos = vosRes.status === "fulfilled" ? vosRes.value : null;
    const quo = quoRes.status === "fulfilled" ? quoRes.value : null;

    // Build a concise stats summary for context
    const statsLines: string[] = [];

    if (vos) {
      statsLines.push("=== PBX (VoSLogic) Live Stats ===");
      if (vos.dashboard) {
        const d = vos.dashboard;
        statsLines.push(`Active calls: ${d.activeCalls ?? 0}`);
        statsLines.push(`Total calls today: ${d.totalCallsToday ?? 0}`);
        statsLines.push(`Inbound today: ${d.totalInboundToday ?? 0}`);
        statsLines.push(`Outbound today: ${d.totalOutboundToday ?? 0}`);
        statsLines.push(`Missed calls today (VoSLogic total): ${d.missedCallsToday ?? 0}`);
      }
      if (vos.ringGroupMissed && vos.ringGroups) {
        const rgMap: Record<number, string> = {};
        for (const rg of vos.ringGroups) rgMap[rg.id] = rg.name;
        statsLines.push("Missed by ring group (PBX, cumulative today):");
        for (const [id, cnt] of Object.entries(vos.ringGroupMissed)) {
          statsLines.push(`  ${rgMap[Number(id)] ?? id}: ${cnt} missed`);
        }
      }
      if (vos.callHistory?.length) {
        statsLines.push("PBX per-agent today:");
        for (const a of vos.callHistory.slice(0, 20)) {
          statsLines.push(`  ${a.agentName}: ${a.calls} calls, ${a.answered} answered, ${a.missed} missed, ${Math.round(a.durationSeconds / 60)}min talk`);
        }
      }
    }

    if (quo) {
      statsLines.push("=== OpenPhone (Quo) Stats — today ===");
      if (quo.teamStats) {
        for (const [team, agentDays] of Object.entries(quo.teamStats)) {
          type DayStats = { totalCalls?: number; answered?: number; missed?: number; talkSeconds?: number; inbound?: number; outbound?: number };
          const agentMap = agentDays as Record<string, Record<string, DayStats>>;
          let teamCalls = 0, teamAnswered = 0, teamMissed = 0, teamSecs = 0;
          const agentSummaries: string[] = [];
          for (const [agent, days] of Object.entries(agentMap)) {
            let calls = 0, answered = 0, missed = 0, secs = 0;
            for (const day of Object.values(days)) {
              calls += day.totalCalls ?? 0;
              answered += day.answered ?? 0;
              missed += day.missed ?? 0;
              secs += day.talkSeconds ?? 0;
            }
            teamCalls += calls; teamAnswered += answered; teamMissed += missed; teamSecs += secs;
            if (calls > 0) agentSummaries.push(`  ${agent}: ${calls} calls, ${answered} answered, ${missed} missed, ${Math.round(secs / 60)}min`);
          }
          statsLines.push(`${team.toUpperCase()} team: ${teamCalls} calls, ${teamAnswered} answered, ${teamMissed} missed, ${Math.round(teamSecs / 60)}min talk`);
          for (const s of agentSummaries) statsLines.push(s);
        }
      }
    }

    const statsContext = statsLines.length
      ? `\n\nLIVE DASHBOARD DATA (as of ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} LA time):\n${statsLines.join("\n")}`
      : "\n\n[Live stats unavailable right now]";

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SAMIA_SYSTEM + statsContext },
      ...history.slice(-10).map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
      { role: "user", content: message },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages,
      max_completion_tokens: 512,
    });

    const reply = completion.choices[0]?.message?.content ?? "Sorry, I couldn't generate a response.";
    return res.json({ reply });
  } catch (err) {
    req.log.error(err, "samia chat error");
    return res.status(500).json({ error: "AI request failed" });
  }
});

export default router;
