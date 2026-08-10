import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { portalUsersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, signToken } from "../middleware/auth.js";
import { authPayloadForUser, loadActivePortalUser, publicAuthUser } from "../lib/authUser.js";
import {
  createRefreshSession,
  findActiveRefreshSession,
  revokeRefreshSession,
  touchRefreshSession,
} from "../lib/sessionStore.js";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "../lib/sessionToken.js";
import {
  clearFixedWindow,
  consumeFixedWindow,
  inspectFixedWindow,
  privateScopeHash,
  requestAddress,
  type RateLimitDecision,
} from "../lib/rateLimitStore.js";
import { logger } from "../lib/logger.js";

const router = Router();
const INVALID_CREDENTIALS = "Invalid credentials";
const DUMMY_PASSWORD_HASH = "$2b$10$cjArsAjWlR.lS7mPsVkMbuAKlNoYmFuzH.95QfojL5OZkVUZLPv9W";
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_IP_LIMIT = 30;
const LOGIN_FAILURE_LIMIT = 5;

function rateLimited(res: Response, decision: RateLimitDecision): void {
  res.setHeader("Retry-After", String(decision.retryAfter));
  res.status(429).json({ error: "Too many attempts. Try again later." });
}

async function issueSession(userId: number, res: Response) {
  const session = await createRefreshSession(userId);
  setRefreshCookie(res, session.token);
  return session.id;
}

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  const normalizedUsername = typeof username === "string" ? username.trim().toLowerCase() : "";
  const address = requestAddress(req);
  const ipScope = privateScopeHash(`login-ip:${address}`);
  const loginDecision = await consumeFixedWindow(ipScope, "login-request", LOGIN_IP_LIMIT, LOGIN_WINDOW_SECONDS);
  if (!loginDecision.allowed) {
    rateLimited(res, loginDecision);
    return;
  }

  if (typeof username !== "string" || typeof password !== "string" || !normalizedUsername) {
    res.status(400).json({ error: "username and password required" });
    return;
  }

  // The IP limiter limits distributed username guessing from one source. This
  // independent account key also limits a distributed attack on one account.
  const failureScope = privateScopeHash(`login-failure:${normalizedUsername}`);
  const existingFailures = await inspectFixedWindow(
    failureScope,
    "login-failure",
    LOGIN_FAILURE_LIMIT,
    LOGIN_WINDOW_SECONDS,
  );
  if (!existingFailures.allowed) {
    rateLimited(res, existingFailures);
    return;
  }

  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.username, normalizedUsername))
    .limit(1);

  const passwordValid = await bcrypt.compare(password, user?.active ? user.passwordHash : DUMMY_PASSWORD_HASH);
  if (!user?.active || !passwordValid) {
    const failureDecision = await consumeFixedWindow(
      failureScope,
      "login-failure",
      LOGIN_FAILURE_LIMIT,
      LOGIN_WINDOW_SECONDS,
    );
    logger.warn({ event: "auth.login.failed" }, "Authentication failed");
    if (!failureDecision.allowed) {
      rateLimited(res, failureDecision);
      return;
    }
    res.status(401).json({ error: INVALID_CREDENTIALS });
    return;
  }

  await clearFixedWindow(failureScope, "login-failure");
  try {
    const sessionId = await issueSession(user.id, res);
    const payload = authPayloadForUser(user, sessionId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ token: signToken(payload), user: publicAuthUser(payload) });
  } catch (error) {
    logger.error({ err: error }, "Authentication session creation failed");
    res.status(503).json({ error: "Authentication service is temporarily unavailable." });
  }
});

router.post("/auth/refresh", async (req, res) => {
  const addressScope = privateScopeHash(`refresh-ip:${requestAddress(req)}`);
  const decision = await consumeFixedWindow(addressScope, "session-refresh", 60, 5 * 60);
  if (!decision.allowed) {
    rateLimited(res, decision);
    return;
  }

  const refreshToken = readRefreshCookie(req);
  if (!refreshToken) {
    clearRefreshCookie(res);
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  const session = await findActiveRefreshSession(refreshToken);
  const user = session ? await loadActivePortalUser(session.userId) : null;
  if (!session || !user) {
    if (session) await revokeRefreshSession(refreshToken);
    clearRefreshCookie(res);
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  await touchRefreshSession(session.id);
  const payload = authPayloadForUser(user, session.id);
  res.setHeader("Cache-Control", "no-store");
  res.json({ token: signToken(payload), user: publicAuthUser(payload) });
});

router.post("/auth/logout", async (req, res) => {
  const refreshToken = readRefreshCookie(req);
  if (refreshToken) await revokeRefreshSession(refreshToken);
  clearRefreshCookie(res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const user = await loadActivePortalUser(req.user!.userId);
  if (!user) {
    clearRefreshCookie(res);
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Legacy 30-day JWTs do not have a session ID. The first /auth/me call
  // upgrades them in place without forcing the user to sign in again.
  const sessionId = req.user!.sessionId ?? await issueSession(user.id, res);
  const payload = authPayloadForUser(user, sessionId);
  res.setHeader("Cache-Control", "no-store");
  res.json({ token: signToken(payload), user: publicAuthUser(payload) });
});

export default router;
