import { createHash } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";

export const REFRESH_COOKIE_NAME = "tracker_refresh";

const isProduction = () => process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1";

function refreshLifetimeDays(): number {
  const configured = Number(process.env["AUTH_REFRESH_TOKEN_DAYS"] ?? 30);
  return Number.isFinite(configured) ? Math.min(90, Math.max(1, Math.floor(configured))) : 30;
}

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "strict",
    path: "/api/auth",
    maxAge: refreshLifetimeDays() * 24 * 60 * 60 * 1_000,
  };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
}

export function clearRefreshCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options);
}

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length > 8_192) return null;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1 || segment.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) continue;
    const encoded = segment.slice(separator + 1).trim();
    try {
      const value = decodeURIComponent(encoded);
      return /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}
