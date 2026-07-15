import app from "../app.js";
import { logger } from "../lib/logger.js";

const rawPort = process.env["BASELINE_SMOKE_PORT"] || "8085";
const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid BASELINE_SMOKE_PORT value: "${rawPort}"`);
}

const server = app.listen(port, "127.0.0.1", () => {
  logger.info({ port }, "Read-only baseline smoke server listening");
});

function shutdown() {
  server.close((error) => {
    if (error) {
      logger.error({ error }, "Read-only baseline smoke server failed to close");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
