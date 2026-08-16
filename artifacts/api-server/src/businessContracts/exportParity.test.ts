import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildOnboardingAnalyticsWorkbook } from "../modules/onboarding/analytics.js";

const goldenPath = path.join(import.meta.dirname, "fixtures", "goldens", "major-dashboard-responses.json");

test("onboarding analytics API values and generated workbook values remain equivalent", async () => {
  const fixture = JSON.parse(await readFile(goldenPath, "utf8")) as { onboardingAnalytics: Parameters<typeof buildOnboardingAnalyticsWorkbook>[0] };
  const api = fixture.onboardingAnalytics;
  const workbook = await buildOnboardingAnalyticsWorkbook(api);
  const bytes = await workbook.xlsx.writeBuffer();
  assert.ok(bytes.byteLength > 4);
  assert.equal(new Uint8Array(bytes)[0], 0x50);
  assert.equal(new Uint8Array(bytes)[1], 0x4b);

  const roundTrip = new ExcelJS.Workbook();
  await roundTrip.xlsx.load(bytes as ArrayBuffer);
  const overview = roundTrip.getWorksheet("Overview");
  const ranking = roundTrip.getWorksheet("Agent Ranking");
  assert.ok(overview);
  assert.ok(ranking);
  const overviewValues = new Map<string, unknown>();
  overview.eachRow((row) => overviewValues.set(String(row.getCell(1).value ?? ""), row.getCell(2).value));
  assert.equal(overviewValues.get("Total calls"), api.kpis.totalCalls);
  assert.equal(overviewValues.get("Inbound received"), api.kpis.inboundReceived);
  assert.equal(overviewValues.get("Inbound answered"), api.kpis.inboundAnswered);
  assert.equal(overviewValues.get("Inbound missed"), api.kpis.inboundMissed);
  assert.equal(overviewValues.get("Response rate"), `${api.kpis.responseRate}%`);
  assert.equal(ranking.getCell("B2").value, api.agents[0]!.name);
  assert.equal(ranking.getCell("C2").value, api.agents[0]!.totalCalls);
  assert.equal(ranking.getCell("Q2").value, api.agents[0]!.onboarded);
  assert.equal(ranking.getCell("R2").value, api.agents[0]!.connection);
});
