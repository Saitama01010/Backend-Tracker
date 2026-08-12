import assert from "node:assert/strict";
import test from "node:test";
import {
  attendanceImportMemberKey,
  buildAttendanceImportPlan,
  buildQuoFirstCallMap,
  planWeeklyQaAssignments,
  type ExistingWeeklyQaTask,
  type WeeklyQaReview,
} from "./databasePerformance.js";

function legacyFirstCallMap(rows: readonly { agentName: string | null; createdAt: Date | null }[]) {
  const calls = new Map<string, Date[]>();
  for (const row of rows) {
    if (!row.agentName || !row.createdAt) continue;
    const key = row.agentName.trim().toLowerCase();
    const existing = calls.get(key);
    if (existing) existing.push(row.createdAt);
    else calls.set(key, [row.createdAt]);
  }
  return new Map([...calls].map(([key, values]) => [
    key,
    values.reduce((earliest, value) => value < earliest ? value : earliest),
  ]));
}

function serializedMap(map: Map<string, Date>) {
  return [...map].map(([key, value]) => [key, value.toISOString()]).sort(([a], [b]) => a.localeCompare(b));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function legacyWeeklyPlan(
  reviews: readonly WeeklyQaReview[],
  tasks: readonly ExistingWeeklyQaTask[],
  weekStart: Date,
  random: () => number,
) {
  const byAgent = new Map<string, WeeklyQaReview[]>();
  for (const review of reviews) {
    if (!byAgent.has(review.agentName)) byAgent.set(review.agentName, []);
    byAgent.get(review.agentName)!.push(review);
  }
  const picks: Array<{ id: string; source: string; reason: string }> = [];
  for (const [agent, list] of byAgent) {
    const existingWeekly = tasks.filter((task) => task.agentName === agent
      && ["weekly_lowest", "weekly_random"].includes(task.source)
      && task.createdAt >= weekStart);
    if (existingWeekly.length > 0) continue;
    const existingIds = new Set(tasks.filter((task) => task.agentName === agent).map((task) => task.id));
    const eligible = list.filter((review) => !existingIds.has(review.id));
    if (eligible.length === 0) continue;
    const lowest = [...eligible].sort((a, b) => a.score - b.score)[0]!;
    const others = eligible.filter((review) => review.id !== lowest.id);
    const randomReview = others.length > 0 ? others[Math.floor(random() * others.length)]! : null;
    picks.push({ id: lowest.id, source: "weekly_lowest", reason: `Weekly review: lowest AI score (${lowest.score}/100)` });
    if (randomReview) {
      picks.push({ id: randomReview.id, source: "weekly_random", reason: `Weekly review: random sample (${randomReview.score}/100)` });
    }
  }
  return { picks, agents: byAgent.size };
}

test("SQL attendance minimum is identical to the legacy in-memory minimum", () => {
  const base = Date.parse("2026-08-03T07:00:00.000Z");
  const rawRows = Array.from({ length: 20_000 }, (_, index) => ({
    agentName: index % 211 === 0 ? null : `  Synthetic Agent ${index % 80}${index % 3 === 0 ? "  " : ""}`,
    createdAt: new Date(base + (index % 1_440) * 60_000),
  }));
  rawRows.push(
    { agentName: "CASE TEST", createdAt: new Date("2026-08-03T10:05:00.000Z") },
    { agentName: " case test ", createdAt: new Date("2026-08-03T09:55:00.000Z") },
  );

  const aggregatedByRawName = new Map<string, Date>();
  for (const row of rawRows) {
    if (!row.agentName || !row.createdAt) continue;
    const current = aggregatedByRawName.get(row.agentName);
    if (!current || row.createdAt < current) aggregatedByRawName.set(row.agentName, row.createdAt);
  }
  const sqlRows = [...aggregatedByRawName].map(([agentName, firstCallAt]) => ({ agentName, firstCallAt }));

  assert.deepEqual(
    serializedMap(buildQuoFirstCallMap(sqlRows)),
    serializedMap(legacyFirstCallMap(rawRows)),
  );
});

test("bulk weekly QA planning is identical to the legacy per-agent selection", () => {
  const weekStart = new Date("2026-08-03T07:00:00.000Z");
  const reviews: WeeklyQaReview[] = Array.from({ length: 1_200 }, (_, index) => ({
    id: `sanitized-call-${index}`,
    agentName: `Synthetic Agent ${index % 40}`,
    department: ["Retention", "CS", "NSF"][index % 3]!,
    score: 45 + (index * 17) % 56,
    criticalFail: index % 29 === 0,
  }));
  const tasks: ExistingWeeklyQaTask[] = [
    { id: "sanitized-call-0", agentName: "Synthetic Agent 0", source: "auto_flag", createdAt: new Date("2026-08-01T12:00:00Z") },
    { id: "existing-weekly-1", agentName: "Synthetic Agent 1", source: "weekly_lowest", createdAt: new Date("2026-08-04T12:00:00Z") },
    { id: "old-weekly-2", agentName: "Synthetic Agent 2", source: "weekly_random", createdAt: new Date("2026-07-20T12:00:00Z") },
  ];

  const legacy = legacyWeeklyPlan(reviews, tasks, weekStart, seededRandom(42));
  const optimized = planWeeklyQaAssignments(reviews, tasks, weekStart, seededRandom(42));
  assert.equal(optimized.agents, legacy.agents);
  assert.deepEqual(
    optimized.picks.map(({ id, source, reason }) => ({ id, source, reason })),
    legacy.picks,
  );
});

test("bulk attendance import preserves member and record totals and first-write conflict behavior", () => {
  const candidates = [
    {
      name: "Synthetic Existing",
      shift: "4",
      department: "CS",
      records: [
        { date: "2026-08-01", status: "in" },
        { date: "2026-08-02", status: "late" },
      ],
    },
    {
      name: "Synthetic New",
      shift: "5",
      department: "CS",
      records: [{ date: "2026-08-01", status: "in" }],
    },
    {
      name: "Synthetic New",
      shift: "9",
      department: "CS",
      records: [
        { date: "2026-08-01", status: "late" },
        { date: "2026-08-03", status: "pto" },
      ],
    },
    {
      name: "Synthetic New",
      shift: "6",
      department: "Backend",
      records: [{ date: "2026-08-01", status: "off" }],
    },
  ];
  const existingKey = attendanceImportMemberKey("CS", "Synthetic Existing");

  const legacyMembers = new Map([[existingKey, { id: 1, shift: "4" }]]);
  const legacyRecords = new Map<string, string>();
  let legacyTotalMembers = 0;
  let legacyTotalRecords = 0;
  let nextId = 2;
  for (const candidate of candidates) {
    const key = attendanceImportMemberKey(candidate.department, candidate.name);
    let member = legacyMembers.get(key);
    if (!member) {
      member = { id: nextId++, shift: candidate.shift };
      legacyMembers.set(key, member);
      legacyTotalMembers++;
    }
    for (const record of candidate.records) {
      legacyTotalRecords++;
      const recordKey = `${member.id}:${record.date}`;
      if (!legacyRecords.has(recordKey)) legacyRecords.set(recordKey, record.status);
    }
  }

  const plan = buildAttendanceImportPlan(candidates);
  const optimizedMembers = new Map([[existingKey, { id: 1, shift: "4" }]]);
  let optimizedTotalMembers = 0;
  let optimizedNextId = 2;
  for (const member of plan.members) {
    if (!optimizedMembers.has(member.key)) {
      optimizedMembers.set(member.key, { id: optimizedNextId++, shift: member.shift });
      optimizedTotalMembers++;
    }
  }
  const optimizedRecords = new Map<string, string>();
  for (const member of plan.members) {
    const memberId = optimizedMembers.get(member.key)!.id;
    for (const record of member.records) {
      const recordKey = `${memberId}:${record.date}`;
      if (!optimizedRecords.has(recordKey)) optimizedRecords.set(recordKey, record.status);
    }
  }

  assert.equal(optimizedTotalMembers, legacyTotalMembers);
  assert.equal(plan.totalRecords, legacyTotalRecords);
  assert.deepEqual([...optimizedRecords], [...legacyRecords]);
  assert.equal(plan.members.find((member) => member.name === "Synthetic New" && member.department === "CS")?.shift, "5");
});
