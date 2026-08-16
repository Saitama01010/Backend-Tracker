import assert from "node:assert/strict";
import test from "node:test";
import { QaReportingError, QaReportingService } from "./qa.reporting.service.js";

const scope = { canAccess: (name: string) => name !== "Hidden", authorizedIdentities: ["visible"] };
const range = {
  from: new Date("2026-08-01T00:00:00Z"),
  to: new Date("2026-08-31T23:59:59Z"),
  dateBasis: "evaluated" as const,
  departments: null,
  agentScope: scope,
};

test("QA stats preserve scoped totals, department breakdown, tax counts, and manager variance", async () => {
  const repository = {
    listStatsReviews: async () => [
      { agentName: "Visible", score: 90, protocolScore: 80, softSkillsScore: 100, pass: true, criticalFail: false, department: "CS", mentionsTax: true },
      { agentName: "Visible", score: 70, protocolScore: 60, softSkillsScore: 80, pass: false, criticalFail: true, department: "CS", mentionsTax: false },
      { agentName: "Hidden", score: 1, protocolScore: 1, softSkillsScore: 1, pass: false, criticalFail: true, department: "NSF", mentionsTax: true },
    ],
    listStatsTasks: async () => [
      { agentName: "Visible", status: "open", managerScore: null, variance: null, createdAt: new Date("2026-07-01T00:00:00Z") },
      { agentName: "Visible", status: "resolved", managerScore: 75, variance: 5, createdAt: new Date("2026-08-10T00:00:00Z") },
    ],
  };
  const service = new QaReportingService(repository as never);
  const result = await service.getStats(range);
  assert.deepEqual(result, {
    reviewed: 2,
    avgScore: 80,
    avgProtocol: 70,
    avgSoftSkills: 90,
    failed: 1,
    criticalFails: 1,
    openManagerQueue: 1,
    managerTasksCreatedInRange: 1,
    avgVariance: 5,
    taxMentions: 1,
    byDept: { CS: { reviewed: 2, avgScore: 80, criticalFails: 1, failed: 1, taxMentions: 1 } },
    dateBasis: "evaluated",
  });
});

test("QA review list rejects an unauthorized requested agent before querying", async () => {
  let queried = false;
  const service = new QaReportingService({
    listReviews: async () => {
      queried = true;
      return [];
    },
  } as never);
  await assert.rejects(
    service.listReviews({ ...range, agent: "Hidden", limit: 100 }),
    (error: unknown) => error instanceof QaReportingError && error.status === 403,
  );
  assert.equal(queried, false);
});
