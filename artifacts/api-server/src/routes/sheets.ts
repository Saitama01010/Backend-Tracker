import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { parseRetentionSheetQuery } from "../modules/retention/retention.schemas.js";
import {
  retentionService,
  RetentionSheetForbiddenError,
  RetentionSheetNotFoundError,
  RetentionSheetSourceNotApprovedError,
  RetentionSheetSourcePolicyError,
} from "../modules/retention/retention.service.js";

const router = Router();
router.use("/sheet", requireAuth);

// Compatibility endpoint consumed by Retention, CS, NSF, Killers, and Backend
// Statistics. Validation and HTTP translation stay here; source/cache/scoping
// orchestration lives in the framework-independent Retention application slice.
router.get("/sheet", async (req, res) => {
  const parsed = parseRetentionSheetQuery(req.query);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const { spreadsheetId, gid } = parsed.query;
  try {
    const result = await retentionService.getDashboardSheet({
      actor: req.user!,
      query: parsed.query,
    });
    const serializeStartedAt = performance.now();
    const body = JSON.stringify(result.payload);
    const serializeMs = Math.round((performance.now() - serializeStartedAt) * 100) / 100;
    const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;

    res.set("Cache-Control", "private, max-age=0, must-revalidate");
    res.set("Vary", "Authorization");
    res.set("ETag", etag);
    res.set("X-Sheet-Cache", result.cache);
    res.set("X-Data-Stale", result.stale ? "true" : "false");
    res.set("X-Source-Updated-At", result.fetchedAt.toISOString());
    res.set("X-Rows-Returned", String(result.rowsReturned));
    res.set("Server-Timing", [
      `provider;dur=${result.providerMs}`,
      `parse;dur=${result.parseMs}`,
      `authz;dur=${result.authorizationMs}`,
      `authn;dur=${req.authTimingMs ?? 0}`,
      `serialize;dur=${serializeMs}`,
    ].join(", "));
    if (result.stale) res.set("Warning", '110 - "Google Sheets response is stale after a refresh failure"');
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.type("application/json").send(body);
  } catch (error) {
    if (error instanceof RetentionSheetSourcePolicyError) {
      req.log.error("Google Sheets source allowlist configuration is invalid");
      res.status(500).json({ error: "Google Sheets source policy is not configured correctly." });
      return;
    }
    if (error instanceof RetentionSheetSourceNotApprovedError) {
      res.status(403).json({ error: "Spreadsheet source is not approved." });
      return;
    }
    if (error instanceof RetentionSheetNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof RetentionSheetForbiddenError) {
      res.status(403).json({ error: "Forbidden", reason: error.reason });
      return;
    }
    req.log.error({ err: error, spreadsheetId, gid }, "sheet fetch failed");
    res.status(502).json({ error: "Fetch failed" });
  }
});

export default router;
