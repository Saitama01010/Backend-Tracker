import { pgTable, serial, text, integer, timestamp, unique, index } from "drizzle-orm/pg-core";

// Operator-uploaded ReadyMode daily report rows, one per (agent, day). This is
// the highest-priority source for /api/readymode/stats — it overrides both the
// bundled attached-asset CSV and the live Google Sheet on overlapping days, so
// a fresh upload always wins.
export const readymodeUploadsTable = pgTable(
  "readymode_uploads",
  {
    id:         serial("id").primaryKey(),
    agentName:  text("agent_name").notNull(),
    statDate:   text("stat_date").notNull(), // ISO YYYY-MM-DD
    dialed:     integer("dialed").notNull().default(0),
    talkSecs:   integer("talk_secs").notNull().default(0),
    uploadedBy: text("uploaded_by").notNull().default("unknown"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("readymode_uploads_agent_date").on(t.agentName, t.statDate),
    index("readymode_uploads_date").on(t.statDate),
  ],
);

export type ReadymodeUpload       = typeof readymodeUploadsTable.$inferSelect;
export type InsertReadymodeUpload = typeof readymodeUploadsTable.$inferInsert;
