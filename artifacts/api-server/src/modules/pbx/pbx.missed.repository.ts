import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import type { PbxMissedMode } from "./pbx.schemas.js";

export type PbxHourlyCountRow = { hour: number; team: string; count: number };
export type PbxDailyCountRow = { date: string; team: string; count: number };
export type PbxQuoBreakdownRow = {
  participant: string;
  team: string;
  createdAt: Date;
  status: string;
  durationSeconds: number;
  ringDurationSeconds: number | null;
};
export type PbxPersistedBreakdownRow = { fromNumber: string; team: string; createdAt: Date };
export type PbxOutboundBreakdownRow = {
  participant: string;
  createdAt: Date;
  durationSeconds: number;
  postAnswerSeconds: number | null;
};
export type PbxCallbackMissedWindow =
  | { kind: "range"; from: string; to: string }
  | { kind: "since"; since: Date };
export type PbxQuoCallbackRow = {
  id: string;
  participant: string;
  team: string;
  lineName: string;
  createdAt: Date;
  durationSeconds: number | null;
  ringDurationSeconds: number | null;
  status: string;
};
export type PbxPersistedCallbackRow = {
  id: number;
  fromNumber: string;
  team: string;
  ringGroupName: string;
  createdAt: Date;
};

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
  loadBlockedNumbers(): Promise<Set<string>>;
  listQuoBreakdown(input: { date: string; internalNumbers: string[] }): Promise<PbxQuoBreakdownRow[]>;
  listPbxBreakdown(date: string): Promise<PbxPersistedBreakdownRow[]>;
  listOutboundBreakdown(input: { date: string; participants: string[] }): Promise<PbxOutboundBreakdownRow[]>;
  listQuoCallbackReview(input: {
    window: PbxCallbackMissedWindow;
    internalNumbers: string[];
  }): Promise<PbxQuoCallbackRow[]>;
  listPbxCallbackReview(window: PbxCallbackMissedWindow): Promise<PbxPersistedCallbackRow[]>;
  listOutboundCallbackReview(input: {
    from: Date;
    to: Date;
    participants: string[];
  }): Promise<PbxOutboundBreakdownRow[]>;
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

  async loadBlockedNumbers(): Promise<Set<string>> {
    const { getBlockedNumbers } = await import("../../lib/blockedNumbers.js");
    return getBlockedNumbers();
  }

  async listQuoBreakdown(input: {
    date: string;
    internalNumbers: string[];
  }): Promise<PbxQuoBreakdownRow[]> {
    const result = await db.execute(sql`
      SELECT participant, line_team, created_at, status, duration_seconds, ring_duration_seconds
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLineSql()})
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${input.date}::date
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalNumberSql(input.internalNumbers)}
      ORDER BY created_at ASC
    `);
    return (result.rows as Array<{
      participant: string;
      line_team: string;
      created_at: Date;
      status: string;
      duration_seconds: number;
      ring_duration_seconds: number | null;
    }>).map((row) => ({
      participant: row.participant,
      team: row.line_team,
      createdAt: new Date(row.created_at),
      status: row.status,
      durationSeconds: row.duration_seconds,
      ringDurationSeconds: row.ring_duration_seconds,
    }));
  }

  async listPbxBreakdown(date: string): Promise<PbxPersistedBreakdownRow[]> {
    const result = await db.execute(sql`
      SELECT from_number, team, created_at
      FROM pbx_missed_calls
      WHERE (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${date}::date
        AND team IN ('retention', 'cs', 'nsf')
      ORDER BY created_at ASC
    `);
    return (result.rows as Array<{ from_number: string; team: string; created_at: Date }>).map((row) => ({
      fromNumber: row.from_number,
      team: row.team,
      createdAt: new Date(row.created_at),
    }));
  }

  async listOutboundBreakdown(input: {
    date: string;
    participants: string[];
  }): Promise<PbxOutboundBreakdownRow[]> {
    const participantList = sql.join(input.participants.map((number) => sql`${number}`), sql`, `);
    const result = await db.execute(sql`
      SELECT participant, created_at, duration_seconds, post_answer_seconds
      FROM phone_calls
      WHERE direction = 'outgoing'
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date >= ${input.date}::date
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date <= (${input.date}::date + interval '1 day')
        AND participant IN (${participantList})
      ORDER BY created_at ASC
    `);
    return (result.rows as Array<{
      participant: string;
      created_at: Date;
      duration_seconds: number;
      post_answer_seconds: number | null;
    }>).map((row) => ({
      participant: row.participant,
      createdAt: new Date(row.created_at),
      durationSeconds: row.duration_seconds,
      postAnswerSeconds: row.post_answer_seconds,
    }));
  }

  private missedWindowSql(window: PbxCallbackMissedWindow) {
    return window.kind === "range"
      ? sql`AND (created_at AT TIME ZONE 'America/Los_Angeles')::date BETWEEN ${window.from}::date AND ${window.to}::date`
      : sql`AND created_at >= ${window.since}`;
  }

  async listQuoCallbackReview(input: {
    window: PbxCallbackMissedWindow;
    internalNumbers: string[];
  }): Promise<PbxQuoCallbackRow[]> {
    const result = await db.execute(sql`
      SELECT id, participant, line_team, line_name, created_at, duration_seconds, ring_duration_seconds, status
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLineSql()})
        ${this.missedWindowSql(input.window)}
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalNumberSql(input.internalNumbers)}
      ORDER BY created_at DESC
      LIMIT 2000
    `);
    return (result.rows as Array<{
      id: string;
      participant: string;
      line_team: string;
      line_name: string;
      created_at: Date;
      duration_seconds: number | null;
      ring_duration_seconds: number | null;
      status: string;
    }>).map((row) => ({
      id: row.id,
      participant: row.participant,
      team: row.line_team,
      lineName: row.line_name,
      createdAt: new Date(row.created_at),
      durationSeconds: row.duration_seconds,
      ringDurationSeconds: row.ring_duration_seconds,
      status: row.status,
    }));
  }

  async listPbxCallbackReview(window: PbxCallbackMissedWindow): Promise<PbxPersistedCallbackRow[]> {
    const result = await db.execute(sql`
      SELECT id, from_number, team, ring_group_name, created_at
      FROM pbx_missed_calls
      WHERE 1=1
        ${this.missedWindowSql(window)}
        AND team IN ('retention', 'cs', 'nsf')
      ORDER BY created_at DESC
      LIMIT 2000
    `);
    return (result.rows as Array<{
      id: number;
      from_number: string;
      team: string;
      ring_group_name: string;
      created_at: Date;
    }>).map((row) => ({
      id: row.id,
      fromNumber: row.from_number,
      team: row.team,
      ringGroupName: row.ring_group_name,
      createdAt: new Date(row.created_at),
    }));
  }

  async listOutboundCallbackReview(input: {
    from: Date;
    to: Date;
    participants: string[];
  }): Promise<PbxOutboundBreakdownRow[]> {
    const participantList = sql.join(input.participants.map((number) => sql`${number}`), sql`, `);
    const result = await db.execute(sql`
      SELECT participant, created_at, duration_seconds, post_answer_seconds
      FROM phone_calls
      WHERE direction = 'outgoing'
        AND created_at >= ${input.from}
        AND created_at <= ${input.to}
        AND participant IN (${participantList})
      ORDER BY created_at ASC
    `);
    return (result.rows as Array<{
      participant: string;
      created_at: Date;
      duration_seconds: number;
      post_answer_seconds: number | null;
    }>).map((row) => ({
      participant: row.participant,
      createdAt: new Date(row.created_at),
      durationSeconds: row.duration_seconds,
      postAnswerSeconds: row.post_answer_seconds,
    }));
  }
}

export const pbxMissedReportingRepository = new PostgresPbxMissedReportingRepository();
