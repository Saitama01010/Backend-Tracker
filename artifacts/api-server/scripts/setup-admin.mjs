import bcrypt from "bcryptjs";
import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const { Pool } = pg;

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), "../../.env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatePassword(password) {
  if (password.length < 15 || !password.trim() || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("ADMIN_PASSWORD must be at least 15 characters and no more than 72 UTF-8 bytes");
  }
}

function normalizeEmail(value) {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("ADMIN_EMAIL must be a valid email address");
  }
  return normalized;
}

function databaseUrls() {
  const target = (process.env.ADMIN_SETUP_DATABASES ?? "active").trim().toLowerCase();
  const urls = [
    ["OLD_DATABASE_URL", process.env.OLD_DATABASE_URL],
    ["DATABASE_URL", process.env.DATABASE_URL],
  ].filter((entry) => Boolean(entry[1]));

  if (target === "all") return urls;
  const active = process.env.DATABASE_URL
    ? ["DATABASE_URL", process.env.DATABASE_URL]
    : ["OLD_DATABASE_URL", process.env.OLD_DATABASE_URL];
  if (!active[1]) throw new Error("DATABASE_URL or OLD_DATABASE_URL is required");
  return [active];
}

async function upsertAdmin(label, connectionString, username, email, passwordHash) {
  const pool = new Pool({ connectionString });
  try {
    const result = await pool.query(
      `
        insert into portal_users (
          username,
          email,
          email_normalized,
          password_hash,
          password_policy_version,
          password_changed_at,
          role,
          permissions,
          team_access,
          allowed_tabs,
          allowed_agents,
          allowed_sub_tabs,
          lock_to_today,
          samia_curse,
          hide_backend_stats,
          active
        )
        values ($1, $2, $2, $3, 1, now(), 'admin', $4, null, null, null, null, false, false, false, true)
        on conflict (username) do update set
          email = excluded.email,
          email_normalized = excluded.email_normalized,
          password_hash = excluded.password_hash,
          password_policy_version = 1,
          password_changed_at = now(),
          role = 'admin',
          permissions = excluded.permissions,
          team_access = null,
          allowed_tabs = null,
          allowed_agents = null,
          allowed_sub_tabs = null,
          lock_to_today = false,
          hide_backend_stats = false,
          active = true
        returning id, username, role, active
      `,
      [
        username,
        email,
        passwordHash,
        JSON.stringify([
          "view_metrics",
          "view_attendance",
          "edit_attendance",
          "manage_members",
          "view_missed_tables",
        ]),
      ],
    );
    const sessionTable = await pool.query("select to_regclass('public.auth_sessions') as table_name");
    if (sessionTable.rows[0]?.table_name && result.rows[0]?.id) {
      await pool.query("delete from auth_sessions where user_id = $1", [result.rows[0].id]);
    }
    console.log(`Admin user is ready in ${label}.`);
  } finally {
    await pool.end();
  }
}

loadEnvFile();

const username = requiredEnv("ADMIN_USERNAME").toLowerCase();
const email = normalizeEmail(requiredEnv("ADMIN_EMAIL"));
const password = requiredEnv("ADMIN_PASSWORD");
validatePassword(password);
const passwordHash = await bcrypt.hash(password, 10);

for (const [label, connectionString] of databaseUrls()) {
  await upsertAdmin(label, connectionString, username, email, passwordHash);
}
