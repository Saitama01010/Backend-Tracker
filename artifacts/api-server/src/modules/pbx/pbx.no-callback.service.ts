import type { Logger } from "pino";
import { businessDayWindow, formatCalendarDate } from "../../lib/businessTime.js";
import { scopeMissedItemsForUser } from "../../lib/missedCallScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { isAdministrator } from "../../middleware/authorizationCore.js";
import { teamFromRingGroupName } from "../../integrations/pbx/mapper.js";
import { nsfReadymodeService } from "../nsf/nsf.readymode.service.js";
import { normalizeCustomerPhone, normalizePhone, phoneComparisonKeys } from "./pbx.phone.js";
import {
  pbxNoCallbackRepository,
  type PbxNoCallbackFallbackRows,
  type PbxNoCallbackMissedRow,
  type PbxNoCallbackQuoMissedRow,
  type PbxNoCallbackRepository,
} from "./pbx.no-callback.repository.js";
import {
  hydratePbxState,
  pbxRuntimeState,
  type MissedNoCallbackItem,
} from "./pbx.state.js";

export type CallbackEntry = {
  at: Date;
  id: string | null;
  source: "pbx" | "quo-outbound" | "quo-inbound";
};

export function addCallback(
  map: Map<string, CallbackEntry[]>,
  rawPhone: string,
  at: Date,
  id: string | null,
  source: CallbackEntry["source"],
): void {
  for (const key of phoneComparisonKeys(rawPhone)) {
    const entries = map.get(key) ?? [];
    entries.push({ at, id, source });
    map.set(key, entries);
  }
}

export function findLaterCallback(
  map: Map<string, CallbackEntry[]>,
  rawPhone: string,
  missedAt: Date,
): CallbackEntry | null {
  const matches: CallbackEntry[] = [];
  for (const key of phoneComparisonKeys(rawPhone)) {
    for (const entry of map.get(key) ?? []) {
      if (entry.at > missedAt) matches.push(entry);
    }
  }
  matches.sort((left, right) => left.at.getTime() - right.at.getTime());
  return matches[0] ?? null;
}

function pbxTeamFromMissedRecord(rec: PbxNoCallbackMissedRow): MissedNoCallbackItem["team"] {
  if (rec.team === "retention" || rec.team === "nsf" || rec.team === "cs") return rec.team;
  return teamFromRingGroupName(rec.ringGroupName);
}

export function buildPbxMissedNoCallbackItems(
  rows: PbxNoCallbackMissedRow[],
  callbacks: Map<string, CallbackEntry[]>,
  blocklist: Set<string>,
  internalNumbers: Set<string>,
): MissedNoCallbackItem[] {
  const items: MissedNoCallbackItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const normalizedCustomerNumber = normalizeCustomerPhone(row.fromNumber);
    const last10 = normalizePhone(row.fromNumber);
    if (!normalizedCustomerNumber || !last10) continue;
    if (blocklist.has(row.fromNumber) || blocklist.has(last10) || blocklist.has(normalizedCustomerNumber)) continue;
    if (internalNumbers.has(last10) || internalNumbers.has(normalizedCustomerNumber)) continue;

    const missedAt = new Date(row.createdAt);
    if (Number.isNaN(missedAt.getTime())) continue;
    const dedupeKey = Number.isFinite(row.id)
      ? `pbx:${row.id}`
      : `pbx:${normalizedCustomerNumber}:${row.ringGroupId}:${missedAt.toISOString()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (findLaterCallback(callbacks, row.fromNumber, missedAt)) continue;

    items.push({
      id: String(row.id),
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      createdAt: missedAt.toISOString(),
      ringGroupId: row.ringGroupId,
      ringGroupName: row.ringGroupName,
      team: pbxTeamFromMissedRecord(row),
      source: "pbx",
      missedCallId: row.id,
      normalizedCustomerNumber,
      callbackFound: false,
      callbackId: null,
      debugReason: "PBX missed call with no later PBX, Quo/OpenPhone, or available outbound callback found for this normalized customer number.",
    });
  }
  return items;
}

export function buildQuoMissedNoCallbackItems(
  rows: PbxNoCallbackQuoMissedRow[],
  callbacks: Map<string, CallbackEntry[]>,
  blocklist: Set<string>,
  internalNumbers: Set<string>,
): MissedNoCallbackItem[] {
  const items: MissedNoCallbackItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const normalizedCustomerNumber = normalizeCustomerPhone(row.participant);
    const last10 = normalizePhone(row.participant);
    if (!normalizedCustomerNumber || !last10) continue;
    if (blocklist.has(row.participant) || blocklist.has(last10) || blocklist.has(normalizedCustomerNumber)) continue;
    if (/[a-zA-Z]/.test(row.participant)) continue;
    if (internalNumbers.has(last10) || internalNumbers.has(normalizedCustomerNumber)) continue;
    const ringDuration = row.ringDurationSeconds ?? (row.durationSeconds === 0 ? 0 : 999);
    if (ringDuration <= 2) continue;

    const missedAt = new Date(row.createdAt);
    if (findLaterCallback(callbacks, row.participant, missedAt)) continue;
    const dedupeKey = `${normalizedCustomerNumber}:${row.lineId}:${Math.floor(missedAt.getTime() / 60_000)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const team = row.lineTeam === "retention" || row.lineTeam === "nsf" || row.lineTeam === "cs"
      ? row.lineTeam
      : "other";
    items.push({
      id: `quo-${row.id}`,
      missedCallId: row.id,
      fromNumber: row.participant,
      toNumber: row.lineName,
      createdAt: missedAt.toISOString(),
      ringGroupId: -1,
      ringGroupName: "OpenPhone",
      team,
      source: "quo",
      normalizedCustomerNumber,
      lineId: row.lineId,
      callbackFound: false,
      callbackId: null,
      debugReason: "Inbound Quo call was not answered and no later callback/outbound attempt was found for this normalized customer number.",
    });
  }
  return items;
}

export interface PbxNoCallbackState {
  hydrate(): Promise<void>;
  read(): {
    fetchedAt: number;
    missedNoCallback: MissedNoCallbackItem[];
    internalNumbers: string[];
  };
}

export interface PbxNoCallbackReadymode {
  listActive(): Promise<MissedNoCallbackItem[]>;
}

const runtimeState: PbxNoCallbackState = {
  hydrate: hydratePbxState,
  read: () => ({
    fetchedAt: pbxRuntimeState.fetchedAt,
    missedNoCallback: pbxRuntimeState.missedNoCallback,
    internalNumbers: pbxRuntimeState.internalNumbers,
  }),
};

function minuteBucket(date: Date): string {
  return date.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

function callbackMap(rows: PbxNoCallbackFallbackRows): Map<string, CallbackEntry[]> {
  const callbacks = new Map<string, CallbackEntry[]>();
  for (const row of rows.quoOutbound) {
    addCallback(callbacks, row.participant, new Date(row.createdAt), row.id, "quo-outbound");
  }
  for (const row of rows.quoInboundAnswered) {
    addCallback(callbacks, row.participant, new Date(row.createdAt), row.id, "quo-inbound");
  }
  return callbacks;
}

export class PbxNoCallbackService {
  constructor(
    private readonly repository: PbxNoCallbackRepository = pbxNoCallbackRepository,
    private readonly readymode: PbxNoCallbackReadymode = nsfReadymodeService,
    private readonly state: PbxNoCallbackState = runtimeState,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(input: {
    actor: AuthPayload;
    log?: Pick<Logger, "warn" | "error">;
  }): Promise<{ items: MissedNoCallbackItem[]; fetchedAt: number }> {
    await this.state.hydrate();
    const now = this.now();
    const snapshot = this.state.read();
    const cacheAgeMs = snapshot.fetchedAt ? now.getTime() - snapshot.fetchedAt : Infinity;
    if (cacheAgeMs > 30_000) {
      await this.repository.enqueueRefresh(minuteBucket(now))
        .catch((error) => input.log?.warn(error, "PBX refresh enqueue failed"));
    }

    if (snapshot.fetchedAt > 0) {
      let extra: MissedNoCallbackItem[] = [];
      try {
        extra = await this.readymode.listActive();
      } catch {
        // Best-effort merge preserves the cached dashboard response.
      }
      const merged = [
        ...snapshot.missedNoCallback.filter((item) => item.source !== "readymode"),
        ...extra,
      ];
      return {
        items: scopeMissedItemsForUser(input.actor, merged),
        fetchedAt: snapshot.fetchedAt,
      };
    }

    try {
      const lockToToday = input.actor.lockToToday && !isAdministrator(input.actor);
      const todayWindow = businessDayWindow(formatCalendarDate(now));
      const rows = await this.repository.loadFallback({
        from: lockToToday ? todayWindow.start : new Date(now.getTime() - 36 * 60 * 60 * 1_000),
        ...(lockToToday ? { to: todayWindow.endExclusive } : {}),
      });
      const callbacks = callbackMap(rows);
      const blocklist = await this.repository.loadBlockedNumbers();
      const internalNumbers = new Set(snapshot.internalNumbers);
      const items = [
        ...buildPbxMissedNoCallbackItems(rows.persistedPbxMissed, callbacks, blocklist, internalNumbers),
        ...buildQuoMissedNoCallbackItems(rows.quoMissed, callbacks, blocklist, internalNumbers),
      ];
      try {
        items.push(...await this.readymode.listActive());
      } catch (error) {
        input.log?.warn({ err: error }, "readymode queue merge failed (fallback)");
      }
      return { items: scopeMissedItemsForUser(input.actor, items), fetchedAt: 0 };
    } catch (error) {
      input.log?.error(error, "vos missed-no-callback fallback error");
      const fallback = this.state.read();
      return {
        items: scopeMissedItemsForUser(input.actor, fallback.missedNoCallback),
        fetchedAt: fallback.fetchedAt,
      };
    }
  }
}

export const pbxNoCallbackService = new PbxNoCallbackService();
