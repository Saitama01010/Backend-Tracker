import {
  createAuthorizationAgentDirectory,
  type AuthorizationAgentDirectory,
} from "../../lib/authorizationScope.js";

export interface RetentionRepository {
  loadAuthorizationAgentDirectory(): Promise<AuthorizationAgentDirectory>;
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
};
