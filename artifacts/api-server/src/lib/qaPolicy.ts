export interface QaPolicyReview {
  source: string;
  evaluatedAt: Date;
}

export interface QaPolicyCall {
  id: string;
  durationSeconds: number;
  createdAt: Date;
}

export type QaDateBasis = "evaluated" | "call";

export function parseQaDateBasis(value: unknown): QaDateBasis | null {
  if (value === undefined || value === null || value === "") return "evaluated";
  if (value === "evaluated" || value === "call") return value;
  return null;
}

export function qaReviewDateForBasis<T extends { evaluatedAt: Date; callDate: Date }>(
  review: T,
  dateBasis: QaDateBasis,
): Date {
  return dateBasis === "evaluated" ? review.evaluatedAt : review.callDate;
}

export interface ValidatedQaResult {
  department?: string;
  categoryScores: Record<string, number>;
  score: number;
  softSkillsScore: number;
  protocolScore: number;
  pass: boolean;
  criticalFail: boolean;
  strengths: string[];
  missedItems: string[];
  criticalIssues: string[];
  reason: string;
  managerReviewRequired: boolean;
}

type QaDepartment = "Retention" | "CS" | "NSF";

const CATEGORY_LIMITS: Record<QaDepartment, Record<string, number>> = {
  Retention: {
    greeting: 8,
    empathy: 10,
    ownership: 5,
    professionalism: 5,
    closing: 7,
    pulledCustomerInfo: 5,
    askedCancellationReason: 10,
    usedRetentionFramework: 15,
    attemptedSave: 15,
    handledObjection: 8,
    offeredSolution: 7,
    followedRetentionProcess: 5,
  },
  CS: {
    greeting: 7,
    empathy: 10,
    ownership: 10,
    professionalism: 5,
    closing: 8,
    attemptedResolution: 15,
    avoidedUnnecessaryTransfer: 10,
    handledCancellationConcerns: 10,
    properWarmTransfer: 5,
    accurateCallbackExpectations: 5,
    accurateInformation: 10,
    followedSupportWorkflow: 5,
  },
  NSF: {
    greeting: 5,
    empathy: 10,
    ownership: 8,
    professionalism: 5,
    closing: 7,
    reviewedAccountStatus: 10,
    explainedPaymentIssue: 10,
    attemptedResolution: 15,
    attemptedSaveBeforeTransfer: 10,
    collectedRequiredInfo: 5,
    properWarmTransfer: 5,
    verifiedDocumentation: 5,
    loggedProperNotes: 5,
  },
};

export function qaEvaluationToolInputSchema(department: QaDepartment) {
  const categoryLimits = CATEGORY_LIMITS[department];
  const categoryNames = Object.keys(categoryLimits);
  return {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      department: { type: "string" as const, enum: [department] },
      categoryScores: {
        type: "object" as const,
        additionalProperties: false,
        properties: Object.fromEntries(Object.entries(categoryLimits).map(([name, maximum]) => [
          name,
          { type: "number" as const, description: `Score for ${name}; server limit ${maximum}` },
        ])),
        required: categoryNames,
      },
      score: { type: "number" as const },
      softSkillsScore: { type: "number" as const },
      protocolScore: { type: "number" as const },
      pass: { type: "boolean" as const },
      criticalFail: { type: "boolean" as const },
      strengths: {
        type: "array" as const,
        items: { type: "string" as const },
      },
      missedItems: {
        type: "array" as const,
        items: { type: "string" as const },
      },
      criticalIssues: {
        type: "array" as const,
        items: { type: "string" as const },
      },
      reason: { type: "string" as const },
      managerReviewRequired: { type: "boolean" as const },
    },
    required: [
      "department",
      "categoryScores",
      "score",
      "softSkillsScore",
      "protocolScore",
      "pass",
      "criticalFail",
      "strengths",
      "missedItems",
      "criticalIssues",
      "reason",
      "managerReviewRequired",
    ],
  };
}

const SOFT_SKILL_CATEGORIES = new Set(["greeting", "empathy", "ownership", "professionalism", "closing"]);

function boundedScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : null;
}

export function validateQaResultWithReason(
  value: unknown,
  expectedDepartment: QaDepartment,
): { result: ValidatedQaResult | null; reason: string | null } {
  const invalid = (reason: string) => ({ result: null, reason });
  if (!value || typeof value !== "object") return invalid("tool input is not an object");
  const raw = value as Record<string, unknown>;
  if (raw["department"] !== expectedDepartment) return invalid("department does not match the call line");
  if (boundedScore(raw["score"]) === null
    || boundedScore(raw["softSkillsScore"]) === null
    || boundedScore(raw["protocolScore"]) === null) return invalid("one or more aggregate scores are invalid");
  if (typeof raw["pass"] !== "boolean"
    || typeof raw["criticalFail"] !== "boolean"
    || typeof raw["managerReviewRequired"] !== "boolean"
    || typeof raw["reason"] !== "string") return invalid("required result fields have invalid types");
  for (const field of ["strengths", "missedItems", "criticalIssues"] as const) {
    if (!Array.isArray(raw[field]) || raw[field].some((item) => typeof item !== "string")) {
      return invalid(`${field} must be a string array`);
    }
  }
  if (!raw["categoryScores"] || typeof raw["categoryScores"] !== "object" || Array.isArray(raw["categoryScores"])) {
    return invalid("categoryScores is invalid");
  }
  const limits = CATEGORY_LIMITS[expectedDepartment];
  const entries = Object.entries(raw["categoryScores"] as Record<string, unknown>);
  if (entries.length !== Object.keys(limits).length) return invalid("categoryScores has missing or extra categories");
  const categoryScores: Record<string, number> = {};
  for (const [key, scoreValue] of entries) {
    const score = boundedScore(scoreValue);
    if (!(key in limits) || score === null || score > limits[key]!) return invalid(`category score is invalid for ${key}`);
    categoryScores[key] = score;
  }
  const computedScore = Object.values(categoryScores).reduce((sum, score) => sum + score, 0);
  const softMaximum = Object.entries(limits)
    .filter(([key]) => SOFT_SKILL_CATEGORIES.has(key))
    .reduce((sum, [, maximum]) => sum + maximum, 0);
  const softSubtotal = Object.entries(categoryScores)
    .filter(([key]) => SOFT_SKILL_CATEGORIES.has(key))
    .reduce((sum, [, score]) => sum + score, 0);
  const protocolMaximum = 100 - softMaximum;
  const protocolSubtotal = computedScore - softSubtotal;
  const softSkillsScore = Math.round(softSubtotal / softMaximum * 100);
  const protocolScore = Math.round(protocolSubtotal / protocolMaximum * 100);
  const stringList = (input: unknown) => (input as string[])
    .map((item) => item.slice(0, 300))
    .slice(0, 4);
  const criticalFail = raw["criticalFail"] === true;
  const score = computedScore;
  return { result: {
    department: expectedDepartment,
    categoryScores,
    score,
    softSkillsScore,
    protocolScore,
    pass: !criticalFail && score >= 80,
    criticalFail,
    strengths: stringList(raw["strengths"]),
    missedItems: stringList(raw["missedItems"]),
    criticalIssues: stringList(raw["criticalIssues"]),
    reason: raw["reason"].slice(0, 1_000),
    managerReviewRequired: criticalFail || score < 80 || protocolScore < 70,
  }, reason: null };
}

export function validateQaResult(value: unknown, expectedDepartment: QaDepartment): ValidatedQaResult | null {
  return validateQaResultWithReason(value, expectedDepartment).result;
}

export function hasRecentAutomaticReview(
  reviews: QaPolicyReview[],
  now: Date,
  intervalDays: number,
): boolean {
  const cutoff = now.getTime() - intervalDays * 24 * 60 * 60 * 1000;
  return reviews.some((review) =>
    review.source === "auto_biweekly" && review.evaluatedAt.getTime() >= cutoff);
}

export function stableEligibleCalls<T extends QaPolicyCall>(
  calls: T[],
  reviewedIds: ReadonlySet<string>,
  minimumSeconds: number,
): T[] {
  return calls
    .filter((call) => call.durationSeconds >= minimumSeconds && !reviewedIds.has(call.id))
    .sort((a, b) =>
      (b.durationSeconds - a.durationSeconds)
      || (b.createdAt.getTime() - a.createdAt.getTime())
      || a.id.localeCompare(b.id));
}

export function shouldReuseStoredReview(existing: unknown, force: boolean): boolean {
  return existing !== null && existing !== undefined && !force;
}
