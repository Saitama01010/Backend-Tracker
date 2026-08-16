import assert from "node:assert/strict";
import test from "node:test";
import { attendanceShiftStart } from "../../lib/businessTime.js";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  AttendanceCallsService,
  type AttendanceCallsServiceDependencies,
} from "./attendance.calls.service.js";
import { AttendanceServiceError } from "./attendance.service.js";

const actor: AuthPayload = {
  userId: 501,
  username: "sanitized-attendance-calls-manager",
  role: "edit",
  permissions: ["view_attendance", "edit_attendance"],
  teamAccess: "retention",
  allowedAgents: null,
};
const admin: AuthPayload = {
  ...actor,
  userId: 1,
  username: "sanitized-admin",
  role: "admin",
  teamAccess: null,
};
const createdAt = new Date("2026-08-16T10:00:00.000Z");
const member = {
  id: 21,
  name: "Agent Alpha",
  shift: "4",
  shiftHours: "8",
  department: "Retention",
  active: true,
  createdAt,
};

function dependencies(options: {
  today?: string;
  firstQuoAt?: Date | null;
  contactRows?: Array<{
    participant: string;
    direction: string;
    status: string;
    durationSeconds: number;
    createdAt: Date;
    agentName: string | null;
  }>;
} = {}) {
  let pbxCalls = 0;
  let contactQueries = 0;
  let inserted: readonly unknown[] = [];
  const value: AttendanceCallsServiceDependencies = {
    repository: {
      async listFirstQuoCalls() {
        return options.firstQuoAt
          ? [{ agentName: member.name, firstCallAt: options.firstQuoAt }]
          : [];
      },
      async listMembers() { return [member]; },
      async listRecordsForDate() { return []; },
      async listRecordedMemberIds() { return []; },
      async insertRecordsIfMissing(records) { inserted = records; },
      async listAgentContactCalls() {
        contactQueries += 1;
        return options.contactRows ?? [];
      },
    },
    async loadDirectory() {
      return createAuthorizationAgentDirectory([
        { id: 21, name: "Agent Alpha", arabicName: null, team: "retention", active: true },
        { id: 22, name: "Agent Beta", arabicName: null, team: "cs", active: true },
      ]);
    },
    async loadPbxCallHistory() {
      pbxCalls += 1;
      return [];
    },
    now: () => new Date("2026-08-16T18:00:00.000Z"),
    today: () => options.today ?? "2026-08-16",
  };
  return {
    value,
    pbxCalls: () => pbxCalls,
    contactQueries: () => contactQueries,
    inserted: () => inserted,
  };
}

test("Historical Attendance call logs skip the live PBX cache and preserve response fields", async () => {
  const fake = dependencies();
  const result = await new AttendanceCallsService(fake.value).getCallLogs({
    actor,
    date: "2026-08-15",
  });

  assert.equal(fake.pbxCalls(), 0);
  assert.equal(result.date, "2026-08-15");
  assert.equal(result.agents[0]?.memberName, "Agent Alpha");
  assert.equal(result.agents[0]?.autoStatus, "no_calls");
  assert.equal(result.agents[0]?.existingRecord, null);
});

test("Attendance auto-mark preserves first-call grace and one bulk insert", async () => {
  const date = "2026-08-15";
  const shiftStart = attendanceShiftStart(date, 4);
  assert.ok(shiftStart);
  const fake = dependencies({ firstQuoAt: new Date(shiftStart.getTime() + 5 * 60_000) });
  const result = await new AttendanceCallsService(fake.value).autoMark({ actor, date });

  assert.equal(fake.pbxCalls(), 0);
  assert.deepEqual(result.results, [{ name: "Agent Alpha", status: "in", note: "" }]);
  assert.equal(fake.inserted().length, 1);
});

test("Attendance contacts reject an unauthorized agent before querying calls", async () => {
  const fake = dependencies();
  const service = new AttendanceCallsService(fake.value);

  await assert.rejects(
    service.getAgentContacts({ actor, agent: "Agent Beta", date: "2026-08-16" }),
    (error: unknown) => error instanceof AttendanceServiceError && error.status === 403,
  );
  assert.equal(fake.contactQueries(), 0);
});

test("Attendance contacts preserve aggregation, ordering, and response shape", async () => {
  const fake = dependencies({
    contactRows: [
      {
        participant: "+15550000001",
        direction: "outgoing",
        status: "completed",
        durationSeconds: 60,
        createdAt: new Date("2026-08-16T15:00:00.000Z"),
        agentName: "Agent Alpha",
      },
      {
        participant: "+15550000001",
        direction: "incoming",
        status: "missed",
        durationSeconds: 0,
        createdAt: new Date("2026-08-16T16:00:00.000Z"),
        agentName: "Agent Alpha",
      },
    ],
  });
  const result = await new AttendanceCallsService(fake.value).getAgentContacts({
    actor: admin,
    agent: "Agent Alpha",
    date: "2026-08-16",
  });

  assert.equal(result.totalCalls, 2);
  assert.equal(result.uniqueContacts, 1);
  assert.deepEqual(result.agentsMatched, ["Agent Alpha"]);
  assert.deepEqual(result.contacts[0], {
    participant: "+15550000001",
    calls: 2,
    answered: 1,
    missed: 1,
    totalSeconds: 60,
    inbound: 1,
    outbound: 1,
    firstCallAt: "8/16, 8:00 AM PDT",
    lastCallAt: "8/16, 9:00 AM PDT",
  });
});
