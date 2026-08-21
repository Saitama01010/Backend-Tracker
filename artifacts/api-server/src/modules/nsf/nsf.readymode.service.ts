import {
  nsfReadymodeRepository,
  type NsfReadymodeRepository,
} from "./nsf.readymode.repository.js";
import {
  formatNsfReadymodePhone,
  normalizeNsfReadymodePhone,
} from "./nsf.readymode.schemas.js";

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
      const number = normalizeNsfReadymodePhone(row.participant);
      if (!number) continue;
      const times = callbackTimes.get(number) ?? [];
      times.push(new Date(row.createdAt));
      callbackTimes.set(number, times);
    }

    const autoDone: number[] = [];
    const items: ReadymodeItem[] = [];
    for (const row of active) {
      const normalized = normalizeNsfReadymodePhone(row.phoneNumber);
      const hasCallback = callbackTimes.get(normalized)?.some((time) => time >= row.addedAt) ?? false;
      if (hasCallback) {
        autoDone.push(row.id);
        continue;
      }
      items.push({
        id: `readymode-${row.id}`,
        fromNumber: formatNsfReadymodePhone(row.phoneNumber),
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

  async add(numbers: string[], addedBy: string) {
    const existing = await this.repository.listExistingActiveNumbers(numbers);
    const skipped = new Set(existing);
    const inserted = await this.repository.insertQueueRows(
      numbers
        .filter((number) => !skipped.has(number))
        .map((phoneNumber) => ({ phoneNumber, addedBy })),
    );
    return {
      added: inserted.length,
      skipped: skipped.size,
      addedNumbers: inserted.map((row) => formatNsfReadymodePhone(row.phoneNumber)),
      skippedNumbers: Array.from(skipped).map(formatNsfReadymodePhone),
    };
  }

  async markDoneById(id: number, doneBy: string): Promise<void> {
    await this.repository.markDoneById(id, this.now(), doneBy);
  }

  async markDoneByNumber(phoneNumber: string, doneBy: string): Promise<void> {
    await this.repository.markDoneByNumber(phoneNumber, this.now(), doneBy);
  }
}

export const nsfReadymodeService = new NsfReadymodeService();
