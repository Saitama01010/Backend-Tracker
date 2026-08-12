export interface QuoAttendanceAggregateRow {
  agentName: string | null;
  firstCallAt: Date | string | null;
}

export interface AttendanceImportCandidate {
  name: string;
  shift: string;
  department: string;
  records: Array<{ date: string; status: string }>;
}

export interface PlannedAttendanceImportMember extends AttendanceImportCandidate {
  key: string;
}

export function attendanceImportMemberKey(department: string, name: string): string {
  return JSON.stringify([department, name]);
}

export function buildAttendanceImportPlan(
  candidates: readonly AttendanceImportCandidate[],
): { members: PlannedAttendanceImportMember[]; totalRecords: number } {
  const members = new Map<string, PlannedAttendanceImportMember>();
  let totalRecords = 0;
  for (const candidate of candidates) {
    const key = attendanceImportMemberKey(candidate.department, candidate.name);
    let member = members.get(key);
    if (!member) {
      member = { ...candidate, key, records: [] };
      members.set(key, member);
    }
    member.records.push(...candidate.records);
    totalRecords += candidate.records.length;
  }
  return { members: [...members.values()], totalRecords };
}

/**
 * Converts SQL's per-raw-agent minimum into the same normalized agent lookup
 * used by the attendance routes. Normalization deliberately remains in
 * JavaScript so aliases, Unicode case conversion, and whitespace behavior do
 * not move into a database collation.
 */
export function buildQuoFirstCallMap(
  rows: readonly QuoAttendanceAggregateRow[],
): Map<string, Date> {
  const firstCalls = new Map<string, Date>();
  for (const row of rows) {
    if (!row.agentName || !row.firstCallAt) continue;
    const key = row.agentName.trim().toLowerCase();
    const candidate = new Date(row.firstCallAt);
    const current = firstCalls.get(key);
    if (!current || candidate < current) firstCalls.set(key, candidate);
  }
  return firstCalls;
}

export interface WeeklyQaReview {
  id: string;
  agentName: string;
  department: string;
  score: number;
  criticalFail: boolean;
}

export interface ExistingWeeklyQaTask {
  id: string;
  agentName: string;
  source: string;
  createdAt: Date;
}

export interface WeeklyQaPick {
  id: string;
  agentName: string;
  department: string;
  aiScore: number;
  score: number;
  reason: string;
  criticalFail: boolean;
  source: "weekly_lowest" | "weekly_random";
  status: "open";
}

export function planWeeklyQaAssignments(
  reviews: readonly WeeklyQaReview[],
  existingTasks: readonly ExistingWeeklyQaTask[],
  weekStart: Date,
  random: () => number = Math.random,
): { picks: WeeklyQaPick[]; agents: number } {
  const byAgent = new Map<string, WeeklyQaReview[]>();
  for (const review of reviews) {
    const list = byAgent.get(review.agentName);
    if (list) list.push(review);
    else byAgent.set(review.agentName, [review]);
  }

  const taskIdsByAgent = new Map<string, Set<string>>();
  const assignedThisWeek = new Set<string>();
  for (const task of existingTasks) {
    const ids = taskIdsByAgent.get(task.agentName);
    if (ids) ids.add(task.id);
    else taskIdsByAgent.set(task.agentName, new Set([task.id]));
    if (
      (task.source === "weekly_lowest" || task.source === "weekly_random")
      && task.createdAt >= weekStart
    ) {
      assignedThisWeek.add(task.agentName);
    }
  }

  const picks: WeeklyQaPick[] = [];
  for (const [agentName, list] of byAgent) {
    if (assignedThisWeek.has(agentName)) continue;
    const existingIds = taskIdsByAgent.get(agentName) ?? new Set<string>();
    const eligible = list.filter((review) => !existingIds.has(review.id));
    if (eligible.length === 0) continue;

    // Stable sort preserves the legacy database order for equal scores.
    const lowest = [...eligible].sort((a, b) => a.score - b.score)[0]!;
    const others = eligible.filter((review) => review.id !== lowest.id);
    const randomReview = others.length > 0
      ? others[Math.floor(random() * others.length)]!
      : null;

    picks.push({
      id: lowest.id,
      agentName,
      department: lowest.department,
      aiScore: lowest.score,
      score: lowest.score,
      reason: `Weekly review: lowest AI score (${lowest.score}/100)`,
      criticalFail: lowest.criticalFail,
      source: "weekly_lowest",
      status: "open",
    });
    if (randomReview) {
      picks.push({
        id: randomReview.id,
        agentName,
        department: randomReview.department,
        aiScore: randomReview.score,
        score: randomReview.score,
        reason: `Weekly review: random sample (${randomReview.score}/100)`,
        criticalFail: randomReview.criticalFail,
        source: "weekly_random",
        status: "open",
      });
    }
  }

  return { picks, agents: byAgent.size };
}
