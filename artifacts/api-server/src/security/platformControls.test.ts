import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import express, { type Express } from "express";
import {
  BODY_LIMITS,
  PlatformHttpError,
  apiNotFound,
  createCorsMiddleware,
  privateApiCache,
  requestContext,
  responseCompression,
  sanitizedErrorHandler,
  securityHeaders,
  stableErrorResponses,
  trustedCorsOrigins,
} from "../middleware/platformControls.js";
import {
  configureHttpServerPolicy,
  DEFAULT_HTTP_TIMEOUTS,
} from "../lib/httpServerPolicy.js";
import {
  LOGGER_REDACT_PATHS,
  errorForSecureLog,
  redactSensitiveLogText,
} from "../lib/logger.js";
import { privateDownloadHeaders } from "../lib/sensitiveWorkflowPolicy.js";
import { protectedActionForRequest } from "../middleware/abusePolicy.js";

async function withServer<T>(
  app: Express,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function platformHarness(): Express {
  const app = express();
  const environment = {
    NODE_ENV: "production",
    FRONTEND_ORIGIN: "https://dashboard.example.test",
  } as NodeJS.ProcessEnv;
  app.use(requestContext);
  app.use(securityHeaders(environment));
  app.use(createCorsMiddleware(environment));
  app.use(responseCompression());
  app.use(stableErrorResponses);
  app.use("/api", privateApiCache);
  app.use(
    "/api/webhook",
    express.raw({ type: "application/json", limit: BODY_LIMITS.webhook }),
  );
  app.use(express.json({ limit: BODY_LIMITS.json }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: BODY_LIMITS.form,
      parameterLimit: 1_000,
    }),
  );

  app.post("/api/json", (req, res) => res.json({ data: req.body }));
  app.post("/api/form", (req, res) => res.json({ data: req.body }));
  app.get("/api/large", (_req, res) =>
    res.json({ data: "x".repeat(4 * 1024) }),
  );
  app.get("/api/stream", (_req, res) => {
    res.type("text/event-stream");
    res.send(`data: ${"x".repeat(4 * 1024)}\n\n`);
  });
  app.post("/api/webhook", (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.json({
      sha256: createHash("sha256").update(body).digest("hex"),
      length: body.length,
    });
  });
  app.get("/api/error", () => {
    throw new Error(
      "password=do-not-leak postgres://private-db/internal_table",
    );
  });
  app.get("/api/caught-database-error", (_req, res) => {
    res.status(500).json({
      error: "relation private_users does not exist at C:\\server\\db.ts",
    });
  });
  app.get("/api/upstream-error", () => {
    throw new PlatformHttpError(
      502,
      "UPSTREAM_ERROR",
      "raw upstream response body",
    );
  });
  app.get("/api/download", (_req, res) => {
    const bytes = Buffer.from("PK\u0003\u0004sanitized-workbook-fixture");
    for (const [name, value] of Object.entries(
      privateDownloadHeaders("Fixture.xlsx"),
    )) {
      res.setHeader(name, value);
    }
    res.send(bytes);
  });
  app.use("/api", apiNotFound);
  app.use(sanitizedErrorHandler);
  return app;
}

test("normal JSON success bodies stay unchanged while private cache, request IDs, and security headers are added", async () => {
  await withServer(platformHarness(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": "fixture-request-1",
      },
      body: JSON.stringify({ totalCalls: 7 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { totalCalls: 7 } });
    assert.equal(response.headers.get("x-request-id"), "fixture-request-1");
    assert.match(response.headers.get("cache-control") ?? "", /private/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.match(
      csp,
      /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/,
    );
  });
});

test("ordinary JSON is compressed while event streams remain untransformed", async () => {
  await withServer(platformHarness(), async (baseUrl) => {
    const compressed = await fetch(`${baseUrl}/api/large`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    assert.equal(
      ((await compressed.json()) as { data: string }).data.length,
      4 * 1024,
    );

    const stream = await fetch(`${baseUrl}/api/stream`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-encoding"), null);
    assert.match(
      stream.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
  });
});

test("oversized and malformed JSON bodies use stable sanitized error contracts", async () => {
  await withServer(platformHarness(), async (baseUrl) => {
    const oversized = await fetch(`${baseUrl}/api/json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(110 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    const oversizedBody = (await oversized.json()) as Record<string, unknown>;
    assert.equal(oversizedBody["code"], "PAYLOAD_TOO_LARGE");
    assert.equal(oversizedBody["error"], "Request payload is too large.");
    assert.equal(
      oversizedBody["requestId"],
      oversized.headers.get("x-request-id"),
    );

    const malformed = await fetch(`${baseUrl}/api/json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      ((await malformed.json()) as Record<string, unknown>)["code"],
      "INVALID_JSON",
    );

    const oversizedForm = await fetch(`${baseUrl}/api/form`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${"x".repeat(110 * 1024)}`,
    });
    assert.equal(oversizedForm.status, 413);
    assert.equal(
      ((await oversizedForm.json()) as Record<string, unknown>)["code"],
      "PAYLOAD_TOO_LARGE",
    );
  });
});

test("CORS reflects only explicit trusted origins and rejects an untrusted origin", async () => {
  const origins = trustedCorsOrigins({
    NODE_ENV: "production",
    FRONTEND_ORIGIN: "https://dashboard.example.test,https://ops.example.test/",
  } as NodeJS.ProcessEnv);
  assert.deepEqual([...origins].sort(), [
    "https://dashboard.example.test",
    "https://ops.example.test",
  ]);

  await withServer(platformHarness(), async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dashboard.example.test",
      },
      body: "{}",
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "https://dashboard.example.test",
    );
    assert.equal(
      allowed.headers.get("access-control-allow-credentials"),
      "true",
    );

    const rejected = await fetch(`${baseUrl}/api/json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example.test",
      },
      body: "{}",
    });
    assert.equal(rejected.status, 403);
    const rejectedBody = (await rejected.json()) as Record<string, unknown>;
    assert.equal(rejectedBody["code"], "CORS_ORIGIN_DENIED");
    assert.equal(rejectedBody["error"], "Origin is not allowed.");
    assert.ok(rejectedBody["requestId"]);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  });
});

test("application, database-shaped, and upstream failures never expose diagnostics", async () => {
  await withServer(platformHarness(), async (baseUrl) => {
    const databaseFailure = await fetch(`${baseUrl}/api/error`);
    assert.equal(databaseFailure.status, 500);
    const databaseBody = (await databaseFailure.json()) as Record<
      string,
      unknown
    >;
    assert.equal(databaseBody["error"], "Internal server error.");
    assert.equal(databaseBody["code"], "INTERNAL_ERROR");
    assert.doesNotMatch(
      JSON.stringify(databaseBody),
      /password|postgres|internal_table|stack/i,
    );

    const caughtDatabaseFailure = await fetch(
      `${baseUrl}/api/caught-database-error`,
    );
    assert.equal(caughtDatabaseFailure.status, 500);
    const caughtDatabaseBody = (await caughtDatabaseFailure.json()) as Record<
      string,
      unknown
    >;
    assert.equal(caughtDatabaseBody["error"], "Internal server error.");
    assert.doesNotMatch(
      JSON.stringify(caughtDatabaseBody),
      /private_users|server\\db/i,
    );

    const upstreamFailure = await fetch(`${baseUrl}/api/upstream-error`);
    assert.equal(upstreamFailure.status, 502);
    const upstreamBody = (await upstreamFailure.json()) as Record<
      string,
      unknown
    >;
    assert.equal(
      upstreamBody["error"],
      "Upstream service is temporarily unavailable.",
    );
    assert.equal(upstreamBody["code"], "UPSTREAM_ERROR");
    assert.doesNotMatch(JSON.stringify(upstreamBody), /raw upstream response/i);

    const missing = await fetch(`${baseUrl}/api/not-present`);
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as Record<string, unknown>)["code"],
      "NOT_FOUND",
    );
  });
});

test("private workbook downloads preserve bytes, names, cache controls, and skip compression", async () => {
  await withServer(platformHarness(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/download`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /spreadsheetml/);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="Fixture.xlsx"',
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-transform/);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(
      Buffer.from(await response.arrayBuffer()).toString(),
      "PK\u0003\u0004sanitized-workbook-fixture",
    );
  });
});

test("webhook parsing retains exact raw bytes before the general JSON parser", async () => {
  await withServer(platformHarness(), async (baseUrl) => {
    const raw = Buffer.from('{\n  "event": "sanitized", "order": [2, 1]\n}\n');
    const response = await fetch(`${baseUrl}/api/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sha256: createHash("sha256").update(raw).digest("hex"),
      length: raw.length,
    });
  });

  const appSource = await readFile(
    new URL("../app.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    appSource.indexOf("express.raw") <
      appSource.indexOf("app.use(express.json"),
  );
  assert.match(appSource, /BODY_LIMITS\.webhook/);
});

test("logger redaction covers credentials and scrubs secrets embedded in errors", () => {
  for (const required of [
    "req.headers.authorization",
    "req.headers.cookie",
    "*.password",
    "*.token",
    "*.apiKey",
    "*.webhookSignature",
  ]) {
    assert.ok(
      LOGGER_REDACT_PATHS.includes(
        required as (typeof LOGGER_REDACT_PATHS)[number],
      ),
      required,
    );
  }
  const redacted = redactSensitiveLogText(
    "Authorization: Bearer abc.def.ghi password=hunter2 api_key=private-key webhook_signature=signed-value",
  );
  assert.doesNotMatch(redacted, /abc\.def|hunter2|private-key|signed-value/);
  assert.match(redacted, /\[REDACTED\]/);

  const bodyBearingError = Object.assign(
    new Error("database failed password=private"),
    {
      body: { transcript: "must-not-be-logged" },
      headers: { authorization: "Bearer private" },
    },
  );
  const serialized = errorForSecureLog(bodyBearingError);
  assert.equal(serialized["body"], undefined);
  assert.equal(serialized["headers"], undefined);
  assert.doesNotMatch(String(serialized["message"]), /private/);
  assert.equal(
    errorForSecureLog("token=private-value")["message"],
    "token=[REDACTED]",
  );
});

test("HTTP receive/header limits do not impose a response timeout on report streams", () => {
  const server: Server = createServer();
  configureHttpServerPolicy(server, {} as NodeJS.ProcessEnv);
  assert.equal(server.headersTimeout, DEFAULT_HTTP_TIMEOUTS.headersTimeout);
  assert.equal(server.requestTimeout, DEFAULT_HTTP_TIMEOUTS.requestTimeout);
  assert.equal(server.keepAliveTimeout, DEFAULT_HTTP_TIMEOUTS.keepAliveTimeout);
  assert.equal(server.maxHeadersCount, DEFAULT_HTTP_TIMEOUTS.maxHeadersCount);
  assert.equal(server.timeout, 0);
});

test("costly diagnostics and downloads join existing durable per-user rate-limit policy", () => {
  for (const [method, path] of [
    ["GET", "/qa/download"],
    ["GET", "/ob-report/download"],
    ["GET", "/ob-analytics/download"],
    ["GET", "/live-transfers/download"],
    ["GET", "/readymode/probe"],
    ["GET", "/vos/debug/proxy"],
  ] as const) {
    assert.ok(protectedActionForRequest(method, path), `${method} ${path}`);
  }
  assert.equal(protectedActionForRequest("GET", "/quo/stats"), null);
});

test("login/dashboard contracts and middleware ordering remain wired in production source", async () => {
  const [appSource, authSource, dashboardHtml] = await Promise.all([
    readFile(new URL("../app.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/auth.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../../agent-dashboard/index.html", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(
    authSource,
    /res\.json\(\{ token: signToken\(payload\), user: publicAuthUser\(payload\) \}\)/,
  );
  assert.match(dashboardHtml, /<div id="root"><\/div>/);
  assert.doesNotMatch(appSource, /req\.headers\.host|requestHost/);
  assert.ok(
    appSource.indexOf("app.use(requestContext)") <
      appSource.indexOf('app.use("/api", router)'),
  );
  assert.ok(
    appSource.indexOf("app.use(stableErrorResponses)") <
      appSource.indexOf('app.use("/api", router)'),
  );
  assert.ok(
    appSource.indexOf('app.use("/api", router)') <
      appSource.indexOf("app.use(sanitizedErrorHandler)"),
  );
});
