import assert from "node:assert/strict";
import test from "node:test";
import { computeOnboardingAnalytics } from "./analytics.js";
import type {
  OnboardingAnalyticsCallRow,
  OnboardingAnalyticsQuery,
  OnboardingAnalyticsRepository,
} from "./onboarding.analytics.repository.js";

class FakeRepository implements OnboardingAnalyticsRepository {
  queries: OnboardingAnalyticsQuery[] = [];
  rows: OnboardingAnalyticsCallRow[] = [];
  blockedNumbers = new Set<string>();

  async load(query: OnboardingAnalyticsQuery) {
    this.queries.push(query);
    return { rows: this.rows, blockedNumbers: this.blockedNumbers };
  }
}

test("Onboarding analytics preserves filtering, KPI, agent, and classification semantics", async () => {
  const repository = new FakeRepository();
  repository.blockedNumbers.add("2025550199");
  repository.rows = [
    {
      id: "answered",
      agentName: "Cassie Lynn",
      participant: "+1 (202) 555-0101",
      lineName: "Onboarding",
      direction: "incoming",
      status: "completed",
      durationSeconds: 120,
      postAnswerSeconds: 100,
      createdAt: new Date("2026-08-16T16:00:00.000Z"),
      callType: "onboarded",
      mentionsTax: true,
    },
    {
      id: "blocked",
      agentName: "Other Agent",
      participant: "2025550199",
      lineName: "Onboarding",
      direction: "incoming",
      status: "missed",
      durationSeconds: 0,
      postAnswerSeconds: null,
      createdAt: new Date("2026-08-16T17:00:00.000Z"),
      callType: null,
      mentionsTax: null,
    },
  ];

  const result = await computeOnboardingAnalytics("2026-08-16", "2026-08-16", repository);

  assert.equal(repository.queries.length, 1);
  assert.equal(result.kpis.totalCalls, 1);
  assert.equal(result.kpis.inboundAnswered, 1);
  assert.equal(result.kpis.firstRingAnswered, 1);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]?.name, "Cassie Lynn");
  assert.equal(result.agents[0]?.onboarded, 1);
  assert.equal(result.agents[0]?.taxMentions, 1);
  assert.equal(result.cassie?.found, true);
});
