import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  buildQuoPhoneCallRow,
  USER_EMAIL_OVERRIDES,
  USER_ID_OVERRIDES,
  type QuoPhoneCallRow,
} from "../../integrations/quo/sync.js";
import {
  fetchQuoConversationCalls,
  fetchQuoLiveDirectory,
  fetchQuoRecentConversations,
  type QuoApiUser,
} from "../../integrations/quo/client.js";
import { canAccessLiveAgent } from "../../lib/authorizationScope.js";
import {
  buildLiveStatusSnapshot,
  isSupersededLiveObservation,
  LIVE_STATUS_MAX_STALE_MS,
  type LiveStatusSource,
} from "../../lib/liveStatus.js";
import { logger } from "../../lib/logger.js";
import { isAdministrator } from "../../middleware/authorizationCore.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { retentionQuoLiveWebhookCalls } from "./retention.quo.live-state.js";
import {
  retentionQuoLiveRepository,
  type RetentionQuoLivePollSnapshot,
  type RetentionQuoLiveRepository,
} from "./retention.quo.live.repository.js";

export const LIVE_POLL_STATE_KEY = "quo:live-poll";
export const LIVE_POLL_LEASE_KEY = "quo:live-poll-lease";
export const LIVE_POLL_TTL_MS = 45_000;
export const LIVE_POLL_TIMEOUT_MS = 90_000;
export const LIVE_POLL_LEASE_MS = 105_000;

const DURABLE_WEBHOOK_LIVE_PREFIX = "quo:webhook-live:";
const DURABLE_WEBHOOK_ENDED_PREFIX = "quo:webhook-ended:";
const DURABLE_WEBHOOK_OBSERVATION_KEY = "quo:webhook-observation";

export interface RetentionQuoLivePayload {
  active: string[];
  agentCalls: Array<{ agentName: string; participant: string | null }>;
  webhookActive: boolean;
  sourceTimestamp: string | null;
  observedAt: string;
  lastSuccessfulUpdateAt: string | null;
  maxStaleAt: string | null;
  fresh: boolean;
  stale: boolean;
}

export interface RetentionQuoLiveResult {
  body: string;
  stale: boolean;
  databaseMs: number;
  authorizationMs: number;
  serializeMs: number;
}

export interface RetentionQuoLegacyLiveResult {
  payload: {
    active: string[];
    agentCalls: Array<{ agentName: string; participant: string | null }>;
    webhookActive: boolean;
  };
  diagnostics: { fromWebhook: number; fromPoll: number; total: number };
}

export interface RetentionQuoLiveDependencies {
  repository: RetentionQuoLiveRepository;
  fetchLiveDirectory: typeof fetchQuoLiveDirectory;
  fetchRecentConversations: typeof fetchQuoRecentConversations;
  fetchConversationCalls: typeof fetchQuoConversationCalls;
  buildPhoneCallRow: typeof buildQuoPhoneCallRow;
  now: () => Date;
  performanceNow: () => number;
  randomId: () => string;
  webhookCalls: typeof retentionQuoLiveWebhookCalls;
}

function roundedTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

export class LivePollRefreshInProgressError extends Error {
  constructor() {
    super("Quo live refresh is already in progress");
    this.name = "LivePollRefreshInProgressError";
  }
}

export class RetentionQuoLiveService {
  private readonly pollLiveAgents = new Set<string>();
  private readonly pollLiveParticipants = new Map<string, string>();
  private livePollRunning = false;

  constructor(private readonly dependencies: RetentionQuoLiveDependencies) {}

  async runLivePoll(signal?: AbortSignal): Promise<RetentionQuoLivePollSnapshot> {
    if (this.livePollRunning) {
      return {
        active: [...this.pollLiveAgents],
        agentCalls: [...this.pollLiveParticipants.entries()]
          .map(([agentName, participant]) => ({ agentName, participant })),
      };
    }
    this.livePollRunning = true;
    try {
      signal?.throwIfAborted();
      const startedAt = this.dependencies.now();
      const fiveMinAgo = new Date(startedAt.getTime() - 5 * 60 * 1000).toISOString();
      const recentCallFloor = new Date(startedAt.getTime() - 4 * 60 * 60 * 1000).toISOString();
      const now = startedAt.toISOString();

      const { users: usersAll, lines: linesAll } = await this.dependencies.fetchLiveDirectory(signal);
      const userMap = new Map<string, string>();
      function addToUserMap(user: QuoApiUser) {
        if (userMap.has(user.id)) return;
        const emailKey = user.email?.toLowerCase().trim() ?? "";
        const override = USER_ID_OVERRIDES[user.id]
          ?? (emailKey && USER_EMAIL_OVERRIDES[emailKey]);
        userMap.set(user.id, override || `${user.firstName} ${user.lastName}`.trim());
      }
      for (const user of usersAll) addToUserMap(user);
      for (const line of linesAll) for (const user of line.users ?? []) addToUserMap(user);

      const lineIds = new Set(linesAll.map((line) => line.id));
      const lineMap = new Map(linesAll.map((line) => [line.id, line]));
      const conversations = await this.dependencies.fetchRecentConversations(fiveMinAgo, now, signal);
      const newLive = new Set<string>();
      const newParticipants = new Map<string, string>();
      const completedRows: QuoPhoneCallRow[] = [];
      const seenCompletedCallIds = new Set<string>();
      const terminalCallIds = new Set<string>();

      const tasks = conversations
        .map((conversation) => ({
          conversation,
          participant: conversation.participants?.find((value) => /^\+[1-9]\d{1,14}$/.test(value)),
        }))
        .filter((entry): entry is { conversation: typeof entry.conversation; participant: string } =>
          lineIds.has(entry.conversation.phoneNumberId) && Boolean(entry.participant),
        )
        .map(({ conversation, participant }) => async () => {
          const calls = await this.dependencies.fetchConversationCalls(
            conversation.phoneNumberId,
            participant,
            recentCallFloor,
            now,
            signal,
          );

          for (const call of calls) {
            const line = lineMap.get(conversation.phoneNumberId);
            if (call.completedAt && line && !seenCompletedCallIds.has(call.id)) {
              seenCompletedCallIds.add(call.id);
              terminalCallIds.add(call.id);
              completedRows.push(this.dependencies.buildPhoneCallRow(call, line, participant, userMap));
            }
            if (call.status !== "in-progress") continue;

            const inlineUser = call.users?.[0];
            if (inlineUser?.id) {
              addToUserMap({
                id: inlineUser.id,
                firstName: inlineUser.firstName ?? "",
                lastName: inlineUser.lastName ?? "",
                email: inlineUser.email,
              });
            }
            const resolvedUserId = call.answeredBy
              ?? call.userId
              ?? call.userIds?.[0]
              ?? inlineUser?.id
              ?? null;

            if (!resolvedUserId) {
              logger.warn(
                { callId: call.id, phoneNumberId: conversation.phoneNumberId, participant },
                "quo livePoll: in-progress call with no resolvable user",
              );
              continue;
            }

            const agentName = userMap.get(resolvedUserId) ?? resolvedUserId;
            if (agentName === resolvedUserId) {
              logger.warn(
                { callId: call.id, userId: resolvedUserId, phoneNumberId: conversation.phoneNumberId },
                "quo livePoll: in-progress user id not in userMap",
              );
            }
            newLive.add(agentName);
            newParticipants.set(agentName, call.participants?.[0] ?? participant);
          }
        });

      const limit = 2;
      let index = 0;
      async function worker() {
        while (index < tasks.length) {
          signal?.throwIfAborted();
          const task = tasks[index++];
          if (task) await task();
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));

      const persisted = await this.dependencies.repository.persistCompletedCalls(completedRows, signal);
      if (terminalCallIds.size > 0) {
        await Promise.allSettled([...terminalCallIds].map(async (callId) => {
          this.dependencies.webhookCalls.delete(callId);
          await this.dependencies.repository.deleteDurableWebhookCall(callId);
        }));
      }
      if (persisted.inserted > 0 || persisted.errors > 0) {
        logger.info(
          { completedCalls: completedRows.length, persisted: persisted.inserted, errors: persisted.errors },
          "quo livePoll: persisted recent terminal calls",
        );
      }

      this.pollLiveAgents.clear();
      this.pollLiveParticipants.clear();
      for (const agentName of newLive) this.pollLiveAgents.add(agentName);
      for (const [agentName, participant] of newParticipants) {
        this.pollLiveParticipants.set(agentName, participant);
      }

      const snapshot: RetentionQuoLivePollSnapshot = {
        active: [...newLive],
        agentCalls: [...newParticipants.entries()]
          .map(([agentName, participant]) => ({ agentName, participant })),
        sourceTimestamp: this.dependencies.now().toISOString(),
      };
      await this.dependencies.repository.publishPollState(
        LIVE_POLL_STATE_KEY,
        snapshot,
        LIVE_POLL_TTL_MS,
      );
      if (newLive.size > 0) {
        logger.info({ agents: [...newLive] }, "quo livePoll: in-progress calls found");
      }
      return snapshot;
    } catch (error) {
      logger.warn({ err: String(error) }, "quo livePoll: error");
      throw error;
    } finally {
      this.livePollRunning = false;
    }
  }

  async requestLiveRefresh(): Promise<RetentionQuoLivePollSnapshot> {
    const existing = await this.dependencies.repository.loadFreshPollState(LIVE_POLL_STATE_KEY);
    if (existing) return existing.value;

    const owner = this.dependencies.randomId();
    const acquired = await this.dependencies.repository.tryAcquirePollLease(
      LIVE_POLL_LEASE_KEY,
      owner,
      LIVE_POLL_LEASE_MS,
    );
    if (!acquired) throw new LivePollRefreshInProgressError();

    try {
      await this.runLivePoll(AbortSignal.timeout(LIVE_POLL_TIMEOUT_MS));
    } finally {
      await this.dependencies.repository.releasePollLease(LIVE_POLL_LEASE_KEY, owner)
        .catch((error: unknown) => {
          logger.warn({ err: String(error) }, "quo livePoll: unable to release durable lease");
        });
    }

    const refreshed = await this.dependencies.repository.loadFreshPollState(LIVE_POLL_STATE_KEY);
    if (!refreshed) throw new Error("Quo live refresh did not publish state");
    return refreshed.value;
  }

  async getLiveStatus(actor: AuthPayload): Promise<RetentionQuoLiveResult> {
    const observedAt = this.dependencies.now();
    const recentFloor = new Date(observedAt.getTime() - LIVE_STATUS_MAX_STALE_MS);
    const databaseStartedAt = this.dependencies.performanceNow();
    const [pollState, durableWebhookCalls, endedWebhookCalls, webhookObservation, dbRows] = await Promise.all([
      this.dependencies.repository.loadPollState(LIVE_POLL_STATE_KEY),
      this.dependencies.repository.loadDurableWebhookCalls(DURABLE_WEBHOOK_LIVE_PREFIX),
      this.dependencies.repository.loadDurableWebhookEnds(DURABLE_WEBHOOK_ENDED_PREFIX),
      this.dependencies.repository.loadWebhookObservation(DURABLE_WEBHOOK_OBSERVATION_KEY),
      this.dependencies.repository.loadInProgressRows(recentFloor),
    ]);
    const databaseMs = roundedTiming(this.dependencies.performanceNow() - databaseStartedAt);

    const observationTimes = [
      pollState?.updatedAt,
      webhookObservation?.updatedAt,
      ...durableWebhookCalls.map((entry) => entry.updatedAt),
      ...endedWebhookCalls.map((entry) => entry.updatedAt),
      ...[...this.dependencies.webhookCalls.values()].map((entry) => entry.ringingSince),
      ...dbRows.map((entry) => entry.syncedAt),
    ].filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
    const liveSources: LiveStatusSource[] = [];
    const latestEndByAgent = new Map<string, Date>();
    for (const entry of endedWebhookCalls) {
      const previous = latestEndByAgent.get(entry.value.agentName);
      if (!previous || entry.updatedAt > previous) {
        latestEndByAgent.set(entry.value.agentName, entry.updatedAt);
      }
    }
    const addSource = (agentName: string, participant: string | null, sourceObservedAt: Date) => {
      liveSources.push({ agentName, participant, observedAt: sourceObservedAt });
    };
    const pollUsable = pollState
      ? observedAt.getTime() - pollState.updatedAt.getTime() <= LIVE_STATUS_MAX_STALE_MS
      : false;

    for (const { agentName, participant, ringingSince } of this.dependencies.webhookCalls.values()) {
      addSource(agentName, participant || null, ringingSince);
    }
    for (const entry of durableWebhookCalls) {
      addSource(entry.value.agentName, entry.value.participant || null, entry.updatedAt);
    }
    if (pollUsable && pollState) {
      const participantByAgent = new Map(
        pollState.value.agentCalls.map((call) => [call.agentName, call.participant]),
      );
      for (const agentName of pollState.value.active) {
        if (isSupersededLiveObservation(pollState.updatedAt, latestEndByAgent.get(agentName))) continue;
        addSource(agentName, participantByAgent.get(agentName) ?? null, pollState.updatedAt);
      }
    }
    for (const row of dbRows) {
      if (row.agentName
        && !isSupersededLiveObservation(row.syncedAt, latestEndByAgent.get(row.agentName))) {
        addSource(row.agentName, row.participant || null, row.syncedAt);
      }
    }
    const merged = buildLiveStatusSnapshot(observedAt, liveSources);
    const lastSuccessfulUpdate = observationTimes.length > 0
      ? new Date(Math.max(...observationTimes.map((value) => value.getTime())))
      : merged.lastSuccessfulUpdateAt;
    const stale = lastSuccessfulUpdate
      ? observedAt.getTime() - lastSuccessfulUpdate.getTime() > LIVE_POLL_TTL_MS
      : true;
    const usable = lastSuccessfulUpdate
      ? observedAt.getTime() - lastSuccessfulUpdate.getTime() <= LIVE_STATUS_MAX_STALE_MS
      : false;

    const authorizationStartedAt = this.dependencies.performanceNow();
    let scopedActive = usable ? merged.active : [];
    let scopedCalls = usable ? merged.agentCalls : [];
    let scopedWebhookActive = usable
      && (this.dependencies.webhookCalls.size > 0 || durableWebhookCalls.length > 0);
    if (!isAdministrator(actor)) {
      const directory = await this.dependencies.repository.loadAuthorizationAgentDirectory();
      scopedActive = scopedActive.filter((agentName) => canAccessLiveAgent(actor, agentName, directory));
      scopedCalls = scopedCalls.filter(({ agentName }) => canAccessLiveAgent(actor, agentName, directory));
      scopedWebhookActive = usable && [
        ...[...this.dependencies.webhookCalls.values()].map(({ agentName }) => agentName),
        ...durableWebhookCalls.map(({ value }) => value.agentName),
      ].some((agentName) => canAccessLiveAgent(actor, agentName, directory));
    }
    const authorizationMs = roundedTiming(
      this.dependencies.performanceNow() - authorizationStartedAt,
    );

    const sourceTimestampCandidates = [
      pollUsable ? pollState?.value.sourceTimestamp : null,
      webhookObservation?.value.sourceTimestamp,
      ...durableWebhookCalls.map((entry) => entry.value.ringingSince),
      ...[...this.dependencies.webhookCalls.values()]
        .map((entry) => entry.ringingSince.toISOString()),
      ...dbRows.map((entry) => entry.syncedAt.toISOString()),
    ].flatMap((value) => {
      if (!value) return [];
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? [timestamp] : [];
    });
    const sourceTimestamp = sourceTimestampCandidates.length > 0
      ? new Date(Math.max(...sourceTimestampCandidates)).toISOString()
      : lastSuccessfulUpdate?.toISOString() ?? null;
    const payload: RetentionQuoLivePayload = {
      active: scopedActive,
      agentCalls: scopedCalls,
      webhookActive: scopedWebhookActive,
      sourceTimestamp,
      observedAt: observedAt.toISOString(),
      lastSuccessfulUpdateAt: lastSuccessfulUpdate?.toISOString() ?? null,
      maxStaleAt: lastSuccessfulUpdate
        ? new Date(lastSuccessfulUpdate.getTime() + LIVE_STATUS_MAX_STALE_MS).toISOString()
        : null,
      fresh: !stale,
      stale,
    };
    const serializeStartedAt = this.dependencies.performanceNow();
    const body = JSON.stringify(payload);
    const serializeMs = roundedTiming(this.dependencies.performanceNow() - serializeStartedAt);
    return { body, stale, databaseMs, authorizationMs, serializeMs };
  }

  async getLegacyLiveStatus(actor: AuthPayload): Promise<RetentionQuoLegacyLiveResult> {
    const pollSnapshot = await this.requestLiveRefresh();
    const durableWebhookCalls = await this.dependencies.repository
      .loadDurableWebhookCalls(DURABLE_WEBHOOK_LIVE_PREFIX);
    const active = new Set<string>();
    for (const { agentName } of this.dependencies.webhookCalls.values()) active.add(agentName);
    for (const { value } of durableWebhookCalls) active.add(value.agentName);
    for (const agentName of this.pollLiveAgents) active.add(agentName);
    for (const agentName of pollSnapshot.active) active.add(agentName);

    const since2h = new Date(this.dependencies.now().getTime() - 2 * 60 * 60 * 1000);
    const dbRows = await this.dependencies.repository.loadInProgressRows(since2h);
    for (const row of dbRows) if (row.agentName) active.add(row.agentName);

    const agentParticipant = new Map<string, string | null>();
    for (const { agentName, participant } of this.dependencies.webhookCalls.values()) {
      agentParticipant.set(agentName, participant || null);
    }
    for (const { value } of durableWebhookCalls) {
      agentParticipant.set(value.agentName, value.participant || null);
    }
    for (const agentName of this.pollLiveAgents) {
      agentParticipant.set(
        agentName,
        this.pollLiveParticipants.get(agentName) ?? agentParticipant.get(agentName) ?? null,
      );
    }
    for (const call of pollSnapshot.agentCalls) {
      agentParticipant.set(
        call.agentName,
        call.participant ?? agentParticipant.get(call.agentName) ?? null,
      );
    }
    for (const row of dbRows) {
      if (row.agentName && row.participant) agentParticipant.set(row.agentName, row.participant);
    }

    const diagnostics = {
      fromWebhook: this.dependencies.webhookCalls.size,
      fromPoll: new Set([...this.pollLiveAgents, ...pollSnapshot.active]).size,
      total: active.size,
    };
    if (isAdministrator(actor)) {
      return {
        payload: {
          active: [...active],
          agentCalls: [...agentParticipant.entries()]
            .map(([agentName, participant]) => ({ agentName, participant })),
          webhookActive: this.dependencies.webhookCalls.size > 0 || durableWebhookCalls.length > 0,
        },
        diagnostics,
      };
    }

    const directory = await this.dependencies.repository.loadAuthorizationAgentDirectory();
    const scopedActive = [...active]
      .filter((agentName) => canAccessLiveAgent(actor, agentName, directory));
    const scopedCalls = [...agentParticipant.entries()]
      .filter(([agentName]) => canAccessLiveAgent(actor, agentName, directory))
      .map(([agentName, participant]) => ({ agentName, participant }));
    const scopedWebhookActive = [
      ...[...this.dependencies.webhookCalls.values()].map(({ agentName }) => agentName),
      ...durableWebhookCalls.map(({ value }) => value.agentName),
    ].some((agentName) => canAccessLiveAgent(actor, agentName, directory));
    return {
      payload: {
        active: scopedActive,
        agentCalls: scopedCalls,
        webhookActive: scopedWebhookActive,
      },
      diagnostics,
    };
  }
}

export const retentionQuoLiveService = new RetentionQuoLiveService({
  repository: retentionQuoLiveRepository,
  fetchLiveDirectory: fetchQuoLiveDirectory,
  fetchRecentConversations: fetchQuoRecentConversations,
  fetchConversationCalls: fetchQuoConversationCalls,
  buildPhoneCallRow: buildQuoPhoneCallRow,
  now: () => new Date(),
  performanceNow: performance.now.bind(performance),
  randomId: randomUUID,
  webhookCalls: retentionQuoLiveWebhookCalls,
});

export async function runLivePoll(signal?: AbortSignal): Promise<RetentionQuoLivePollSnapshot> {
  return retentionQuoLiveService.runLivePoll(signal);
}
