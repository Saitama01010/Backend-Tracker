import { pgTable, integer, text, timestamp, index } from "drizzle-orm/pg-core";

export const pbxMissedCallsTable = pgTable(
  "pbx_missed_calls",
  {
    id: integer("id").primaryKey(),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    ringGroupId: integer("ring_group_id").notNull(),
    ringGroupName: text("ring_group_name").notNull(),
    team: text("team").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("pbx_missed_created").on(t.createdAt),
    index("pbx_missed_team_created").on(t.team, t.createdAt),
  ],
);

export type PbxMissedCall = typeof pbxMissedCallsTable.$inferSelect;
export type InsertPbxMissedCall = typeof pbxMissedCallsTable.$inferInsert;
