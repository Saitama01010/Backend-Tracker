import {
  pbxMissedReportingRepository,
  type PbxDailyCountRow,
  type PbxHourlyCountRow,
  type PbxMissedReportingRepository,
} from "./pbx.missed.repository.js";
import { teamFromRingGroupName } from "../../integrations/pbx/mapper.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { canAccessFullTeam, isAdministrator, type MetricTeam } from "../../middleware/authorizationCore.js";
import { isPbxGhostCall, KNOWN_GHOST_NUMBERS, normalizePhone } from "./pbx.phone.js";
import type {
  PbxBreakdownQuery,
  PbxCallbackReviewQuery,
  PbxDailyQuery,
  PbxHourlyQuery,
} from "./pbx.schemas.js";

type PbxTeam = "retention" | "cs" | "nsf";
type SourceCounts = { quo: number; ghost: number; pbx: number };
type HourRow = Record<PbxTeam, SourceCounts>;

export type PbxHourlyResponse = {
  hours: Array<{ hour: number } & HourRow>;
  date: string;
};

export type PbxDailyResponse = {
  days: Array<{ date: string } & HourRow>;
};

export type PbxBreakdownNumber = {
  fromNumber: string;
  team: string;
  source: "quo" | "pbx" | "both";
  missedCount: number;
  firstMissedAt: string;
  hasCallback: boolean;
  callbackConnected: boolean;
  callbackAt: string | null;
  responseMinutes: number | null;
  ghostCount: number;
  isGhost: boolean;
};
export type PbxCallbackReviewItem = {
  id: string;
  fromNumber: string;
  team: string;
  source: "quo" | "pbx";
  ringGroupName: string;
  missedAt: string;
  isGhost: boolean;
  hasCallback: boolean;
  callbackConnected: boolean;
  callbackAt: string | null;
  responseMinutes: number | null;
};

function emptyHour(): HourRow {
  return {
    retention: { quo: 0, ghost: 0, pbx: 0 },
    cs: { quo: 0, ghost: 0, pbx: 0 },
    nsf: { quo: 0, ghost: 0, pbx: 0 },
  };
}

function isPbxTeam(value: string): value is PbxTeam {
  return value === "retention" || value === "cs" || value === "nsf";
}

function mergeCounts(
  hourMap: Map<number, HourRow>,
  rows: PbxHourlyCountRow[],
  source: keyof SourceCounts,
) {
  for (const row of rows) {
    if (!isPbxTeam(row.team)) continue;
    const hour = hourMap.get(row.hour) ?? emptyHour();
    hour[row.team][source] += row.count;
    hourMap.set(row.hour, hour);
  }
}

function mergeDailyCounts(
  dayMap: Map<string, HourRow>,
  rows: PbxDailyCountRow[],
  source: keyof SourceCounts,
) {
  for (const row of rows) {
    if (!isPbxTeam(row.team)) continue;
    const day = dayMap.get(row.date) ?? emptyHour();
    day[row.team][source] += row.count;
    dayMap.set(row.date, day);
  }
}

export class PbxMissedReportingService {
  constructor(
    private readonly repository: PbxMissedReportingRepository = pbxMissedReportingRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getHourly(input: {
    query: PbxHourlyQuery;
    internalNumbers: string[];
    livePbxByHour: Record<number, Record<PbxTeam, number>>;
  }): Promise<PbxHourlyResponse> {
    const today = this.now().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const [quoRows, ghostRows] = await Promise.all([
      this.repository.listQuoHourly({
        date: input.query.date,
        mode: input.query.mode,
        internalNumbers: input.internalNumbers,
      }),
      this.repository.listQuoGhostHourly({
        date: input.query.date,
        internalNumbers: input.internalNumbers,
      }),
    ]);
    const hourMap = new Map<number, HourRow>();
    mergeCounts(hourMap, quoRows, "quo");
    mergeCounts(hourMap, ghostRows, "ghost");

    if (input.query.date === today && input.query.mode === "times") {
      for (const [rawHour, counts] of Object.entries(input.livePbxByHour)) {
        const hour = Number(rawHour);
        const row = hourMap.get(hour) ?? emptyHour();
        row.retention.pbx += counts.retention;
        row.cs.pbx += counts.cs;
        row.nsf.pbx += counts.nsf;
        hourMap.set(hour, row);
      }
    } else {
      mergeCounts(
        hourMap,
        await this.repository.listPbxHourly({ date: input.query.date, mode: input.query.mode }),
        "pbx",
      );
    }

    return {
      hours: [...hourMap.entries()]
        .sort(([left], [right]) => left - right)
        .map(([hour, teams]) => ({ hour, ...teams })),
      date: input.query.date,
    };
  }

  async getDaily(input: {
    query: PbxDailyQuery;
    internalNumbers: string[];
    liveRingGroupMissed: Record<number, number>;
    ringGroupNames: Map<number, string>;
  }): Promise<PbxDailyResponse> {
    const now = this.now();
    const from = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const today = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const [quoRows, ghostRows, pbxRows] = await Promise.all([
      this.repository.listQuoDaily({
        from,
        mode: input.query.mode,
        internalNumbers: input.internalNumbers,
      }),
      this.repository.listQuoGhostDaily({ from, internalNumbers: input.internalNumbers }),
      this.repository.listPbxDaily({ from, mode: input.query.mode }),
    ]);
    const dayMap = new Map<string, HourRow>();
    mergeDailyCounts(dayMap, quoRows, "quo");
    mergeDailyCounts(dayMap, ghostRows, "ghost");
    mergeDailyCounts(dayMap, pbxRows, "pbx");

    if (input.query.mode === "times") {
      const liveByTeam: Partial<Record<PbxTeam, number>> = {};
      for (const [rawRingGroup, count] of Object.entries(input.liveRingGroupMissed)) {
        const name = input.ringGroupNames.get(Number(rawRingGroup)) ?? "";
        const team = teamFromRingGroupName(name);
        if (isPbxTeam(team)) liveByTeam[team] = (liveByTeam[team] ?? 0) + count;
      }
      if (Object.keys(liveByTeam).length > 0) {
        const day = dayMap.get(today) ?? emptyHour();
        for (const team of ["retention", "cs", "nsf"] as const) {
          const live = liveByTeam[team] ?? 0;
          if (live > day[team].pbx) day[team].pbx = live;
        }
        dayMap.set(today, day);
      }
    }

    return {
      days: [...dayMap.entries()]
        .sort(([left], [right]) => right.localeCompare(left))
        .map(([date, teams]) => ({ date, ...teams })),
    };
  }

  async getBreakdown(input: {
    actor: AuthPayload;
    query: PbxBreakdownQuery;
    internalNumbers: string[];
  }) {
    const [blocklist, quoRows, pbxRows] = await Promise.all([
      this.repository.loadBlockedNumbers(),
      this.repository.listQuoBreakdown({ date: input.query.date, internalNumbers: input.internalNumbers }),
      this.repository.listPbxBreakdown(input.query.date),
    ]);
    type NumberEntry = {
      fromNumber: string;
      team: string;
      sources: Set<"quo" | "pbx">;
      missedTimes: Date[];
      rawParticipants: Set<string>;
      quoCalls: number;
      ghostCalls: number;
    };
    const numbersByPhone = new Map<string, NumberEntry>();

    for (const row of quoRows) {
      if (blocklist.has(row.participant)) continue;
      const normalized = normalizePhone(row.participant);
      if (!normalized) continue;
      const entry = numbersByPhone.get(normalized) ?? {
        fromNumber: row.participant,
        team: row.team,
        sources: new Set<"quo" | "pbx">(),
        missedTimes: [],
        rawParticipants: new Set<string>(),
        quoCalls: 0,
        ghostCalls: 0,
      };
      entry.sources.add("quo");
      entry.missedTimes.push(new Date(row.createdAt));
      entry.rawParticipants.add(row.participant);
      entry.quoCalls += 1;
      if (isPbxGhostCall(row.status, row.durationSeconds, row.ringDurationSeconds)) entry.ghostCalls += 1;
      numbersByPhone.set(normalized, entry);
    }
    for (const row of pbxRows) {
      if (blocklist.has(row.fromNumber)) continue;
      const normalized = normalizePhone(row.fromNumber);
      if (!normalized) continue;
      const entry = numbersByPhone.get(normalized) ?? {
        fromNumber: row.fromNumber,
        team: row.team,
        sources: new Set<"quo" | "pbx">(),
        missedTimes: [],
        rawParticipants: new Set<string>(),
        quoCalls: 0,
        ghostCalls: 0,
      };
      entry.sources.add("pbx");
      entry.missedTimes.push(new Date(row.createdAt));
      entry.rawParticipants.add(row.fromNumber);
      numbersByPhone.set(normalized, entry);
    }

    if (numbersByPhone.size === 0) {
      return {
        date: input.query.date,
        numbers: [] as PbxBreakdownNumber[],
        stats: { total: 0, withCallback: 0, rate: 0 },
      };
    }

    const participants = new Set<string>();
    for (const entry of numbersByPhone.values()) {
      for (const participant of entry.rawParticipants) participants.add(participant);
    }
    const outbound = await this.repository.listOutboundBreakdown({
      date: input.query.date,
      participants: [...participants],
    });
    const callbacks = new Map<string, Array<{ date: Date; connected: boolean }>>();
    for (const row of outbound) {
      const normalized = normalizePhone(row.participant);
      if (!normalized) continue;
      const entries = callbacks.get(normalized) ?? [];
      const talkSeconds = row.postAnswerSeconds ?? row.durationSeconds ?? 0;
      entries.push({ date: new Date(row.createdAt), connected: talkSeconds > 60 });
      callbacks.set(normalized, entries);
    }

    const numbers: PbxBreakdownNumber[] = [];
    for (const [normalized, entry] of numbersByPhone) {
      entry.missedTimes.sort((left, right) => left.getTime() - right.getTime());
      const firstMissed = entry.missedTimes[0]!;
      const callback = callbacks.get(normalized)?.find((candidate) => candidate.date >= firstMissed) ?? null;
      const sources = [...entry.sources];
      numbers.push({
        fromNumber: entry.fromNumber,
        team: entry.team,
        source: sources.length === 2 ? "both" : sources[0]!,
        missedCount: entry.missedTimes.length,
        firstMissedAt: firstMissed.toISOString(),
        hasCallback: Boolean(callback),
        callbackConnected: callback?.connected ?? false,
        callbackAt: callback?.date.toISOString() ?? null,
        responseMinutes: callback ? Math.round((callback.date.getTime() - firstMissed.getTime()) / 60_000) : null,
        ghostCount: entry.ghostCalls,
        isGhost: KNOWN_GHOST_NUMBERS.has(normalized)
          || (entry.quoCalls > 0 && entry.ghostCalls === entry.quoCalls),
      });
    }
    numbers.sort((left, right) => {
      const leftRank = !left.hasCallback ? 0 : !left.callbackConnected ? 1 : 2;
      const rightRank = !right.hasCallback ? 0 : !right.callbackConnected ? 1 : 2;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return new Date(left.firstMissedAt).getTime() - new Date(right.firstMissedAt).getTime();
    });

    const visibleNumbers = isAdministrator(input.actor)
      ? numbers
      : numbers.filter((number) => (
        number.team === "retention" || number.team === "nsf" || number.team === "cs" || number.team === "killers"
      ) && canAccessFullTeam(input.actor, number.team as MetricTeam));
    const withCallback = visibleNumbers.filter((number) => number.hasCallback).length;
    const connected = visibleNumbers.filter((number) => number.callbackConnected).length;
    return {
      date: input.query.date,
      numbers: visibleNumbers,
      stats: {
        total: visibleNumbers.length,
        withCallback,
        connected,
        callbackRate: visibleNumbers.length > 0 ? Math.round(withCallback / visibleNumbers.length * 100) / 100 : 0,
        connectRate: withCallback > 0 ? Math.round(connected / withCallback * 100) / 100 : 0,
      },
    };
  }

  async getCallbackReview(input: {
    actor: AuthPayload;
    query: PbxCallbackReviewQuery;
    internalNumbers: string[];
  }) {
    let missedWindow;
    let callbackStart: Date;
    let callbackEnd: Date;
    if (input.query.kind === "range") {
      missedWindow = { kind: "range" as const, from: input.query.from, to: input.query.to };
      callbackStart = new Date(`${input.query.from}T00:00:00Z`);
      callbackStart.setDate(callbackStart.getDate() - 1);
      callbackEnd = new Date(`${input.query.to}T23:59:59Z`);
      callbackEnd.setDate(callbackEnd.getDate() + 3);
    } else {
      const now = this.now();
      callbackStart = new Date(now.getTime() - input.query.days * 24 * 60 * 60 * 1000);
      missedWindow = { kind: "since" as const, since: callbackStart };
      callbackEnd = new Date(now.getTime());
      callbackEnd.setDate(callbackEnd.getDate() + 3);
    }

    const [blocklist, quoMissed, pbxMissed] = await Promise.all([
      this.repository.loadBlockedNumbers(),
      this.repository.listQuoCallbackReview({
        window: missedWindow,
        internalNumbers: input.internalNumbers,
      }),
      this.repository.listPbxCallbackReview(missedWindow),
    ]);
    const rawNumbers = new Set<string>();
    for (const row of quoMissed) {
      if (!blocklist.has(row.participant) && normalizePhone(row.participant)) rawNumbers.add(row.participant);
    }
    for (const row of pbxMissed) {
      if (!blocklist.has(row.fromNumber) && normalizePhone(row.fromNumber)) rawNumbers.add(row.fromNumber);
    }

    const callbackMap = new Map<string, Array<{ date: Date; connected: boolean }>>();
    if (rawNumbers.size > 0) {
      const outbound = await this.repository.listOutboundCallbackReview({
        from: callbackStart,
        to: callbackEnd,
        participants: [...rawNumbers],
      });
      for (const row of outbound) {
        const normalized = normalizePhone(row.participant);
        if (!normalized) continue;
        const callbacks = callbackMap.get(normalized) ?? [];
        const talkSeconds = row.postAnswerSeconds ?? row.durationSeconds ?? 0;
        callbacks.push({ date: new Date(row.createdAt), connected: talkSeconds > 60 });
        callbackMap.set(normalized, callbacks);
      }
    }

    const items: PbxCallbackReviewItem[] = [];
    for (const row of quoMissed) {
      if (blocklist.has(row.participant)) continue;
      const normalized = normalizePhone(row.participant);
      if (!normalized) continue;
      const missedAt = new Date(row.createdAt);
      const callback = callbackMap.get(normalized)?.find((candidate) => candidate.date >= missedAt) ?? null;
      items.push({
        id: `quo-${row.id}`,
        fromNumber: row.participant,
        team: row.team,
        source: "quo",
        ringGroupName: row.lineName,
        missedAt: missedAt.toISOString(),
        isGhost: KNOWN_GHOST_NUMBERS.has(normalized)
          || isPbxGhostCall(row.status, row.durationSeconds ?? 0, row.ringDurationSeconds),
        hasCallback: Boolean(callback),
        callbackConnected: callback?.connected ?? false,
        callbackAt: callback?.date.toISOString() ?? null,
        responseMinutes: callback ? Math.round((callback.date.getTime() - missedAt.getTime()) / 60_000) : null,
      });
    }
    for (const row of pbxMissed) {
      if (blocklist.has(row.fromNumber)) continue;
      const normalized = normalizePhone(row.fromNumber);
      if (!normalized) continue;
      const missedAt = new Date(row.createdAt);
      const callback = callbackMap.get(normalized)?.find((candidate) => candidate.date >= missedAt) ?? null;
      items.push({
        id: `pbx-${row.id}`,
        fromNumber: row.fromNumber,
        team: row.team,
        source: "pbx",
        ringGroupName: row.ringGroupName,
        missedAt: missedAt.toISOString(),
        isGhost: false,
        hasCallback: Boolean(callback),
        callbackConnected: callback?.connected ?? false,
        callbackAt: callback?.date.toISOString() ?? null,
        responseMinutes: callback ? Math.round((callback.date.getTime() - missedAt.getTime()) / 60_000) : null,
      });
    }
    items.sort((left, right) => new Date(right.missedAt).getTime() - new Date(left.missedAt).getTime());

    const visibleItems = isAdministrator(input.actor)
      ? items
      : items.filter((item) => (
        item.team === "retention" || item.team === "nsf" || item.team === "cs" || item.team === "killers"
      ) && canAccessFullTeam(input.actor, item.team as MetricTeam));
    const realItems = visibleItems.filter((item) => !item.isGhost);
    const withCallback = realItems.filter((item) => item.hasCallback).length;
    const connected = realItems.filter((item) => item.callbackConnected).length;
    const responseTimes = realItems
      .filter((item) => item.responseMinutes !== null)
      .map((item) => item.responseMinutes!);
    return {
      items: visibleItems,
      stats: {
        total: realItems.length,
        ghost: visibleItems.filter((item) => item.isGhost).length,
        withCallback,
        connected,
        rate: realItems.length > 0 ? Math.round(withCallback / realItems.length * 100) / 100 : 0,
        connectRate: withCallback > 0 ? Math.round(connected / withCallback * 100) / 100 : 0,
        avgResponseMinutes: responseTimes.length > 0
          ? Math.round(responseTimes.reduce((sum, minutes) => sum + minutes, 0) / responseTimes.length)
          : 0,
      },
    };
  }
}

export const pbxMissedReportingService = new PbxMissedReportingService();
