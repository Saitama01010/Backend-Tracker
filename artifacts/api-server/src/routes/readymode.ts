import { Router } from "express";
import { performance } from "node:perf_hooks";
import { parseReadymodeRows } from "../integrations/readymode/csvParser.js";
import { probeReadyModePath, resetReadyModeSession } from "../integrations/readymode/htmlProbe.js";
import { persistReadyModeUpload, prepareReadyModeUpload } from "../integrations/readymode/importer.js";
import { approvedReadyModeProbePath } from "../lib/externalIntegrationPolicy.js";
import { logger as rootLogger } from "../lib/logger";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { canAccessDateRange } from "../middleware/authorizationCore.js";
import { retentionReadyModeService } from "../modules/retention/retention.readymode.service.js";
import {
  retentionReadyModeDateInput,
  validateRetentionReadyModeQuery,
} from "../modules/retention/retention.schemas.js";
export type { RetentionReadyModeStatsResponse as RmStatsResponse } from "../modules/retention/retention.types.js";

const router = Router();
router.use("/readymode", requireAuth);

function roundedTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * GET /api/readymode/stats
 * Returns the existing ReadyMode compatibility response. The route retains
 * validation, authorization ordering, HTTP headers, and error translation;
 * source/cache/merge orchestration lives in the Retention application service.
 */
router.get("/readymode/stats", async (req, res) => {
  const log = req.log ?? rootLogger;
  const dateInput = retentionReadyModeDateInput(req.query);
  if (!canAccessDateRange(req.user!, [dateInput.fromIso, dateInput.toIso])) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const parsed = validateRetentionReadyModeQuery(dateInput);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const requestStartedAt = performance.now();
  try {
    const result = await retentionReadyModeService.getStats({
      actor: req.user!,
      query: parsed.query,
      log,
    });
    const serializeStartedAt = performance.now();
    const body = JSON.stringify(result.response);
    const serializeMs = roundedTiming(performance.now() - serializeStartedAt);
    res.set("Cache-Control", "private, no-store");
    res.set("X-ReadyMode-Cache", result.cache);
    res.set("X-Data-Stale", result.stale ? "true" : "false");
    res.set("X-Result-Rows", String(result.rowCount));
    res.set("Server-Timing", [
      `provider;dur=${result.providerMs}`,
      `db;dur=${result.databaseMs}`,
      `parse;dur=${result.parseMs}`,
      `authz;dur=${result.authorizationMs}`,
      `authn;dur=${req.authTimingMs ?? 0}`,
      `transform;dur=${result.transformMs}`,
      `serialize;dur=${serializeMs}`,
      `app;dur=${roundedTiming(performance.now() - requestStartedAt)}`,
    ].join(", "));
    if (result.stale) res.set("Warning", '110 - "ReadyMode response is stale after a refresh failure"');
    return res.type("application/json").send(body);
  } catch (err) {
    log.error({ err }, "readymode/stats error");
    return res.status(500).json({ error: "ReadyMode statistics are temporarily unavailable." });
  }
});

/**
 * GET /api/readymode/probe?path=/approved/path
 * Admin-only diagnostic for approved ReadyMode paths. It returns response
 * metadata only and rejects redirects and response bodies.
 */
router.get("/readymode/probe", requireRole("admin"), async (req, res) => {
  const log = req.log ?? rootLogger;
  const path = approvedReadyModeProbePath(req.query["path"] ?? "/");
  if (!path) {
    res.status(400).json({ error: "ReadyMode probe path is not approved." });
    return;
  }
  try {
    const result = await probeReadyModePath(path);
    res.json({
      path,
      status: result.status,
      isJson: result.isJson,
      bodyLength: result.bodyLength,
    });
  } catch (err) {
    log.error({ err }, "readymode/probe error");
    res.status(500).json({ error: "ReadyMode probe failed." });
  }
});

/**
 * POST /api/readymode/upload
 * Body: { csv: string, filename?: string }
 * Parses an uploaded ReadyMode daily-report CSV and upserts its per-(agent, day)
 * rows into readymode_uploads. These rows are the highest-priority source for
 * /readymode/stats, so re-uploading a day overwrites it. Admin/edit only.
 */
router.post("/readymode/upload", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  const log = req.log ?? rootLogger;
  try {
    const { csv, filename, date } = req.body as {
      csv?: unknown;
      filename?: unknown;
      date?: unknown;
    };
    if (typeof csv !== "string" || !csv.trim()) {
      return res.status(400).json({ error: "Missing csv text in request body." });
    }
    let fallbackIso: string | undefined;
    if (date !== undefined && date !== null && date !== "") {
      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
      ) {
        return res.status(400).json({ error: "Invalid date; expected a real YYYY-MM-DD date." });
      }
      fallbackIso = date;
    }
    const source = typeof filename === "string" && filename.trim() ? filename.trim() : "upload";
    const rows = parseReadymodeRows(csv, log, source, fallbackIso);
    if (rows.length === 0) {
      return res.status(400).json({
        error:
          "No valid rows found. Daily reports have no calendar date — pick the report date when uploading. Expected a ReadyMode report with Name and Logged calls columns.",
      });
    }

    const uploadedBy = req.user?.username ?? "unknown";
    const values = prepareReadyModeUpload(rows, uploadedBy);
    await persistReadyModeUpload(values);
    retentionReadyModeService.invalidateCache();

    const dates = [...new Set(values.map((value) => value.statDate))].sort();
    log.info({ rows: values.length, dates: dates.length, uploadedBy, source }, "readymode/upload stored");
    return res.json({
      ok: true,
      rowsStored: values.length,
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      days: dates.length,
    });
  } catch (err) {
    log.error({ err }, "readymode/upload error");
    return res.status(500).json({ error: "ReadyMode upload could not be processed." });
  }
});

/** Clears the cached provider session so the next request logs in again. */
router.post("/readymode/session/reset", requireRole("admin"), (_req, res) => {
  resetReadyModeSession();
  res.json({ ok: true });
});

export default router;
