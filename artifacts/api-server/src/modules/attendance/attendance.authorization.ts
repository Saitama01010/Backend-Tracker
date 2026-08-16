import { ATTENDANCE_MEMBER_ALIASES } from "../../lib/attendancePolicy.js";
import {
  canAccessAgent,
  canAccessAttendanceDepartment,
  isCanonicalUser,
} from "../../middleware/authorizationCore.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  canAccessMetricAgent,
  type AuthorizationAgentDirectory,
} from "../../lib/authorizationScope.js";

export function canAccessAttendanceMember(
  actor: AuthPayload,
  member: { name: string; department: string },
  directory: AuthorizationAgentDirectory,
): boolean {
  if (!canAccessAttendanceDepartment(actor, member.department)) return false;
  const aliases = ATTENDANCE_MEMBER_ALIASES[member.name] ?? [];
  if (!isCanonicalUser(actor)) return canAccessAgent(actor, member.name, aliases);
  return [member.name, ...aliases]
    .some((name) => canAccessMetricAgent(actor, name, directory));
}
