import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { portalUsersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password required" });
    return;
  }
  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.username, username.trim().toLowerCase()))
    .limit(1);

  if (!user || !user.active) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = signToken({ userId: user.id, username: user.username, role: user.role as "admin" | "edit" | "view" });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
