import {
  createAuthorizationAgentDirectory,
  type AuthorizationAgentDirectory,
} from "../../lib/authorizationScope.js";
import type { RetentionReadyModeDayRow } from "./retention.types.js";

export interface RetentionRepository {
  loadAuthorizationAgentDirectory(): Promise<AuthorizationAgentDirectory>;
  loadReadyModeUploads(fromIso?: string, toIso?: string): Promise<RetentionReadyModeDayRow[]>;
}

export const retentionRepository: RetentionRepository = {
  async loadAuthorizationAgentDirectory() {
    const { db, teamAgentsTable } = await import("@workspace/db");
    const rows = await db.select({
      id: teamAgentsTable.id,
      name: teamAgentsTable.name,
      arabicName: teamAgentsTable.arabicName,
      team: teamAgentsTable.team,
      active: teamAgentsTable.active,
    }).from(teamAgentsTable);
    return createAuthorizationAgentDirectory(rows);
  },
  async loadReadyModeUploads(fromIso, toIso) {
    const [{ db, readymodeUploadsTable }, { and, gte, lte }] = await Promise.all([
      import("@workspace/db"),
      import("drizzle-orm"),
    ]);
    const conditions = [];
    if (fromIso) conditions.push(gte(readymodeUploadsTable.statDate, fromIso));
    if (toIso) conditions.push(lte(readymodeUploadsTable.statDate, toIso));
    const rows = await db
      .select()
      .from(readymodeUploadsTable)
      .where(conditions.length ? and(...conditions) : undefined);
    return rows.map((row) => ({
      name: row.agentName,
      iso: row.statDate,
      dialed: row.dialed,
      talkSecs: row.talkSecs,
    }));
  },
};
