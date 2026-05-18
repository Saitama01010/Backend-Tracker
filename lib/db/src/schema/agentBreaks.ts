import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

export const agentBreaksTable = pgTable(
  "agent_breaks",
  {
    id:         serial("id").primaryKey(),
    agentName:  text("agent_name").notNull(),
    department: text("department").notNull(),
    breakStart: timestamp("break_start", { withTimezone: true }).notNull(),
    breakEnd:   timestamp("break_end",   { withTimezone: true }),
    note:       text("note"),
    loggedBy:   text("logged_by").notNull().default("self"),
    createdAt:  timestamp("created_at",  { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("agent_breaks_agent_start").on(t.agentName, t.breakStart),
    index("agent_breaks_start").on(t.breakStart),
  ],
);

export type AgentBreak       = typeof agentBreaksTable.$inferSelect;
export type InsertAgentBreak = typeof agentBreaksTable.$inferInsert;
