import assert from "node:assert/strict";
import test from "node:test";
import type { PbxRefreshDirectory, PbxRingGroupScan } from "./pbx.provider.service.js";
import {
  PbxRefreshService,
  type PbxRefreshProvider,
  type PbxRefreshReadymode,
  type PbxRefreshRuntimeState,
} from "./pbx.refresh.service.js";
import type {
  PbxRefreshCallbackRows,
  PbxRefreshMissedInsert,
  PbxRefreshRepository,
} from "./pbx.refresh.repository.js";
import type { PbxNoCallbackQuoMissedRow } from "./pbx.no-callback.repository.js";

class FakeProvider implements PbxRefreshProvider {
  directoryCalls = 0;
  scanInputs: Array<Parameters<PbxRefreshProvider["scanRingGroupCalls"]>[0]> = [];
  async fetchRefreshDirectory(): Promise<PbxRefreshDirectory> {
    this.directoryCalls += 1;
    return {
      dashboard: { callsByAgent: [], totalCallsToday: 0 } as unknown as PbxRefreshDirectory["dashboard"],
      agents: [],
      ringGroups: [],
    };
  }
  async fetchAgentCallsForDate(): Promise<never> { throw new Error("unexpected agent scan"); }
  async probeAgentInboundLines(): Promise<string[]> { return []; }
  async fetchQuoLineNumbers(): Promise<Set<string>> { return new Set(["2025550199"]); }
  async scanRingGroupCalls(input: Parameters<PbxRefreshProvider["scanRingGroupCalls"]>[0]): Promise<PbxRingGroupScan> {
    this.scanInputs.push(input);
    return { missedCounts: {}, missedRecords: [], pbxOutboundCalls: [] };
  }
}

class FakeRepository implements PbxRefreshRepository {
  blockedCalls = 0;
  callbackWindows: Date[] = [];
  quoWindows: Date[] = [];
  upserts: PbxRefreshMissedInsert[][] = [];
  enqueued: Array<{ userId: number; requestedAt: Date }> = [];
  async loadBlockedNumbers() { this.blockedCalls += 1; return new Set<string>(); }
  async loadCallbackRows(since: Date): Promise<PbxRefreshCallbackRows> {
    this.callbackWindows.push(since);
    return { quoOutbound: [], quoInboundAnswered: [], persistedPbxMissed: [] };
  }
  async loadQuoMissed(since: Date): Promise<PbxNoCallbackQuoMissedRow[]> {
    this.quoWindows.push(since);
    return [];
  }
  async upsertMissed(rows: PbxRefreshMissedInsert[]) { this.upserts.push(rows); }
  async enqueueManualRefresh(userId: number, requestedAt: Date) { this.enqueued.push({ userId, requestedAt }); }
}

class FakeReadymode implements PbxRefreshReadymode {
  async listActive() { return []; }
}

function runtimeState(): PbxRefreshRuntimeState {
  return {
    fetching: false,
    callHistory: [],
    fetchedAt: 0,
    ringGroupMissed: {},
    missedNoCallback: [],
    ringGroupNames: new Map(),
    internalNumbers: [],
    persistentLineRingGroups: new Map(),
    cumulativeRingGroupMissed: {},
    seenMissedCallIds: new Set(),
    cumulativeDate: "",
    cumulativeMissedByHour: {},
    callSpans: new Map(),
    callTimestamps: new Map(),
  };
}

test("PBX refresh service preserves provider/repository sequence and durable state publication", async () => {
  const provider = new FakeProvider();
  const repository = new FakeRepository();
  const state = runtimeState();
  let persists = 0;
  const now = new Date("2026-08-16T12:00:00.000Z");
  const service = new PbxRefreshService(
    provider,
    repository,
    new FakeReadymode(),
    state,
    async () => { persists += 1; },
    () => now,
  );

  await service.refresh();
  assert.equal(provider.directoryCalls, 1);
  assert.equal(provider.scanInputs.length, 1);
  assert.equal(repository.blockedCalls, 2);
  assert.deepEqual(repository.callbackWindows, [new Date("2026-08-15T00:00:00.000Z")]);
  assert.deepEqual(repository.quoWindows, [new Date("2026-08-15T00:00:00.000Z")]);
  assert.deepEqual(repository.upserts, []);
  assert.equal(persists, 1);
  assert.equal(state.fetching, false);
  assert.equal(state.fetchedAt, now.getTime());
  assert.equal(state.cumulativeDate, "2026-08-16");
  assert.deepEqual(state.internalNumbers, ["2025550199"]);
});

test("PBX refresh service preserves the coalesced in-process refresh lock", async () => {
  const provider = new FakeProvider();
  const state = runtimeState();
  state.fetching = true;
  const service = new PbxRefreshService(provider, new FakeRepository(), new FakeReadymode(), state);

  await service.refresh();
  assert.equal(provider.directoryCalls, 0);
  assert.equal(state.fetching, true);
});

test("PBX manual refresh delegates the exact user and request time", async () => {
  const repository = new FakeRepository();
  const service = new PbxRefreshService(new FakeProvider(), repository, new FakeReadymode(), runtimeState());
  const requestedAt = new Date("2026-08-16T12:00:00.000Z");

  await service.enqueueManual(42, requestedAt);
  assert.deepEqual(repository.enqueued, [{ userId: 42, requestedAt }]);
});
