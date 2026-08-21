import { db } from "@workspace/db";
import {
  portalUsersTable,
  portalUserTabGrantsTable,
  portalUserTeamGrantsTable,
  teamAgentsTable,
  type CanonicalAccessRole,
  type CanonicalDashboardTab,
  type TeamSlug,
} from "@workspace/db/schema";
import { asc, eq, getTableColumns } from "drizzle-orm";
import { revokeUserSessions } from "../../lib/sessionStore.js";

export type PortalUserRecord = typeof portalUsersTable.$inferSelect;
export type PortalUserCreate = typeof portalUsersTable.$inferInsert;
export type PortalUserUpdates = Partial<typeof portalUsersTable.$inferInsert>;

export interface CanonicalAgentAccessRecord {
  id: number;
  nameNormalized: string | null;
  team: string;
  active: boolean;
  emailNormalized: string | null;
}

export interface PortalUserListRow extends PortalUserRecord {
  canonicalAgentId: number | null;
  canonicalAgentName: string | null;
  canonicalAgentTeam: string | null;
  canonicalAgentActive: boolean | null;
  canonicalAgentEmail: string | null;
}

export interface PortalUserListData {
  users: PortalUserListRow[];
  teamGrants: Array<{ portalUserId: number; team: TeamSlug }>;
  tabGrants: Array<{ portalUserId: number; tab: CanonicalDashboardTab }>;
}

export interface PortalUserGrantUpdate {
  teamGrants: TeamSlug[];
  tabGrants: CanonicalDashboardTab[];
}

export interface AdminCandidate {
  id: number;
  role: string;
  accessRole: CanonicalAccessRole | null;
  active: boolean;
}

export interface UsersRepository {
  loadCanonicalAgent(id: number): Promise<CanonicalAgentAccessRecord | null>;
  loadRosterEmailNormalized(id: number): Promise<string | null>;
  findRosterIdentityByEmail(emailNormalized: string): Promise<{ id: number } | null>;
  listUsersData(): Promise<PortalUserListData>;
  listAdminCandidates(): Promise<AdminCandidate[]>;
  findUser(id: number): Promise<PortalUserRecord | null>;
  createUser(values: PortalUserCreate, grants: PortalUserGrantUpdate): Promise<number>;
  updateUser(input: {
    id: number;
    updates: PortalUserUpdates;
    grants: PortalUserGrantUpdate | null;
    revokeSessions: boolean;
  }): Promise<void>;
  deleteUser(id: number): Promise<void>;
}

async function replaceGrants(
  executor: Pick<typeof db, "delete" | "insert">,
  userId: number,
  grants: PortalUserGrantUpdate,
): Promise<void> {
  await executor.delete(portalUserTeamGrantsTable)
    .where(eq(portalUserTeamGrantsTable.portalUserId, userId));
  await executor.delete(portalUserTabGrantsTable)
    .where(eq(portalUserTabGrantsTable.portalUserId, userId));
  if (grants.teamGrants.length) {
    await executor.insert(portalUserTeamGrantsTable).values(
      grants.teamGrants.map((team) => ({ portalUserId: userId, team })),
    );
  }
  if (grants.tabGrants.length) {
    await executor.insert(portalUserTabGrantsTable).values(
      grants.tabGrants.map((tab) => ({ portalUserId: userId, tab })),
    );
  }
}

export class PostgresUsersRepository implements UsersRepository {
  async loadCanonicalAgent(id: number): Promise<CanonicalAgentAccessRecord | null> {
    const [agent] = await db.select({
      id: teamAgentsTable.id,
      nameNormalized: teamAgentsTable.nameNormalized,
      team: teamAgentsTable.team,
      active: teamAgentsTable.active,
      emailNormalized: teamAgentsTable.emailNormalized,
    }).from(teamAgentsTable).where(eq(teamAgentsTable.id, id)).limit(1);
    return agent ?? null;
  }

  async loadRosterEmailNormalized(id: number): Promise<string | null> {
    const [agent] = await db.select({ emailNormalized: teamAgentsTable.emailNormalized })
      .from(teamAgentsTable)
      .where(eq(teamAgentsTable.id, id))
      .limit(1);
    return agent?.emailNormalized ?? null;
  }

  async findRosterIdentityByEmail(emailNormalized: string): Promise<{ id: number } | null> {
    const [identity] = await db.select({ id: teamAgentsTable.id })
      .from(teamAgentsTable)
      .where(eq(teamAgentsTable.emailNormalized, emailNormalized))
      .limit(1);
    return identity ?? null;
  }

  async listUsersData(): Promise<PortalUserListData> {
    const [users, teamGrants, tabGrants] = await Promise.all([
      db.select({
        ...getTableColumns(portalUsersTable),
        canonicalAgentId: teamAgentsTable.id,
        canonicalAgentName: teamAgentsTable.name,
        canonicalAgentTeam: teamAgentsTable.team,
        canonicalAgentActive: teamAgentsTable.active,
        canonicalAgentEmail: teamAgentsTable.email,
      })
        .from(portalUsersTable)
        .leftJoin(teamAgentsTable, eq(portalUsersTable.teamAgentId, teamAgentsTable.id))
        .orderBy(asc(portalUsersTable.createdAt)),
      db.select().from(portalUserTeamGrantsTable),
      db.select().from(portalUserTabGrantsTable),
    ]);
    return { users, teamGrants, tabGrants };
  }

  async listAdminCandidates(): Promise<AdminCandidate[]> {
    return db.select({
      id: portalUsersTable.id,
      role: portalUsersTable.role,
      accessRole: portalUsersTable.accessRole,
      active: portalUsersTable.active,
    }).from(portalUsersTable);
  }

  async findUser(id: number): Promise<PortalUserRecord | null> {
    const [user] = await db.select().from(portalUsersTable)
      .where(eq(portalUsersTable.id, id))
      .limit(1);
    return user ?? null;
  }

  async createUser(values: PortalUserCreate, grants: PortalUserGrantUpdate): Promise<number> {
    return db.transaction(async (tx) => {
      const [user] = await tx.insert(portalUsersTable).values(values)
        .returning({ id: portalUsersTable.id });
      await replaceGrants(tx, user!.id, grants);
      return user!.id;
    });
  }

  async updateUser(input: {
    id: number;
    updates: PortalUserUpdates;
    grants: PortalUserGrantUpdate | null;
    revokeSessions: boolean;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      if (Object.keys(input.updates).length) {
        await tx.update(portalUsersTable).set(input.updates)
          .where(eq(portalUsersTable.id, input.id));
      }
      if (input.grants) await replaceGrants(tx, input.id, input.grants);
      if (input.revokeSessions) await revokeUserSessions(input.id, tx);
    });
  }

  async deleteUser(id: number): Promise<void> {
    await db.delete(portalUsersTable).where(eq(portalUsersTable.id, id));
  }
}

export const usersRepository = new PostgresUsersRepository();
