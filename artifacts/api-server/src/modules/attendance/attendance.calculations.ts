import { ATTENDANCE_MEMBER_ALIASES } from "../../lib/attendancePolicy.js";

export function lateNote(minsLate: number): string {
  if (minsLate < 60) return `late ${minsLate}min`;
  const hours = Math.floor(minsLate / 60);
  const minutes = minsLate % 60;
  return minutes > 0 ? `late ${hours}h ${minutes}min` : `late ${hours}h`;
}

export function resolveFirstCall(
  member: { name: string },
  dayStartUtc: Date,
  shiftStartUtc: Date | null,
  pbxFirstCalls: ReadonlyMap<string, Date>,
  quoFirstCalls: ReadonlyMap<string, Date>,
): Date | null {
  if (!shiftStartUtc) return null;
  const agentNames: readonly string[] = ATTENDANCE_MEMBER_ALIASES[member.name]
    ?? [member.name.split("-")[0]!.trim(), member.name];
  let firstCallAt: Date | null = null;
  for (const nameLower of agentNames.map((name) => name.trim().toLowerCase())) {
    const pbx = pbxFirstCalls.get(nameLower);
    if (pbx && pbx >= dayStartUtc && (!firstCallAt || pbx < firstCallAt)) firstCallAt = pbx;
    const quo = quoFirstCalls.get(nameLower);
    if (quo && quo >= dayStartUtc && (!firstCallAt || quo < firstCallAt)) firstCallAt = quo;
  }
  return firstCallAt;
}

export function pacificDisplayTime(instant: Date): string {
  const display = instant.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const offset = instant.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  });
  const timezone = offset.match(/P[SD]T/)?.[0] ?? "PT";
  return `${display} ${timezone}`;
}
