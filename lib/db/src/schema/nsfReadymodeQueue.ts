import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

export const nsfReadymodeQueueTable = pgTable(
  "nsf_readymode_queue",
  {
    id: serial("id").primaryKey(),
    phoneNumber: text("phone_number").notNull(),
    addedBy: text("added_by"),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneBy: text("done_by"),
  },
  (t) => [
    index("nsf_readymode_active").on(t.doneAt),
    index("nsf_readymode_number").on(t.phoneNumber),
  ],
);

export type NsfReadymodeQueueRow = typeof nsfReadymodeQueueTable.$inferSelect;
export type InsertNsfReadymodeQueue = typeof nsfReadymodeQueueTable.$inferInsert;
