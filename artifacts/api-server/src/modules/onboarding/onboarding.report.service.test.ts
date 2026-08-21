import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOnboardingReportWorkbook,
  importOnboardingClassifications,
} from "./report.js";
import type {
  OnboardingClassificationImportRow,
  OnboardingClassificationWrite,
  OnboardingReportRangeQuery,
  OnboardingReportRepository,
  OnboardingReportStatePatch,
  RawOnboardingReportRow,
} from "./onboarding.report.repository.js";

class FakeRepository implements OnboardingReportRepository {
  reportRows: RawOnboardingReportRow[] = [];
  reportQueries: OnboardingReportRangeQuery[] = [];
  imports: readonly OnboardingClassificationImportRow[] = [];
  importTotal = 0;

  async readState() { return null; }
  async writeState(_patch: OnboardingReportStatePatch) {}
  async listPending(_lineId: string) { return []; }
  async insertClassification(_value: OnboardingClassificationWrite) {}
  async loadReportRows(query: OnboardingReportRangeQuery) {
    this.reportQueries.push(query);
    return this.reportRows;
  }
  async loadCounts(_query: OnboardingReportRangeQuery) {
    return { typeCounts: [], taxCounts: [], totalCalls: 0 };
  }
  async importClassifications(values: readonly OnboardingClassificationImportRow[]) {
    this.imports = values;
    return this.importTotal;
  }
}

test("Onboarding report repository rows preserve workbook field and label semantics", async () => {
  const repository = new FakeRepository();
  repository.reportRows = [{
    id: "call-1",
    participant: "+1 202 555 0101",
    agentName: "Agent One",
    direction: "incoming",
    status: "completed",
    durationSeconds: 125,
    createdAt: new Date("2026-08-16T16:00:00.000Z"),
    callType: "onboarded",
    customerName: "Customer One",
    closerAgent: "Closer One",
    mentionsTax: true,
  }];

  const workbook = await buildOnboardingReportWorkbook("2026-08-16", "2026-08-16", repository);
  const sheet = workbook.getWorksheet("All Calls");
  assert.ok(sheet);
  assert.equal(repository.reportQueries.length, 1);
  assert.deepEqual(Array.from(sheet.getRow(5).values as unknown[]), [
    undefined,
    "8/16/2026, 9:00:00 AM",
    "Incoming",
    "+1 202 555 0101",
    "Customer One",
    "Agent One",
    "Closer One",
    "Onboarded Customer",
    "Yes",
    "completed",
    2.1,
    "call-1",
  ]);
});

test("Onboarding classification import preserves received and database-total response fields", async () => {
  const repository = new FakeRepository();
  repository.importTotal = 42;
  const values = [{ callId: "call-1", callType: "connection", notes: null }];

  assert.deepEqual(await importOnboardingClassifications(values, repository), {
    received: 1,
    total: 42,
  });
  assert.equal(repository.imports, values);
});
