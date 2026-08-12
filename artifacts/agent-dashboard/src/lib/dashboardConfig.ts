export interface DashboardSheetSource {
  spreadsheetId: string;
  gid: string;
}

export interface DashboardOperationalConfig {
  businessTimeZone: string;
  staffTimeZone: string;
  timezoneCorrectnessCutover: string;
  retentionCutoverDate: string;
  sheets: Readonly<{
    oldRetention: DashboardSheetSource;
    newRetention: DashboardSheetSource;
    oldNsf: DashboardSheetSource;
    newNsf: DashboardSheetSource;
    idpHandled: DashboardSheetSource;
    idpCancelRetained: DashboardSheetSource;
  }>;
}

const SPREADSHEET_ID = /^[a-zA-Z0-9_-]{20,128}$/;
const GID = /^(?:0|[1-9]\d{0,9})$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function configuredTimeZone(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!validTimeZone(value)) throw new Error(`${key} must be a valid IANA timezone.`);
  return value;
}

function configuredDate(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!CALENDAR_DATE.test(value)) throw new Error(`${key} must be YYYY-MM-DD.`);
  const [year, month, day] = value.split("-").map(Number);
  if (new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !== value) {
    throw new Error(`${key} must be a real calendar date.`);
  }
  return value;
}

function sheet(
  env: Record<string, string | undefined>,
  idKey: string,
  gidKey: string,
  defaultId: string,
  defaultGid: string,
): DashboardSheetSource {
  const spreadsheetId = env[idKey]?.trim() || defaultId;
  const gid = env[gidKey]?.trim() || defaultGid;
  if (!SPREADSHEET_ID.test(spreadsheetId) || !GID.test(gid) || Number(gid) > 2_147_483_647) {
    throw new Error(`${idKey}/${gidKey} contains an invalid spreadsheet source.`);
  }
  return { spreadsheetId, gid };
}

export function buildDashboardOperationalConfig(
  env: Record<string, string | undefined> = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}),
): DashboardOperationalConfig {
  const oldRetentionId = "1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII";
  const newRetentionId = "1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o";
  const oldNsfId = "16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38";
  const newNsfId = "11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc";
  return {
    businessTimeZone: configuredTimeZone(env, "VITE_BUSINESS_TIMEZONE", "America/Los_Angeles"),
    staffTimeZone: configuredTimeZone(env, "VITE_STAFF_TIMEZONE", "Africa/Cairo"),
    timezoneCorrectnessCutover: configuredDate(env, "VITE_TIMEZONE_CORRECTNESS_CUTOVER", "2026-08-10"),
    retentionCutoverDate: configuredDate(env, "VITE_RETENTION_CUTOVER_DATE", "2026-05-04"),
    sheets: {
      oldRetention: sheet(env, "VITE_OLD_RETENTION_SHEET_ID", "VITE_OLD_RETENTION_SHEET_GID", oldRetentionId, "0"),
      newRetention: sheet(env, "VITE_NEW_RETENTION_SHEET_ID", "VITE_NEW_RETENTION_SHEET_GID", newRetentionId, "837339339"),
      oldNsf: sheet(env, "VITE_OLD_NSF_SHEET_ID", "VITE_OLD_NSF_SHEET_GID", oldNsfId, "0"),
      newNsf: sheet(env, "VITE_NEW_NSF_SHEET_ID", "VITE_NEW_NSF_SHEET_GID", newNsfId, "0"),
      idpHandled: sheet(env, "VITE_IDP_HANDLED_SHEET_ID", "VITE_IDP_HANDLED_SHEET_GID", newNsfId, "871007220"),
      idpCancelRetained: sheet(env, "VITE_IDP_CANCEL_RETAINED_SHEET_ID", "VITE_IDP_CANCEL_RETAINED_SHEET_GID", newNsfId, "1018337469"),
    },
  };
}

export const DASHBOARD_OPERATIONAL_CONFIG = buildDashboardOperationalConfig();

export function googleCsvUrl(source: DashboardSheetSource): string {
  return `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/export?format=csv&gid=${source.gid}`;
}
