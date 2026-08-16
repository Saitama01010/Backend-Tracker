import {
  pbxMissedReportingRepository,
  type PbxDailyCountRow,
  type PbxHourlyCountRow,
  type PbxMissedReportingRepository,
} from "./pbx.missed.repository.js";
import { teamFromRingGroupName } from "../../integrations/pbx/mapper.js";
import type { PbxDailyQuery, PbxHourlyQuery } from "./pbx.schemas.js";

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
}

export const pbxMissedReportingService = new PbxMissedReportingService();
