import { timingSafeEqual } from "node:crypto";

export function validCronAuthorization(authorization: string | undefined, secret: string | undefined): boolean {
  const configured = secret?.trim();
  if (!configured || configured.length < 16 || !authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const expectedBytes = Buffer.from(configured, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}
