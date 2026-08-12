export const DEFAULT_ALLOWED_ANTHROPIC_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"] as const;

export type TrackedTeam = "retention" | "nsf" | "cs";

export interface SheetSourceConfig {
  spreadsheetId: string;
  gid: number;
}

export interface AttendanceImportSourceConfig extends SheetSourceConfig {
  department: string;
}

export interface OperationalConfig {
  businessTimeZone: string;
  staffTimeZone: string;
  attendanceShiftTimezoneCutover: string;
  attendanceImportYear: number;
  attendanceImportSources: readonly AttendanceImportSourceConfig[];
  attendanceMemberAliases: Readonly<Record<string, readonly string[]>>;
  readyModeSheet: SheetSourceConfig;
  lineTeamMap: Readonly<Record<string, TrackedTeam>>;
  trackedTeamLines: readonly string[];
  lineIds: Readonly<{
    retentionMain: string;
    onboarding: string;
    onboardingNumber: string;
    onboardingLabel: string;
  }>;
  retentionCutoverDate: string;
  dashboardSheets: Readonly<{
    oldRetention: SheetSourceConfig;
    newRetention: SheetSourceConfig;
    oldNsf: SheetSourceConfig;
    newNsf: SheetSourceConfig;
    idpHandled: SheetSourceConfig;
    idpCancelRetained: SheetSourceConfig;
  }>;
  aiModels: Readonly<{
    samia: string;
    qa: string;
    liveTransfers: string;
    onboarding: string;
  }>;
}

export class OperationalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalConfigurationError";
  }
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPREADSHEET_ID = /^[a-zA-Z0-9_-]{20,128}$/;
const DEFAULT_BUSINESS_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_STAFF_TIME_ZONE = "Africa/Cairo";

const DEFAULT_ATTENDANCE_MEMBER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "Levi Miller": ["Levi Miller", "Ahmed Ayman"],
  "Rick Miller": ["Rick Miller", "Zeiad Fouad"],
  "Jacob Stephenson": ["Jacob Stephenson", "Abdulrhman Isawi", "Adam Maxwell"],
  "Michael Belfort": ["Michael Belfort", "Nouralden"],
  "Ryan Henderson": ["Ryan Henderson", "Jacob Ahmed"],
  "Henry Hart": ["Henry Hart", "Max Francis"],
  "Jacob Xander": ["Jacob Xander", "Youssef Nady"],
  "John Marcus": ["John Marcus", "Youssef Nasser", "Youssef-John Marcus"],
};

const DEFAULT_LINE_TEAM_MAP: Readonly<Record<string, TrackedTeam>> = {
  "ahmed ayman-levi miller": "retention",
  "youssef nady-jacob xander": "cs",
  "nour-michael belfort-2900": "retention",
  "levi ob": "retention",
  "levi cs ob": "retention",
  "talia nsf": "retention",
  "talia morgan cs ob": "retention",
  "jacob ob": "cs",
  "jacob cs ob": "retention",
  "adam ob": "retention",
  "rick ob": "retention",
  "ryan ob": "retention",
  "abdlrhman-jacob stephenson": "retention",
  "zeiad fouad-zack ford": "retention",
  "mohammed ayman-max francis-2268": "retention",
  "max - ma": "retention",
};

const DEFAULT_DASHBOARD_SHEETS = {
  oldRetention: { spreadsheetId: "1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII", gid: 0 },
  newRetention: { spreadsheetId: "1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o", gid: 837_339_339 },
  oldNsf: { spreadsheetId: "16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38", gid: 0 },
  newNsf: { spreadsheetId: "11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc", gid: 0 },
  idpHandled: { spreadsheetId: "11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc", gid: 871_007_220 },
  idpCancelRetained: { spreadsheetId: "11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc", gid: 1_018_337_469 },
} as const;

const DEFAULT_ATTENDANCE_IMPORT_SOURCES: readonly AttendanceImportSourceConfig[] = [
  { spreadsheetId: "16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38", gid: 2_116_872_008, department: "CS" },
  { spreadsheetId: "1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII", gid: 655_352_634, department: "Backend" },
];

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function calendarDateIsValid(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
}

function requiredTimeZone(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!validTimeZone(value)) throw new OperationalConfigurationError(`${key} must be a valid IANA timezone.`);
  return value;
}

function configuredCalendarDate(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!calendarDateIsValid(value)) throw new OperationalConfigurationError(`${key} must be a valid YYYY-MM-DD date.`);
  return value;
}

function parseJson(raw: string | undefined, key: string): unknown {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new OperationalConfigurationError(`${key} must contain valid JSON.`);
  }
}

function validSheetSource(value: unknown, key: string): SheetSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationalConfigurationError(`${key} must be a spreadsheet source object.`);
  }
  const source = value as Record<string, unknown>;
  const spreadsheetId = typeof source["spreadsheetId"] === "string" ? source["spreadsheetId"].trim() : "";
  const gid = source["gid"];
  if (!SPREADSHEET_ID.test(spreadsheetId) || !Number.isSafeInteger(gid) || Number(gid) < 0 || Number(gid) > 2_147_483_647) {
    throw new OperationalConfigurationError(`${key} contains an invalid spreadsheetId or gid.`);
  }
  return { spreadsheetId, gid: Number(gid) };
}

function attendanceImportSources(env: NodeJS.ProcessEnv): readonly AttendanceImportSourceConfig[] {
  const configured = parseJson(env["ATTENDANCE_IMPORT_SOURCES_JSON"], "ATTENDANCE_IMPORT_SOURCES_JSON");
  if (configured === undefined) return DEFAULT_ATTENDANCE_IMPORT_SOURCES;
  if (!Array.isArray(configured) || configured.length === 0 || configured.length > 20) {
    throw new OperationalConfigurationError("ATTENDANCE_IMPORT_SOURCES_JSON must be a non-empty array with at most 20 entries.");
  }
  return configured.map((entry, index) => {
    const source = validSheetSource(entry, `ATTENDANCE_IMPORT_SOURCES_JSON[${index}]`);
    const department = typeof (entry as Record<string, unknown>)["department"] === "string"
      ? String((entry as Record<string, unknown>)["department"]).trim()
      : "";
    if (!department || department.length > 100) {
      throw new OperationalConfigurationError(`ATTENDANCE_IMPORT_SOURCES_JSON[${index}].department is invalid.`);
    }
    return { ...source, department };
  });
}

function memberAliases(env: NodeJS.ProcessEnv): Readonly<Record<string, readonly string[]>> {
  const configured = parseJson(env["ATTENDANCE_MEMBER_ALIASES_JSON"], "ATTENDANCE_MEMBER_ALIASES_JSON");
  if (configured === undefined) return DEFAULT_ATTENDANCE_MEMBER_ALIASES;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new OperationalConfigurationError("ATTENDANCE_MEMBER_ALIASES_JSON must be an object.");
  }
  const output: Record<string, readonly string[]> = {};
  for (const [canonical, aliases] of Object.entries(configured as Record<string, unknown>)) {
    if (!canonical.trim() || canonical.length > 128 || !Array.isArray(aliases) || aliases.length === 0 || aliases.length > 20
      || aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 128)) {
      throw new OperationalConfigurationError("ATTENDANCE_MEMBER_ALIASES_JSON contains an invalid name or alias list.");
    }
    output[canonical.trim()] = aliases.map((alias) => String(alias).trim());
  }
  return output;
}

function lineTeamMap(env: NodeJS.ProcessEnv): Readonly<Record<string, TrackedTeam>> {
  const configured = parseJson(env["QUO_LINE_TEAM_MAP_JSON"], "QUO_LINE_TEAM_MAP_JSON");
  if (configured === undefined) return DEFAULT_LINE_TEAM_MAP;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new OperationalConfigurationError("QUO_LINE_TEAM_MAP_JSON must be an object.");
  }
  const output: Record<string, TrackedTeam> = {};
  for (const [line, team] of Object.entries(configured as Record<string, unknown>)) {
    const normalizedLine = line.trim().toLowerCase();
    if (!normalizedLine || normalizedLine.length > 160 || !["retention", "nsf", "cs"].includes(String(team))) {
      throw new OperationalConfigurationError("QUO_LINE_TEAM_MAP_JSON contains an invalid line or team.");
    }
    output[normalizedLine] = team as TrackedTeam;
  }
  return output;
}

function dashboardSheets(env: NodeJS.ProcessEnv): OperationalConfig["dashboardSheets"] {
  const configured = parseJson(env["DASHBOARD_SHEET_SOURCES_JSON"], "DASHBOARD_SHEET_SOURCES_JSON");
  if (configured === undefined) return DEFAULT_DASHBOARD_SHEETS;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new OperationalConfigurationError("DASHBOARD_SHEET_SOURCES_JSON must be an object.");
  }
  const source = configured as Record<string, unknown>;
  return {
    oldRetention: validSheetSource(source["oldRetention"], "DASHBOARD_SHEET_SOURCES_JSON.oldRetention"),
    newRetention: validSheetSource(source["newRetention"], "DASHBOARD_SHEET_SOURCES_JSON.newRetention"),
    oldNsf: validSheetSource(source["oldNsf"], "DASHBOARD_SHEET_SOURCES_JSON.oldNsf"),
    newNsf: validSheetSource(source["newNsf"], "DASHBOARD_SHEET_SOURCES_JSON.newNsf"),
    idpHandled: validSheetSource(source["idpHandled"], "DASHBOARD_SHEET_SOURCES_JSON.idpHandled"),
    idpCancelRetained: validSheetSource(source["idpCancelRetained"], "DASHBOARD_SHEET_SOURCES_JSON.idpCancelRetained"),
  };
}

function aiModels(env: NodeJS.ProcessEnv): OperationalConfig["aiModels"] {
  const allowed = new Set((env["ANTHROPIC_MODEL_ALLOWLIST"]?.split(",").map((value) => value.trim()).filter(Boolean)
    ?? [...DEFAULT_ALLOWED_ANTHROPIC_MODELS]));
  const models = {
    samia: env["ANTHROPIC_SAMIA_MODEL"]?.trim() || "claude-sonnet-5",
    qa: env["ANTHROPIC_QA_MODEL"]?.trim() || "claude-haiku-4-5",
    liveTransfers: env["ANTHROPIC_LT_MODEL"]?.trim() || "claude-haiku-4-5",
    onboarding: env["ANTHROPIC_OB_MODEL"]?.trim() || "claude-haiku-4-5",
  };
  for (const [feature, model] of Object.entries(models)) {
    if (!/^[a-zA-Z0-9._-]{3,100}$/.test(model) || !allowed.has(model)) {
      throw new OperationalConfigurationError(`Configured ${feature} AI model is not in ANTHROPIC_MODEL_ALLOWLIST.`);
    }
  }
  return models;
}

function currentYearInTimeZone(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now));
}

function configuredIdentifier(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(value)) {
    throw new OperationalConfigurationError(`${key} contains an invalid operational identifier.`);
  }
  return value;
}

function configuredPhoneNumber(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new OperationalConfigurationError(`${key} must be an E.164 phone number.`);
  }
  return value;
}

function configuredSheetSource(
  env: NodeJS.ProcessEnv,
  idKey: string,
  gidKey: string,
  fallback: SheetSourceConfig,
): SheetSourceConfig {
  return validSheetSource({
    spreadsheetId: env[idKey]?.trim() || fallback.spreadsheetId,
    gid: env[gidKey]?.trim() ? Number(env[gidKey]) : fallback.gid,
  }, `${idKey}/${gidKey}`);
}

function configuredLabel(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!value || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OperationalConfigurationError(`${key} contains an invalid label.`);
  }
  return value;
}

export function buildOperationalConfig(env: NodeJS.ProcessEnv = process.env, now = new Date()): OperationalConfig {
  const businessTimeZone = requiredTimeZone(env, "BUSINESS_TIMEZONE", DEFAULT_BUSINESS_TIME_ZONE);
  const staffTimeZone = requiredTimeZone(env, "STAFF_TIMEZONE", DEFAULT_STAFF_TIME_ZONE);
  const rawImportYear = env["ATTENDANCE_IMPORT_YEAR"]?.trim();
  const attendanceImportYear = rawImportYear ? Number(rawImportYear) : currentYearInTimeZone(now, businessTimeZone);
  if (!Number.isSafeInteger(attendanceImportYear) || attendanceImportYear < 2000 || attendanceImportYear > 2100) {
    throw new OperationalConfigurationError("ATTENDANCE_IMPORT_YEAR must be an integer from 2000 through 2100.");
  }
  const trackedTeamLines = (env["TRACKED_TEAM_LINE_NAMES"]?.split(",").map((value) => value.trim()).filter(Boolean)
    ?? ["Retention", "CS Team", "Main NSF"]);
  if (trackedTeamLines.length === 0 || trackedTeamLines.length > 50 || trackedTeamLines.some((line) => line.length > 160)) {
    throw new OperationalConfigurationError("TRACKED_TEAM_LINE_NAMES is invalid.");
  }
  return {
    businessTimeZone,
    staffTimeZone,
    attendanceShiftTimezoneCutover: configuredCalendarDate(env, "ATTENDANCE_SHIFT_TIMEZONE_CUTOVER", "2026-08-10"),
    attendanceImportYear,
    attendanceImportSources: attendanceImportSources(env),
    attendanceMemberAliases: memberAliases(env),
    readyModeSheet: configuredSheetSource(env, "READYMODE_SHEET_ID", "READYMODE_SHEET_GID", {
      spreadsheetId: "1wjOupcSaJMl7uSvZEQsoVl2J-US-62HamjVLvKHl-fM",
      gid: 0,
    }),
    lineTeamMap: lineTeamMap(env),
    trackedTeamLines,
    lineIds: {
      retentionMain: configuredIdentifier(env, "RETENTION_MAIN_LINE_ID", "PN0uO5PSsk"),
      onboarding: configuredIdentifier(env, "ONBOARDING_LINE_ID", "PNdcJ0UEu5"),
      onboardingNumber: configuredPhoneNumber(env, "ONBOARDING_LINE_NUMBER", "+19493157441"),
      onboardingLabel: configuredLabel(env, "ONBOARDING_LINE_LABEL", "(949) 315-7441"),
    },
    retentionCutoverDate: configuredCalendarDate(env, "RETENTION_CUTOVER_DATE", "2026-05-04"),
    dashboardSheets: dashboardSheets(env),
    aiModels: aiModels(env),
  };
}

export const OPERATIONAL_CONFIG = buildOperationalConfig();

export function validateOperationalConfiguration(): OperationalConfig {
  return OPERATIONAL_CONFIG;
}

export function googleCsvUrl(source: SheetSourceConfig): string {
  return `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/export?format=csv&gid=${source.gid}`;
}
