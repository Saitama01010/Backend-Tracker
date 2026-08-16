import fs from "node:fs/promises";
import path from "node:path";
import { googleCsvUrl, OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";

// Operator-maintained Google Sheet exported as CSV. The sheet is published with
// daily ReadyMode agent reports; interpretation remains in csvParser.ts.
const READYMODE_CSV_URL = googleCsvUrl(OPERATIONAL_CONFIG.readyModeSheet);

export function fetchConfiguredReadyModeCsv(): Promise<Response> {
  return fetch(READYMODE_CSV_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function loadAttachedReadyModeCsv(): Promise<{ text: string; source: string } | null> {
  const candidates = [
    path.resolve(process.cwd(), "..", "..", "attached_assets"),
    path.resolve(process.cwd(), "attached_assets"),
    "/home/runner/workspace/attached_assets",
  ];
  for (const root of candidates) {
    try {
      const files = await fs.readdir(root);
      const csvFiles = files
        .filter((file) => /^Agent_report.*\.csv$/i.test(file))
        .sort()
        .reverse();
      if (csvFiles.length > 0) {
        const picked = path.join(root, csvFiles[0]!);
        return {
          text: await fs.readFile(picked, "utf8"),
          source: `attached-asset:${csvFiles[0]}`,
        };
      }
    } catch {
      // Try the next known local asset location.
    }
  }
  return null;
}
