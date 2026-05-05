import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { portalUsersTable, ALL_PERMISSIONS } from "@workspace/db/schema";
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

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  await seedAdminUser();
});
