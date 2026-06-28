import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
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
const configuredOrigins = (process.env["FRONTEND_ORIGIN"] ?? process.env["CORS_ORIGIN"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (configuredOrigins.length === 0 && process.env.NODE_ENV !== "production") return cb(null, true);
    if (configuredOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS origin not allowed"));
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

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

export default app;
