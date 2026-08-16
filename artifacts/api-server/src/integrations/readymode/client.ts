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
