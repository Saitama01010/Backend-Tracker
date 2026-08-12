import type { NextFunction, Request, Response } from "express";
import { consumeFixedWindow, privateScopeHash } from "../lib/rateLimitStore.js";
import { logger } from "../lib/logger.js";
import { protectedActionForRequest } from "./abusePolicy.js";

export async function rateLimitExpensiveActions(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    next();
    return;
  }
  const action = protectedActionForRequest(req.method, req.path, req);
  if (!action) {
    next();
    return;
  }

  try {
    const scope = privateScopeHash(`user:${req.user.userId}`);
    const decision = await consumeFixedWindow(scope, action.key, action.limit, action.windowSeconds);
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfter));
      res.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }
    next();
  } catch (error) {
    logger.error({ err: error, action: action.key }, "API abuse-protection storage failed");
    res.status(503).json({ error: "Request protection is temporarily unavailable." });
  }
}
