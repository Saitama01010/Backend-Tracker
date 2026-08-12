import { pgTable, text, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const phoneCallsTable = pgTable(
  "phone_calls",
  {
    id: text("id").primaryKey(),
    lineId: text("line_id").notNull(),
    lineName: text("line_name").notNull(),
    lineTeam: text("line_team").notNull(),
    agentId: text("agent_id"),
    agentName: text("agent_name"),
    participant: text("participant").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull(),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    postAnswerSeconds: integer("post_answer_seconds"),
    ringDurationSeconds: integer("ring_duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("phone_calls_line_created").on(t.lineId, t.createdAt),
    index("phone_calls_agent_created").on(t.agentId, t.createdAt),
    index("phone_calls_team_created").on(t.lineTeam, t.createdAt),
    index("phone_calls_created_at_idx").on(t.createdAt),
    index("phone_calls_attendance_created_agent_idx")
      .on(t.createdAt, t.agentName)
      .where(sql`${t.agentName} is not null and (${t.direction} = 'outgoing' or (${t.direction} = 'incoming' and ${t.status} = 'completed'))`),
    index("phone_calls_participant_created_idx").on(t.participant, t.createdAt.desc()),
    index("phone_calls_missed_line_created_idx")
      .on(t.lineName, t.createdAt)
      .where(sql`${t.direction} = 'incoming' and ${t.status} in ('no-answer', 'voicemail', 'missed', 'voicemail-brief')`),
    index("phone_calls_live_synced_idx")
      .on(t.syncedAt)
      .where(sql`${t.status} = 'in-progress'`),
  ],
);

export type PhoneCall = typeof phoneCallsTable.$inferSelect;
export type InsertPhoneCall = typeof phoneCallsTable.$inferInsert;

export const phoneSyncStateTable = pgTable("phone_sync_state", {
  id: text("id").primaryKey().default("singleton"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  isSyncing: boolean("is_syncing").notNull().default(false),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
