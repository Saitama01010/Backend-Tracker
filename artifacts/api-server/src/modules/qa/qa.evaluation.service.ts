import type Anthropic from "@anthropic-ai/sdk";
import { canonicalAgentName } from "../../integrations/quo/sync.js";
import { AI_UNTRUSTED_DATA_SYSTEM_POLICY, wrapUntrustedAiData } from "../../lib/aiPrivacy.js";
import { anthropicErrorStatus, createAnthropicToolMessage, toolInput, usageFields } from "../../lib/anthropic.js";
import { logger } from "../../lib/logger.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import {
  qaEvaluationToolInputSchema,
  validateQaResultWithReason,
} from "../../lib/qaPolicy.js";
import { getQuoCallArtifacts, type QuoCallArtifacts } from "../../lib/quoCall.js";
import { QA_ROLLING_INTERVAL_DAYS } from "../../lib/aiRequestReservations.js";
import {
  qaRepository,
  type QaManagerTaskWrite,
  type QaReviewRecord,
  type QaReviewWrite,
} from "./qa.repository.js";
import type { QaDepartment } from "./qa.schemas.js";

const QA_MODEL = OPERATIONAL_CONFIG.aiModels.qa;
export const QA_REVIEW_INTERVAL_DAYS = QA_ROLLING_INTERVAL_DAYS;
export const QA_MIN_CALL_SECONDS = Math.max(30, Number(process.env["QA_MIN_CALL_SECONDS"] ?? 90) || 90);

const DEPARTMENTS: QaDepartment[] = ["Retention", "CS", "NSF"];

function lineTeamToDepartment(lineTeam: string): QaDepartment | null {
  switch ((lineTeam || "").toLowerCase()) {
    case "retention": return "Retention";
    case "cs": return "CS";
    case "nsf": return "NSF";
    default: return null;
  }
}

const UNIVERSAL_PREAMBLE = `You are a strict but fair AI Quality Assurance evaluator for a financial services call center.

You will be given a phone-call transcript between an AGENT and a CUSTOMER, plus context (line/team, direction, duration, AI summary). Score the AGENT against the department-specific scorecard below.

Every call is also evaluated on these UNIVERSAL soft-skill categories. Combine them with the department rubric to produce the final score.

UNIVERSAL CATEGORIES (subset of softSkillsScore):
- greeting:      proper, professional greeting; agent identifies self + company
- empathy:       acknowledges customer's situation/frustration
- ownership:     takes responsibility; does not blame other depts/systems
- listening:     responds to what the customer actually said
- communication: clear, accurate, jargon-free
- compliance:    follows verification + disclosure requirements
- problemResolution: actually solves or routes the problem
- callControl:   keeps the call on-track and on-pace
- professionalism: tone, language, no rudeness
- closing:       recap, next steps, polite close

OUTPUT — submit the complete evaluation through the record_qa_evaluation tool.

Hard rules:
- score MUST equal the sum of values in categoryScores.
- pass = (score >= 80) AND (criticalFail == false).
- managerReviewRequired = criticalFail OR score < 80 OR protocolScore < 70.
- Be concise. Be honest. Penalize transfers without attempt, missing process steps, rude tone.
`;

const DEPT_RUBRICS: Record<QaDepartment, string> = {
  Retention: `DEPARTMENT: Retention
SCORECARD (max 100, you choose how to split across these categories; weight them as listed):
- greeting (8), empathy (10), ownership (5), professionalism (5), closing (7)        ← softSkillsScore = sum of these
- pulledCustomerInfo (5)         ← did the agent pull/verify customer info up front?
- askedCancellationReason (10)
- usedRetentionFramework (15)    ← feel/felt/found, value-stack, reframe, dig-deeper
- attemptedSave (15)              ← clear, deliberate retention attempt — not just "ok"
- handledObjection (8)
- offeredSolution (7)              ← discount/plan change/concession when appropriate
- followedRetentionProcess (5)    ← documented properly, correct disposition
                                     (last 6 = protocolScore)

CRITICAL FAILS (criticalFail=true, pass=false):
- No retention attempt at all
- Customer explicitly asked to cancel and agent immediately cancelled without save attempt
- Agent ignored or talked over the cancellation concern
- Rude/dismissive/hostile behavior
- Major protocol violation (e.g. unauthorized cancellation, false promises)`,

  CS: `DEPARTMENT: Customer Support (CS)
SCORECARD (max 100):
- greeting (7), empathy (10), ownership (10), professionalism (5), closing (8)         ← softSkillsScore
- attemptedResolution (15)       ← tried to solve before transferring/escalating
- avoidedUnnecessaryTransfer (10) ← only transferred when truly needed
- handledCancellationConcerns (10) ← if customer hinted at cancel, addressed it first
- properWarmTransfer (5)         ← introduced customer to next agent if transferred
- accurateCallbackExpectations (5) ← gave correct timeframe / next steps
- accurateInformation (10)
- followedSupportWorkflow (5)
                                     (last 7 = protocolScore)

CRITICAL FAILS:
- Immediate transfer with no resolution attempt
- Cold transfer when warm was required
- Failure to explain next steps on an unresolved issue
- Incorrect escalation path (wrong team)
- Rude or dismissive behavior`,

  NSF: `DEPARTMENT: NSF (Non-Sufficient Funds / Payment Recovery)
SCORECARD (max 100):
- greeting (5), empathy (10), ownership (8), professionalism (5), closing (7)         ← softSkillsScore
- reviewedAccountStatus (10)     ← pulled NSF/account info up front
- explainedPaymentIssue (10)
- attemptedResolution (15)       ← payment method update, payment plan, retry
- attemptedSaveBeforeTransfer (10) ← did not transfer until save attempted
- collectedRequiredInfo (5)
- properWarmTransfer (5)
- verifiedDocumentation (5)
- loggedProperNotes (5)
                                     (last 8 = protocolScore)

CRITICAL FAILS:
- Failed to address the NSF/payment issue at all
- Transferred without any save/resolution attempt
- Missing critical documentation discussion (e.g. payment authorization)
- Rude or hostile to a financially-distressed customer`,
};

function buildSystemPrompt(department: QaDepartment): string {
  return `${UNIVERSAL_PREAMBLE}\n${AI_UNTRUSTED_DATA_SYSTEM_POLICY}\n${DEPT_RUBRICS[department]}`;
}

async function getTranscriptAndSummary(callId: string): Promise<{
  transcript: string;
  summary: string;
  nextSteps: string;
  artifacts: QuoCallArtifacts;
} | null> {
  const artifacts = await getQuoCallArtifacts(callId);
  if (artifacts.status !== "ready") return null;
  return {
    transcript: artifacts.transcriptText,
    summary: artifacts.summary.join(" "),
    nextSteps: artifacts.nextSteps.join("; "),
    artifacts,
  };
}

export type QaEvaluationOptions = {
  source?: "auto_biweekly" | "manual_call_id";
  userId?: number;
  artifacts?: QuoCallArtifacts;
};

export async function evaluateCall(
  callId: string,
  opts?: QaEvaluationOptions,
): Promise<QaReviewRecord | null> {
  const call = await qaRepository.getCall(callId);
  if (!call) return null;
  if (call.status !== "completed") return null;
  if ((opts?.source ?? "auto_biweekly") === "auto_biweekly" && (call.durationSeconds ?? 0) < QA_MIN_CALL_SECONDS) return null;

  const initialDept = lineTeamToDepartment(call.lineTeam);
  if (!initialDept) return null;

  const transcriptData = opts?.artifacts?.status === "ready"
    ? {
        transcript: opts.artifacts.transcriptText,
        summary: opts.artifacts.summary.join(" "),
        nextSteps: opts.artifacts.nextSteps.join("; "),
        artifacts: opts.artifacts,
      }
    : await getTranscriptAndSummary(callId);
  if (!transcriptData) return null;

  if ((opts?.source ?? "auto_biweekly") === "auto_biweekly") {
    const existingReview = await qaRepository.getReview(callId);
    if (existingReview) return null;
  }

  const transcript = transcriptData.transcript.length > 16000
    ? `${transcriptData.transcript.slice(0, 16000)}\n[...truncated]`
    : transcriptData.transcript;
  const agentName = canonicalAgentName(call.agentName) ?? "Unknown";

  let completion;
  try {
    const tool: Anthropic.Tool = {
      name: "record_qa_evaluation",
      description: "Record the complete validated QA scorecard for this call.",
      input_schema: qaEvaluationToolInputSchema(initialDept),
    };
    completion = await createAnthropicToolMessage({
      model: QA_MODEL,
      maxTokens: 900,
      system: buildSystemPrompt(initialDept),
      prompt: `Agent identity: [AUTHORIZED_EMPLOYEE]\nLine-classified department: ${initialDept}\nDirection: ${call.direction}\nDuration: ${call.durationSeconds}s\n\n${wrapUntrustedAiData("quo_summary", `Summary: ${transcriptData.summary || "(none)"}\nNext steps: ${transcriptData.nextSteps || "(none)"}`, 4_000)}\n\n${wrapUntrustedAiData("quo_transcript", transcript, 16_000)}`,
      tool,
    });
    logger.info({
      feature: "qa",
      userId: opts?.userId ?? 0,
      model: completion.model,
      requestId: completion._request_id,
      success: true,
      ...usageFields(completion.usage),
    }, "anthropic request complete");
  } catch (error) {
    logger.warn({
      feature: "qa",
      userId: opts?.userId ?? 0,
      model: QA_MODEL,
      requestId: (error as { request_id?: unknown })?.request_id ?? null,
      success: false,
    }, "anthropic request failed");
    throw error;
  }

  const decoded = toolInput(completion, "record_qa_evaluation");
  const validation = validateQaResultWithReason(decoded, initialDept);
  const parsed = validation.result;
  if (!parsed) {
    logger.warn({
      feature: "qa",
      userId: opts?.userId ?? 0,
      model: QA_MODEL,
      success: false,
      validationReason: validation.reason ?? "record_qa_evaluation tool input was missing",
    }, "qa result validation failed");
    return null;
  }

  const detectedDept: QaDepartment = (() => {
    const department = String(parsed.department ?? "").trim();
    return DEPARTMENTS.includes(department as QaDepartment)
      ? department as QaDepartment
      : initialDept;
  })();
  const categoryScores = parsed.categoryScores ?? {};
  const computedScore = Object.values(categoryScores).reduce((a, b) => a + (Number(b) || 0), 0);
  const score = Math.max(0, Math.min(100, Math.round(parsed.score ?? computedScore)));
  const softSkillsScore = Math.max(0, Math.min(100, Math.round(parsed.softSkillsScore ?? 0)));
  const protocolScore = Math.max(0, Math.min(100, Math.round(parsed.protocolScore ?? 0)));
  const criticalFail = Boolean(parsed.criticalFail);
  const pass = !criticalFail && score >= 80;
  const managerReviewRequired = criticalFail || score < 80 || protocolScore < 70;

  const reviewRow: QaReviewWrite = {
    id: callId,
    agentName,
    phoneNumber: call.participant,
    callDate: call.createdAt,
    lineTeam: call.lineTeam,
    department: detectedDept,
    transcript: transcript.slice(0, 8000),
    aiSummary: transcriptData.summary || null,
    score,
    softSkillsScore,
    protocolScore,
    pass,
    criticalFail,
    strengths: parsed.strengths,
    missedItems: parsed.missedItems,
    criticalIssues: parsed.criticalIssues,
    categoryScores,
    reason: parsed.reason ?? null,
    managerReviewRequired,
    model: QA_MODEL,
    source: opts?.source ?? "auto_biweekly",
  };

  let managerTask: QaManagerTaskWrite | null = null;
  if (managerReviewRequired) {
    const taskReason = parsed.reason
      ?? (criticalFail ? "Critical fail" : protocolScore < 70 ? "Protocol compliance < 70" : "Score below 80");
    managerTask = {
      id: callId,
      agentName,
      department: detectedDept,
      aiScore: score,
      score,
      reason: taskReason,
      criticalFail,
      source: opts?.source ?? "auto_biweekly",
      status: "open",
    };
  }

  return qaRepository.saveEvaluation(reviewRow, managerTask);
}

export { anthropicErrorStatus };
