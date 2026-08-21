import { postgresBackgroundJobStore } from "../../lib/backgroundJobStore.js";
import { scheduledJobKey } from "../../lib/durableBackgroundJobs.js";
import type { AuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import { retentionRepository } from "./retention.repository.js";

export interface RetentionPbxRepository {
  enqueueScheduledRefresh(minute: string): Promise<void>;
  loadAuthorizationAgentDirectory(): Promise<AuthorizationAgentDirectory>;
}

export const retentionPbxRepository: RetentionPbxRepository = {
  async enqueueScheduledRefresh(minute) {
    await postgresBackgroundJobStore.enqueue({
      jobType: "integration_live_refresh",
      idempotencyKey: scheduledJobKey("integration_live_refresh", minute),
      priority: 100,
      maxAttempts: 4,
    });
  },
  loadAuthorizationAgentDirectory: () => retentionRepository.loadAuthorizationAgentDirectory(),
};
