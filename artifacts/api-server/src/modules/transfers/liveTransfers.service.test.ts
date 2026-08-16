import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLiveTransferWorkbook,
  getLiveTransferStatus,
} from "./liveTransfers.js";
import {
  QuoAnthropicLiveTransferProvider,
  validateLiveTransferClassification,
} from "./liveTransfers.provider.js";
import type {
  LiveTransferClassificationWrite,
  LiveTransferRangeQuery,
  LiveTransferRepository,
  LiveTransferStatePatch,
  LiveTransferStatusQuery,
  RawLiveTransferRow,
} from "./liveTransfers.repository.js";

class FakeRepository implements LiveTransferRepository {
  rows: RawLiveTransferRow[] = [];
  rowQueries: LiveTransferRangeQuery[] = [];

  async readState() {
    return { progressDone: 4, progressTotal: 7, lastRunAt: new Date("2026-08-16T12:00:00.000Z") };
  }
  async writeState(_patch: LiveTransferStatePatch) {}
  async listPending(_lineId: string, _minimumSeconds: number) { return []; }
  async insertClassification(_value: LiveTransferClassificationWrite) {}
  async loadRows(query: LiveTransferRangeQuery) {
    this.rowQueries.push(query);
    return this.rows;
  }
  async loadStatus(_query: LiveTransferStatusQuery) {
    return {
      totalIncoming: 9,
      byKindCompany: [
        { kind: "partner", company: "Aspire", cnt: 2 },
        { kind: "internal", company: "NSF", cnt: 1 },
      ],
    };
  }
}

test("Live Transfer provider preserves QUO transcript text normalization", () => {
  const provider = new QuoAnthropicLiveTransferProvider();
  assert.equal(provider.buildTranscript([
    { identifier: "agent", content: " Agent opening " },
    { identifier: "customer", content: " Customer reply " },
    { identifier: "customer", content: "   " },
  ]), "Agent opening\nCustomer reply");
});

test("Live Transfer provider preserves strict classification validation and normalization", () => {
  assert.deepEqual(validateLiveTransferClassification({
    kind: "partner",
    company: " Aspire ",
    agent: " Partner Agent ",
    evidence: " warm transfer ",
  }), {
    kind: "partner",
    company: "Aspire",
    agent: "Partner Agent",
    evidence: "warm transfer",
  });
  assert.equal(validateLiveTransferClassification({
    kind: "invented",
    company: "Aspire",
    agent: "Agent",
    evidence: "invalid",
  }), null);
});

test("Live Transfer status composes repository counts without changing response semantics", async () => {
  const repository = new FakeRepository();
  const result = await getLiveTransferStatus(
    "2026-08-16",
    "2026-08-16",
    repository,
    async () => null,
  );

  assert.equal(result.totalIncoming, 9);
  assert.equal(result.totalLive, 3);
  assert.equal(result.partnerTotal, 2);
  assert.equal(result.internalTotal, 1);
  assert.equal(result.aspire, 2);
  assert.equal(result.resync, 0);
  assert.equal(result.clarity, 0);
  assert.equal(result.concordia, 0);
  assert.equal(result.unspecified, 0);
  assert.deepEqual(result.internalByDept, [{ dept: "NSF", count: 1 }]);
  assert.equal(result.progressDone, 4);
  assert.equal(result.progressTotal, 7);
});

test("Live Transfer repository rows preserve workbook field and label semantics", async () => {
  const repository = new FakeRepository();
  repository.rows = [{
    id: "call-1",
    participant: "+1 202 555 0101",
    lineName: "Retention",
    agentName: "Agent One",
    durationSeconds: 90,
    createdAt: new Date("2026-08-16T16:00:00.000Z"),
    kind: "partner",
    company: "Aspire",
    agent: "Partner Agent",
    evidence: "warm transfer",
  }];

  const workbook = await buildLiveTransferWorkbook("2026-08-16", "2026-08-16", repository);
  const sheet = workbook.getWorksheet("Live Transfers");
  assert.ok(sheet);
  assert.equal(repository.rowQueries.length, 1);
  assert.equal(sheet.getCell(5, 4).value, "Partner");
  assert.equal(sheet.getCell(5, 5).value, "Aspire");
  assert.equal(sheet.getCell(5, 6).value, "Partner Agent");
  assert.equal(sheet.getCell(5, 9).value, 1.5);
  assert.equal(sheet.getCell(5, 10).value, "call-1");
});
