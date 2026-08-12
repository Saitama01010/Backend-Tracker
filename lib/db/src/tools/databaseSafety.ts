export const EMPTY_DATABASE_ACKNOWLEDGEMENT =
  "I_ACKNOWLEDGE_THIS_IS_EMPTY_AND_NON_PRODUCTION";

const SAFE_DATABASE_NAME =
  /(?:test|staging|stage|preview|ephemeral|disposable|local|bootstrap)/i;

export interface DatabaseSafetyResult {
  databaseName: string;
  safeEnvironment: boolean;
  safeName: boolean;
  productionIndicator: boolean;
}

export function databaseSafety(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseSafetyResult {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const declaredEnvironment = (
    environment["DATABASE_ENVIRONMENT"] ??
    environment["VERCEL_ENV"] ??
    environment["NODE_ENV"] ??
    ""
  ).toLowerCase();
  const productionIndicator =
    declaredEnvironment === "production" ||
    environment["VERCEL_TARGET_ENV"]?.toLowerCase() === "production" ||
    /(?:^|[_-])prod(?:uction)?(?:$|[_-])/i.test(databaseName);
  return {
    databaseName,
    safeEnvironment: ["test", "development", "staging", "preview"].includes(
      declaredEnvironment,
    ),
    safeName: SAFE_DATABASE_NAME.test(databaseName),
    productionIndicator,
  };
}

export function requireEmptyDatabaseBootstrapSafety(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseSafetyResult {
  const safety = databaseSafety(databaseUrl, environment);
  if (
    environment["EMPTY_DATABASE_BOOTSTRAP_ACK"] !==
    EMPTY_DATABASE_ACKNOWLEDGEMENT
  ) {
    throw new Error("EMPTY_DATABASE_BOOTSTRAP_ACK_REQUIRED");
  }
  if (
    safety.productionIndicator ||
    !safety.safeEnvironment ||
    !safety.safeName
  ) {
    throw new Error("EMPTY_DATABASE_BOOTSTRAP_SAFETY_REFUSAL");
  }
  return safety;
}
