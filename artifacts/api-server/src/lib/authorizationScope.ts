import type { AuthPayload } from "../middleware/authCore.js";
import {
  canAccessAgent,
  canViewTab,
  metricTeamsForUser,
  normalizeAgentIdentity,
  todayInLosAngeles,
  type MetricTeam,
} from "../middleware/authorizationCore.js";

export interface AuthorizationAgent {
  name: string;
  arabicName: string | null;
  team: MetricTeam;
}

export interface AuthorizationAgentDirectory {
  agents: AuthorizationAgent[];
  byIdentity: Map<string, AuthorizationAgent>;
}

export function createAuthorizationAgentDirectory(agents: AuthorizationAgent[]): AuthorizationAgentDirectory {
  const byIdentity = new Map<string, AuthorizationAgent>();
  for (const agent of agents) {
    byIdentity.set(normalizeAgentIdentity(agent.name), agent);
    if (agent.arabicName) byIdentity.set(normalizeAgentIdentity(agent.arabicName), agent);
  }
  return { agents, byIdentity };
}

export async function loadAuthorizationAgentDirectory(): Promise<AuthorizationAgentDirectory> {
  const { db, teamAgentsTable } = await import("@workspace/db");
  const rows = await db.select({
    name: teamAgentsTable.name,
    arabicName: teamAgentsTable.arabicName,
    team: teamAgentsTable.team,
  }).from(teamAgentsTable);
  return createAuthorizationAgentDirectory(rows);
}

export function authorizationAgent(directory: AuthorizationAgentDirectory, name: string): AuthorizationAgent | undefined {
  return directory.byIdentity.get(normalizeAgentIdentity(name));
}

export function canAccessMetricAgent(
  user: AuthPayload,
  name: string,
  directory: AuthorizationAgentDirectory,
  fallbackTeam?: MetricTeam | null,
): boolean {
  if (user.role === "admin") return true;
  const agent = authorizationAgent(directory, name);
  const aliases = agent ? [agent.name, agent.arabicName ?? ""] : [];
  if (!canAccessAgent(user, name, aliases)) return false;
  const teams = metricTeamsForUser(user);
  if (teams === null) return true;
  const resolvedTeam = agent?.team ?? fallbackTeam ?? null;
  return resolvedTeam !== null && teams.has(resolvedTeam);
}

export function canAccessLiveAgent(user: AuthPayload, name: string, directory: AuthorizationAgentDirectory): boolean {
  if (user.role === "admin") return true;
  const agent = authorizationAgent(directory, name);
  const aliases = agent ? [agent.name, agent.arabicName ?? ""] : [];
  if (!canAccessAgent(user, name, aliases)) return false;
  return !user.teamAccess || agent?.team === user.teamAccess;
}

type SheetData = { headers: string[]; rows: Record<string, string>[] };
export type ScopedSheetResult = { ok: true; data: SheetData } | { ok: false; reason: string };

const AGENT_HEADERS = ["agent name", "agent", "representative", "employee", "user", "submitted by"];
const DATE_HEADERS = ["timestamp", "time stamp", "submitted at", "created at", "date", "date/time", "submission time", "submit time"];

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findHeader(headers: readonly string[], aliases: readonly string[]): string | null {
  const normalizedAliases = new Set(aliases.map(normalizedHeader));
  return headers.find((header) => normalizedAliases.has(normalizedHeader(header))) ?? null;
}

function sheetCalendarDate(value: string): string | null {
  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;
  const us = value.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export function scopeSheetData(
  user: AuthPayload,
  data: SheetData,
  directory: AuthorizationAgentDirectory,
  now = new Date(),
): ScopedSheetResult {
  if (user.role === "admin" || canViewTab(user, "backend-stats")) return { ok: true, data };

  const agentHeader = findHeader(data.headers, AGENT_HEADERS);
  if (!agentHeader) return { ok: false, reason: "The requested sheet has no resolvable agent column." };
  const dateHeader = user.lockToToday ? findHeader(data.headers, DATE_HEADERS) : null;
  if (user.lockToToday && !dateHeader) return { ok: false, reason: "The requested sheet has no resolvable date column." };

  const today = todayInLosAngeles(now);
  const rows = data.rows.filter((row) => {
    const agentName = row[agentHeader]?.trim() ?? "";
    if (!agentName || !canAccessMetricAgent(user, agentName, directory)) return false;
    if (dateHeader && sheetCalendarDate(row[dateHeader] ?? "") !== today) return false;
    return true;
  });
  return { ok: true, data: { headers: data.headers, rows } };
}
