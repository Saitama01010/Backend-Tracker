import { Router } from "express";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { addAttendanceCalendarDays, attendanceDate } from "../lib/attendancePolicy.js";
import {
  validateOptionalWorkflowRange,
  validateWorkflowCalendarDate,
} from "../lib/sensitiveWorkflowPolicy.js";
import {
  AttendanceImportSourceError,
  AttendanceServiceError,
  attendanceService,
} from "../modules/attendance/attendance.service.js";
import { attendanceCallsService } from "../modules/attendance/attendance.calls.service.js";
import type {
  AttendanceBatchRecordInput,
  AttendanceMemberPatch,
} from "../modules/attendance/attendance.types.js";

export { parseAttendanceImportDate } from "../integrations/googleSheets/attendanceImport.js";
export { lateNote, resolveFirstCall } from "../modules/attendance/attendance.calculations.js";

const router = Router();
router.use("/attendance", requireAuth);

router.get("/attendance", async (req, res) => {
  try {
    const to = (req.query["to"] as string) || attendanceDate();
    const from = (req.query["from"] as string) || addAttendanceCalendarDays(to, -30);
    const requestedRange = validateOptionalWorkflowRange(from, to);
    if (!requestedRange.ok) {
      res.status(400).json({ error: requestedRange.error });
      return;
    }
    const includeInactive = req.query["includeInactive"] === "true";
    res.json(await attendanceService.getDashboard({ actor: req.user!, from, to, includeInactive }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance GET error");
    res.status(500).json({ error: "Unable to load attendance." });
  }
});

router.post("/attendance/members", requireAuth, requirePermission("manage_members"), async (req, res) => {
  try {
    const { name, shift, shiftHours, department } = req.body as {
      name: string;
      shift?: string;
      shiftHours?: string;
      department?: string;
    };
    if (!name?.trim()) {
      res.status(400).json({ error: "name required" });
      return;
    }
    res.json(await attendanceService.createMember({
      actor: req.user!,
      member: { name, shift, shiftHours, department },
    }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance POST member error");
    res.status(500).json({ error: "Unable to create attendance member." });
  }
});

router.patch("/attendance/members/:id", requireAuth, requirePermission("manage_members"), async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid attendance member id." });
      return;
    }
    res.json(await attendanceService.updateMember({
      actor: req.user!,
      id,
      patch: req.body as AttendanceMemberPatch,
    }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance PATCH member error");
    res.status(500).json({ error: "Unable to update attendance member." });
  }
});

router.put("/attendance/record", requireAuth, requirePermission("edit_attendance"), async (req, res) => {
  try {
    const { memberId, date, status, note, coaching } = req.body as {
      memberId: number;
      date: string;
      status: string;
      note?: string | null;
      coaching?: boolean;
    };
    if (!memberId || !validateWorkflowCalendarDate(date)) {
      res.status(400).json({ error: "memberId and date required" });
      return;
    }
    res.json(await attendanceService.updateRecord({
      actor: req.user!,
      record: { memberId, date, status, note, coaching },
    }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance PUT record error");
    const invalid = (error as Error).message.includes("invalid");
    res.status(invalid ? 400 : 500).json({
      error: invalid ? "Invalid attendance record." : "Unable to update attendance.",
    });
  }
});

router.post("/attendance/import", requireAuth, requirePermission("manage_members"), async (req, res) => {
  try {
    res.json(await attendanceService.importAttendance(req.user!));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance import error");
    const upstreamFailure = error instanceof AttendanceImportSourceError;
    res.status(upstreamFailure ? 502 : 500).json({
      error: upstreamFailure
        ? "Attendance import source is unavailable or invalid."
        : "Unable to import attendance.",
    });
  }
});

router.get("/attendance/call-logs", async (req, res) => {
  try {
    const date = ((req.query["date"] as string) || attendanceDate()).trim();
    if (!validateWorkflowCalendarDate(date)) {
      res.status(400).json({ error: "Invalid attendance date." });
      return;
    }
    res.json(await attendanceCallsService.getCallLogs({ actor: req.user!, date }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance call-logs error");
    res.status(500).json({ error: "Unable to load attendance call logs." });
  }
});

router.post("/attendance/set", requireAuth, requirePermission("edit_attendance"), async (req, res) => {
  try {
    const { records, force = false, confirmed = false } = req.body as {
      records: AttendanceBatchRecordInput[];
      force?: boolean;
      confirmed?: boolean;
    };
    if (!Array.isArray(records) || records.length === 0) {
      res.status(400).json({ error: "records array required" });
      return;
    }
    if (records.length > 1 && !confirmed) {
      res.status(409).json({ error: "Bulk attendance changes require confirmed=true" });
      return;
    }
    if (records.some((record) => !validateWorkflowCalendarDate(record.date))) {
      res.status(400).json({ error: "Invalid attendance date." });
      return;
    }
    res.json(await attendanceService.setRecords({
      actor: req.user!,
      batch: { records, force },
    }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance set error");
    const invalid = (error as Error).message.includes("invalid");
    res.status(invalid ? 400 : 500).json({
      error: invalid ? "Invalid attendance record." : "Unable to set attendance.",
    });
  }
});

router.post("/attendance/auto-mark", requireAuth, requirePermission("edit_attendance"), async (req, res) => {
  try {
    const date = ((req.body as { date?: string })?.date ?? attendanceDate()).trim();
    if (!validateWorkflowCalendarDate(date)) {
      res.status(400).json({ error: "Invalid attendance date." });
      return;
    }
    res.json(await attendanceCallsService.autoMark({ actor: req.user!, date }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "attendance auto-mark error");
    res.status(500).json({ error: "Unable to auto-mark attendance." });
  }
});

router.get("/attendance/agent-contacts", async (req, res) => {
  try {
    const rawAgent = req.query["agent"];
    const rawDate = req.query["date"];
    if (typeof rawAgent !== "string" || (rawDate !== undefined && typeof rawDate !== "string")) {
      res.status(400).json({ error: "Invalid agent or attendance date." });
      return;
    }
    const agent = rawAgent.trim();
    const date = rawDate?.trim() ?? "";
    if (!agent) {
      res.status(400).json({ error: "agent param is required" });
      return;
    }
    if (agent.length > 128 || (date && !validateWorkflowCalendarDate(date))) {
      res.status(400).json({ error: "Invalid agent or attendance date." });
      return;
    }
    res.json(await attendanceCallsService.getAgentContacts({ actor: req.user!, agent, date }));
  } catch (error) {
    if (error instanceof AttendanceServiceError) {
      res.status(error.status).json(error.payload);
      return;
    }
    req.log.error(error, "agent-contacts error");
    res.status(500).json({ error: "Unable to load agent contacts." });
  }
});

export default router;
