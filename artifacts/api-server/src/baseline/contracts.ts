import { z } from "zod";

const count = z.number().finite();
const nullableIsoDate = z.string().nullable();

export const authUserSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  role: z.enum(["admin", "edit", "view"]),
  permissions: z.array(z.string()),
  teamAccess: z.enum(["retention", "nsf", "cs"]).nullable().optional(),
  allowedTabs: z.array(z.string()).nullable().optional(),
  allowedAgents: z.array(z.string()).nullable().optional(),
  allowedSubTabs: z.array(z.string()).nullable().optional(),
  lockToToday: z.boolean().optional(),
  hideBackendStats: z.boolean().optional(),
});

export const authResponseSchema = z.object({
  token: z.string().min(1),
  user: authUserSchema,
});

export const phoneAgentDaySchema = z.object({
  totalCalls: count,
  talkSeconds: count,
  inbound: count,
  outbound: count,
  answered: count,
  missed: count,
  voicemail: count,
  vmBrief: count,
  uniqueContacts: count,
});

const phoneAgentStatsSchema = z.record(z.record(phoneAgentDaySchema));

export const quoStatsSchema = z.object({
  teamStats: z.record(phoneAgentStatsSchema),
  allAgentStats: phoneAgentStatsSchema,
  lineInbound: z.record(z.record(z.object({
    lineId: z.string(),
    lineName: z.string(),
    received: count,
    answered: count,
    missed: count,
    voicemail: count,
  }))),
  agentLastCall: z.record(z.record(z.string())),
  allAgentLastCall: z.record(z.string()),
  totalRows: count,
  lastSyncedAt: nullableIsoDate,
  isSyncing: z.boolean(),
});

const readyModeAgentSchema = z.object({
  agentName: z.string(),
  dialed: count,
  connected: count,
  talkTimeSecs: count,
  avgTalkSecs: count,
  connectRate: count,
});

export const readyModeStatsSchema = z.object({
  agents: z.array(readyModeAgentSchema),
  totals: z.object({
    dialed: count,
    connected: count,
    talkTimeSecs: count,
    connectRate: count,
  }),
  updatedAt: z.string(),
  raw: z.string().optional(),
});

const vosAgentStatSchema = z.object({
  agentName: z.string(),
  calls: count,
  inbound: count,
  outbound: count,
  avgDuration: count,
});

const vosLiveCallSchema = z.object({
  id: z.union([z.number(), z.string()]),
  direction: z.string(),
  agentName: z.string().nullable(),
  phoneLabel: z.string(),
  ringGroupName: z.string().nullable(),
  duration: count,
  startedAt: z.string(),
});

const vosAgentStatusSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  extension: z.string(),
  status: z.string(),
  callsToday: count,
});

export const vosStatsSchema = z.object({
  dashboard: z.object({
    activeCalls: count,
    totalAgents: count,
    onlineAgents: count,
    availableAgents: count,
    totalCallsToday: count,
    avgDurationToday: count,
    totalInboundToday: count,
    totalOutboundToday: count,
    missedCallsToday: count,
    callsByAgent: z.array(vosAgentStatSchema),
    liveCalls: z.array(vosLiveCallSchema),
    agentStatuses: z.array(vosAgentStatusSchema),
  }),
  agents: z.array(z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    extension: z.string(),
    status: z.string(),
    ringGroupIds: z.array(z.union([z.number(), z.string()])),
  })),
  ringGroups: z.array(z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    agentIds: z.array(z.union([z.number(), z.string()])),
  })),
});

export const attendanceSchema = z.object({
  members: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    shift: z.string(),
    shiftHours: z.string(),
    department: z.string(),
    active: z.boolean(),
  })),
  records: z.array(z.object({
    id: z.number().int(),
    memberId: z.number().int(),
    date: z.string(),
    status: z.string(),
    note: z.string().nullable(),
    coaching: z.boolean(),
  })),
  timezone: z.string(),
});

export const sheetDataSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.record(z.string())),
});

export const onboardingStatusSchema = z.object({
  running: z.boolean(),
  progressDone: count,
  progressTotal: count,
  lastRunAt: nullableIsoDate,
  lastError: z.string().nullable(),
  totalCalls: count,
  classified: count,
  typeCounts: z.record(count),
  taxYes: count,
  taxNo: count,
});

const onboardingAgentSchema = z.object({
  name: z.string(),
  totalCalls: count,
  inbound: count,
  outbound: count,
  answered: count,
  missed: count,
  voicemail: count,
  talkSeconds: count,
  uniqueContacts: count,
  responseRate: count,
  missedRatio: count,
  avgGapMin: count,
  onboarded: count,
  connection: count,
  onboardedRate: count,
});

export const onboardingAnalyticsSchema = z.object({
  meta: z.object({
    line: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    generatedAt: z.string(),
    dataFirst: z.string().nullable(),
    dataLast: z.string().nullable(),
    totalAgents: count,
  }),
  kpis: z.object({
    totalCalls: count,
    inbound: count,
    outbound: count,
    answered: count,
    missed: count,
    voicemail: count,
    talkSeconds: count,
    responseRate: count,
    missedRatio: count,
    avgTalkSec: count,
    avgGapMin: count,
  }),
  agents: z.array(onboardingAgentSchema),
  hourly: z.array(z.object({
    hour: count,
    calls: count,
    inbound: count,
    missed: count,
    idleMinutes: count,
  })),
  peaks: z.object({
    mostMissedHour: count.nullable(),
    mostAvailableHour: count.nullable(),
    busiestHour: count.nullable(),
  }),
  cassie: z.unknown().nullable(),
  insights: z.array(z.string()),
});

export const violationsSchema = z.object({
  lateLogin: z.array(z.object({
    key: z.string(),
    member: z.string(),
    department: z.string(),
    date: z.string(),
    shiftStart: z.string(),
    firstCallAt: z.string(),
    minutesLate: count,
  })),
  availabilityGaps: z.array(z.object({
    key: z.string(),
    member: z.string(),
    department: z.string(),
    date: z.string(),
    gapCount: count,
    gaps: z.array(z.object({
      start: z.string(),
      end: z.string(),
      minutes: count,
      source: z.enum(["quo", "pbx", "combined"]).optional(),
    })),
  })),
  missedWhileAvail: z.array(z.object({
    key: z.string(),
    pbxCallId: z.number().nullable(),
    source: z.enum(["pbx", "quo"]),
    date: z.string(),
    missedAt: z.string(),
    team: z.string(),
    fromNumber: z.string(),
    ringGroupName: z.string(),
    availableAgents: z.array(z.string()),
    busyAgents: z.array(z.string()),
  })),
  verifiedKeys: z.array(z.string()),
});

export const samiaDiagnosticsSchema = z.object({
  anthropicKeyExists: z.boolean(),
  samiaModel: z.string(),
  qaModel: z.string(),
  liveTransferModel: z.string(),
  aiRequestUsageExists: z.boolean(),
  qaBiweeklyRunsExists: z.boolean(),
  rateLimits: z.object({
    requestsPerMinute: count,
    requestsPerDay: count,
  }),
  deploymentEnvironment: z.string(),
});

export const teamAgentListSchema = z.array(z.object({
  id: z.number().int(),
  name: z.string(),
  team: z.enum(["retention", "nsf", "cs", "killers"]),
  active: z.boolean(),
}));

export const adminUserListSchema = z.array(authUserSchema.extend({
  active: z.boolean(),
}));

export const IMPORTANT_ENDPOINTS = [
  ["POST", "/auth/login"],
  ["GET", "/auth/me"],
  ["GET", "/quo/stats"],
  ["GET", "/quo/calls"],
  ["GET", "/vos/stats"],
  ["GET", "/attendance"],
  ["GET", "/sheet"],
  ["GET", "/ob-report/status"],
  ["GET", "/ob-report/download"],
  ["GET", "/ob-analytics"],
  ["GET", "/ob-analytics/download"],
  ["GET", "/readymode/stats"],
  ["GET", "/violations"],
  ["GET", "/samia/diagnostics"],
  ["POST", "/samia/chat"],
  ["GET", "/users"],
  ["GET", "/team-agents"],
] as const;

export type SanitizedCallFixture = {
  agent: string;
  team: "retention" | "nsf" | "cs" | "killers";
  totalCalls: number;
  answered: number;
  missed: number;
};

export function summarizeCallKpis(rows: SanitizedCallFixture[]) {
  const byAgent: Record<string, { totalCalls: number; connectedCalls: number; missedCalls: number }> = {};
  const byTeam: Record<string, { totalCalls: number; connectedCalls: number; missedCalls: number }> = {};
  const total = { totalCalls: 0, connectedCalls: 0, missedCalls: 0 };

  for (const row of rows) {
    const agent = byAgent[row.agent] ?? { totalCalls: 0, connectedCalls: 0, missedCalls: 0 };
    const team = byTeam[row.team] ?? { totalCalls: 0, connectedCalls: 0, missedCalls: 0 };
    for (const bucket of [agent, team, total]) {
      bucket.totalCalls += row.totalCalls;
      bucket.connectedCalls += row.answered;
      bucket.missedCalls += row.missed;
    }
    byAgent[row.agent] = agent;
    byTeam[row.team] = team;
  }

  return { total, byAgent, byTeam };
}

export function summarizeAttendance(records: Array<{ status: string }>) {
  const byStatus: Record<string, number> = {};
  for (const record of records) byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
  return { total: records.length, byStatus };
}

export function summarizeOnboarding(agents: Array<{ onboarded: number; connection: number }>) {
  return agents.reduce(
    (total, agent) => ({
      onboarded: total.onboarded + agent.onboarded,
      connection: total.connection + agent.connection,
    }),
    { onboarded: 0, connection: 0 },
  );
}

export function summarizeViolations(input: {
  lateLogin: unknown[];
  availabilityGaps: Array<{ gapCount: number }>;
  missedWhileAvail: unknown[];
}) {
  const late = input.lateLogin.length;
  const availability = input.availabilityGaps.reduce((sum, row) => sum + row.gapCount, 0);
  const missed = input.missedWhileAvail.length;
  return { late, availability, missed, total: late + availability + missed };
}
