import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { portalUsersTable, ALL_PERMISSIONS, attendanceMembersTable, attendanceRecordsTable } from "@workspace/db/schema";
import { count, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const isProduction = () => process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1";

function dashboardPassword(): string {
  const value = process.env["DASHBOARD_PASSWORD"];
  if (value) return value;
  throw new Error(isProduction()
    ? "DASHBOARD_PASSWORD is required in production."
    : "DASHBOARD_PASSWORD is required before seeding or updating the admin user.");
}

async function seedAdminUser() {
  const [{ value }] = await db.select({ value: count() }).from(portalUsersTable);
  if (value === 0) {
    const hash = await bcrypt.hash(dashboardPassword(), 10);
    await db.insert(portalUsersTable).values({
      username: "admin",
      passwordHash: hash,
      role: "admin",
      permissions: JSON.stringify([...ALL_PERMISSIONS]),
      active: true,
    });
    logger.info("Seeded default admin user (username: admin)");
    return;
  }

  if (process.env["RESET_ADMIN_PASSWORD_ON_BOOT"] === "true") {
    const hash = await bcrypt.hash(dashboardPassword(), 10);
    const [updated] = await db
      .update(portalUsersTable)
      .set({ passwordHash: hash })
      .where(eq(portalUsersTable.username, "admin"))
      .returning({ id: portalUsersTable.id });
    if (updated) logger.info("Updated admin password from DASHBOARD_PASSWORD because RESET_ADMIN_PASSWORD_ON_BOOT=true");
  }
}

async function seedAttendanceMembers() {
  const [{ value }] = await db.select({ value: count() }).from(attendanceMembersTable);
  if (value > 0) return;

  const members = [
    { name: "Estella Cruz",                   shift: "8", department: "NSF",       active: true },
    { name: "Katie Miller",                    shift: "8", department: "NSF",       active: true },
    { name: "Ellie Moser",                     shift: "7", department: "NSF",       active: true },
    { name: "Jenny Morgan",                    shift: "6", department: "NSF",       active: true },
    { name: "Talia Morgan",                    shift: "6", department: "NSF",       active: true },
    { name: "Alex Cruz",                       shift: "5", department: "NSF",       active: true },
    { name: "Rika Hart",                       shift: "4", department: "NSF",       active: true },
    { name: "Austin White",                    shift: "4", department: "NSF",       active: true },
    { name: "Youssef Nady-Jacob Xander",       shift: "8", department: "Retention", active: true },
    { name: "Zeiad Fouad-Zack Ford",           shift: "6", department: "Retention", active: true },
    { name: "Abdlrhman-Jacob Stephenson",      shift: "5", department: "Retention", active: true },
    { name: "Nour-Michael Belfort-2900",       shift: "5", department: "Retention", active: true },
    { name: "Ahmed Ayman-Levi Miller",         shift: "4", department: "Retention", active: true },
    { name: "Jacob Ahmed",                     shift: "4", department: "Retention", active: true },
    { name: "Mohammed Ayman-Max Francis-2268", shift: "4", department: "Retention", active: true },
    { name: "Leo Carter",                      shift: "5", department: "CS",        active: true },
    { name: "Nora Adam",                       shift: "6", department: "CS",        active: true },
    { name: "Carla Bennet",                    shift: "8", department: "CS",        active: true },
  ];

  await db.insert(attendanceMembersTable).values(members);
  logger.info({ count: members.length }, "Seeded attendance members");
}

async function seedAttendanceRecords() {
  const [{ value }] = await db.select({ value: count() }).from(attendanceRecordsTable);
  if (value > 0) return;

  const records = [
    { memberId: 9,  date: "2026-04-16", status: "in" },
    { memberId: 10, date: "2026-04-16", status: "in" },
    { memberId: 11, date: "2026-04-16", status: "in" },
    { memberId: 14, date: "2026-04-16", status: "in" },
    { memberId: 9,  date: "2026-04-17", status: "in" },
    { memberId: 10, date: "2026-04-17", status: "in" },
    { memberId: 11, date: "2026-04-17", status: "in" },
    { memberId: 14, date: "2026-04-17", status: "in" },
    { memberId: 14, date: "2026-04-18", status: "in" },
    { memberId: 1,  date: "2026-04-20", status: "in" },
    { memberId: 2,  date: "2026-04-20", status: "in" },
    { memberId: 3,  date: "2026-04-20", status: "in" },
    { memberId: 4,  date: "2026-04-20", status: "in" },
    { memberId: 5,  date: "2026-04-20", status: "in" },
    { memberId: 6,  date: "2026-04-20", status: "in" },
    { memberId: 7,  date: "2026-04-20", status: "in" },
    { memberId: 8,  date: "2026-04-20", status: "in" },
    { memberId: 10, date: "2026-04-20", status: "in" },
    { memberId: 11, date: "2026-04-20", status: "in" },
    { memberId: 13, date: "2026-04-20", status: "pto" },
    { memberId: 14, date: "2026-04-20", status: "in" },
    { memberId: 1,  date: "2026-04-21", status: "in" },
    { memberId: 2,  date: "2026-04-21", status: "in" },
    { memberId: 3,  date: "2026-04-21", status: "in" },
    { memberId: 4,  date: "2026-04-21", status: "in" },
    { memberId: 5,  date: "2026-04-21", status: "in" },
    { memberId: 6,  date: "2026-04-21", status: "in" },
    { memberId: 7,  date: "2026-04-21", status: "in" },
    { memberId: 8,  date: "2026-04-21", status: "in" },
    { memberId: 10, date: "2026-04-21", status: "in" },
    { memberId: 11, date: "2026-04-21", status: "in" },
    { memberId: 13, date: "2026-04-21", status: "pto" },
    { memberId: 14, date: "2026-04-21", status: "in" },
    { memberId: 1,  date: "2026-04-22", status: "in" },
    { memberId: 2,  date: "2026-04-22", status: "in" },
    { memberId: 3,  date: "2026-04-22", status: "in" },
    { memberId: 4,  date: "2026-04-22", status: "in" },
    { memberId: 5,  date: "2026-04-22", status: "in" },
    { memberId: 6,  date: "2026-04-22", status: "off" },
    { memberId: 7,  date: "2026-04-22", status: "in" },
    { memberId: 8,  date: "2026-04-22", status: "in" },
    { memberId: 10, date: "2026-04-22", status: "in" },
    { memberId: 11, date: "2026-04-22", status: "in" },
    { memberId: 13, date: "2026-04-22", status: "pto" },
    { memberId: 14, date: "2026-04-22", status: "in" },
    { memberId: 1,  date: "2026-04-23", status: "in" },
    { memberId: 2,  date: "2026-04-23", status: "in" },
    { memberId: 3,  date: "2026-04-23", status: "in" },
    { memberId: 4,  date: "2026-04-23", status: "in" },
    { memberId: 5,  date: "2026-04-23", status: "in" },
    { memberId: 6,  date: "2026-04-23", status: "off" },
    { memberId: 7,  date: "2026-04-23", status: "in" },
    { memberId: 8,  date: "2026-04-23", status: "off" },
    { memberId: 9,  date: "2026-04-23", status: "in" },
    { memberId: 10, date: "2026-04-23", status: "in" },
    { memberId: 11, date: "2026-04-23", status: "in" },
    { memberId: 13, date: "2026-04-23", status: "pto" },
    { memberId: 14, date: "2026-04-23", status: "in" },
    { memberId: 1,  date: "2026-04-24", status: "in" },
    { memberId: 3,  date: "2026-04-24", status: "in" },
    { memberId: 4,  date: "2026-04-24", status: "in" },
    { memberId: 5,  date: "2026-04-24", status: "in" },
    { memberId: 6,  date: "2026-04-24", status: "in" },
    { memberId: 8,  date: "2026-04-24", status: "off" },
    { memberId: 9,  date: "2026-04-24", status: "off" },
    { memberId: 10, date: "2026-04-24", status: "in" },
    { memberId: 11, date: "2026-04-24", status: "in" },
    { memberId: 12, date: "2026-04-24", status: "in" },
    { memberId: 13, date: "2026-04-24", status: "pto" },
    { memberId: 14, date: "2026-04-24", status: "in" },
    { memberId: 1,  date: "2026-04-25", status: "in" },
    { memberId: 1,  date: "2026-04-27", status: "in" },
    { memberId: 2,  date: "2026-04-27", status: "in" },
    { memberId: 3,  date: "2026-04-27", status: "in" },
    { memberId: 4,  date: "2026-04-27", status: "in" },
    { memberId: 5,  date: "2026-04-27", status: "in" },
    { memberId: 6,  date: "2026-04-27", status: "in" },
    { memberId: 7,  date: "2026-04-27", status: "in" },
    { memberId: 8,  date: "2026-04-27", status: "off" },
    { memberId: 9,  date: "2026-04-27", status: "in" },
    { memberId: 10, date: "2026-04-27", status: "in" },
    { memberId: 11, date: "2026-04-27", status: "off" },
    { memberId: 12, date: "2026-04-27", status: "in" },
    { memberId: 13, date: "2026-04-27", status: "in" },
    { memberId: 14, date: "2026-04-27", status: "in" },
    { memberId: 1,  date: "2026-04-28", status: "in" },
    { memberId: 2,  date: "2026-04-28", status: "in" },
    { memberId: 3,  date: "2026-04-28", status: "in" },
    { memberId: 4,  date: "2026-04-28", status: "in" },
    { memberId: 5,  date: "2026-04-28", status: "in" },
    { memberId: 6,  date: "2026-04-28", status: "in" },
    { memberId: 7,  date: "2026-04-28", status: "in" },
    { memberId: 8,  date: "2026-04-28", status: "in" },
    { memberId: 9,  date: "2026-04-28", status: "in" },
    { memberId: 10, date: "2026-04-28", status: "in" },
    { memberId: 11, date: "2026-04-28", status: "in" },
    { memberId: 12, date: "2026-04-28", status: "in" },
    { memberId: 13, date: "2026-04-28", status: "in" },
    { memberId: 14, date: "2026-04-28", status: "in" },
    { memberId: 15, date: "2026-04-28", status: "in" },
    { memberId: 1,  date: "2026-04-29", status: "in" },
    { memberId: 2,  date: "2026-04-29", status: "in" },
    { memberId: 3,  date: "2026-04-29", status: "in" },
    { memberId: 4,  date: "2026-04-29", status: "in" },
    { memberId: 5,  date: "2026-04-29", status: "in" },
    { memberId: 6,  date: "2026-04-29", status: "in" },
    { memberId: 7,  date: "2026-04-29", status: "in" },
    { memberId: 8,  date: "2026-04-29", status: "in" },
    { memberId: 9,  date: "2026-04-29", status: "in" },
    { memberId: 10, date: "2026-04-29", status: "in" },
    { memberId: 11, date: "2026-04-29", status: "in" },
    { memberId: 12, date: "2026-04-29", status: "in" },
    { memberId: 13, date: "2026-04-29", status: "in" },
    { memberId: 14, date: "2026-04-29", status: "in" },
    { memberId: 15, date: "2026-04-29", status: "in" },
    { memberId: 1,  date: "2026-04-30", status: "in" },
    { memberId: 2,  date: "2026-04-30", status: "in" },
    { memberId: 3,  date: "2026-04-30", status: "in" },
    { memberId: 4,  date: "2026-04-30", status: "in" },
    { memberId: 5,  date: "2026-04-30", status: "in" },
    { memberId: 6,  date: "2026-04-30", status: "in" },
    { memberId: 7,  date: "2026-04-30", status: "in" },
    { memberId: 8,  date: "2026-04-30", status: "in" },
    { memberId: 9,  date: "2026-04-30", status: "in" },
    { memberId: 10, date: "2026-04-30", status: "in" },
    { memberId: 11, date: "2026-04-30", status: "in" },
    { memberId: 12, date: "2026-04-30", status: "in" },
    { memberId: 13, date: "2026-04-30", status: "in" },
    { memberId: 14, date: "2026-04-30", status: "in" },
    { memberId: 15, date: "2026-04-30", status: "off" },
    { memberId: 1,  date: "2026-05-01", status: "in" },
    { memberId: 2,  date: "2026-05-01", status: "in" },
    { memberId: 3,  date: "2026-05-01", status: "in" },
    { memberId: 4,  date: "2026-05-01", status: "in" },
    { memberId: 5,  date: "2026-05-01", status: "in" },
    { memberId: 7,  date: "2026-05-01", status: "off" },
    { memberId: 8,  date: "2026-05-01", status: "in" },
    { memberId: 9,  date: "2026-05-01", status: "off" },
    { memberId: 10, date: "2026-05-01", status: "in" },
    { memberId: 11, date: "2026-05-01", status: "off" },
    { memberId: 12, date: "2026-05-01", status: "in" },
    { memberId: 13, date: "2026-05-01", status: "in" },
    { memberId: 14, date: "2026-05-01", status: "in" },
    { memberId: 15, date: "2026-05-01", status: "in" },
    { memberId: 11, date: "2026-05-02", status: "in" },
    { memberId: 12, date: "2026-05-02", status: "in" },
    { memberId: 15, date: "2026-05-02", status: "in" },
    { memberId: 1,  date: "2026-05-04", status: "in" },
    { memberId: 2,  date: "2026-05-04", status: "in" },
    { memberId: 3,  date: "2026-05-04", status: "in" },
    { memberId: 4,  date: "2026-05-04", status: "off" },
    { memberId: 5,  date: "2026-05-04", status: "in" },
    { memberId: 7,  date: "2026-05-04", status: "in" },
    { memberId: 8,  date: "2026-05-04", status: "in" },
    { memberId: 9,  date: "2026-05-04", status: "late" },
    { memberId: 10, date: "2026-05-04", status: "late" },
    { memberId: 11, date: "2026-05-04", status: "in" },
    { memberId: 12, date: "2026-05-04", status: "in" },
    { memberId: 13, date: "2026-05-04", status: "in" },
    { memberId: 14, date: "2026-05-04", status: "in" },
    { memberId: 15, date: "2026-05-04", status: "in" },
    { memberId: 7,  date: "2026-05-05", status: "in" },
    { memberId: 8,  date: "2026-05-05", status: "in" },
    { memberId: 13, date: "2026-05-05", status: "in" },
    { memberId: 14, date: "2026-05-05", status: "in" },
    { memberId: 16, date: "2026-05-05", status: "in" },
  ];

  await db.insert(attendanceRecordsTable).values(records);
  logger.info({ count: records.length }, "Seeded attendance records");
}

async function clearTeamAccessRestrictions() {
  // Remove team locks from specific users so they see all data.
  const targets = ["rick miller", "retention"];
  for (const username of targets) {
    const [updated] = await db
      .update(portalUsersTable)
      .set({ teamAccess: null })
      .where(eq(portalUsersTable.username, username))
      .returning({ id: portalUsersTable.id, username: portalUsersTable.username });
    if (updated) logger.info({ username }, "startup: cleared teamAccess restriction");
  }
}

async function deactivateFormerUsers() {
  // Deactivate accounts for users who are no longer with the team.
  const targets = ["retetnion", "retention"];
  for (const username of targets) {
    const [updated] = await db
      .update(portalUsersTable)
      .set({ active: false })
      .where(eq(portalUsersTable.username, username))
      .returning({ id: portalUsersTable.id, username: portalUsersTable.username });
    if (updated) logger.info({ username }, "startup: deactivated former user account");
  }
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  await seedAdminUser();
  if (process.env["RUN_LEGACY_USER_BOOT_FIXUPS"] === "true") {
    await clearTeamAccessRestrictions();
    await deactivateFormerUsers();
  }
  await seedAttendanceMembers();
  await seedAttendanceRecords();
});
