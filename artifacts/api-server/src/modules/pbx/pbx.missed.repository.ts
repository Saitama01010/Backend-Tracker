import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import type { PbxMissedMode } from "./pbx.schemas.js";

export type PbxHourlyCountRow = { hour: number; team: string; count: number };
export type PbxDailyCountRow = { date: string; team: string; count: number };

export interface PbxMissedReportingRepository {
  listQuoHourly(input: {
    date: string;
    mode: PbxMissedMode;
    internalNumbers: string[];
  }): Promise<PbxHourlyCountRow[]>;
  listQuoGhostHourly(input: {
    date: string;
    internalNumbers: string[];
  }): Promise<PbxHourlyCountRow[]>;
  listPbxHourly(input: {
    date: string;
    mode: PbxMissedMode;
  }): Promise<PbxHourlyCountRow[]>;
  listQuoDaily(input: {
    from: Date;
    mode: PbxMissedMode;
    internalNumbers: string[];
  }): Promise<PbxDailyCountRow[]>;
  listQuoGhostDaily(input: {
    from: Date;
    internalNumbers: string[];
  }): Promise<PbxDailyCountRow[]>;
  listPbxDaily(input: {
    from: Date;
    mode: PbxMissedMode;
  }): Promise<PbxDailyCountRow[]>;
}

const teamLines = [...OPERATIONAL_CONFIG.trackedTeamLines];

function teamLineSql() {
  return sql.join(teamLines.map((line) => sql`${line}`), sql`, `);
}

function internalNumberSql(internalNumbers: string[]) {
  return internalNumbers.length > 0
    ? sql`AND participant NOT IN (${sql.join(internalNumbers.map((number) => sql`${number}`), sql`, `)})`
    : sql``;
}

function calendarDate(value: unknown): string {
  return value instanceof Date ? value.toISOString().split("T")[0]! : String(value);
}

export class PostgresPbxMissedReportingRepository implements PbxMissedReportingRepository {
  async listQuoHourly(input: {
    date: string;
    mode: PbxMissedMode;
    internalNumbers: string[];
  }): Promise<PbxHourlyCountRow[]> {
    const count = input.mode === "numbers" ? sql`COUNT(DISTINCT participant)::int` : sql`COUNT(*)::int`;
    const result = await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Los_Angeles'))::int AS hour,
        line_team,
        ${count} AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLineSql()})
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${input.date}::date
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalNumberSql(input.internalNumbers)}
      GROUP BY hour, line_team
      ORDER BY hour
    `);
    return (result.rows as Array<{ hour: number; line_team: string; cnt: number }>).map((row) => ({
      hour: row.hour,
      team: row.line_team,
      count: row.cnt,
    }));
  }

  async listQuoGhostHourly(input: {
    date: string;
    internalNumbers: string[];
  }): Promise<PbxHourlyCountRow[]> {
    const result = await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Los_Angeles'))::int AS hour,
        line_team,
        COUNT(*)::int AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail-brief', 'voicemail', 'missed')
        AND (
          (ring_duration_seconds IS NOT NULL AND ring_duration_seconds <= 2)
          OR (ring_duration_seconds IS NULL AND duration_seconds = 0 AND status = 'no-answer')
          OR (ring_duration_seconds IS NULL AND duration_seconds <= 4 AND status = 'voicemail-brief')
        )
        AND line_name IN (${teamLineSql()})
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${input.date}::date
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalNumberSql(input.internalNumbers)}
      GROUP BY hour, line_team
      ORDER BY hour
    `);
    return (result.rows as Array<{ hour: number; line_team: string; cnt: number }>).map((row) => ({
      hour: row.hour,
      team: row.line_team,
      count: row.cnt,
    }));
  }

  async listPbxHourly(input: {
    date: string;
    mode: PbxMissedMode;
  }): Promise<PbxHourlyCountRow[]> {
    const count = input.mode === "numbers" ? sql`COUNT(DISTINCT from_number)::int` : sql`COUNT(*)::int`;
    const result = await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Los_Angeles'))::int AS hour,
        team,
        ${count} AS cnt
      FROM pbx_missed_calls
      WHERE (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${input.date}::date
        AND team IN ('retention', 'cs', 'nsf')
      GROUP BY hour, team
      ORDER BY hour
    `);
    return (result.rows as Array<{ hour: number; team: string; cnt: number }>).map((row) => ({
      hour: row.hour,
      team: row.team,
      count: row.cnt,
    }));
  }

  async listQuoDaily(input: {
    from: Date;
    mode: PbxMissedMode;
    internalNumbers: string[];
  }): Promise<PbxDailyCountRow[]> {
    const count = input.mode === "numbers" ? sql`COUNT(DISTINCT participant)::int` : sql`COUNT(*)::int`;
    const result = await db.execute(sql`
      SELECT
        (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
        line_team,
        ${count} AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLineSql()})
        AND created_at >= ${input.from}
        AND participant ~ '^[^a-zA-Z]+$'
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Los_Angeles')) >= 8
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Los_Angeles')) < 20
        ${internalNumberSql(input.internalNumbers)}
      GROUP BY day, line_team
      ORDER BY day DESC, line_team
    `);
    return (result.rows as Array<{ day: unknown; line_team: string; cnt: number }>).map((row) => ({
      date: calendarDate(row.day),
      team: row.line_team,
      count: row.cnt,
    }));
  }

  async listQuoGhostDaily(input: {
    from: Date;
    internalNumbers: string[];
  }): Promise<PbxDailyCountRow[]> {
    const result = await db.execute(sql`
      SELECT
        (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
        line_team,
        COUNT(*)::int AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail-brief', 'voicemail', 'missed')
        AND (
          (ring_duration_seconds IS NOT NULL AND ring_duration_seconds <= 2)
          OR (ring_duration_seconds IS NULL AND duration_seconds = 0 AND status = 'no-answer')
          OR (ring_duration_seconds IS NULL AND duration_seconds <= 4 AND status = 'voicemail-brief')
        )
        AND line_name IN (${teamLineSql()})
        AND created_at >= ${input.from}
        AND participant ~ '^[^a-zA-Z]+$'
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Los_Angeles')) >= 8
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Los_Angeles')) < 20
        ${internalNumberSql(input.internalNumbers)}
      GROUP BY day, line_team
      ORDER BY day DESC, line_team
    `);
    return (result.rows as Array<{ day: unknown; line_team: string; cnt: number }>).map((row) => ({
      date: calendarDate(row.day),
      team: row.line_team,
      count: row.cnt,
    }));
  }

  async listPbxDaily(input: {
    from: Date;
    mode: PbxMissedMode;
  }): Promise<PbxDailyCountRow[]> {
    const count = input.mode === "numbers" ? sql`COUNT(DISTINCT from_number)::int` : sql`COUNT(*)::int`;
    const result = await db.execute(sql`
      SELECT
        (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
        team,
        ${count} AS cnt
      FROM pbx_missed_calls
      WHERE created_at >= ${input.from}
        AND team IN ('retention', 'cs', 'nsf')
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Los_Angeles')) >= 8
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Los_Angeles')) < 20
      GROUP BY day, team
      ORDER BY day DESC, team
    `);
    return (result.rows as Array<{ day: unknown; team: string; cnt: number }>).map((row) => ({
      date: calendarDate(row.day),
      team: row.team,
      count: row.cnt,
    }));
  }
}

export const pbxMissedReportingRepository = new PostgresPbxMissedReportingRepository();
