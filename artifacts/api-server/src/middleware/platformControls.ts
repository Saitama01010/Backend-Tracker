import { randomUUID } from "node:crypto";
import compression from "compression";
import cors, { type CorsOptions } from "cors";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import helmet from "helmet";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const DEFAULT_JSON_LIMIT = "100kb";
const DEFAULT_FORM_LIMIT = "100kb";
const DEFAULT_WEBHOOK_LIMIT = "1mb";
const DEFAULT_SAMIA_LIMIT = "8mb";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

type Environment = NodeJS.ProcessEnv;
type ErrorBody = Record<string, unknown>;

export const BODY_LIMITS = Object.freeze({
  json: DEFAULT_JSON_LIMIT,
  form: DEFAULT_FORM_LIMIT,
  webhook: DEFAULT_WEBHOOK_LIMIT,
  samia: DEFAULT_SAMIA_LIMIT,
});

export class PlatformHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformHttpError";
  }
}

function isProduction(environment: Environment): boolean {
  return (
    environment["NODE_ENV"] === "production" || environment["VERCEL"] === "1"
  );
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function trustedCorsOrigins(
  environment: Environment = process.env,
): ReadonlySet<string> {
  const configured = [
    environment["FRONTEND_ORIGIN"],
    environment["CORS_ORIGIN"],
    environment["PUBLIC_APP_ORIGIN"],
    environment["RENDER_EXTERNAL_URL"],
  ]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  if (environment["VERCEL_URL"])
    configured.push(`https://${environment["VERCEL_URL"]}`);

  if (!isProduction(environment)) {
    const dashboardPort = environment["DASHBOARD_PORT"]?.trim() || "3000";
    configured.push(
      `http://localhost:${dashboardPort}`,
      `http://127.0.0.1:${dashboardPort}`,
    );
  }

  const origins = new Set<string>();
  for (const value of configured) {
    const normalized = normalizeOrigin(value);
    if (!normalized)
      throw new Error(`Invalid trusted browser origin configuration: ${value}`);
    origins.add(normalized);
  }
  return origins;
}

export function createCorsMiddleware(
  environment: Environment = process.env,
): RequestHandler {
  const trustedOrigins = trustedCorsOrigins(environment);
  const options: CorsOptions = {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
    exposedHeaders: ["Content-Disposition", "Retry-After", "X-Request-ID"],
    maxAge: 600,
    origin(origin, callback) {
      if (!origin || trustedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(
        new PlatformHttpError(
          403,
          "CORS_ORIGIN_DENIED",
          "Origin is not allowed.",
        ),
      );
    },
  };
  return cors(options);
}

export function requestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.get("x-request-id")?.trim();
  req.requestId =
    incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
}

export function securityHeaders(
  environment: Environment = process.env,
): RequestHandler {
  const production = isProduction(environment);
  return helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    strictTransportSecurity: production
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        workerSrc: ["'self'", "blob:"],
        upgradeInsecureRequests: production ? [] : null,
      },
    },
  });
}

export function privateApiCache(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

export function responseCompression(): RequestHandler {
  return compression({
    threshold: "1kb",
    filter(_req, res) {
      const disposition = String(
        res.getHeader("Content-Disposition") ?? "",
      ).toLowerCase();
      const contentType = String(
        res.getHeader("Content-Type") ?? "",
      ).toLowerCase();
      if (
        disposition.includes("attachment") ||
        contentType.includes("spreadsheetml") ||
        contentType.includes("text/event-stream")
      ) {
        return false;
      }
      return compression.filter(_req, res);
    },
  });
}

function statusErrorCode(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "RATE_LIMITED";
    case 502:
      return "UPSTREAM_ERROR";
    case 503:
      return "SERVICE_UNAVAILABLE";
    case 504:
      return "GATEWAY_TIMEOUT";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
  }
}

function statusErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return "Invalid request.";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not found.";
    case 405:
      return "Method not allowed.";
    case 409:
      return "Request conflict.";
    case 413:
      return "Request payload is too large.";
    case 415:
      return "Unsupported media type.";
    case 422:
      return "Request could not be processed.";
    case 429:
      return "Too many requests. Try again later.";
    case 502:
      return "Upstream service is temporarily unavailable.";
    case 503:
      return "Service is temporarily unavailable.";
    case 504:
      return "Upstream request timed out.";
    default:
      return status >= 500 ? "Internal server error." : "Request failed.";
  }
}

function publicMessage(body: ErrorBody, status: number): string {
  if (status >= 500) return statusErrorMessage(status);
  const candidate = body["error"];
  if (
    typeof candidate !== "string" ||
    !candidate.trim() ||
    candidate.length > 300
  ) {
    return statusErrorMessage(status);
  }
  const unsafe =
    /(?:bearer\s+|authorization|cookie|password|api[_-]?key|secret|signature|postgres(?:ql)?:|file:\/\/|\bselect\b.+\bfrom\b|\binsert\b.+\binto\b|\bupdate\b.+\bset\b|[A-Za-z]:\\|\\\\[^\\]+\\|\/(?:app|home|opt|srv|tmp|usr|var|workspace)\/|\n\s*at\s)/i;
  return unsafe.test(candidate) ? statusErrorMessage(status) : candidate;
}

export function stableErrorResponses(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode < 400) return originalJson(body);
    const record =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as ErrorBody)
        : {};
    const configuredCode =
      typeof record["code"] === "string" &&
      ERROR_CODE_PATTERN.test(record["code"])
        ? (record["code"] as string)
        : statusErrorCode(res.statusCode);
    return originalJson({
      ...record,
      error: publicMessage(record, res.statusCode),
      code: configuredCode,
      requestId: res.getHeader("X-Request-ID"),
    });
  }) as Response["json"];
  next();
}

export function apiNotFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "API route was not found." });
}

function classifyError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof PlatformHttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const parsed =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  switch (parsed["type"]) {
    case "entity.too.large":
    case "parameters.too.many":
      return {
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: statusErrorMessage(413),
      };
    case "entity.parse.failed":
      return {
        status: 400,
        code: "INVALID_JSON",
        message: "Request body is not valid JSON.",
      };
    case "encoding.unsupported":
      return {
        status: 415,
        code: "UNSUPPORTED_CONTENT_ENCODING",
        message: statusErrorMessage(415),
      };
    case "request.aborted":
      return {
        status: 400,
        code: "REQUEST_ABORTED",
        message: "Request was not completed.",
      };
    default:
      return {
        status: 500,
        code: "INTERNAL_ERROR",
        message: statusErrorMessage(500),
      };
  }
}

export const sanitizedErrorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const classified = classifyError(error);
  req.log?.error(
    {
      err: error,
      requestId: req.requestId,
      statusCode: classified.status,
      errorCode: classified.code,
    },
    "API request failed",
  );
  res.status(classified.status).json({
    error: classified.message,
    code: classified.code,
    requestId: req.requestId,
  });
};
