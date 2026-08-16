import {
  attendanceMembersTable,
  db,
  pbxMissedCallsTable,
  phoneCallsTable,
  violationVerificationsTable,
  type ViolationVerification,
} from "@workspace/db";
import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import type { ViolationVerificationPayload } from "../../lib/sensitiveWorkflowPolicy.js";

export type ViolationMember = typeof attendanceMembersTable.$inferSelect;

export interface ViolationCallRow {
  agentName: string | null;
  direction: string;
  status: string;
  createdAt: Date;
  durationSeconds: number;
  ringDurationSeconds: number | null;
}

export interface QuoMissedViolationRow {
  id: string;
  participant: string;
  lineTeam: string;
  lineName: string;
  createdAt: Date;
  status: string;
  durationSeconds: number;
  ringDurationSeconds: number | null;
}

export interface PbxMissedViolationRow {
  id: number;
  fromNumber: string;
  toNumber: string;
  ringGroupId: number;
  ringGroupName: string;
  team: string;
  createdAt: Date;
  recordedAt: Date;
}

export interface ViolationsDashboardData {
  members: ViolationMember[];
  verifications: ViolationVerification[];
  callRows: ViolationCallRow[];
  missedRows: PbxMissedViolationRow[];
  quoMissedRows: QuoMissedViolationRow[];
}

export interface ViolationScope {
  department: string;
  date: string;
}

export interface ViolationsRepository {
  loadDashboardData(rangeStart: Date, rangeEnd: Date, quoLines: readonly string[]): Promise<ViolationsDashboardData>;
  resolveMissedVerificationScope(key: string, quoLines: readonly string[]): Promise<ViolationScope | null>;
  saveVerification(payload: ViolationVerificationPayload): Promise<void>;
  deleteVerification(key: string): Promise<void>;
  listVerifications(): Promise<ViolationVerification[]>;
}

const TEAM_DEPARTMENTS = ["retention", "cs", "nsf"];
const MISSED_STATUSES = ["no-answer", "voicemail", "missed", "voicemail-brief"];
const LA_TIME_ZONE = "America/Los_Angeles";

export class PostgresViolationsRepository implements ViolationsRepository {
  async loadDashboardData(
    rangeStart: Date,
    rangeEnd: Date,
    quoLines: readonly string[],
  ): Promise<ViolationsDashboardData> {
    const [members, verifications, callRows, missedRows, quoMissedRows] = await Promise.all([
      db.select().from(attendanceMembersTable).where(eq(attendanceMembersTable.active, true)),
      db.select().from(violationVerificationsTable),
      db.select({
        agentName: phoneCallsTable.agentName,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        createdAt: phoneCallsTable.createdAt,
        durationSeconds: phoneCallsTable.durationSeconds,
        ringDurationSeconds: phoneCallsTable.ringDurationSeconds,
      }).from(phoneCallsTable).where(and(
        gte(phoneCallsTable.createdAt, rangeStart),
        lte(phoneCallsTable.createdAt, rangeEnd),
        or(
          eq(phoneCallsTable.direction, "outgoing"),
          eq(phoneCallsTable.direction, "incoming"),
        ),
      )),
      db.select().from(pbxMissedCallsTable).where(and(
        gte(pbxMissedCallsTable.createdAt, rangeStart),
        lte(pbxMissedCallsTable.createdAt, rangeEnd),
        inArray(pbxMissedCallsTable.team, TEAM_DEPARTMENTS),
      )),
      db.select({
        id: phoneCallsTable.id,
        participant: phoneCallsTable.participant,
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        createdAt: phoneCallsTable.createdAt,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        ringDurationSeconds: phoneCallsTable.ringDurationSeconds,
      }).from(phoneCallsTable).where(and(
        gte(phoneCallsTable.createdAt, rangeStart),
        lte(phoneCallsTable.createdAt, rangeEnd),
        eq(phoneCallsTable.direction, "incoming"),
        inArray(phoneCallsTable.status, MISSED_STATUSES),
        inArray(phoneCallsTable.lineName, [...quoLines]),
      )),
    ]);
    return { members, verifications, callRows, missedRows, quoMissedRows };
  }

  async resolveMissedVerificationScope(key: string, quoLines: readonly string[]): Promise<ViolationScope | null> {
    const pbxMatch = /^missed:(\d+)$/.exec(key);
    if (pbxMatch) {
      const id = Number(pbxMatch[1]);
      if (!Number.isSafeInteger(id)) return null;
      const [row] = await db.select({
        team: pbxMissedCallsTable.team,
        createdAt: pbxMissedCallsTable.createdAt,
      }).from(pbxMissedCallsTable).where(eq(pbxMissedCallsTable.id, id)).limit(1);
      if (!row || !TEAM_DEPARTMENTS.includes(row.team)) return null;
      return {
        department: row.team,
        date: new Date(row.createdAt).toLocaleDateString("en-CA", { timeZone: LA_TIME_ZONE }),
      };
    }

    const quoMatch = /^quo-missed:([A-Za-z0-9._:-]{1,200})$/.exec(key);
    if (!quoMatch) return null;
    const [row] = await db.select({
      direction: phoneCallsTable.direction,
      status: phoneCallsTable.status,
      lineTeam: phoneCallsTable.lineTeam,
      lineName: phoneCallsTable.lineName,
      createdAt: phoneCallsTable.createdAt,
    }).from(phoneCallsTable).where(eq(phoneCallsTable.id, quoMatch[1]!)).limit(1);
    if (!row
      || row.direction !== "incoming"
      || !MISSED_STATUSES.includes(row.status)
      || !quoLines.includes(row.lineName)
      || !TEAM_DEPARTMENTS.includes(row.lineTeam)) return null;
    return {
      department: row.lineTeam,
      date: new Date(row.createdAt).toLocaleDateString("en-CA", { timeZone: LA_TIME_ZONE }),
    };
  }

  async saveVerification(payload: ViolationVerificationPayload): Promise<void> {
    await db.insert(violationVerificationsTable).values(payload).onConflictDoNothing();
  }

  async deleteVerification(key: string): Promise<void> {
    await db.delete(violationVerificationsTable).where(eq(violationVerificationsTable.key, key));
  }

  async listVerifications(): Promise<ViolationVerification[]> {
    return db.select().from(violationVerificationsTable)
      .orderBy(violationVerificationsTable.verifiedAt);
  }
}

export const violationsRepository = new PostgresViolationsRepository();
