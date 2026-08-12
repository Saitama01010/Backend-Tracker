import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  BODY_LIMITS,
  apiNotFound,
  createCorsMiddleware,
  privateApiCache,
  requestContext,
  responseCompression,
  sanitizedErrorHandler,
  securityHeaders,
  stableErrorResponses,
} from "./middleware/platformControls";

const app: Express = express();

if (process.env["VERCEL"] === "1") {
  app.set("trust proxy", 1);
} else if (process.env["TRUST_PROXY_HOPS"]) {
  app.set("trust proxy", Number(process.env["TRUST_PROXY_HOPS"]));
}

app.use(requestContext);
app.use(securityHeaders());
app.use(
  pinoHttp({
    logger,
    genReqId(req) {
      return req.requestId;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(createCorsMiddleware());
app.use(responseCompression());
app.use(stableErrorResponses);
// A generous standard API ceiling complements the durable, lower per-user
// limits on login, AI, refresh, import, and sync operations. Keeping this
// recognized middleware at the API boundary prevents unbounded request floods
// while preserving provider webhook retries and health probes.
app.use("/api", rateLimit({
  windowMs: 5 * 60 * 1_000,
  limit: 1_200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => /^\/api\/(?:health(?:\/|$)|(?:quo|openphone)\/webhook(?:\/|$))/.test(req.originalUrl.split("?")[0] ?? ""),
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many requests. Try again later." });
  },
}));
app.use("/api", privateApiCache);
// Samia accepts at most two screenshots; give that authenticated route enough
// room for base64 payloads while preserving the smaller default limit elsewhere.
app.use("/api/samia/chat", express.json({ limit: BODY_LIMITS.samia }));
// Signature verification must receive the exact bytes delivered by Quo. Mount
// this before the general JSON parser so whitespace and property order are not
// changed by a parse/serialize round trip.
app.use(
  ["/api/quo/webhook", "/api/openphone/webhook"],
  express.raw({ type: "application/json", limit: BODY_LIMITS.webhook }),
);
app.use(express.json({ limit: BODY_LIMITS.json }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMITS.form, parameterLimit: 1_000 }));

app.use("/api", router);
app.use("/api", apiNotFound);

// Serve the built frontend from the same origin (single-deploy hosting, e.g.
// Render). The dashboard fetches the API via relative "/api" URLs, so no CORS
// or base-URL config is needed. Skipped in dev, where Vite serves the UI on its
// own port and this directory does not exist.
const clientDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-dashboard/dist/public",
);
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  // SPA fallback: send index.html for non-API GET requests so client-side
  // routing works on deep links / refresh.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(clientDir, "index.html"));
  });
  logger.info({ clientDir }, "Serving built frontend");
}

app.use(sanitizedErrorHandler);

export default app;
