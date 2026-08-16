import {
  nsfReadymodeRepository,
  type NsfReadymodeRepository,
} from "./nsf.readymode.repository.js";

export interface ReadymodeItem {
  id: string;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "nsf";
  source: "readymode";
}

function normalizePhone(num: string): string {
  const digits = (num ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function formatPhone(num: string): string {
  const digits = normalizePhone(num);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return num;
}

export class NsfReadymodeService {
  constructor(
    private readonly repository: NsfReadymodeRepository = nsfReadymodeRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listActive(): Promise<ReadymodeItem[]> {
    const active = await this.repository.listActive();
    if (active.length === 0) return [];

    const earliest = active.reduce(
      (minimum, row) => (row.addedAt < minimum ? row.addedAt : minimum),
      active[0]!.addedAt,
    );
    const outbound = await this.repository.listOutboundSince(earliest);
    const callbackTimes = new Map<string, Date[]>();
    for (const row of outbound) {
      const number = normalizePhone(row.participant);
      if (!number) continue;
      const times = callbackTimes.get(number) ?? [];
      times.push(new Date(row.createdAt));
      callbackTimes.set(number, times);
    }

    const autoDone: number[] = [];
    const items: ReadymodeItem[] = [];
    for (const row of active) {
      const normalized = normalizePhone(row.phoneNumber);
      const hasCallback = callbackTimes.get(normalized)?.some((time) => time >= row.addedAt) ?? false;
      if (hasCallback) {
        autoDone.push(row.id);
        continue;
      }
      items.push({
        id: `readymode-${row.id}`,
        fromNumber: formatPhone(row.phoneNumber),
        toNumber: "Readymode",
        createdAt: row.addedAt.toISOString(),
        ringGroupId: -1,
        ringGroupName: "Readymode",
        team: "nsf",
        source: "readymode",
      });
    }

    await this.repository.markDoneByIds(autoDone, this.now(), "auto:callback");
    return items;
  }
}

export const nsfReadymodeService = new NsfReadymodeService();
