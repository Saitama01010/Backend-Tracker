import assert from "node:assert/strict";
import test from "node:test";
import type { ViolationVerificationPayload } from "../../lib/sensitiveWorkflowPolicy.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { calculateViolations } from "./violations.calculations.js";
import type {
  ViolationScope,
  ViolationsDashboardData,
  ViolationsRepository,
} from "./violations.repository.js";
import {
  ViolationsService,
  ViolationsServiceError,
  type ViolationsServiceDependencies,
} from "./violations.service.js";

const admin: AuthPayload = {
  userId: 1,
  username: "admin-user",
  role: "admin",
  permissions: [],
};

class FakeRepository implements ViolationsRepository {
  dashboardLoads = 0;
  saved: ViolationVerificationPayload[] = [];
  data: ViolationsDashboardData = {
    members: [],
    verifications: [],
    callRows: [],
    missedRows: [],
    quoMissedRows: [],
  };

  async loadDashboardData() {
    this.dashboardLoads++;
    return this.data;
  }
  async resolveMissedVerificationScope(_key: string): Promise<ViolationScope | null> { return null; }
  async saveVerification(payload: ViolationVerificationPayload) { this.saved.push(payload); }
  async deleteVerification(_key: string) {}
  async listVerifications() { return this.data.verifications; }
}

function dependencies(repository: ViolationsRepository): ViolationsServiceDependencies {
  return {
    repository,
    hydratePbxState: async () => undefined,
    pbxCallSpans: new Map(),
    pbxCallTimestamps: new Map(),
    loadAuthorizationDirectory: async () => ({ agents: [], byIdentity: new Map() }),
    now: () => new Date("2026-08-10T20:00:00.000Z"),
  };
}

test("Violation calculations preserve late-login, gap, missed-call, and verification semantics", () => {
  const date = "2026-08-10";
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const result = calculateViolations({
    dates: [date],
    rangeStart: new Date("2026-08-10T00:00:00.000Z"),
    rangeEnd: new Date("2026-08-11T00:00:00.000Z"),
    nowUtc: new Date("2026-08-10T20:00:00.000Z"),
    members: [{ id: 1, name: "Agent One", department: "retention", shift: "4", shiftHours: "8", active: true, createdAt }],
    verifiedKeys: ["late:Agent One:2026-08-10"],
    callRows: [
      { agentName: "Agent One", direction: "outgoing", status: "completed", createdAt: new Date("2026-08-10T13:20:00.000Z"), durationSeconds: 60, ringDurationSeconds: null },
      { agentName: "Agent One", direction: "outgoing", status: "completed", createdAt: new Date("2026-08-10T13:40:00.000Z"), durationSeconds: 60, ringDurationSeconds: null },
    ],
    missedRows: [{
      id: 7,
      fromNumber: "+12025550101",
      toNumber: "+12025550102",
      ringGroupId: 3,
      ringGroupName: "Retention",
      team: "retention",
      createdAt: new Date("2026-08-10T14:00:00.000Z"),
      recordedAt: new Date("2026-08-10T14:01:00.000Z"),
    }],
    quoMissedRows: [{
      id: "quo-1",
      participant: "+12025550103",
      lineTeam: "retention",
      lineName: "Retention",
      createdAt: new Date("2026-08-10T14:30:00.000Z"),
      status: "missed",
      durationSeconds: 0,
      ringDurationSeconds: 5,
    }],
    pbxCallSpans: new Map(),
    pbxCallTimestamps: new Map(),
    agentNamesForMember: (name) => [name],
  });

  assert.equal(result.lateLogin[0]?.minutesLate, 20);
  assert.equal(result.availabilityGaps[0]?.gaps[0]?.minutes, 20);
  assert.deepEqual(result.missedWhileAvail.map((row) => row.key), ["quo-missed:quo-1", "missed:7"]);
  assert.deepEqual(result.missedWhileAvail.map((row) => row.availableAgents), [["Agent One"], ["Agent One"]]);
  assert.deepEqual(result.verifiedKeys, ["late:Agent One:2026-08-10"]);
});

test("Violations service preserves validation timing and authenticated verification attribution", async () => {
  const repository = new FakeRepository();
  let hydrateCalls = 0;
  const deps = dependencies(repository);
  deps.hydratePbxState = async () => { hydrateCalls++; };
  const service = new ViolationsService(deps);

  await assert.rejects(
    service.getDashboard({ actor: admin, query: { from: "2026-02-30", to: "2026-03-01" } }),
    (error) => error instanceof ViolationsServiceError && error.status === 400,
  );
  assert.equal(hydrateCalls, 1);
  assert.equal(repository.dashboardLoads, 0);

  assert.deepEqual(await service.verify({
    actor: admin,
    body: {
      key: "late:Agent One:2026-08-10",
      type: "late_login",
      member: "Agent One",
      department: "retention",
      date: "2026-08-10",
      details: {},
      verifiedBy: "untrusted-client-value",
    },
  }), { ok: true });
  assert.equal(repository.saved[0]?.verifiedBy, "admin-user");
});
