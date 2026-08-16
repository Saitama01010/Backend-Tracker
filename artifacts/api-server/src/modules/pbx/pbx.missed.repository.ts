import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import type { PbxMissedMode } from "./pbx.schemas.js";

export type PbxHourlyCountRow = { hour: number; team: string; count: number };

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
}

export const pbxMissedReportingRepository = new PostgresPbxMissedReportingRepository();
