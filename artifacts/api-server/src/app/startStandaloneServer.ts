import app from "../app.js";
import { configureHttpServerPolicy } from "../lib/httpServerPolicy.js";
import { logger } from "../lib/logger.js";
import { validateOperationalConfiguration } from "../lib/operationalConfig.js";
import { standalonePort } from "./standaloneConfig.js";
import { runStartupDatabaseTasks } from "./startupDatabase.js";

export function startStandaloneServer(environment: NodeJS.ProcessEnv = process.env) {
  const operationalConfig = validateOperationalConfiguration();
  logger.info({
    businessTimeZone: operationalConfig.businessTimeZone,
    staffTimeZone: operationalConfig.staffTimeZone,
    attendanceShiftTimezoneCutover: operationalConfig.attendanceShiftTimezoneCutover,
    attendanceImportSources: operationalConfig.attendanceImportSources.length,
  }, "Validated operational configuration");

  const port = standalonePort(environment);
  const server = app.listen(port, async (error) => {
    if (error) {
      logger.error({ err: error }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    await runStartupDatabaseTasks(environment);
  });
  configureHttpServerPolicy(server, environment);
  return server;
}
