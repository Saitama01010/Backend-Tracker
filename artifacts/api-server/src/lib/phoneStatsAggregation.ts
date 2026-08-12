import { performance } from "node:perf_hooks";
import { pool } from "@workspace/db";

export type PhoneStatsDimension = {
  agentName: string;
  team: string;
  authorized: boolean;
};

export type PhoneStatsDimensionRow = {
  rawAgentName: string | null;
  lineName: string;
  lineTeam: string;
};

export type PhoneStatsAggregateRow = {
  kind: "team" | "all" | "line" | "meta";
  resolvedTeam: string | null;
  agentName: string | null;
  day: string | null;
  lineId: string | null;
  lineName: string | null;
  totalCalls: number;
  outbound: number;
  inbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  vmBrief: number;
  talkSeconds: number;
  uniqueContacts: number;
  lastCall: Date | null;
};

export type PhoneStatsAggregationResult = {
  rows: PhoneStatsAggregateRow[];
  timings: {
    dimensionQueryMs: number;
    aggregateQueryMs: number;
    databaseMs: number;
  };
  dimensionsLoaded: number;
  dimensionsAuthorized: number;
};

type RawAggregateRow = {
  kind: PhoneStatsAggregateRow["kind"];
  resolved_team: string | null;
  agent_name: string | null;
  day: string | null;
  line_id: string | null;
  line_name: string | null;
  total_calls: number | string;
  outbound: number | string;
  inbound: number | string;
  answered: number | string;
  missed: number | string;
  voicemail: number | string;
  vm_brief: number | string;
  talk_seconds: number | string;
  unique_contacts: number | string;
  last_call: Date | string | null;
};

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function numberValue(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export function effectivePhoneCallStatus(row: {
  status: string;
  direction: string;
  durationSeconds: number;
  postAnswerSeconds?: number | null;
}): string {
  if (row.status !== "completed") return row.status;
  if (row.direction === "outgoing") {
    const postAnswerSeconds = row.postAnswerSeconds;
    if (postAnswerSeconds !== null && postAnswerSeconds !== undefined) {
      if (postAnswerSeconds >= 60) return "completed";
      if (postAnswerSeconds >= 20) return "voicemail";
      return "voicemail-brief";
    }
    if (row.durationSeconds >= 75) return "completed";
    if (row.durationSeconds >= 35) return "voicemail";
    return "voicemail-brief";
  }
  if (row.direction === "incoming" && row.durationSeconds === 0 && row.postAnswerSeconds == null) {
    return "voicemail-brief";
  }
  return "completed";
}

function buildMappingValues(
  dimensions: Array<PhoneStatsDimensionRow & PhoneStatsDimension>,
  params: unknown[],
): string {
  return dimensions.map((dimension) => {
    const placeholders: string[] = [];
    for (const value of [
      dimension.rawAgentName,
      dimension.lineName,
      dimension.lineTeam,
      dimension.agentName,
      dimension.team,
    ]) {
      params.push(value);
      placeholders.push(`$${params.length}`);
    }
    return `(${placeholders[0]}::text, ${placeholders[1]}::text, ${placeholders[2]}::text, ${placeholders[3]}::text, ${placeholders[4]}::text)`;
  }).join(",\n");
}

/**
 * Aggregate the dashboard's historical call metrics in PostgreSQL while using
 * the existing JavaScript mapping and authorization rules to decide the small
 * set of source dimensions admitted to the query.
 */
export async function loadPhoneStatsAggregates(options: {
  fromDate: Date;
  toDate: Date;
  timeZone: string;
  blockedNumbers: ReadonlySet<string>;
  resolveDimension: (row: PhoneStatsDimensionRow) => PhoneStatsDimension;
}): Promise<PhoneStatsAggregationResult> {
  const dimensionStartedAt = performance.now();
  const dimensionsResult = await pool.query<{
    agent_name: string | null;
    line_name: string;
    line_team: string;
  }>(`
    SELECT DISTINCT agent_name, line_name, line_team
    FROM phone_calls
    WHERE created_at >= $1
      AND created_at <= $2
      AND status <> 'in-progress'
  `, [options.fromDate, options.toDate]);
  const dimensionQueryMs = elapsedMs(dimensionStartedAt);

  const dimensions = dimensionsResult.rows.map((row) => {
    const source: PhoneStatsDimensionRow = {
      rawAgentName: row.agent_name,
      lineName: row.line_name,
      lineTeam: row.line_team,
    };
    return { ...source, ...options.resolveDimension(source) };
  });
  const authorized = dimensions.filter((dimension) => dimension.authorized);
  if (authorized.length === 0) {
    return {
      rows: [],
      timings: { dimensionQueryMs, aggregateQueryMs: 0, databaseMs: dimensionQueryMs },
      dimensionsLoaded: dimensions.length,
      dimensionsAuthorized: 0,
    };
  }

  const params: unknown[] = [
    options.fromDate,
    options.toDate,
    options.timeZone,
    [...options.blockedNumbers],
  ];
  const mappingValues = buildMappingValues(authorized, params);
  const aggregateStartedAt = performance.now();
  const aggregateResult = await pool.query<RawAggregateRow>(`
    WITH mapping(raw_agent, line_name, line_team, resolved_agent, resolved_team) AS (
      VALUES ${mappingValues}
    ),
    scoped_before_block AS MATERIALIZED (
      SELECT
        calls.line_id,
        calls.line_name,
        calls.participant,
        calls.direction,
        calls.duration_seconds,
        calls.created_at,
        mapping.resolved_agent,
        mapping.resolved_team,
        to_char(calls.created_at AT TIME ZONE $3::text, 'YYYY-MM-DD') AS day,
        calls.created_at + calls.duration_seconds * interval '1 second' AS call_end,
        CASE
          WHEN calls.status <> 'completed' THEN calls.status
          WHEN calls.direction = 'outgoing' AND calls.post_answer_seconds IS NOT NULL AND calls.post_answer_seconds >= 60 THEN 'completed'
          WHEN calls.direction = 'outgoing' AND calls.post_answer_seconds IS NOT NULL AND calls.post_answer_seconds >= 20 THEN 'voicemail'
          WHEN calls.direction = 'outgoing' AND calls.post_answer_seconds IS NOT NULL THEN 'voicemail-brief'
          WHEN calls.direction = 'outgoing' AND calls.duration_seconds >= 75 THEN 'completed'
          WHEN calls.direction = 'outgoing' AND calls.duration_seconds >= 35 THEN 'voicemail'
          WHEN calls.direction = 'outgoing' THEN 'voicemail-brief'
          WHEN calls.direction = 'incoming' AND calls.duration_seconds = 0 AND calls.post_answer_seconds IS NULL THEN 'voicemail-brief'
          ELSE 'completed'
        END AS effective_status
      FROM phone_calls AS calls
      INNER JOIN mapping
        ON calls.agent_name IS NOT DISTINCT FROM mapping.raw_agent
       AND calls.line_name = mapping.line_name
       AND calls.line_team = mapping.line_team
      WHERE calls.created_at >= $1
        AND calls.created_at <= $2
        AND calls.status <> 'in-progress'
    ),
    scoped AS MATERIALIZED (
      SELECT *
      FROM scoped_before_block
      WHERE NOT (participant = ANY($4::text[]))
    ),
    grouped AS (
      SELECT
        'team'::text AS kind,
        resolved_team,
        resolved_agent AS agent_name,
        day,
        NULL::text AS line_id,
        NULL::text AS line_name,
        count(*)::int AS total_calls,
        count(*) FILTER (WHERE direction = 'outgoing')::int AS outbound,
        count(*) FILTER (WHERE direction <> 'outgoing')::int AS inbound,
        count(*) FILTER (WHERE effective_status = 'completed')::int AS answered,
        count(*) FILTER (WHERE effective_status NOT IN ('completed', 'voicemail', 'voicemail-brief'))::int AS missed,
        count(*) FILTER (WHERE effective_status = 'voicemail')::int AS voicemail,
        count(*) FILTER (WHERE effective_status = 'voicemail-brief')::int AS vm_brief,
        coalesce(sum(duration_seconds), 0)::bigint AS talk_seconds,
        count(DISTINCT participant) FILTER (WHERE participant <> '')::int AS unique_contacts,
        max(call_end) AS last_call
      FROM scoped
      GROUP BY resolved_team, resolved_agent, day

      UNION ALL

      SELECT
        'all'::text AS kind,
        NULL::text AS resolved_team,
        resolved_agent AS agent_name,
        day,
        NULL::text AS line_id,
        NULL::text AS line_name,
        count(*)::int AS total_calls,
        count(*) FILTER (WHERE direction = 'outgoing')::int AS outbound,
        count(*) FILTER (WHERE direction <> 'outgoing')::int AS inbound,
        count(*) FILTER (WHERE effective_status = 'completed')::int AS answered,
        count(*) FILTER (WHERE effective_status NOT IN ('completed', 'voicemail', 'voicemail-brief'))::int AS missed,
        count(*) FILTER (WHERE effective_status = 'voicemail')::int AS voicemail,
        count(*) FILTER (WHERE effective_status = 'voicemail-brief')::int AS vm_brief,
        coalesce(sum(duration_seconds), 0)::bigint AS talk_seconds,
        count(DISTINCT participant) FILTER (WHERE participant <> '')::int AS unique_contacts,
        max(call_end) AS last_call
      FROM scoped
      GROUP BY resolved_agent, day

      UNION ALL

      SELECT
        'line'::text AS kind,
        NULL::text AS resolved_team,
        NULL::text AS agent_name,
        day,
        line_id,
        (array_agg(line_name ORDER BY created_at ASC))[1] AS line_name,
        count(*)::int AS total_calls,
        0::int AS outbound,
        count(*)::int AS inbound,
        count(*) FILTER (WHERE effective_status = 'completed')::int AS answered,
        count(*) FILTER (WHERE effective_status NOT IN ('completed', 'voicemail'))::int AS missed,
        count(*) FILTER (WHERE effective_status = 'voicemail')::int AS voicemail,
        0::int AS vm_brief,
        0::bigint AS talk_seconds,
        0::int AS unique_contacts,
        NULL::timestamptz AS last_call
      FROM scoped
      WHERE direction = 'incoming'
      GROUP BY line_id, day

      UNION ALL

      SELECT
        'meta'::text AS kind,
        NULL::text AS resolved_team,
        NULL::text AS agent_name,
        NULL::text AS day,
        NULL::text AS line_id,
        NULL::text AS line_name,
        count(*)::int AS total_calls,
        0::int AS outbound,
        0::int AS inbound,
        0::int AS answered,
        0::int AS missed,
        0::int AS voicemail,
        0::int AS vm_brief,
        0::bigint AS talk_seconds,
        0::int AS unique_contacts,
        NULL::timestamptz AS last_call
      FROM scoped_before_block
    )
    SELECT * FROM grouped
  `, params);
  const aggregateQueryMs = elapsedMs(aggregateStartedAt);

  return {
    rows: aggregateResult.rows.map((row) => ({
      kind: row.kind,
      resolvedTeam: row.resolved_team,
      agentName: row.agent_name,
      day: row.day,
      lineId: row.line_id,
      lineName: row.line_name,
      totalCalls: numberValue(row.total_calls),
      outbound: numberValue(row.outbound),
      inbound: numberValue(row.inbound),
      answered: numberValue(row.answered),
      missed: numberValue(row.missed),
      voicemail: numberValue(row.voicemail),
      vmBrief: numberValue(row.vm_brief),
      talkSeconds: numberValue(row.talk_seconds),
      uniqueContacts: numberValue(row.unique_contacts),
      lastCall: row.last_call ? new Date(row.last_call) : null,
    })),
    timings: {
      dimensionQueryMs,
      aggregateQueryMs,
      databaseMs: Math.round((dimensionQueryMs + aggregateQueryMs) * 100) / 100,
    },
    dimensionsLoaded: dimensions.length,
    dimensionsAuthorized: authorized.length,
  };
}
