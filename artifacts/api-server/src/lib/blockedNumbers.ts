import { db, blockedNumbersTable } from "@workspace/db";

// Hard-coded numbers always blocked regardless of DB (legacy / known spam + known internal numbers)
const HARDCODED_BLOCKLIST = new Set([
  "+17035075710",
  "17035075710",
  // Internal employee / agent numbers
  "+18723768788",
  "18723768788",
  "+19494401100",
  "19494401100",
  "+201098581818",
  "201098581818",
]);

let cachedSet: Set<string> = new Set(HARDCODED_BLOCKLIST);
let lastFetched = 0;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getBlockedNumbers(): Promise<Set<string>> {
  if (Date.now() - lastFetched < TTL_MS) return cachedSet;
  try {
    const rows = await db.select({ number: blockedNumbersTable.number }).from(blockedNumbersTable);
    const merged = new Set(HARDCODED_BLOCKLIST);
    for (const r of rows) {
      merged.add(r.number);
      // also add without leading + in case the caller strips it
      if (r.number.startsWith("+")) merged.add(r.number.slice(1));
    }
    cachedSet = merged;
    lastFetched = Date.now();
  } catch {
    // On error keep the previous cache
  }
  return cachedSet;
}

export function invalidateBlockedNumbersCache() {
  lastFetched = 0;
}
