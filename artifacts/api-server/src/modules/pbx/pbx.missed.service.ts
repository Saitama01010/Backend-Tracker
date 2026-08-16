import {
  pbxMissedReportingRepository,
  type PbxHourlyCountRow,
  type PbxMissedReportingRepository,
} from "./pbx.missed.repository.js";
import type { PbxHourlyQuery } from "./pbx.schemas.js";

type PbxTeam = "retention" | "cs" | "nsf";
type SourceCounts = { quo: number; ghost: number; pbx: number };
type HourRow = Record<PbxTeam, SourceCounts>;

export type PbxHourlyResponse = {
  hours: Array<{ hour: number } & HourRow>;
  date: string;
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
}

export const pbxMissedReportingService = new PbxMissedReportingService();
