import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  PbxNoCallbackService,
  type PbxNoCallbackReadymode,
  type PbxNoCallbackState,
} from "./pbx.no-callback.service.js";
import type {
  PbxNoCallbackFallbackRows,
  PbxNoCallbackRepository,
} from "./pbx.no-callback.repository.js";
import type { MissedNoCallbackItem } from "./pbx.state.js";

const admin = {
  userId: 1,
  username: "phase3-admin",
  role: "admin",
  permissions: [],
} as unknown as AuthPayload;

class FakeRepository implements PbxNoCallbackRepository {
  enqueued: string[] = [];
  fallbackInputs: Array<{ from: Date; to?: Date }> = [];
  blocked = new Set<string>();
  rows: PbxNoCallbackFallbackRows = {
    quoMissed: [],
    quoOutbound: [],
    quoInboundAnswered: [],
    persistedPbxMissed: [],
  };
  fallbackError: Error | null = null;

  async enqueueRefresh(bucket: string) { this.enqueued.push(bucket); }
  async loadFallback(input: { from: Date; to?: Date }) {
    this.fallbackInputs.push(input);
    if (this.fallbackError) throw this.fallbackError;
    return this.rows;
  }
  async loadBlockedNumbers() { return this.blocked; }
}

class FakeReadymode implements PbxNoCallbackReadymode {
  items: MissedNoCallbackItem[] = [];
  async listActive() { return this.items; }
}

class FakeState implements PbxNoCallbackState {
  hydrated = 0;
  snapshot = {
    fetchedAt: 0,
    missedNoCallback: [] as MissedNoCallbackItem[],
    internalNumbers: [] as string[],
  };
  async hydrate() { this.hydrated += 1; }
  read() { return this.snapshot; }
}

function item(input: Partial<MissedNoCallbackItem> & Pick<MissedNoCallbackItem, "id" | "source">): MissedNoCallbackItem {
  return {
    fromNumber: "+12025550100",
    toNumber: "+12025550999",
    createdAt: "2026-08-16T10:00:00.000Z",
    ringGroupId: 1,
    ringGroupName: "Retention",
    team: "retention",
    ...input,
  };
}

test("no-callback cache path preserves refresh enqueue and replaces stale ReadyMode rows", async () => {
  const repository = new FakeRepository();
  const readymode = new FakeReadymode();
  const state = new FakeState();
  state.snapshot = {
    fetchedAt: Date.parse("2026-08-16T10:00:00.000Z"),
    missedNoCallback: [item({ id: "pbx-1", source: "pbx" }), item({ id: "readymode-old", source: "readymode", team: "nsf" })],
    internalNumbers: [],
  };
  readymode.items = [item({ id: "readymode-new", source: "readymode", team: "nsf" })];
  const service = new PbxNoCallbackService(
    repository,
    readymode,
    state,
    () => new Date("2026-08-16T10:01:00.000Z"),
  );

  assert.deepEqual(await service.get({ actor: admin }), {
    items: [item({ id: "pbx-1", source: "pbx" }), item({ id: "readymode-new", source: "readymode", team: "nsf" })],
    fetchedAt: Date.parse("2026-08-16T10:00:00.000Z"),
  });
  assert.equal(state.hydrated, 1);
  assert.deepEqual(repository.enqueued, ["202608161001"]);
  assert.deepEqual(repository.fallbackInputs, []);
});

test("no-callback fallback preserves PBX, Quo, callback, ghost, and duplicate rules", async () => {
  const repository = new FakeRepository();
  const state = new FakeState();
  repository.rows = {
    quoOutbound: [{ id: "out-1", participant: "+12025550101", createdAt: new Date("2026-08-16T10:05:00.000Z") }],
    quoInboundAnswered: [],
    persistedPbxMissed: [
      { id: 1, fromNumber: "+12025550101", toNumber: "+12025550999", createdAt: new Date("2026-08-16T10:00:00.000Z"), ringGroupId: 1, ringGroupName: "Retention", team: "retention" },
      { id: 2, fromNumber: "+12025550102", toNumber: "+12025550999", createdAt: new Date("2026-08-16T10:00:00.000Z"), ringGroupId: 1, ringGroupName: "Retention", team: "retention" },
    ],
    quoMissed: [
      { id: "quo-1", participant: "+12025550103", lineId: "line-1", lineTeam: "cs", lineName: "CS Main", status: "missed", durationSeconds: 0, ringDurationSeconds: 5, createdAt: new Date("2026-08-16T10:00:00.000Z") },
      { id: "quo-duplicate", participant: "+12025550103", lineId: "line-1", lineTeam: "cs", lineName: "CS Main", status: "missed", durationSeconds: 0, ringDurationSeconds: 5, createdAt: new Date("2026-08-16T10:00:20.000Z") },
      { id: "quo-ghost", participant: "+12025550104", lineId: "line-1", lineTeam: "cs", lineName: "CS Main", status: "missed", durationSeconds: 0, ringDurationSeconds: 2, createdAt: new Date("2026-08-16T10:00:00.000Z") },
    ],
  };
  const service = new PbxNoCallbackService(
    repository,
    new FakeReadymode(),
    state,
    () => new Date("2026-08-16T12:00:00.000Z"),
  );

  const result = await service.get({ actor: admin });
  assert.deepEqual(result.items.map(({ id, source, team }) => ({ id, source, team })), [
    { id: "2", source: "pbx", team: "retention" },
    { id: "quo-quo-1", source: "quo", team: "cs" },
  ]);
  assert.equal(result.fetchedAt, 0);
  assert.deepEqual(repository.enqueued, ["202608161200"]);
  assert.deepEqual(repository.fallbackInputs, [{ from: new Date("2026-08-15T00:00:00.000Z") }]);
});

test("today-only no-callback fallback keeps the Los Angeles bounded query", async () => {
  const repository = new FakeRepository();
  const service = new PbxNoCallbackService(
    repository,
    new FakeReadymode(),
    new FakeState(),
    () => new Date("2026-08-16T12:00:00.000Z"),
  );
  const actor = { ...admin, role: "view", lockToToday: true } as unknown as AuthPayload;

  await service.get({ actor });
  assert.deepEqual(repository.fallbackInputs, [{
    from: new Date("2026-08-16T07:00:00.000Z"),
    to: new Date("2026-08-17T07:00:00.000Z"),
  }]);
});

test("fallback failure preserves the cached response and safe logging path", async () => {
  const repository = new FakeRepository();
  repository.fallbackError = new Error("sanitized fixture failure");
  const state = new FakeState();
  state.snapshot.missedNoCallback = [item({ id: "cached", source: "pbx" })];
  const errors: unknown[][] = [];
  const service = new PbxNoCallbackService(repository, new FakeReadymode(), state);

  assert.deepEqual(await service.get({
    actor: admin,
    log: {
      warn() {},
      error(...args: unknown[]) { errors.push(args); },
    } as never,
  }), {
    items: [item({ id: "cached", source: "pbx" })],
    fetchedAt: 0,
  });
  assert.equal(errors.length, 1);
});
