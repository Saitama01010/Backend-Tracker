import jwt, { type SignOptions } from "jsonwebtoken";
import type { AuthPayload, SessionAuthPayload } from "../middleware/authCore.js";

const isProduction = () => process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1";

function sessionSecret(): string {
  const value = process.env["SESSION_SECRET"];
  if (value) return value;
  if (isProduction()) {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return "dev-secret-change-me";
}

export function signToken(payload: SessionAuthPayload): string {
  const expiresIn = (process.env["AUTH_ACCESS_TOKEN_TTL"] ?? "15m") as SignOptions["expiresIn"];
  return jwt.sign(payload, sessionSecret(), { algorithm: "HS256", expiresIn });
}

export function verifyToken(token: string): SessionAuthPayload {
  const decoded = jwt.verify(token, sessionSecret(), { algorithms: ["HS256"] });
  if (!decoded || typeof decoded === "string") throw new Error("Invalid access token claims");
  const claims = decoded as Partial<AuthPayload>;
  if (!Number.isSafeInteger(claims.userId)
    || typeof claims.username !== "string"
    || claims.username.length === 0
    || !["admin", "edit", "view"].includes(claims.role ?? "")
    || !Array.isArray(claims.permissions)
    || typeof claims.sessionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sessionId)) {
    throw new Error("Invalid access token claims");
  }
  return claims as SessionAuthPayload;
}
