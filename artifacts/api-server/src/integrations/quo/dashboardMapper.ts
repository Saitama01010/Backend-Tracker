import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import type { QuoPhoneNumber } from "./client.js";

export type { QuoPhoneNumber } from "./client.js";

const LINE_TEAM_MAP = OPERATIONAL_CONFIG.lineTeamMap;

export function classifyDashboardLine(name: string): "retention" | "nsf" | "cs" | null {
  const normalizedName = name.toLowerCase().trim();
  if (normalizedName in LINE_TEAM_MAP) return LINE_TEAM_MAP[normalizedName];
  if (/\bcs\b|customer support|talia|hiba|nourhan|rasha|bassant|ella monroe/.test(normalizedName) || name === "CS Team") return "cs";
  if (/retention|ob|outbound|ryan|abdlrhman|rick|zeiad|zack|henry.?hart|katherine|karma/.test(normalizedName)) return "retention";
  if (/nsf|national settlement|ellie|alex|katie|jenny|estella|rika|austin/.test(normalizedName)) return "nsf";
  return null;
}

const AGENT_TEAM: Record<string, "retention" | "nsf" | "cs"> = {
  "ryan henderson": "retention",
  "henry hart": "retention",
  "katherine adams": "retention",
  "jacob stephenson": "retention",
  "abdulrhman isawi": "retention",
  "rick miller": "retention",
  "zeiad fouad": "retention",
  "max francis": "retention",
  "mohammed ayman": "retention",
  "leo carter": "cs",
  "fares": "cs",
  "alex cruz": "nsf",
  "austin white": "nsf",
  "rika hart": "nsf",
  "jenny morgan": "nsf",
  "estella cruz": "nsf",
  "katie miller": "nsf",
  "ellie moser": "nsf",
  "ahmed ayman": "retention",
  "levi miller": "retention",
  "michael belfort": "retention",
  "talia morgan": "retention",
  "chase miller": "cs",
  "nour eldin atef": "cs",
  "youssef nady": "cs",
  "jacob xander": "cs",
  "ella monroe": "cs",
  "nora adam": "cs",
  "carla bennet": "cs",
};

export function dashboardAgentTeam(agentName: string): "retention" | "nsf" | "cs" | null {
  return AGENT_TEAM[agentName.toLowerCase().trim()] ?? null;
}

export function inferDashboardAgentFromLine(lineName: string): string | null {
  const line = lineName.toLowerCase().replace(/\s+/g, " ").trim();
  for (const name of Object.keys(AGENT_TEAM)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(line)) return name.replace(/\b\w/g, (character) => character.toUpperCase());
  }
  const mappedTeamLine = Object.keys(LINE_TEAM_MAP).find((known) => line.includes(known));
  if (mappedTeamLine) {
    const parts = mappedTeamLine.split("-").map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      if (AGENT_TEAM[part]) return part.replace(/\b\w/g, (character) => character.toUpperCase());
    }
  }
  return null;
}
