import type { Logger } from "pino";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  retentionPbxService,
  type RetentionPbxService,
} from "../retention/retention.pbx.service.js";
import {
  pbxMissedReportingService,
  type PbxMissedReportingService,
} from "./pbx.missed.service.js";
import type {
  PbxBreakdownQuery,
  PbxCallbackReviewQuery,
  PbxDailyQuery,
  PbxHourlyQuery,
} from "./pbx.schemas.js";
import { hydratePbxState, pbxRuntimeState } from "./pbx.state.js";

type RetentionReporting = Pick<RetentionPbxService, "getStats" | "getLive">;
type MissedReporting = Pick<
  PbxMissedReportingService,
  "getHourly" | "getDaily" | "getBreakdown" | "getCallbackReview"
>;

export interface PbxDashboardState {
  callHistory: typeof pbxRuntimeState.callHistory;
  fetchedAt: number;
  ringGroupMissed: typeof pbxRuntimeState.ringGroupMissed;
  internalNumbers: string[];
  cumulativeMissedByHour: typeof pbxRuntimeState.cumulativeMissedByHour;
  ringGroupNames: Map<number, string>;
}

export class PbxDashboardService {
  constructor(
    private readonly retention: RetentionReporting = retentionPbxService,
    private readonly missed: MissedReporting = pbxMissedReportingService,
    private readonly state: PbxDashboardState = pbxRuntimeState,
    private readonly hydrate: () => Promise<void> = hydratePbxState,
  ) {}

  async getStats(actor: AuthPayload, log: Pick<Logger, "warn">) {
    await this.hydrate();
    return this.retention.getStats({
      actor,
      cache: {
        callHistory: this.state.callHistory,
        fetchedAt: this.state.fetchedAt,
        ringGroupMissed: this.state.ringGroupMissed,
      },
      log,
    });
  }

  async getHourly(query: PbxHourlyQuery) {
    return this.missed.getHourly({
      query,
      internalNumbers: this.state.internalNumbers,
      livePbxByHour: this.state.cumulativeMissedByHour,
    });
  }

  async getDaily(query: PbxDailyQuery) {
    return this.missed.getDaily({
      query,
      internalNumbers: this.state.internalNumbers,
      liveRingGroupMissed: this.state.ringGroupMissed,
      ringGroupNames: this.state.ringGroupNames,
    });
  }

  async getBreakdown(actor: AuthPayload, query: PbxBreakdownQuery) {
    return this.missed.getBreakdown({ actor, query, internalNumbers: this.state.internalNumbers });
  }

  async getCallbackReview(actor: AuthPayload, query: PbxCallbackReviewQuery) {
    return this.missed.getCallbackReview({ actor, query, internalNumbers: this.state.internalNumbers });
  }

  async getLive(actor: AuthPayload) {
    return this.retention.getLive(actor);
  }
}

export const pbxDashboardService = new PbxDashboardService();
