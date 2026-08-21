import { db, onboardingClassificationsTable, phoneCallsTable } from "@workspace/db";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { getBlockedNumbers } from "../../lib/blockedNumbers.js";

export interface OnboardingAnalyticsCallRow {
  id: string;
  agentName: string | null;
  participant: string;
  lineName: string;
  direction: string;
  status: string;
  durationSeconds: number;
  postAnswerSeconds: number | null;
  createdAt: Date;
  callType: string | null;
  mentionsTax: boolean | null;
}

export interface OnboardingAnalyticsQuery {
  lineId: string;
  fromDate: Date;
  toDate: Date;
}

export interface OnboardingAnalyticsData {
  rows: OnboardingAnalyticsCallRow[];
  blockedNumbers: Set<string>;
}

export interface OnboardingAnalyticsRepository {
  load(query: OnboardingAnalyticsQuery): Promise<OnboardingAnalyticsData>;
}

export class PostgresOnboardingAnalyticsRepository implements OnboardingAnalyticsRepository {
  async load(query: OnboardingAnalyticsQuery): Promise<OnboardingAnalyticsData> {
    const [rows, blockedNumbers] = await Promise.all([
      db
        .select({
          id: phoneCallsTable.id,
          agentName: phoneCallsTable.agentName,
          participant: phoneCallsTable.participant,
          lineName: phoneCallsTable.lineName,
          direction: phoneCallsTable.direction,
          status: phoneCallsTable.status,
          durationSeconds: phoneCallsTable.durationSeconds,
          postAnswerSeconds: phoneCallsTable.postAnswerSeconds,
          createdAt: phoneCallsTable.createdAt,
          callType: onboardingClassificationsTable.callType,
          mentionsTax: onboardingClassificationsTable.mentionsTax,
        })
        .from(phoneCallsTable)
        .leftJoin(
          onboardingClassificationsTable,
          eq(onboardingClassificationsTable.callId, phoneCallsTable.id),
        )
        .where(
          and(
            eq(phoneCallsTable.lineId, query.lineId),
            gte(phoneCallsTable.createdAt, query.fromDate),
            lte(phoneCallsTable.createdAt, query.toDate),
            ne(phoneCallsTable.status, "in-progress"),
          ),
        )
        .orderBy(phoneCallsTable.createdAt),
      getBlockedNumbers(),
    ]);
    return { rows: rows as OnboardingAnalyticsCallRow[], blockedNumbers };
  }
}

export const onboardingAnalyticsRepository = new PostgresOnboardingAnalyticsRepository();
