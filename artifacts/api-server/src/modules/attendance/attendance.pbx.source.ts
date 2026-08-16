import { getCallHistoryCache, hydrateVosState } from "../../routes/vos.js";

export interface AttendancePbxFirstCall {
  agentName: string;
  firstCallAt: string | null;
}

// Compatibility adapter over the existing shared PBX cache. Moving that cache
// itself belongs to the later VoS domain slice; this preserves its exact
// hydration, staleness, and provider-call behavior for Attendance.
export async function loadAttendancePbxCallHistory(): Promise<AttendancePbxFirstCall[]> {
  await hydrateVosState();
  return getCallHistoryCache().map((row) => ({
    agentName: row.agentName,
    firstCallAt: row.firstCallAt,
  }));
}
