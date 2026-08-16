import assert from "node:assert/strict";
import test from "node:test";
import { QaExportService } from "./qa.export.service.js";

test("QA export preserves visible rows, values, and tax highlighting", async () => {
  const repository = {
    listExportReviews: async () => [
      {
        evaluatedAt: new Date("2026-08-16T12:00:00Z"),
        callDate: new Date("2026-08-15T12:00:00Z"),
        agentName: "Visible",
        department: "CS",
        phoneNumber: "+15555550100",
        score: 88,
        protocolScore: 84,
        softSkillsScore: 92,
        pass: true,
        criticalFail: false,
        aiSummary: "Sanitized summary",
        mentionsTax: true,
      },
      {
        evaluatedAt: new Date("2026-08-16T12:00:00Z"),
        callDate: new Date("2026-08-15T12:00:00Z"),
        agentName: "Hidden",
        department: "NSF",
        phoneNumber: null,
        score: 10,
        protocolScore: 10,
        softSkillsScore: 10,
        pass: false,
        criticalFail: true,
        aiSummary: null,
        mentionsTax: false,
      },
    ],
  };
  const service = new QaExportService(repository as never);
  const workbook = await service.buildWorkbook({
    from: new Date("2026-08-01T00:00:00Z"),
    to: new Date("2026-08-31T23:59:59Z"),
    dateBasis: "evaluated",
    departments: null,
    agentScope: {
      canAccess: (agentName) => agentName === "Visible",
      authorizedIdentities: ["visible"],
    },
  });
  const worksheet = workbook.getWorksheet("QA Reviews");
  assert.ok(worksheet);
  assert.equal(worksheet.getCell(1, 1).value, "QA Reviews — Tax Mentions Report");
  assert.equal(worksheet.getCell(5, 3).value, "Visible");
  assert.equal(worksheet.getCell(5, 6).value, 88);
  assert.equal(worksheet.getCell(5, 11).value, "YES");
  assert.equal(worksheet.getCell(5, 11).fill.type, "pattern");
  assert.equal(worksheet.getCell(6, 3).value, null);
});
