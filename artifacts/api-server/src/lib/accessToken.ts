import jwt, { type SignOptions } from "jsonwebtoken";
import type { AuthPayload } from "../middleware/authCore.js";

const isProduction = () => process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1";

function sessionSecret(): string {
  const value = process.env["SESSION_SECRET"];
  if (value) return value;
  if (isProduction()) {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return "dev-secret-change-me";
}

export function signToken(payload: AuthPayload): string {
  const expiresIn = (process.env["AUTH_ACCESS_TOKEN_TTL"] ?? "15m") as SignOptions["expiresIn"];
  return jwt.sign(payload, sessionSecret(), { expiresIn });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, sessionSecret()) as AuthPayload;
}
