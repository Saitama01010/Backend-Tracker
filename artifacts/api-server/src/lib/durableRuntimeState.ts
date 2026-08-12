import { and, eq, gt, isNull, like, or } from "drizzle-orm";
import { db, durableRuntimeStateTable } from "@workspace/db";

export async function putDurableRuntimeState(
  key: string,
  value: Record<string, unknown>,
  ttlMs?: number,
): Promise<void> {
  const now = new Date();
  const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs) : null;
  await db.insert(durableRuntimeStateTable)
    .values({ key, value, updatedAt: now, expiresAt })
    .onConflictDoUpdate({
      target: durableRuntimeStateTable.key,
      set: { value, updatedAt: now, expiresAt },
    });
}

export async function getDurableRuntimeState<T extends Record<string, unknown>>(
  key: string,
  now = new Date(),
): Promise<{ value: T; updatedAt: Date; expiresAt: Date | null } | null> {
  const [row] = await db.select().from(durableRuntimeStateTable).where(and(
    eq(durableRuntimeStateTable.key, key),
    or(isNull(durableRuntimeStateTable.expiresAt), gt(durableRuntimeStateTable.expiresAt, now)),
  )).limit(1);
  if (!row) return null;
  return { value: row.value as T, updatedAt: row.updatedAt, expiresAt: row.expiresAt };
}

export async function getDurableRuntimeStateIncludingExpired<T extends Record<string, unknown>>(
  key: string,
): Promise<{ value: T; updatedAt: Date; expiresAt: Date | null } | null> {
  const [row] = await db.select().from(durableRuntimeStateTable)
    .where(eq(durableRuntimeStateTable.key, key))
    .limit(1);
  if (!row) return null;
  return { value: row.value as T, updatedAt: row.updatedAt, expiresAt: row.expiresAt };
}

export async function listDurableRuntimeState<T extends Record<string, unknown>>(
  prefix: string,
  now = new Date(),
): Promise<Array<{ key: string; value: T; updatedAt: Date; expiresAt: Date | null }>> {
  const escaped = prefix.replace(/[\\%_]/g, "\\$&");
  const rows = await db.select().from(durableRuntimeStateTable).where(and(
    like(durableRuntimeStateTable.key, `${escaped}%`),
    or(isNull(durableRuntimeStateTable.expiresAt), gt(durableRuntimeStateTable.expiresAt, now)),
  ));
  return rows.map((row) => ({
    key: row.key,
    value: row.value as T,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  }));
}

export async function deleteDurableRuntimeState(key: string): Promise<void> {
  await db.delete(durableRuntimeStateTable).where(eq(durableRuntimeStateTable.key, key));
}
