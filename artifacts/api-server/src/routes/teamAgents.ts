import { Router } from "express";
import { db } from "@workspace/db";
import { teamAgentsTable, VALID_TEAMS } from "@workspace/db/schema";
import type { TeamSlug } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

const teamAgentColumns = {
  id: teamAgentsTable.id,
  name: teamAgentsTable.name,
  arabicName: teamAgentsTable.arabicName,
  shift: teamAgentsTable.shift,
  notes: teamAgentsTable.notes,
  team: teamAgentsTable.team,
  active: teamAgentsTable.active,
  createdAt: teamAgentsTable.createdAt,
  updatedAt: teamAgentsTable.updatedAt,
};

function isTeamSlug(value: unknown): value is TeamSlug {
  return typeof value === "string" && (VALID_TEAMS as readonly string[]).includes(value);
}

function trimOptionalString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get("/team-agents", requireAuth, async (_req, res) => {
  const agents = await db
    .select(teamAgentColumns)
    .from(teamAgentsTable)
    .orderBy(asc(teamAgentsTable.team), asc(teamAgentsTable.name));
  res.json(agents);
});

router.post("/team-agents", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, team, arabicName, shift, notes, active } = req.body ?? {};
  if (typeof name !== "string" || !name.trim() || !isTeamSlug(team)) {
    res.status(400).json({ error: "name and valid team (retention|nsf|cs|killers) required" });
    return;
  }

  let optionalFields: { arabicName: string | null; shift: string | null; notes: string | null };
  try {
    optionalFields = {
      arabicName: trimOptionalString(arabicName, "arabicName"),
      shift: trimOptionalString(shift, "shift"),
      notes: trimOptionalString(notes, "notes"),
    };
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid roster fields" });
    return;
  }

  const now = new Date();
  const [agent] = await db
    .insert(teamAgentsTable)
    .values({
      name: name.trim(),
      team,
      ...optionalFields,
      active: typeof active === "boolean" ? active : true,
      createdAt: now,
      updatedAt: now,
    })
    .returning(teamAgentColumns);
  res.status(201).json(agent);
});

router.patch("/team-agents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "invalid id" }); return; }

  const body = req.body ?? {};
  const updates: Partial<typeof teamAgentsTable.$inferInsert> = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    updates.name = body.name.trim();
  }
  if ("team" in body) {
    if (!isTeamSlug(body.team)) {
      res.status(400).json({ error: "valid team (retention|nsf|cs|killers) required" });
      return;
    }
    updates.team = body.team;
  }
  if ("active" in body) {
    if (typeof body.active !== "boolean") {
      res.status(400).json({ error: "active must be a boolean" });
      return;
    }
    updates.active = body.active;
  }
  try {
    if ("arabicName" in body) updates.arabicName = trimOptionalString(body.arabicName, "arabicName");
    if ("shift" in body) updates.shift = trimOptionalString(body.shift, "shift");
    if ("notes" in body) updates.notes = trimOptionalString(body.notes, "notes");
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid roster fields" });
    return;
  }

  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "nothing to update" }); return; }
  updates.updatedAt = new Date();
  const [updated] = await db
    .update(teamAgentsTable)
    .set(updates)
    .where(eq(teamAgentsTable.id, id))
    .returning(teamAgentColumns);
  if (!updated) { res.status(404).json({ error: "not found" }); return; }
  res.json(updated);
});

router.delete("/team-agents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "invalid id" }); return; }
  await db.delete(teamAgentsTable).where(eq(teamAgentsTable.id, id));
  res.status(204).send();
});

export default router;
