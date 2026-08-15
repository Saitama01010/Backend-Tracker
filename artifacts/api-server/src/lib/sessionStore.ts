import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { authSessionsTable } from "@workspace/db/schema";
import { hashRefreshToken } from "./sessionToken.js";

type SessionStoreExecutor = Pick<typeof db, "insert" | "update">;

function refreshLifetimeDays(): number {
  const configured = Number(process.env["AUTH_REFRESH_TOKEN_DAYS"] ?? 30);
  return Number.isFinite(configured) ? Math.min(90, Math.max(1, Math.floor(configured))) : 30;
}

export async function createRefreshSession(
  userId: number,
  executor: SessionStoreExecutor = db,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + refreshLifetimeDays() * 24 * 60 * 60 * 1_000);
  await executor.insert(authSessionsTable).values({
    id,
    userId,
    refreshTokenHash: hashRefreshToken(token),
    expiresAt,
  });
  return { id, token };
}

export async function rotateRefreshSession(token: string): Promise<{ id: string; userId: number; token: string } | null> {
  const rotatedToken = randomBytes(32).toString("base64url");
  const [session] = await db
    .update(authSessionsTable)
    .set({
      refreshTokenHash: hashRefreshToken(rotatedToken),
      lastUsedAt: new Date(),
    })
    .where(and(
      eq(authSessionsTable.refreshTokenHash, hashRefreshToken(token)),
      isNull(authSessionsTable.revokedAt),
      gt(authSessionsTable.expiresAt, new Date()),
    ))
    .returning({ id: authSessionsTable.id, userId: authSessionsTable.userId });
  return session ? { ...session, token: rotatedToken } : null;
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

export async function revokeRefreshSession(token: string): Promise<void> {
  await db.update(authSessionsTable)
    .set({ revokedAt: new Date(), lastUsedAt: new Date() })
    .where(eq(authSessionsTable.refreshTokenHash, hashRefreshToken(token)));
}

export async function revokeUserSessions(
  userId: number,
  executor: SessionStoreExecutor = db,
): Promise<void> {
  await executor.update(authSessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessionsTable.userId, userId), isNull(authSessionsTable.revokedAt)));
}
