import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const backgroundJobsTable = pgTable("background_jobs", {
  id: serial("id").primaryKey(),
  jobType: text("job_type").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("queued"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb("result").$type<Record<string, unknown> | null>(),
  priority: integer("priority").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  requestedByUserId: integer("requested_by_user_id"),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("background_jobs_idempotency_uidx").on(table.idempotencyKey),
  index("background_jobs_claim_idx").on(table.status, table.runAfter, table.priority),
  index("background_jobs_type_status_idx").on(table.jobType, table.status, table.updatedAt),
  index("background_jobs_lease_idx").on(table.leaseExpiresAt),
  check(
    "background_jobs_status_check",
    sql`${table.status} in ('queued', 'running', 'retry', 'completed', 'failed')`,
  ),
  check("background_jobs_attempts_check", sql`${table.attempts} >= 0 and ${table.maxAttempts} between 1 and 20`),
]);

export const durableRuntimeStateTable = pgTable("durable_runtime_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (table) => [
  index("durable_runtime_state_expires_idx").on(table.expiresAt),
]);

export type BackgroundJob = typeof backgroundJobsTable.$inferSelect;
export type InsertBackgroundJob = typeof backgroundJobsTable.$inferInsert;
export type DurableRuntimeState = typeof durableRuntimeStateTable.$inferSelect;
