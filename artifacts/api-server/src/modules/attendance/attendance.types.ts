export interface AttendanceMemberInput {
  name: string;
  shift?: string;
  shiftHours?: string;
  department?: string;
}

export type AttendanceMemberPatch = Partial<{
  name: string;
  shift: string;
  shiftHours: string;
  department: string;
  active: boolean;
}>;

export interface AttendanceRecordInput {
  memberId: number;
  date: string;
  status: string;
  note?: string | null;
  coaching?: boolean;
}

export interface AttendanceBatchRecordInput {
  date: string;
  memberId?: number;
  memberName?: string;
  status: string;
  note?: string;
  coaching?: boolean;
}

export interface AttendanceBatchInput {
  records: AttendanceBatchRecordInput[];
  force: boolean;
}
