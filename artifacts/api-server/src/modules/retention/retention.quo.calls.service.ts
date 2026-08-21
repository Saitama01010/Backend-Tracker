import { canonicalAgentName } from "../../integrations/quo/sync.js";
import {
  dashboardAgentTeam,
  inferDashboardAgentFromLine,
} from "../../integrations/quo/dashboardMapper.js";
import {
  authorizationAgent,
  canAccessMetricAgent,
} from "../../lib/authorizationScope.js";
import { businessDayWindow } from "../../lib/businessTime.js";
import { paginateAuthorizedBatches } from "../../lib/externalIntegrationPolicy.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { isAdministrator, type MetricTeam } from "../../middleware/authorizationCore.js";
import {
  retentionQuoRepository,
  type RetentionQuoRepository,
} from "./retention.quo.repository.js";
import type {
  RetentionQuoCallRow,
  RetentionQuoCallsQuery,
  RetentionQuoCallsResult,
} from "./retention.types.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRange(query: RetentionQuoCallsQuery): { fromDate: Date; toDate: Date } {
  return {
    fromDate: DATE_ONLY.test(query.from)
      ? businessDayWindow(query.from).start
      : new Date(query.from),
    toDate: DATE_ONLY.test(query.to)
      ? businessDayWindow(query.to).endExclusive
      : new Date(query.to),
  };
}

export class RetentionQuoCallsService {
  constructor(private readonly repository: RetentionQuoRepository) {}

  async listCalls(input: {
    actor: AuthPayload;
    query: RetentionQuoCallsQuery;
  }): Promise<RetentionQuoCallsResult> {
    const { actor, query } = input;
    const { fromDate, toDate } = parseDateRange(query);
    const directory = isAdministrator(actor)
      ? null
      : await this.repository.loadAuthorizationAgentDirectory();
    const isAuthorized = (row: RetentionQuoCallRow) => {
      const agentName = canonicalAgentName(row.agentName)
        ?? inferDashboardAgentFromLine(row.lineName)
        ?? "Unknown";
      const rawTeam = dashboardAgentTeam(agentName) ?? row.lineTeam;
      const fallbackTeam: MetricTeam | null = rawTeam === "retention"
        || rawTeam === "nsf"
        || rawTeam === "cs"
        ? rawTeam
        : null;
      if (!directory) return !query.team || rawTeam === query.team;
      const resolvedTeam = authorizationAgent(directory, agentName)?.team ?? fallbackTeam;
      return (!query.team || resolvedTeam === query.team)
        && canAccessMetricAgent(actor, agentName, directory, fallbackTeam);
    };

    return paginateAuthorizedBatches(
      (databaseOffset, batchSize) => this.repository.loadCallBatch(
        fromDate,
        toDate,
        databaseOffset,
        batchSize,
      ),
      isAuthorized,
      query.offset,
      query.limit,
    );
  }
}

export const retentionQuoCallsService = new RetentionQuoCallsService(retentionQuoRepository);
