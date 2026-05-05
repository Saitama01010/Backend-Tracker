import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { portalUsersTable, ALL_PERMISSIONS, attendanceMembersTable } from "@workspace/db/schema";
import { count } from "drizzle-orm";
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

async function seedAdminUser() {
  const [{ value }] = await db.select({ value: count() }).from(portalUsersTable);
  if (value === 0) {
    const defaultPass = process.env["DASHBOARD_PASSWORD"] ?? "tracker2026";
    const hash = await bcrypt.hash(defaultPass, 10);
    await db.insert(portalUsersTable).values({
      username: "admin",
      passwordHash: hash,
      role: "admin",
      permissions: JSON.stringify([...ALL_PERMISSIONS]),
      active: true,
    });
    logger.info("Seeded default admin user (username: admin)");
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

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  await seedAdminUser();
  await seedAttendanceMembers();
});
