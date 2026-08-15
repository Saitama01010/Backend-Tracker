import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { authSessionsTable } from "@workspace/db/schema";
import { hashRefreshToken } from "./sessionToken.js";

type SessionStoreExecutor = Pick<typeof db, "insert" | "update">;

export interface RefreshSession {
  id: string;
  token: string;
  binding?: string;
  tabBound: boolean;
}

function refreshCredential(token: string, binding?: string): string {
  return binding ? `${token}.${binding}` : token;
}

function newRefreshCredential(tabBound: boolean): { token: string; binding?: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  const binding = tabBound ? randomBytes(32).toString("base64url") : undefined;
  return {
    token,
    ...(binding ? { binding } : {}),
    hash: hashRefreshToken(refreshCredential(token, binding)),
  };
}

function refreshLifetimeDays(): number {
  const configured = Number(process.env["AUTH_REFRESH_TOKEN_DAYS"] ?? 30);
  return Number.isFinite(configured) ? Math.min(90, Math.max(1, Math.floor(configured))) : 30;
}

export async function createRefreshSession(
  userId: number,
  executor: SessionStoreExecutor = db,
  options: { tabBound?: boolean } = {},
): Promise<RefreshSession> {
  const id = randomUUID();
  const tabBound = options.tabBound === true;
  const credential = newRefreshCredential(tabBound);
  const expiresAt = new Date(Date.now() + refreshLifetimeDays() * 24 * 60 * 60 * 1_000);
  await executor.insert(authSessionsTable).values({
    id,
    userId,
    refreshTokenHash: credential.hash,
    expiresAt,
  });
  return {
    id,
    token: credential.token,
    ...(credential.binding ? { binding: credential.binding } : {}),
    tabBound,
  };
}

async function rotateRefreshCredential(
  token: string,
  binding: string | undefined,
  tabBound: boolean,
): Promise<(RefreshSession & { userId: number }) | null> {
  const rotated = newRefreshCredential(tabBound);
  const [session] = await db
    .update(authSessionsTable)
    .set({
      refreshTokenHash: rotated.hash,
      lastUsedAt: new Date(),
    })
    .where(and(
      eq(authSessionsTable.refreshTokenHash, hashRefreshToken(refreshCredential(token, binding))),
      isNull(authSessionsTable.revokedAt),
      gt(authSessionsTable.expiresAt, new Date()),
    ))
    .returning({ id: authSessionsTable.id, userId: authSessionsTable.userId });
  return session ? {
    ...session,
    token: rotated.token,
    ...(rotated.binding ? { binding: rotated.binding } : {}),
    tabBound,
  } : null;
}

export async function rotateRefreshSession(
  token: string,
  binding?: string,
): Promise<(RefreshSession & { userId: number }) | null> {
  if (binding) {
    const tabSession = await rotateRefreshCredential(token, binding, true);
    if (tabSession) return tabSession;
  }
  return rotateRefreshCredential(token, undefined, false);
}

export async function isActiveAccessSession(sessionId: string, userId: number): Promise<boolean> {
  const [session] = await db
    .select({ id: authSessionsTable.id })
    .from(authSessionsTable)
    .where(and(
      eq(authSessionsTable.id, sessionId),
      eq(authSessionsTable.userId, userId),
      isNull(authSessionsTable.revokedAt),
      gt(authSessionsTable.expiresAt, new Date()),
    ))
    .limit(1);
  return !!session;
}

export async function revokeRefreshSession(token: string, binding?: string): Promise<void> {
  const candidateHashes = [hashRefreshToken(token)];
  if (binding) candidateHashes.push(hashRefreshToken(refreshCredential(token, binding)));
  await db.update(authSessionsTable)
    .set({ revokedAt: new Date(), lastUsedAt: new Date() })
    .where(inArray(authSessionsTable.refreshTokenHash, candidateHashes));
}

export async function revokeUserSessions(
  userId: number,
  executor: SessionStoreExecutor = db,
): Promise<void> {
  await executor.update(authSessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessionsTable.userId, userId), isNull(authSessionsTable.revokedAt)));
}
