import assert from "node:assert/strict";
import test from "node:test";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import {
  QuoAnthropicOnboardingReportProvider,
  validateOnboardingClassification,
} from "./onboarding.report.provider.js";

test("Onboarding provider preserves QUO speaker mapping and transcript trimming", () => {
  const provider = new QuoAnthropicOnboardingReportProvider();
  assert.equal(provider.buildTranscript([
    { identifier: OPERATIONAL_CONFIG.lineIds.onboardingNumber, content: " Agent line " },
    { identifier: "customer", content: " Customer line " },
    { identifier: "customer", content: "   " },
  ]), "AGENT: Agent line\nCUSTOMER: Customer line");
});

test("Onboarding provider preserves strict classification validation and normalization", () => {
  assert.deepEqual(validateOnboardingClassification({
    customerName: " Customer One ",
    closerAgent: " ",
    callType: "onboarded",
    notes: " completed setup ",
  }), {
    customerName: "Customer One",
    closerAgent: null,
    callType: "onboarded",
    notes: "completed setup",
  });
  assert.equal(validateOnboardingClassification({
    customerName: null,
    closerAgent: null,
    callType: "invented",
    notes: "invalid",
  }), null);
});
