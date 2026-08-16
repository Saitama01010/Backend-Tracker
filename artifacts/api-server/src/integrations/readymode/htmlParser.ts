export interface ReadyModeAgentStat {
  agentName: string;
  dialed: number;
  connected: number;
  talkTimeSecs: number;
  avgTalkSecs: number;
  connectRate: number;
}

function parseSecs(value: string): number {
  const parts = value.trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]!;
}

export function parseAgentTable(html: string): ReadyModeAgentStat[] {
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi);
  if (!tableMatch) return [];

  const agents: ReadyModeAgentStat[] = [];
  for (const table of tableMatch) {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rows.length < 2) continue;

    const headerRow = rows[0]?.[1] ?? "";
    const headers = [...headerRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) =>
      match[1]?.replace(/<[^>]+>/g, "").trim().toLowerCase() ?? ""
    );
    const hasAgent = headers.some((header) => header.includes("agent") || header.includes("name"));
    const hasCalls = headers.some((header) => header.includes("dial") || header.includes("call") || header.includes("total"));
    if (!hasAgent || !hasCalls) continue;

    const nameIdx = headers.findIndex((header) => header.includes("agent") || header.includes("name"));
    const dialIdx = headers.findIndex((header) => header.includes("dial") || header.includes("total call") || header.includes("calls"));
    const connIdx = headers.findIndex((header) => header.includes("connect") || header.includes("answer") || header.includes("talk"));
    const timeIdx = headers.findIndex((header) => header.includes("time") || header.includes("duration") || header.includes("talk"));

    for (const row of rows.slice(1)) {
      const cells = [...row[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) =>
        match[1]?.replace(/<[^>]+>/g, "").trim() ?? ""
      );
      if (cells.length < 2) continue;

      const name = cells[nameIdx] ?? cells[0] ?? "";
      if (!name || name.toLowerCase().includes("total") || name.toLowerCase().includes("summary")) continue;

      const dialedRaw = cells[dialIdx] ?? cells[1] ?? "0";
      const connRaw = connIdx >= 0 ? (cells[connIdx] ?? "0") : "0";
      const timeRaw = timeIdx >= 0 ? (cells[timeIdx] ?? "0") : "0";
      const dialed = parseInt(dialedRaw.replace(/[^0-9]/g, ""), 10) || 0;
      const connected = connIdx >= 0 ? parseInt(connRaw.replace(/[^0-9]/g, ""), 10) || 0 : 0;
      const talkTimeSecs = timeRaw.includes(":") ? parseSecs(timeRaw) : parseInt(timeRaw.replace(/[^0-9]/g, ""), 10) || 0;
      const connectRate = dialed > 0 ? Math.round((connected / dialed) * 1000) / 10 : 0;
      const avgTalkSecs = connected > 0 ? Math.round(talkTimeSecs / connected) : 0;

      if (dialed > 0 || connected > 0) {
        agents.push({ agentName: name, dialed, connected, talkTimeSecs, avgTalkSecs, connectRate });
      }
    }
    if (agents.length > 0) break;
  }
  return agents;
}
