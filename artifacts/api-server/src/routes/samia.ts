import { Router } from "express";
import OpenAI from "openai";

const router = Router();

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

const SAMIA_SYSTEM = `You are Samia, an intelligent performance analyst assistant embedded in the Backend Tracker dashboard.

Your job is to help the team understand their call center numbers — Retention, Internal CS, and NSF teams.

You have access to live stats injected into each message. Use them to answer questions precisely with actual numbers. Be concise, confident, and direct. Format numbers with commas. Use % for rates. If asked about a metric you don't have data for, say so honestly.

You know the team structure:
- Retention agents track retains and cancels (from Google Sheets) plus outbound call stats (OpenPhone/Quo).
- NSF (National Settlement) agents also track retains/cancels from their own sheet.
- CS (Customer Support) handles inbound calls — no retains/cancels sheet.
- PBX (VoSLogic) tracks all phone calls across all teams via ring groups.

## Attendance tools

You have three attendance tools:

**auto_mark_attendance(date?)** — Automatically marks attendance for all agents on a given date by checking their first call from the dialer. Pass a date (YYYY-MM-DD Egypt time) for historical dates; omit for today. Marks on-time or late based on shift start (10-min grace). Skips anyone whose shift hasn't started yet (today only) or who already has a record. Use this when asked to "mark attendance", "auto-mark", "check who was late", etc.

**get_call_logs(date?)** — Returns per-agent dialer data: first call time, shift info, computed on-time/late status, and any existing record. Use this to preview data before writing, or to show the manager what the system found.

**set_attendance(records[], force?)** — Writes specific attendance records directly. Use this for:
- Pre-planned absences: "Nora said she'll be off on May 10 for a doctor's appointment" → set status "off" with note
- Corrections: fixing a wrong status after auto-mark
- Any case where auto_mark_attendance can't determine the right status
- Pass force=true to overwrite an existing record

When someone tells you an agent will be off, on PTO, or absent on a future date — even with a reason — use set_attendance immediately to record it. Don't wait to be asked. Acknowledge what you wrote and summarize it clearly.

Status values: "in" (present/on-time), "late" (with note like "late 23min"), "off" (day off), "absent", "pto".

Member names must match exactly — they're in the attendance data shown above.

## Phone contact lookup tool

**get_agent_contacts(agentName, date?)** — Returns the list of phone numbers (participants) an agent spoke with, pulled from the OpenPhone database. Before querying, it automatically triggers a fresh sync of the last 3 hours so the data is as current as possible. Each contact includes the phone number, number of calls, total talk time, directions (inbound/outbound), and answered/missed status.

- When no date is given (or "today"): queries the **last 24 hours** from right now — this is intentional to capture full night-shift cycles that cross the Egypt calendar midnight.
- When a specific date is given (YYYY-MM-DD Egypt time): queries that exact calendar day.

Use this when asked "who did X call today", "what numbers did X speak with", "get me the phone numbers that X spoke with", etc. agentName is a partial name — case-insensitive search.

When presenting phone contacts, list them as a clean numbered list: phone number, calls count, talk time, direction (in/out/both). Keep it tight — no extra commentary unless asked.

Your personality: professional but warm, sharp, and helpful. Speak like a smart analyst who knows the numbers cold.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { cells.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

function parseCSVWithHeaders(text: string): Array<Record<string, string>> {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = (rows[0] ?? []).map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) obj[headers[i]] = (row[i] ?? "").trim();
    }
    return obj;
  });
}

function findCol(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return headers[idx] ?? null;
  }
  return null;
}

// Egypt time = UTC+2
function parseEgyptTimestamp(raw: string): Date | null {
  if (!raw) return null;
  // Formats: "5/7/2026 14:32:01", "2026-05-07 14:32:01"
  const mSlash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (mSlash) {
    const [, mon, day, yr, hr, min, sec] = mSlash;
    const utcMs = Date.UTC(Number(yr), Number(mon) - 1, Number(day), Number(hr) - 2, Number(min), Number(sec ?? 0));
    return new Date(utcMs);
  }
  const mIso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (mIso) {
    const [, yr, mon, day, hr, min, sec] = mIso;
    const utcMs = Date.UTC(Number(yr), Number(mon) - 1, Number(day), Number(hr) - 2, Number(min), Number(sec ?? 0));
    return new Date(utcMs);
  }
  return null;
}

function toCaliforniaDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function parseLegacyDate(s: string): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  // M/D/YYYY
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (mdy) return `${mdy[3]}-${String(mdy[1]).padStart(2, "0")}-${String(mdy[2]).padStart(2, "0")}`;
  return null;
}

// ─── Sheet summary helper ────────────────────────────────────────────────────

interface SheetSummary {
  todayRetained: number;
  todayCancelled: number;
  monthRetained: number;
  monthCancelled: number;
  byAgent: Record<string, { todayRetained: number; todayCancelled: number; monthRetained: number; monthCancelled: number }>;
}

function isRetained(status: string): boolean {
  return /retain/i.test(status);
}
function isCancelled(status: string): boolean {
  return !!status && !isRetained(status) && !/idp/i.test(status);
}

async function fetchSheetSummary(
  oldUrl: string,
  newUrl: string,
  newStatusCol: string,
  cutoverDate: string,
  todayStr: string,
  monthStr: string,
): Promise<SheetSummary> {
  const result: SheetSummary = { todayRetained: 0, todayCancelled: 0, monthRetained: 0, monthCancelled: 0, byAgent: {} };

  const ensure = (agent: string) => {
    const key = agent.toLowerCase().trim();
    if (!result.byAgent[key]) result.byAgent[key] = { todayRetained: 0, todayCancelled: 0, monthRetained: 0, monthCancelled: 0 };
    return result.byAgent[key];
  };

  const tally = (agent: string, status: string, dateStr: string) => {
    if (!agent || !dateStr) return;
    const a = ensure(agent);
    const retained = isRetained(status);
    const cancelled = isCancelled(status);
    if (dateStr === todayStr) {
      if (retained) { result.todayRetained++; a.todayRetained++; }
      if (cancelled) { result.todayCancelled++; a.todayCancelled++; }
    }
    if (dateStr.startsWith(monthStr)) {
      if (retained) { result.monthRetained++; a.monthRetained++; }
      if (cancelled) { result.monthCancelled++; a.monthCancelled++; }
    }
  };

  const [oldText, newText] = await Promise.all([
    fetch(oldUrl).then((r) => r.ok ? r.text() : ""),
    fetch(newUrl).then((r) => r.ok ? r.text() : ""),
  ]);

  // Old sheet
  if (oldText) {
    const rows = parseCSVWithHeaders(oldText);
    const headers = Object.keys(rows[0] ?? {});
    const agentCol = findCol(headers, ["Agent", "Agent Name", "Rep"]);
    const statusCol = findCol(headers, ["Status", "Result", "Outcome", "Disposition"]);
    const dateCol = findCol(headers, ["Date", "Day", "Call Date"]);
    for (const r of rows) {
      const agent = agentCol ? (r[agentCol] ?? "") : "";
      const status = statusCol ? (r[statusCol] ?? "") : "";
      const rawDate = dateCol ? (r[dateCol] ?? "") : "";
      const dateStr = parseLegacyDate(rawDate) ?? "";
      tally(agent, status, dateStr);
    }
  }

  // New sheet
  if (newText) {
    const rows = parseCSVWithHeaders(newText);
    for (const r of rows) {
      const tsRaw = r["Timestamp"] ?? "";
      const d = parseEgyptTimestamp(tsRaw);
      if (!d) continue;
      const caDate = toCaliforniaDateStr(d);
      if (caDate < cutoverDate) continue;
      const agent = r["Agent Name"] ?? "";
      const status = r[newStatusCol] ?? "";
      tally(agent, status, caDate);
    }
  }

  return result;
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post("/samia/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body as { message: string; history: ChatMessage[] };
    if (!message?.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    const port = process.env["PORT"];
    const base = `http://localhost:${port}`;
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const monthStr = todayStr.slice(0, 7);
    const todayStart = `${todayStr}T00:00:00.000Z`;
    const nowStr = new Date().toISOString();

    const CUTOVER = "2026-05-04";
    const OLD_RETENTION_URL = "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=0";
    const NEW_RETENTION_URL = "https://docs.google.com/spreadsheets/d/1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o/export?format=csv&gid=837339339";
    const OLD_NSF_URL = "https://docs.google.com/spreadsheets/d/16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38/export?format=csv&gid=0";
    const NEW_NSF_URL = "https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=0";

    // Fetch everything in parallel
    const [
      vosRes,
      quoTodayRes,
      quoMonthRes,
      missedHourlyRes,
      missedDailyRes,
      missedNoCBRes,
      vosLiveRes,
      attendanceRes,
      retentionSheetRes,
      nsfSheetRes,
    ] = await Promise.allSettled([
      fetch(`${base}/api/vos/stats`).then((r) => r.ok ? r.json() : null),
      fetch(`${base}/api/quo/stats?from=${encodeURIComponent(todayStart)}&to=${encodeURIComponent(nowStr)}`).then((r) => r.ok ? r.json() : null),
      fetch(`${base}/api/quo/stats?from=${encodeURIComponent(monthStr + "T00:00:00.000Z")}&to=${encodeURIComponent(nowStr)}`).then((r) => r.ok ? r.json() : null),
      fetch(`${base}/api/vos/missed-hourly`).then((r) => r.ok ? r.json() : null),
      fetch(`${base}/api/vos/missed-daily`).then((r) => r.ok ? r.json() : null),
      fetch(`${base}/api/vos/missed-no-callback`).then((r) => r.ok ? r.json() : null),
      fetch(`${base}/api/vos/live`).then((r) => r.ok ? r.json() : null),
      fetch(`${base}/api/attendance?from=${todayStr}&to=${todayStr}`).then((r) => r.ok ? r.json() : null),
      fetchSheetSummary(OLD_RETENTION_URL, NEW_RETENTION_URL, "Cancel request update", CUTOVER, todayStr, monthStr).catch(() => null),
      fetchSheetSummary(OLD_NSF_URL, NEW_NSF_URL, "File Status", CUTOVER, todayStr, monthStr).catch(() => null),
    ]);

    const vos     = vosRes.status === "fulfilled" ? vosRes.value : null;
    const quoToday = quoTodayRes.status === "fulfilled" ? quoTodayRes.value : null;
    const quoMonth = quoMonthRes.status === "fulfilled" ? quoMonthRes.value : null;
    const missedHourly = missedHourlyRes.status === "fulfilled" ? missedHourlyRes.value : null;
    const missedDaily  = missedDailyRes.status === "fulfilled" ? missedDailyRes.value : null;
    const missedNoCB   = missedNoCBRes.status === "fulfilled" ? missedNoCBRes.value : null;
    const vosLive  = vosLiveRes.status === "fulfilled" ? vosLiveRes.value : null;
    const attendance = attendanceRes.status === "fulfilled" ? attendanceRes.value : null;
    const retSheet = retentionSheetRes.status === "fulfilled" ? retentionSheetRes.value : null;
    const nsfSheet = nsfSheetRes.status === "fulfilled" ? nsfSheetRes.value : null;

    const lines: string[] = [];
    const L = (s: string) => lines.push(s);

    // ── PBX Dashboard ──────────────────────────────────────────────────────────
    if (vos?.dashboard) {
      const d = vos.dashboard;
      L("=== PBX (VoSLogic) Dashboard — Today ===");
      L(`Active calls right now: ${d.activeCalls ?? 0}`);
      L(`Total agents: ${d.totalAgents ?? 0} | Online: ${d.onlineAgents ?? 0} | Available: ${d.availableAgents ?? 0}`);
      L(`Total calls today: ${d.totalCallsToday ?? 0} (inbound: ${d.totalInboundToday ?? 0}, outbound: ${d.totalOutboundToday ?? 0})`);
      L(`Missed calls today (PBX total): ${d.missedCallsToday ?? 0}`);
    }

    // ── Live calls ─────────────────────────────────────────────────────────────
    if (vosLive?.liveCalls?.length) {
      L("\n=== Live Calls Right Now (PBX) ===");
      for (const c of vosLive.liveCalls) {
        const agent = c.agentName ?? "unknown";
        const dir = c.direction ?? "?";
        const rg = c.ringGroupName ? ` [${c.ringGroupName}]` : "";
        const dur = c.duration ? `${Math.floor(c.duration / 60)}m${c.duration % 60}s` : "just started";
        L(`  ${agent}${rg} — ${dir}, ${dur}`);
      }
    }

    // ── PBX agent statuses ─────────────────────────────────────────────────────
    if (vosLive?.agentStatuses?.length) {
      L("\n=== Agent Statuses (PBX) ===");
      for (const a of vosLive.agentStatuses) {
        L(`  ${a.name} (ext ${a.extension}): ${a.status}, ${a.callsToday} calls today`);
      }
    }

    // ── PBX per-agent call history ─────────────────────────────────────────────
    if (vos?.callHistory?.length) {
      L("\n=== PBX Per-Agent Stats — Today ===");
      for (const a of vos.callHistory) {
        const answerRate = a.calls > 0 ? Math.round((a.answered / a.calls) * 100) : 0;
        L(`  ${a.agentName}: ${a.calls} calls | answered: ${a.answered} (${answerRate}%) | missed: ${a.missed} | voicemail: ${a.voicemail} | talk: ${Math.round(a.durationSeconds / 60)}min`);
      }
    }

    // ── PBX missed by ring group ───────────────────────────────────────────────
    if (vos?.ringGroupMissed && vos?.ringGroups) {
      const rgMap: Record<number, string> = {};
      for (const rg of vos.ringGroups) rgMap[rg.id] = rg.name;
      const entries = Object.entries(vos.ringGroupMissed as Record<string, number>).filter(([, v]) => v > 0);
      if (entries.length) {
        L("\n=== Missed Calls by Ring Group (PBX cumulative today) ===");
        for (const [id, cnt] of entries) {
          L(`  ${rgMap[Number(id)] ?? `Ring group ${id}`}: ${cnt} missed`);
        }
      }
    }

    // ── OpenPhone (Quo) stats — today ──────────────────────────────────────────
    type DayStat = { totalCalls?: number; answered?: number; missed?: number; talkSeconds?: number; outbound?: number; inbound?: number; voicemail?: number; vmBrief?: number; uniqueContacts?: number };
    if (quoToday?.teamStats) {
      L("\n=== OpenPhone (Quo) Stats — Today ===");
      for (const [team, agentMap] of Object.entries(quoToday.teamStats as Record<string, Record<string, Record<string, DayStat>>>)) {
        let tc = 0, ta = 0, tm = 0, ts = 0, tout = 0, tin = 0;
        const agentLines: string[] = [];
        for (const [agent, days] of Object.entries(agentMap)) {
          let calls = 0, ans = 0, miss = 0, secs = 0, out = 0, inn = 0, vm = 0, cxReached = 0;
          for (const day of Object.values(days)) {
            calls += day.totalCalls ?? 0;
            ans += day.answered ?? 0;
            miss += day.missed ?? 0;
            secs += day.talkSeconds ?? 0;
            out += day.outbound ?? 0;
            inn += day.inbound ?? 0;
            vm += (day.voicemail ?? 0) + (day.vmBrief ?? 0);
            cxReached += day.uniqueContacts ?? 0;
          }
          tc += calls; ta += ans; tm += miss; ts += secs; tout += out; tin += inn;
          if (calls > 0) {
            const ar = calls > 0 ? Math.round((ans / calls) * 100) : 0;
            agentLines.push(`  ${agent}: ${calls} calls (${out} out/${inn} in) | answered: ${ans} (${ar}%) | missed: ${miss} | voicemail: ${vm} | CX reached: ${cxReached} | talk: ${Math.round(secs / 60)}min`);
          }
        }
        const teamAr = tc > 0 ? Math.round((ta / tc) * 100) : 0;
        L(`\n${team.toUpperCase()} team today: ${tc} calls (${tout} out/${tin} in) | answered: ${ta} (${teamAr}%) | missed: ${tm} | talk: ${Math.round(ts / 60)}min`);
        for (const l of agentLines) L(l);
      }
    }

    // ── OpenPhone stats — this month ───────────────────────────────────────────
    if (quoMonth?.teamStats) {
      L(`\n=== OpenPhone (Quo) Stats — This Month (${monthStr}) ===`);
      for (const [team, agentMap] of Object.entries(quoMonth.teamStats as Record<string, Record<string, Record<string, DayStat>>>)) {
        let tc = 0, ta = 0, tm = 0, ts = 0;
        const agentLines: string[] = [];
        for (const [agent, days] of Object.entries(agentMap)) {
          let calls = 0, ans = 0, miss = 0, secs = 0, cxReached = 0;
          for (const day of Object.values(days)) {
            calls += day.totalCalls ?? 0;
            ans += day.answered ?? 0;
            miss += day.missed ?? 0;
            secs += day.talkSeconds ?? 0;
            cxReached += day.uniqueContacts ?? 0;
          }
          tc += calls; ta += ans; tm += miss; ts += secs;
          if (calls > 0) {
            const ar = calls > 0 ? Math.round((ans / calls) * 100) : 0;
            agentLines.push(`  ${agent}: ${calls} calls | answered: ${ans} (${ar}%) | missed: ${miss} | CX reached: ${cxReached} | talk: ${Math.round(secs / 60)}min`);
          }
        }
        const teamAr = tc > 0 ? Math.round((ta / tc) * 100) : 0;
        L(`\n${team.toUpperCase()} team this month: ${tc} calls | answered: ${ta} (${teamAr}%) | missed: ${tm} | talk: ${Math.round(ts / 60)}min`);
        for (const l of agentLines) L(l);
      }
    }

    // ── Google Sheets retains / cancels ────────────────────────────────────────
    if (retSheet) {
      L("\n=== Retention Sheet — Retains & Cancels ===");
      L(`Today (${todayStr}): ${retSheet.todayRetained} retains, ${retSheet.todayCancelled} cancels`);
      L(`This month (${monthStr}): ${retSheet.monthRetained} retains, ${retSheet.monthCancelled} cancels`);
      const agents = Object.entries(retSheet.byAgent).filter(([, v]) => v.monthRetained + v.monthCancelled > 0);
      if (agents.length) {
        L("Per-agent this month:");
        for (const [agent, stats] of agents.sort(([, a], [, b]) => (b.monthRetained + b.monthCancelled) - (a.monthRetained + a.monthCancelled))) {
          L(`  ${agent}: ${stats.monthRetained} retains, ${stats.monthCancelled} cancels (today: ${stats.todayRetained}R / ${stats.todayCancelled}C)`);
        }
      }
    }

    if (nsfSheet) {
      L("\n=== NSF Sheet — Retains & Cancels ===");
      L(`Today (${todayStr}): ${nsfSheet.todayRetained} retains, ${nsfSheet.todayCancelled} cancels`);
      L(`This month (${monthStr}): ${nsfSheet.monthRetained} retains, ${nsfSheet.monthCancelled} cancels`);
      const agents = Object.entries(nsfSheet.byAgent).filter(([, v]) => v.monthRetained + v.monthCancelled > 0);
      if (agents.length) {
        L("Per-agent this month:");
        for (const [agent, stats] of agents.sort(([, a], [, b]) => (b.monthRetained + b.monthCancelled) - (a.monthRetained + a.monthCancelled))) {
          L(`  ${agent}: ${stats.monthRetained} retains, ${stats.monthCancelled} cancels (today: ${stats.todayRetained}R / ${stats.todayCancelled}C)`);
        }
      }
    }

    // ── Missed — hourly breakdown ──────────────────────────────────────────────
    if (missedHourly?.hours?.length) {
      L("\n=== Missed Calls by Hour Today (LA time) ===");
      L("Hour | Retention (Quo+PBX) | CS (Quo+PBX) | NSF (Quo+PBX)");
      for (const h of missedHourly.hours as { hour: number; retention: { quo: number; pbx: number }; cs: { quo: number; pbx: number }; nsf: { quo: number; pbx: number } }[]) {
        const fmt = (t: { quo: number; pbx: number }) => `${t.quo + t.pbx} (Q:${t.quo}/P:${t.pbx})`;
        L(`  ${String(h.hour).padStart(2, "0")}:00 — Ret: ${fmt(h.retention)} | CS: ${fmt(h.cs)} | NSF: ${fmt(h.nsf)}`);
      }
    }

    // ── Missed — 14-day trend ──────────────────────────────────────────────────
    if (missedDaily?.days?.length) {
      L("\n=== Missed Calls — Last 14 Days ===");
      L("Date | Retention (Quo+PBX) | CS (Quo+PBX) | NSF (Quo+PBX)");
      for (const d of (missedDaily.days as { date: string; retention: { quo: number; pbx: number }; cs: { quo: number; pbx: number }; nsf: { quo: number; pbx: number } }[]).slice(0, 14)) {
        const total = (t: { quo: number; pbx: number }) => t.quo + t.pbx;
        L(`  ${d.date} — Ret: ${total(d.retention)} | CS: ${total(d.cs)} | NSF: ${total(d.nsf)}`);
      }
    }

    // ── Missed with no callback ────────────────────────────────────────────────
    if (missedNoCB?.items?.length) {
      const items = missedNoCB.items as { team: string; ringGroupName: string; createdAt: string }[];
      const byTeam: Record<string, number> = {};
      for (const it of items) byTeam[it.team] = (byTeam[it.team] ?? 0) + 1;
      L("\n=== Missed Calls With No Callback (Today) ===");
      L(`Total: ${items.length} unreturned`);
      for (const [team, cnt] of Object.entries(byTeam)) {
        L(`  ${team}: ${cnt} unreturned`);
      }
    }

    // ── Attendance ─────────────────────────────────────────────────────────────
    if (attendance?.members?.length) {
      L("\n=== Attendance — Today ===");
      const recMap: Record<number, { status: string; note?: string; coaching?: boolean }> = {};
      for (const rec of attendance.records ?? []) recMap[rec.memberId] = rec;
      const byDept: Record<string, string[]> = {};
      for (const m of attendance.members as { id: number; name: string; shift: string; department: string }[]) {
        const rec = recMap[m.id];
        const statusLabel = rec?.status ? rec.status.toUpperCase() : "?";
        const note = rec?.note ? ` (${rec.note})` : "";
        const coaching = rec?.coaching ? " [coaching]" : "";
        const dept = m.department || "Other";
        if (!byDept[dept]) byDept[dept] = [];
        byDept[dept].push(`  ${m.name} (shift ${m.shift}): ${statusLabel}${coaching}${note}`);
      }
      for (const [dept, entries] of Object.entries(byDept)) {
        L(`${dept}:`);
        for (const e of entries) L(e);
      }
    }

    const statsContext = lines.length
      ? `\n\nLIVE DASHBOARD DATA (as of ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} LA time):\n${lines.join("\n")}`
      : "\n\n[Live stats unavailable right now]";

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SAMIA_SYSTEM + statsContext },
      ...history.slice(-10).map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
      { role: "user", content: message },
    ];

    const tools: OpenAI.Chat.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "auto_mark_attendance",
          description: "Automatically mark attendance for all agents on a given date. Fetches each agent's first call from the database, compares to their shift start (shift N = N PM Egypt time), marks on-time (within 10 min grace) or late. Skips agents who already have a record. For today, also skips agents whose shift hasn't started yet. For past dates, uses OpenPhone DB only (VoS has no historical data).",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "Date to mark attendance for, as YYYY-MM-DD in Egypt time. Omit or pass null for today.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_call_logs",
          description: "Get per-agent call data for a specific date: first call time, shift info, computed on-time/late status, and any existing attendance record. Use this to preview what auto_mark_attendance would do, or to show the manager the data before writing.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "Date in YYYY-MM-DD format (Egypt time). Omit for today.",
              },
            },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_agent_contacts",
          description: "Returns the unique phone numbers (participants) an agent spoke with on a given date, from the OpenPhone database. Use when asked 'who did X call', 'what numbers did X speak with', 'get me the phone numbers that X spoke with today', etc.",
          parameters: {
            type: "object",
            properties: {
              agentName: {
                type: "string",
                description: "Partial or full agent name — case-insensitive search (e.g. 'talia', 'Talia Morgan').",
              },
              date: {
                type: "string",
                description: "Date in YYYY-MM-DD format (Egypt time). Omit for today.",
              },
            },
            required: ["agentName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "set_attendance",
          description: "Write attendance records for specific agents on specific dates. Use for manual corrections or when auto_mark misses someone. Pass force=true to overwrite existing records.",
          parameters: {
            type: "object",
            properties: {
              records: {
                type: "array",
                description: "Array of attendance records to write.",
                items: {
                  type: "object",
                  properties: {
                    date:       { type: "string", description: "YYYY-MM-DD (Egypt time)" },
                    memberName: { type: "string", description: "Exact member name from the attendance system" },
                    status:     { type: "string", enum: ["in", "late", "absent", "off", "pto"], description: "Attendance status" },
                    note:       { type: "string", description: "Optional note (e.g. 'late 23min')" },
                    coaching:   { type: "boolean", description: "Whether this agent is in coaching" },
                  },
                  required: ["date", "memberName", "status"],
                },
              },
              force: {
                type: "boolean",
                description: "If true, overwrite existing records. Default false (skip existing).",
              },
            },
            required: ["records"],
          },
        },
      },
    ];

    // ── Multi-turn tool loop (up to 4 rounds) ─────────────────────────────────
    let currentMessages = [...messages];
    let finalReply: string | null = null;
    let attendanceMarked = false;

    for (let round = 0; round < 4; round++) {
      const completion = await openai.chat.completions.create({
        model: "gpt-5.1",
        messages: currentMessages,
        tools,
        max_completion_tokens: 800,
      });

      const choice = completion.choices[0];

      if (choice?.finish_reason !== "tool_calls" || !choice.message?.tool_calls?.length) {
        finalReply = choice?.message?.content ?? "Sorry, I couldn't generate a response.";
        break;
      }

      // Add the assistant's tool-call message to the thread
      currentMessages.push(choice.message);

      // Execute all tool calls in this round (may be parallel)
      for (const toolCall of choice.message.tool_calls) {
        const fnName = toolCall.function.name;
        let toolResult: string;

        try {
          if (fnName === "auto_mark_attendance") {
            const args = JSON.parse(toolCall.function.arguments || "{}") as { date?: string };
            const body = args.date ? JSON.stringify({ date: args.date }) : "{}";
            const markRes = await fetch(`${base}/api/attendance/auto-mark`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            });
            const markData = await markRes.json() as {
              success: boolean; date: string;
              results: { name: string; status: string; note: string; skipped?: string }[];
            };
            attendanceMarked = true;
            const marked   = markData.results.filter((r) => r.status);
            const onTime   = marked.filter((r) => r.status === "in");
            const late     = marked.filter((r) => r.status === "late");
            const skipped  = markData.results.filter((r) => !r.status);
            toolResult = JSON.stringify({
              date: markData.date,
              marked: marked.length,
              onTime: onTime.length,
              onTimeAgents: onTime.map((r) => r.name),
              late: late.length,
              lateAgents: late.map((r) => ({ name: r.name, note: r.note })),
              skippedTotal: skipped.length,
              skippedReasons: skipped.reduce((acc, r) => {
                const k = r.skipped ?? "unknown"; acc[k] = (acc[k] ?? 0) + 1; return acc;
              }, {} as Record<string, number>),
              skippedAgents: skipped.map((r) => ({ name: r.name, reason: r.skipped })),
            });

          } else if (fnName === "get_call_logs") {
            const args = JSON.parse(toolCall.function.arguments || "{}") as { date?: string };
            const url = args.date ? `${base}/api/attendance/call-logs?date=${args.date}` : `${base}/api/attendance/call-logs`;
            const logsRes = await fetch(url);
            toolResult = JSON.stringify(await logsRes.json());

          } else if (fnName === "get_agent_contacts") {
            const args = JSON.parse(toolCall.function.arguments || "{}") as { agentName: string; date?: string };

            // Trigger a fresh sync for the relevant window so DB is up-to-date.
            // Sync covers last 3 hours (catches the most recent calls).
            const syncTo   = new Date();
            const syncFrom = new Date(syncTo.getTime() - 3 * 3600 * 1000);
            fetch(`${base}/api/quo/sync`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ from: syncFrom.toISOString(), to: syncTo.toISOString() }),
            }).catch(() => { /* best-effort */ });

            // Brief pause so the sync can write the most recent calls before we query.
            await new Promise((r) => setTimeout(r, 3000));

            const params = new URLSearchParams({ agent: args.agentName });
            if (args.date) params.set("date", args.date);
            const contactsRes = await fetch(`${base}/api/attendance/agent-contacts?${params.toString()}`);
            toolResult = JSON.stringify(await contactsRes.json());

          } else if (fnName === "set_attendance") {
            const args = JSON.parse(toolCall.function.arguments || "{}");
            const setRes = await fetch(`${base}/api/attendance/set`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(args),
            });
            toolResult = JSON.stringify(await setRes.json());
            attendanceMarked = true;

          } else {
            toolResult = JSON.stringify({ error: `Unknown tool: ${fnName}` });
          }
        } catch (e) {
          toolResult = JSON.stringify({ error: String(e) });
        }

        currentMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
      }
    }

    if (!finalReply) finalReply = "Done.";
    return res.json({ reply: finalReply, attendanceMarked });
  } catch (err) {
    req.log.error(err, "samia chat error");
    return res.status(500).json({ error: "AI request failed" });
  }
});

export default router;
