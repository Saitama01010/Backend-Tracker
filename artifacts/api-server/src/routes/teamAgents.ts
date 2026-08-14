import { Router, type Request, type Response } from "express";
import {
  canonicalizeAgentDisplayName,
  isValidAgentEmail,
  normalizeAgentArabicName,
  normalizeAgentEmail,
  normalizeAgentEnglishName,
} from "@workspace/api-zod/agent-identity";
import { db } from "@workspace/db";
import { portalUsersTable, teamAgentsTable, VALID_TEAMS } from "@workspace/db/schema";
import type { TeamSlug } from "@workspace/db/schema";
import { and, asc, eq, ne } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { canAccessAgent, isAdministrator } from "../middleware/authorizationCore.js";
import { revokeUserSessions } from "../lib/sessionStore.js";

const router = Router();

async function revokeLinkedPortalSessions(teamAgentId: number): Promise<void> {
  const linked = await db.select({ id: portalUsersTable.id })
    .from(portalUsersTable)
    .where(eq(portalUsersTable.teamAgentId, teamAgentId));
  await Promise.all(linked.map(({ id }) => revokeUserSessions(id)));
}

const teamAgentColumns = {
  id: teamAgentsTable.id,
  name: teamAgentsTable.name,
  arabicName: teamAgentsTable.arabicName,
  email: teamAgentsTable.email,
  shift: teamAgentsTable.shift,
  notes: teamAgentsTable.notes,
  team: teamAgentsTable.team,
  active: teamAgentsTable.active,
  createdAt: teamAgentsTable.createdAt,
  updatedAt: teamAgentsTable.updatedAt,
};

type AgentIdentityField = "name" | "arabicName" | "email";
type AgentConflict = {
  error: "AGENT_ENGLISH_NAME_ALREADY_EXISTS" | "AGENT_ARABIC_NAME_ALREADY_EXISTS" | "AGENT_EMAIL_ALREADY_EXISTS";
  field: AgentIdentityField;
  message: string;
};

const CONFLICTS: Record<AgentIdentityField, AgentConflict> = {
  name: {
    error: "AGENT_ENGLISH_NAME_ALREADY_EXISTS",
    field: "name",
    message: "An agent with this English name already exists.",
  },
  arabicName: {
    error: "AGENT_ARABIC_NAME_ALREADY_EXISTS",
    field: "arabicName",
    message: "An agent with this Arabic name already exists.",
  },
  email: {
    error: "AGENT_EMAIL_ALREADY_EXISTS",
    field: "email",
    message: "An agent with this email already exists.",
  },
};

const CONSTRAINT_FIELDS: Record<string, AgentIdentityField> = {
  team_agents_name_normalized_uidx: "name",
  team_agents_arabic_name_normalized_uidx: "arabicName",
  team_agents_email_normalized_uidx: "email",
};

class AgentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; field?: AgentIdentityField; message: string },
  ) {
    super(body.message);
  }
}

function isTeamSlug(value: unknown): value is TeamSlug {
  return typeof value === "string" && (VALID_TEAMS as readonly string[]).includes(value);
}

function trimOptionalString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new AgentRequestError(400, {
      error: "INVALID_AGENT_FIELD",
      message: `${field} must be a string`,
    });
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function englishIdentity(value: unknown): { name: string; nameNormalized: string } {
  if (typeof value !== "string") {
    throw new AgentRequestError(400, {
      error: "AGENT_ENGLISH_NAME_REQUIRED",
      field: "name",
      message: "English name is required.",
    });
  }
  const name = canonicalizeAgentDisplayName(value);
  if (!name) {
    throw new AgentRequestError(400, {
      error: "AGENT_ENGLISH_NAME_REQUIRED",
      field: "name",
      message: "English name is required.",
    });
  }
  return { name, nameNormalized: normalizeAgentEnglishName(name) };
}

function arabicIdentity(value: unknown): {
  arabicName: string | null;
  arabicNameNormalized: string | null;
} {
  if (value == null) return { arabicName: null, arabicNameNormalized: null };
  if (typeof value !== "string") {
    throw new AgentRequestError(400, {
      error: "INVALID_AGENT_ARABIC_NAME",
      field: "arabicName",
      message: "Arabic name must be a string.",
    });
  }
  const arabicName = canonicalizeAgentDisplayName(value);
  return arabicName
    ? { arabicName, arabicNameNormalized: normalizeAgentArabicName(arabicName) }
    : { arabicName: null, arabicNameNormalized: null };
}

function emailIdentity(value: unknown, required: boolean): {
  email: string | null;
  emailNormalized: string | null;
} {
  if (value == null || (typeof value === "string" && !value.trim())) {
    if (required) {
      throw new AgentRequestError(400, {
        error: "AGENT_EMAIL_REQUIRED",
        field: "email",
        message: "Email is required for new agents.",
      });
    }
    return { email: null, emailNormalized: null };
  }
  if (typeof value !== "string" || !isValidAgentEmail(value)) {
    throw new AgentRequestError(400, {
      error: "INVALID_AGENT_EMAIL",
      field: "email",
      message: "Enter a valid email address.",
    });
  }
  const email = normalizeAgentEmail(value);
  return { email, emailNormalized: email };
}

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function conflictResponse(field: AgentIdentityField): AgentConflict {
  return CONFLICTS[field];
}

function postgresUniqueConflict(error: unknown): AgentIdentityField | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate && typeof candidate === "object"; depth += 1) {
    const record = candidate as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === "23505" && typeof record.constraint === "string") {
      return CONSTRAINT_FIELDS[record.constraint] ?? null;
    }
    candidate = record.cause;
  }
  return null;
}

async function findIdentityConflict(
  identities: {
    nameNormalized?: string;
    arabicNameNormalized?: string | null;
    emailNormalized?: string | null;
  },
  excludeId?: number,
): Promise<AgentIdentityField | null> {
  const exclude = excludeId ? ne(teamAgentsTable.id, excludeId) : undefined;
  if (identities.nameNormalized) {
    const [existing] = await db
      .select({ id: teamAgentsTable.id })
      .from(teamAgentsTable)
      .where(and(eq(teamAgentsTable.nameNormalized, identities.nameNormalized), exclude))
      .limit(1);
    if (existing) return "name";
  }
  if (identities.arabicNameNormalized) {
    const [existing] = await db
      .select({ id: teamAgentsTable.id })
      .from(teamAgentsTable)
      .where(and(eq(teamAgentsTable.arabicNameNormalized, identities.arabicNameNormalized), exclude))
      .limit(1);
    if (existing) return "arabicName";
  }
  if (identities.emailNormalized) {
    const [existing] = await db
      .select({ id: teamAgentsTable.id })
      .from(teamAgentsTable)
      .where(and(eq(teamAgentsTable.emailNormalized, identities.emailNormalized), exclude))
      .limit(1);
    if (existing) return "email";
  }
  return null;
}

function sendCaughtError(
  req: Request,
  res: Response,
  error: unknown,
  operation: "save" | "update" | "delete",
): void {
  if (error instanceof AgentRequestError) {
    res.status(error.status).json(error.body);
    return;
  }
  const conflictField = postgresUniqueConflict(error);
  if (conflictField) {
    res.status(409).json(conflictResponse(conflictField));
    return;
  }
  req.log.error(error, `team-agents ${operation} error`);
  const messages = {
    save: "Failed to save team agent",
    update: "Failed to update team agent",
    delete: "Failed to deactivate team agent",
  };
  res.status(500).json({ error: messages[operation] });
}

router.get("/team-agents", requireAuth, async (req, res) => {
  try {
    const agents = await db
      .select(teamAgentColumns)
      .from(teamAgentsTable)
      .orderBy(asc(teamAgentsTable.team), asc(teamAgentsTable.name));
    const scoped = req.user && isAdministrator(req.user)
      ? agents
      : agents.filter((agent) => {
          if (req.user?.teamAccess && agent.team !== req.user.teamAccess) return false;
          return !!req.user && canAccessAgent(
            req.user,
            agent.name,
            agent.arabicName ? [agent.arabicName] : [],
            { id: agent.id, team: agent.team },
          );
        });
    res.json(scoped);
  } catch (error) {
    req.log.error(error, "team-agents GET error");
    res.status(500).json({ error: "Failed to load team agents" });
  }
});

router.post("/team-agents", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { name: rawName, team, arabicName: rawArabicName, email: rawEmail, shift, notes, active } = req.body ?? {};
    if (!isTeamSlug(team)) {
      throw new AgentRequestError(400, {
        error: "INVALID_AGENT_TEAM",
        message: "A valid team (retention|nsf|cs|killers) is required.",
      });
    }
    const nameIdentity = englishIdentity(rawName);
    const arabicNameIdentity = arabicIdentity(rawArabicName);
    const agentEmailIdentity = emailIdentity(rawEmail, true);
    const conflict = await findIdentityConflict({
      nameNormalized: nameIdentity.nameNormalized,
      arabicNameNormalized: arabicNameIdentity.arabicNameNormalized,
      emailNormalized: agentEmailIdentity.emailNormalized,
    });
    if (conflict) {
      res.status(409).json(conflictResponse(conflict));
      return;
    }

    const now = new Date();
    const [agent] = await db
      .insert(teamAgentsTable)
      .values({
        ...nameIdentity,
        ...arabicNameIdentity,
        ...agentEmailIdentity,
        team,
        shift: trimOptionalString(shift, "shift"),
        notes: trimOptionalString(notes, "notes"),
        active: typeof active === "boolean" ? active : true,
        createdAt: now,
        updatedAt: now,
      })
      .returning(teamAgentColumns);
    res.status(201).json(agent);
  } catch (error) {
    sendCaughtError(req, res, error, "save");
  }
});

router.patch("/team-agents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      throw new AgentRequestError(400, { error: "INVALID_AGENT_ID", message: "Invalid agent ID." });
    }

    const body: Record<string, unknown> = req.body
      && typeof req.body === "object"
      && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const updates: Partial<typeof teamAgentsTable.$inferInsert> = {};
    const identities: {
      nameNormalized?: string;
      arabicNameNormalized?: string | null;
      emailNormalized?: string | null;
    } = {};

    if ("name" in body) {
      const identity = englishIdentity(body.name);
      Object.assign(updates, identity);
      identities.nameNormalized = identity.nameNormalized;
    }
    if ("arabicName" in body) {
      const identity = arabicIdentity(body.arabicName);
      Object.assign(updates, identity);
      identities.arabicNameNormalized = identity.arabicNameNormalized;
    }
    if ("email" in body) {
      const identity = emailIdentity(body.email, false);
      Object.assign(updates, identity);
      identities.emailNormalized = identity.emailNormalized;
    }
    if ("team" in body) {
      if (!isTeamSlug(body.team)) {
        throw new AgentRequestError(400, {
          error: "INVALID_AGENT_TEAM",
          message: "A valid team (retention|nsf|cs|killers) is required.",
        });
      }
      updates.team = body.team;
    }
    if ("active" in body) {
      if (typeof body.active !== "boolean") {
        throw new AgentRequestError(400, {
          error: "INVALID_AGENT_ACTIVE_STATE",
          message: "Active must be a boolean.",
        });
      }
      updates.active = body.active;
    }
    if ("shift" in body) updates.shift = trimOptionalString(body.shift, "shift");
    if ("notes" in body) updates.notes = trimOptionalString(body.notes, "notes");

    if (Object.keys(updates).length === 0) {
      throw new AgentRequestError(400, { error: "NO_AGENT_UPDATES", message: "Nothing to update." });
    }
    const conflict = await findIdentityConflict(identities, id);
    if (conflict) {
      res.status(409).json(conflictResponse(conflict));
      return;
    }

    updates.updatedAt = new Date();
    const [updated] = await db
      .update(teamAgentsTable)
      .set(updates)
      .where(eq(teamAgentsTable.id, id))
      .returning(teamAgentColumns);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (updates.active === false) await revokeLinkedPortalSessions(updated.id);
    res.json(updated);
  } catch (error) {
    sendCaughtError(req, res, error, "update");
  }
});

// Canonical identities are never hard-deleted. Preserve the existing route and
// status contract while turning DELETE into deactivation so historical name
// attribution and reserved inactive identities remain intact.
router.delete("/team-agents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      throw new AgentRequestError(400, { error: "INVALID_AGENT_ID", message: "Invalid agent ID." });
    }
    const [updated] = await db
      .update(teamAgentsTable)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(teamAgentsTable.id, id))
      .returning({ id: teamAgentsTable.id });
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await revokeLinkedPortalSessions(updated.id);
    res.status(204).send();
  } catch (error) {
    sendCaughtError(req, res, error, "delete");
  }
});

export default router;
