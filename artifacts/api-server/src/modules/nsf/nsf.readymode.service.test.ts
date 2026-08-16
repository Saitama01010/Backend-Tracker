import assert from "node:assert/strict";
import test from "node:test";
import {
  NsfReadymodeService,
} from "./nsf.readymode.service.js";
import type {
  ActiveReadymodeQueueRow,
  NsfReadymodeRepository,
  ReadymodeOutboundRow,
} from "./nsf.readymode.repository.js";

class FakeRepository implements NsfReadymodeRepository {
  active: ActiveReadymodeQueueRow[] = [];
  outbound: ReadymodeOutboundRow[] = [];
  outboundSince: Date[] = [];
  marked: Array<{ ids: number[]; doneAt: Date; doneBy: string }> = [];

  async listActive() { return this.active; }
  async listOutboundSince(earliest: Date) {
    this.outboundSince.push(earliest);
    return this.outbound;
  }
  async markDoneByIds(ids: number[], doneAt: Date, doneBy: string) {
    this.marked.push({ ids, doneAt, doneBy });
  }
}

test("active ReadyMode service preserves queue formatting and later-callback auto-clear behavior", async () => {
  const repository = new FakeRepository();
  repository.active = [
    { id: 10, phoneNumber: "2025550101", addedAt: new Date("2026-08-16T10:05:00.000Z") },
    { id: 11, phoneNumber: "2025550102", addedAt: new Date("2026-08-16T10:00:00.000Z") },
  ];
  repository.outbound = [
    { participant: "+1 (202) 555-0102", createdAt: new Date("2026-08-16T10:01:00.000Z") },
  ];
  const completedAt = new Date("2026-08-16T11:00:00.000Z");
  const service = new NsfReadymodeService(repository, () => completedAt);

  assert.deepEqual(await service.listActive(), [{
    id: "readymode-10",
    fromNumber: "(202) 555-0101",
    toNumber: "Readymode",
    createdAt: "2026-08-16T10:05:00.000Z",
    ringGroupId: -1,
    ringGroupName: "Readymode",
    team: "nsf",
    source: "readymode",
  }]);
  assert.deepEqual(repository.outboundSince, [new Date("2026-08-16T10:00:00.000Z")]);
  assert.deepEqual(repository.marked, [{ ids: [11], doneAt: completedAt, doneBy: "auto:callback" }]);
});

test("empty ReadyMode queue performs no callback scan or update", async () => {
  const repository = new FakeRepository();
  const service = new NsfReadymodeService(repository);

  assert.deepEqual(await service.listActive(), []);
  assert.deepEqual(repository.outboundSince, []);
  assert.deepEqual(repository.marked, []);
});
