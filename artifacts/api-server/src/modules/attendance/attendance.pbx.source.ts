import { getCallHistoryCache, hydratePbxState } from "../pbx/pbx.state.js";

export interface AttendancePbxFirstCall {
  agentName: string;
  firstCallAt: string | null;
}

// Attendance delegates to the canonical shared PBX durable runtime state while
// preserving its exact hydration, staleness, and provider-call behavior.
export async function loadAttendancePbxCallHistory(): Promise<AttendancePbxFirstCall[]> {
  await hydratePbxState();
  return getCallHistoryCache().map((row) => ({
    agentName: row.agentName,
    firstCallAt: row.firstCallAt,
  }));
}
