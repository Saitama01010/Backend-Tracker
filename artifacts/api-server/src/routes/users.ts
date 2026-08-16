import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { UserRequestError, usersService } from "../modules/users/users.service.js";

const router = Router();

function postgresCode(error: unknown): string | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate && typeof candidate === "object"; depth += 1) {
    const record = candidate as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    candidate = record.cause;
  }
  return null;
}

function postgresConstraint(error: unknown): string | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate && typeof candidate === "object"; depth += 1) {
    const record = candidate as { constraint?: unknown; cause?: unknown };
    if (typeof record.constraint === "string") return record.constraint;
    candidate = record.cause;
  }
  return null;
}

function sendUserError(req: Request, res: Response, error: unknown): void {
  if (error instanceof UserRequestError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (postgresCode(error) === "23505") {
    if (postgresConstraint(error) === "portal_users_email_normalized_uidx") {
      res.status(409).json({ error: "Email is already assigned to another user" });
      return;
    }
    res.status(409).json({ error: "Username or canonical Agent is already assigned" });
    return;
  }
  req.log.error(error, "portal user management failed");
  res.status(500).json({ error: "Failed to save portal user" });
}

router.get("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    res.json(await usersService.listUsers());
  } catch (error) {
    sendUserError(req, res, error);
  }
});

router.post("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    res.status(201).json(await usersService.createUser(req.body));
  } catch (error) {
    sendUserError(req, res, error);
  }
});

router.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    res.json(await usersService.updateUser({
      actorId: req.user?.userId,
      id: req.params.id,
      body: req.body,
    }));
  } catch (error) {
    sendUserError(req, res, error);
  }
});

router.delete("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    res.json(await usersService.deleteUser({ actorId: req.user?.userId, id: req.params.id }));
  } catch (error) {
    sendUserError(req, res, error);
  }
});

export default router;
