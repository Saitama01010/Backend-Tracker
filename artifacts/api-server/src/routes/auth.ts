import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { normalizeAgentEmail } from "@workspace/api-zod/agent-identity";
import { db } from "@workspace/db";
import { portalUsersTable, teamAgentsTable } from "@workspace/db/schema";
import { and, eq, getTableColumns, isNull } from "drizzle-orm";
import { requireAuth, signToken } from "../middleware/auth.js";
import {
  authPayloadForAccess,
  loadAuthenticatablePortalUser,
  publicAuthUser,
} from "../lib/authUser.js";
import type { SessionAuthPayload } from "../middleware/authCore.js";
import {
  createRefreshSession,
  rotateRefreshSession,
  revokeRefreshSession,
  revokeUserSessions,
} from "../lib/sessionStore.js";
import {
  clearRefreshCookie,
  readRefreshCookie,
  readSessionBinding,
  setRefreshCookie,
} from "../lib/sessionToken.js";
import {
  clearFixedWindow,
  boundedAnonymousScope,
  consumeFixedWindow,
  inspectFixedWindow,
  requestAddress,
  type RateLimitDecision,
} from "../lib/rateLimitStore.js";
import { logger } from "../lib/logger.js";
import { CURRENT_PASSWORD_POLICY_VERSION, validateNewPassword } from "../lib/passwordPolicy.js";
import {
  passwordCredentialStampMatches,
  signPasswordUpgradeToken,
  verifyPasswordUpgradeToken,
} from "../lib/passwordUpgradeToken.js";

const router = Router();
const INVALID_CREDENTIALS = "Invalid credentials";
const DUMMY_PASSWORD_HASH = "$2b$10$cjArsAjWlR.lS7mPsVkMbuAKlNoYmFuzH.95QfojL5OZkVUZLPv9W";
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_IP_LIMIT = 30;
const LOGIN_FAILURE_LIMIT = 5;
const PASSWORD_UPGRADE_WINDOW_SECONDS = 10 * 60;
const PASSWORD_UPGRADE_IP_LIMIT = 30;
const INVALID_PASSWORD_UPGRADE_TOKEN = "Invalid or expired password upgrade token";

function isAdminAccount(user: { role: string; accessRole: string | null }): boolean {
  return user.accessRole === "admin" || (!user.accessRole && user.role === "admin");
}

async function loadPortalUserByLoginEmail(normalizedEmail: string) {
  const [explicitUser] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.emailNormalized, normalizedEmail))
    .limit(1);
  if (explicitUser) return explicitUser;

  const [rosterLinkedUser] = await db
    .select({ ...getTableColumns(portalUsersTable) })
    .from(portalUsersTable)
    .innerJoin(teamAgentsTable, eq(portalUsersTable.teamAgentId, teamAgentsTable.id))
    .where(and(
      isNull(portalUsersTable.emailNormalized),
      eq(teamAgentsTable.emailNormalized, normalizedEmail),
    ))
    .limit(1);
  return rosterLinkedUser;
}

function rateLimited(res: Response, decision: RateLimitDecision): void {
  res.setHeader("Retry-After", String(decision.retryAfter));
  res.status(429).json({ error: "Too many attempts. Try again later." });
}

router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const normalizedEmail = typeof email === "string" ? normalizeAgentEmail(email) : "";
  const address = requestAddress(req);
  const ipScope = boundedAnonymousScope(`login-ip:${address}`);
  const loginDecision = await consumeFixedWindow(ipScope, "login-request", LOGIN_IP_LIMIT, LOGIN_WINDOW_SECONDS);
  if (!loginDecision.allowed) {
    rateLimited(res, loginDecision);
    return;
  }

  if (typeof email !== "string" || typeof password !== "string" || !normalizedEmail) {
    res.status(400).json({ error: "email and password required" });
    return;
  }

  // The IP limiter limits distributed username guessing from one source. This
  // independent normalized email key also limits a distributed attack on one account.
  const failureScope = boundedAnonymousScope(`login-failure:${normalizedEmail}`);
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

  const user = await loadPortalUserByLoginEmail(normalizedEmail);

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

  const access = await loadAuthenticatablePortalUser(user.id);
  if (!access) {
    await consumeFixedWindow(failureScope, "login-failure", LOGIN_FAILURE_LIMIT, LOGIN_WINDOW_SECONDS);
    logger.warn({ event: "auth.login.failed" }, "Authentication failed");
    res.status(401).json({ error: INVALID_CREDENTIALS });
    return;
  }

  await clearFixedWindow(failureScope, "login-failure");
  const passwordPolicyError = validateNewPassword(password);
  if (passwordPolicyError) {
    try {
      const verifiedPasswordHash = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            active: portalUsersTable.active,
            passwordHash: portalUsersTable.passwordHash,
          })
          .from(portalUsersTable)
          .where(eq(portalUsersTable.id, user.id))
          .limit(1)
          .for("update");
        return current?.active && current.passwordHash === user.passwordHash
          ? current.passwordHash
          : null;
      });
      if (!verifiedPasswordHash) {
        logger.warn({ event: "auth.login.failed" }, "Authentication failed");
        res.status(401).json({ error: INVALID_CREDENTIALS });
        return;
      }
      clearRefreshCookie(res);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        passwordChangeRequired: true,
        upgradeToken: signPasswordUpgradeToken(user.id, verifiedPasswordHash),
      });
    } catch (error) {
      logger.error({ err: error }, "Password upgrade challenge creation failed");
      res.status(503).json({ error: "Authentication service is temporarily unavailable." });
    }
    return;
  }

  try {
    const session = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          active: portalUsersTable.active,
          passwordHash: portalUsersTable.passwordHash,
          passwordPolicyVersion: portalUsersTable.passwordPolicyVersion,
          role: portalUsersTable.role,
          accessRole: portalUsersTable.accessRole,
        })
        .from(portalUsersTable)
        .where(eq(portalUsersTable.id, user.id))
        .limit(1)
        .for("update");
      if (!current?.active || current.passwordHash !== user.passwordHash) return null;
      if (current.passwordPolicyVersion !== CURRENT_PASSWORD_POLICY_VERSION) {
        await tx.update(portalUsersTable)
          .set({ passwordPolicyVersion: CURRENT_PASSWORD_POLICY_VERSION })
          .where(eq(portalUsersTable.id, user.id));
      }
      return createRefreshSession(user.id, tx, { tabBound: !isAdminAccount(current) });
    });
    if (!session) {
      logger.warn({ event: "auth.login.failed" }, "Authentication failed");
      res.status(401).json({ error: INVALID_CREDENTIALS });
      return;
    }
    setRefreshCookie(res, session.token, !session.tabBound);
    const payload = authPayloadForAccess(access, session.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      token: signToken(payload),
      user: publicAuthUser(payload),
      ...(session.binding ? { sessionBinding: session.binding } : {}),
    });
  } catch (error) {
    logger.error({ err: error }, "Authentication session creation failed");
    res.status(503).json({ error: "Authentication service is temporarily unavailable." });
  }
});

router.post("/auth/password-upgrade", async (req, res) => {
  const addressScope = boundedAnonymousScope(`password-upgrade-ip:${requestAddress(req)}`);
  const decision = await consumeFixedWindow(
    addressScope,
    "password-upgrade-request",
    PASSWORD_UPGRADE_IP_LIMIT,
    PASSWORD_UPGRADE_WINDOW_SECONDS,
  );
  if (!decision.allowed) {
    rateLimited(res, decision);
    return;
  }

  const { upgradeToken, newPassword, confirmPassword } = req.body ?? {};
  if (
    typeof upgradeToken !== "string"
    || typeof newPassword !== "string"
    || typeof confirmPassword !== "string"
  ) {
    res.status(400).json({ error: "upgradeToken, newPassword, and confirmPassword are required" });
    return;
  }

  let claims;
  try {
    claims = verifyPasswordUpgradeToken(upgradeToken);
  } catch {
    res.status(401).json({ error: INVALID_PASSWORD_UPGRADE_TOKEN });
    return;
  }

  const [user] = await db
    .select({
      id: portalUsersTable.id,
      username: portalUsersTable.username,
      passwordHash: portalUsersTable.passwordHash,
      active: portalUsersTable.active,
    })
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, claims.userId))
    .limit(1);
  const access = user?.active ? await loadAuthenticatablePortalUser(user.id) : null;
  if (
    !user?.active
    || !access
    || !passwordCredentialStampMatches(user.id, user.passwordHash, claims.credentialStamp)
  ) {
    res.status(401).json({ error: INVALID_PASSWORD_UPGRADE_TOKEN });
    return;
  }

  if (newPassword !== confirmPassword) {
    res.status(400).json({ error: "Passwords do not match." });
    return;
  }
  const passwordError = validateNewPassword(newPassword);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const replacement = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: portalUsersTable.id,
          username: portalUsersTable.username,
          passwordHash: portalUsersTable.passwordHash,
          active: portalUsersTable.active,
          role: portalUsersTable.role,
          accessRole: portalUsersTable.accessRole,
        })
        .from(portalUsersTable)
        .where(eq(portalUsersTable.id, claims.userId))
        .limit(1)
        .for("update");
      if (
        !current?.active
        || !passwordCredentialStampMatches(current.id, current.passwordHash, claims.credentialStamp)
      ) return { kind: "invalid" as const };

      const currentPasswordError = validateNewPassword(newPassword);
      if (currentPasswordError) return { kind: "password-error" as const, error: currentPasswordError };

      await tx.update(portalUsersTable)
        .set({
          passwordHash,
          passwordPolicyVersion: CURRENT_PASSWORD_POLICY_VERSION,
          passwordChangedAt: new Date(),
        })
        .where(eq(portalUsersTable.id, current.id));
      await revokeUserSessions(current.id, tx);
      const session = await createRefreshSession(current.id, tx, { tabBound: !isAdminAccount(current) });
      return { kind: "success" as const, session };
    });

    if (replacement.kind === "invalid") {
      res.status(401).json({ error: INVALID_PASSWORD_UPGRADE_TOKEN });
      return;
    }
    if (replacement.kind === "password-error") {
      res.status(400).json({ error: replacement.error });
      return;
    }

    const refreshedAccess = await loadAuthenticatablePortalUser(user.id);
    if (!refreshedAccess) {
      await revokeRefreshSession(replacement.session.token);
      clearRefreshCookie(res);
      res.status(401).json({ error: INVALID_PASSWORD_UPGRADE_TOKEN });
      return;
    }
    setRefreshCookie(res, replacement.session.token, !replacement.session.tabBound);
    const payload = authPayloadForAccess(refreshedAccess, replacement.session.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      token: signToken(payload),
      user: publicAuthUser(payload),
      ...(replacement.session.binding ? { sessionBinding: replacement.session.binding } : {}),
    });
  } catch (error) {
    logger.error({ err: error }, "Password upgrade failed");
    res.status(503).json({ error: "Authentication service is temporarily unavailable." });
  }
});

router.post("/auth/refresh", async (req, res) => {
  const addressScope = boundedAnonymousScope(`refresh-ip:${requestAddress(req)}`);
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

  const sessionBinding = readSessionBinding(req) ?? undefined;
  const rotatedSession = await rotateRefreshSession(refreshToken, sessionBinding);
  const access = rotatedSession ? await loadAuthenticatablePortalUser(rotatedSession.userId) : null;
  if (!rotatedSession || !access) {
    if (rotatedSession) await revokeRefreshSession(rotatedSession.token, rotatedSession.binding);
    clearRefreshCookie(res);
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  let session = rotatedSession;
  const shouldBeTabBound = access.payload.role !== "admin";
  if (!session.tabBound && shouldBeTabBound) {
    await revokeRefreshSession(session.token);
    clearRefreshCookie(res);
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }
  if (session.tabBound && !shouldBeTabBound) {
    await revokeRefreshSession(session.token, session.binding);
    session = {
      ...await createRefreshSession(session.userId, db, { tabBound: false }),
      userId: session.userId,
    };
  }

  setRefreshCookie(res, session.token, !session.tabBound);
  const payload = authPayloadForAccess(access, session.id);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    token: signToken(payload),
    user: publicAuthUser(payload),
    ...(session.binding ? { sessionBinding: session.binding } : {}),
  });
});

router.post("/auth/logout", async (req, res) => {
  const refreshToken = readRefreshCookie(req);
  if (refreshToken) await revokeRefreshSession(refreshToken, readSessionBinding(req) ?? undefined);
  clearRefreshCookie(res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const sessionId = req.user!.sessionId;
  if (!sessionId) {
    clearRefreshCookie(res);
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  const payload: SessionAuthPayload = { ...req.user!, sessionId };
  res.setHeader("Cache-Control", "no-store");
  res.json({ token: signToken(payload), user: publicAuthUser(payload) });
});

export default router;
