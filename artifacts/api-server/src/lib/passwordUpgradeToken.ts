import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { authSigningSecret } from "./authSecret.js";
import { CURRENT_PASSWORD_POLICY_VERSION } from "./passwordPolicy.js";

const PASSWORD_UPGRADE_PURPOSE = "password-upgrade";
const PASSWORD_UPGRADE_ISSUER = "backend-tracker-api";
const PASSWORD_UPGRADE_AUDIENCE = "password-upgrade";
const DEFAULT_PASSWORD_UPGRADE_TTL_SECONDS = 10 * 60;

export interface PasswordUpgradeClaims {
  userId: number;
  credentialStamp: string;
  tokenId: string;
}

function passwordUpgradeSigningKey(): Buffer {
  return createHmac("sha256", authSigningSecret())
    .update("backend-tracker:password-upgrade-token:v1")
    .digest();
}

function configuredLifetimeSeconds(): number {
  const configured = Number(process.env["AUTH_PASSWORD_UPGRADE_TOKEN_TTL_SECONDS"] ?? DEFAULT_PASSWORD_UPGRADE_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_PASSWORD_UPGRADE_TTL_SECONDS;
  return Math.min(10 * 60, Math.max(5 * 60, Math.floor(configured)));
}

export function passwordCredentialStamp(userId: number, passwordHash: string): string {
  return createHmac("sha256", passwordUpgradeSigningKey())
    .update(String(userId))
    .update("\0")
    .update(passwordHash)
    .digest("base64url");
}

export function passwordCredentialStampMatches(
  userId: number,
  passwordHash: string,
  candidate: string,
): boolean {
  const expected = passwordCredentialStamp(userId, passwordHash);
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}

export function signPasswordUpgradeToken(
  userId: number,
  passwordHash: string,
  expiresInSeconds = configuredLifetimeSeconds(),
): string {
  const tokenId = randomUUID();
  return jwt.sign(
    {
      purpose: PASSWORD_UPGRADE_PURPOSE,
      userId,
      credentialStamp: passwordCredentialStamp(userId, passwordHash),
      passwordPolicyVersion: CURRENT_PASSWORD_POLICY_VERSION,
    },
    passwordUpgradeSigningKey(),
    {
      algorithm: "HS256",
      audience: PASSWORD_UPGRADE_AUDIENCE,
      issuer: PASSWORD_UPGRADE_ISSUER,
      jwtid: tokenId,
      subject: String(userId),
      expiresIn: expiresInSeconds,
    },
  );
}

export function verifyPasswordUpgradeToken(token: string): PasswordUpgradeClaims {
  if (typeof token !== "string" || token.length < 32 || token.length > 2_048) {
    throw new Error("Invalid password upgrade token");
  }
  const decoded = jwt.verify(token, passwordUpgradeSigningKey(), {
    algorithms: ["HS256"],
    audience: PASSWORD_UPGRADE_AUDIENCE,
    issuer: PASSWORD_UPGRADE_ISSUER,
  });
  if (!decoded || typeof decoded === "string") throw new Error("Invalid password upgrade token claims");
  const claims = decoded as Record<string, unknown>;
  if (
    claims["purpose"] !== PASSWORD_UPGRADE_PURPOSE
    || claims["passwordPolicyVersion"] !== CURRENT_PASSWORD_POLICY_VERSION
    || !Number.isSafeInteger(claims["userId"])
    || Number(claims["userId"]) <= 0
    || claims["sub"] !== String(claims["userId"])
    || typeof claims["jti"] !== "string"
    || !/^[0-9a-f-]{36}$/i.test(claims["jti"])
    || typeof claims["credentialStamp"] !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(claims["credentialStamp"])
  ) {
    throw new Error("Invalid password upgrade token claims");
  }
  return {
    userId: Number(claims["userId"]),
    credentialStamp: claims["credentialStamp"],
    tokenId: claims["jti"],
  };
}
