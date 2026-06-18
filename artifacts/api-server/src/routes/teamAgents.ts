import { Router } from "express";
import { db } from "@workspace/db";
import { teamAgentsTable } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

const VALID_TEAMS = ["retention", "nsf", "cs", "killers"] as const;

router.get("/team-agents", requireAuth, async (_req, res) => {
  const agents = await db
    .select()
    .from(teamAgentsTable)
    .orderBy(asc(teamAgentsTable.team), asc(teamAgentsTable.name));
  res.json(agents);
});

router.post("/team-agents", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, team, arabicName, shift } = req.body ?? {};
  if (!name || typeof name !== "string" || !VALID_TEAMS.includes(team)) {
    res.status(400).json({ error: "name and valid team (retention|nsf|cs|killers) required" });
    return;
  }
  const [agent] = await db
    .insert(teamAgentsTable)
    .values({
      name: name.trim(),
      team,
      arabicName: typeof arabicName === "string" && arabicName.trim() ? arabicName.trim() : null,
      shift: typeof shift === "string" && shift.trim() ? shift.trim() : null,
    })
    .returning();
  res.status(201).json(agent);
});

router.patch("/team-agents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const { name, team, active, arabicName, shift } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (name && typeof name === "string") updates["name"] = name.trim();
  if (team && VALID_TEAMS.includes(team)) updates["team"] = team;
  if (active !== undefined) updates["active"] = Boolean(active);
  if (arabicName !== undefined) updates["arabicName"] = typeof arabicName === "string" && arabicName.trim() ? arabicName.trim() : null;
  if (shift !== undefined) updates["shift"] = typeof shift === "string" && shift.trim() ? shift.trim() : null;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "nothing to update" }); return; }
  updates["updatedAt"] = new Date();
  const [updated] = await db
    .update(teamAgentsTable)
    .set(updates)
    .where(eq(teamAgentsTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "not found" }); return; }
  res.json(updated);
});

router.delete("/team-agents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  await db.delete(teamAgentsTable).where(eq(teamAgentsTable.id, id));
  res.status(204).send();
});

export default router;
