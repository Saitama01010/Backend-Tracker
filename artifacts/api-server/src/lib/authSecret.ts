const isProduction = () => process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1";

export function authSigningSecret(): string {
  const value = process.env["SESSION_SECRET"];
  if (value) return value;
  if (isProduction()) {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return "dev-secret-change-me";
}
