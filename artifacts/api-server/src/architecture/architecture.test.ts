import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { standalonePort } from "../app/standaloneConfig.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(sourceRoot, relativePath), "utf8");
}

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [absolute];
  }));
  return files.flat();
}

function relativeImports(contents: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["'](\.[^"']+)["']/g;
  for (const match of contents.matchAll(pattern)) imports.push(match[1]!);
  return imports;
}

function resolveTypeScriptImport(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  const withoutJavaScriptExtension = specifier.replace(/\.js$/, "");
  const base = path.resolve(path.dirname(from), withoutJavaScriptExtension);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

test("standalone port validation preserves the previous startup contract", () => {
  assert.equal(standalonePort({ PORT: "5000" }), 5000);
  assert.throws(() => standalonePort({}), /PORT environment variable is required/);
  assert.throws(() => standalonePort({ PORT: "invalid" }), /Invalid PORT value/);
  assert.throws(() => standalonePort({ PORT: "0" }), /Invalid PORT value/);
});

test("middleware and application startup have one canonical owner", async () => {
  const files = await productionTypeScriptFiles(sourceRoot);
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  assert.ok(files.some((file) => file.endsWith(path.join("middleware", "auth.ts"))));
  assert.equal(files.some((file) => file.includes(`${path.sep}middlewares${path.sep}`)), false);
  assert.equal(sources.some((contents) => /["'][^"']*middlewares\//.test(contents)), false);

  const [entrypoint, standalone, startupDatabase] = await Promise.all([
    source("index.ts"),
    source("app/startStandaloneServer.ts"),
    source("app/startupDatabase.ts"),
  ]);
  assert.match(entrypoint, /startStandaloneServer\(\)/);
  assert.doesNotMatch(entrypoint, /@workspace\/db|app\.listen|process\.env/);
  assert.match(standalone, /app\.listen/);
  assert.match(standalone, /runStartupDatabaseTasks/);
  assert.doesNotMatch(startupDatabase, /\bexpress\b|app\.listen|configureHttpServerPolicy/);
});

test("Quo provider operations with established boundaries stay out of HTTP routes", async () => {
  const [onboarding, liveTransfers, backgroundHandlers] = await Promise.all([
    source("modules/onboarding/report.ts"),
    source("modules/transfers/liveTransfers.ts"),
    source("lib/backgroundJobHandlers.ts"),
  ]);
  for (const route of [onboarding, liveTransfers]) {
    assert.match(route, /integrations\/quo\/transcripts\.js/);
    assert.doesNotMatch(route, /call-transcripts/);
  }
  assert.match(backgroundHandlers, /integrations\/quo\/sync\.js/);
  await assert.rejects(access(path.join(sourceRoot, "routes/quoSync.ts")));
});

test("migrated dashboard routes delegate provider transport and raw parsing to source adapters", async () => {
  const [
    quo,
    retentionQuoService,
    retentionQuoRepository,
    retentionQuoLiveService,
    retentionQuoLiveRepository,
    retentionQuoCallsService,
    sheets,
    retentionService,
    retentionRepository,
    readymode,
    retentionReadyModeService,
    vos,
    retentionPbxService,
    retentionPbxRepository,
  ] = await Promise.all([
    source("routes/quo.ts"),
    source("modules/retention/retention.quo.service.ts"),
    source("modules/retention/retention.quo.repository.ts"),
    source("modules/retention/retention.quo.live.service.ts"),
    source("modules/retention/retention.quo.live.repository.ts"),
    source("modules/retention/retention.quo.calls.service.ts"),
    source("routes/sheets.ts"),
    source("modules/retention/retention.service.ts"),
    source("modules/retention/retention.repository.ts"),
    source("routes/readymode.ts"),
    source("modules/retention/retention.readymode.service.ts"),
    source("routes/vos.ts"),
    source("modules/retention/retention.pbx.service.ts"),
    source("modules/retention/retention.pbx.repository.ts"),
  ]);

  assert.match(quo, /integrations\/quo\/client\.js/);
  assert.doesNotMatch(quo, /api\.openphone\.com|QUO_API_KEY|fetchQuoJson|fetchAllQuoPages|nextPageToken|pageToken|\bfetch\s*\(/);
  const optimizedStatsHandler = quo.slice(
    quo.indexOf("export async function optimizedQuoStatsHandler"),
    quo.indexOf('router.get("/quo/stats", optimizedQuoStatsHandler)'),
  );
  assert.match(optimizedStatsHandler, /retentionQuoStatsService\.getStats/);
  assert.doesNotMatch(optimizedStatsHandler, /loadPhoneStatsAggregates|phoneStatsResponseCache|teamStats\s*:/);
  assert.match(retentionQuoService, /retention\.quo\.repository\.js/);
  assert.doesNotMatch(retentionQuoService, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(retentionQuoService, /@workspace\/db|drizzle-orm/);
  assert.match(retentionQuoRepository, /loadPhoneStatsAggregates/);
  assert.doesNotMatch(retentionQuoRepository, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  const optimizedLiveHandler = quo.slice(
    quo.indexOf("export async function optimizedQuoLiveHandler"),
    quo.indexOf('router.get("/quo/live", optimizedQuoLiveHandler)'),
  );
  assert.match(optimizedLiveHandler, /retentionQuoLiveService\.getLiveStatus/);
  assert.doesNotMatch(optimizedLiveHandler, /@workspace\/db|durableRuntimeState|buildLiveStatusSnapshot/);
  assert.match(retentionQuoLiveService, /retention\.quo\.live\.repository\.js/);
  assert.doesNotMatch(retentionQuoLiveService, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(retentionQuoLiveService, /@workspace\/db|drizzle-orm/);
  assert.match(retentionQuoLiveRepository, /@workspace\/db/);
  assert.doesNotMatch(retentionQuoLiveRepository, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  const callsHandler = quo.slice(
    quo.indexOf('router.get("/quo/calls"'),
    quo.indexOf("export { router as quoRouter }"),
  );
  assert.match(callsHandler, /retentionQuoCallsService\.listCalls/);
  assert.doesNotMatch(callsHandler, /@workspace\/db|phoneCallsTable|paginateAuthorizedBatches/);
  assert.match(retentionQuoCallsService, /retention\.quo\.repository\.js/);
  assert.doesNotMatch(retentionQuoCallsService, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(retentionQuoCallsService, /@workspace\/db|drizzle-orm/);

  assert.match(sheets, /modules\/retention\/retention\.service\.js/);
  assert.doesNotMatch(sheets, /@workspace\/db|drizzle-orm|integrations\/googleSheets/);
  assert.doesNotMatch(sheets, /sheets\.googleapis\.com|oauth2\.googleapis\.com|GOOGLE_(?:SA|SERVICE_ACCOUNT)|\bfetch\s*\(/);
  assert.match(retentionService, /integrations\/googleSheets\/(?:client|mapper)\.js/);
  assert.match(retentionService, /retention\.repository\.js/);
  assert.doesNotMatch(retentionService, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(retentionService, /@workspace\/db|drizzle-orm/);
  assert.match(retentionRepository, /@workspace\/db/);
  assert.doesNotMatch(retentionRepository, /from ["']express["']|integrations\//);

  assert.match(readymode, /modules\/retention\/retention\.readymode\.service\.js/);
  assert.match(readymode, /integrations\/readymode\/(?:csvParser|htmlProbe|importer)\.js/);
  assert.doesNotMatch(readymode, /@workspace\/db|drizzle-orm|integrations\/readymode\/client\.js/);
  assert.doesNotMatch(readymode, /icydeals\.readymode\.com|READYMODE_(?:USERNAME|PASSWORD|CSV_URL)|login_new|node:fs|node:path|\bfetch\s*\(/);
  assert.match(retentionReadyModeService, /integrations\/readymode\/(?:client|csvParser)\.js/);
  assert.match(retentionReadyModeService, /retention\.repository\.js/);
  assert.doesNotMatch(retentionReadyModeService, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(retentionReadyModeService, /@workspace\/db|drizzle-orm/);

  assert.match(vos, /modules\/pbx\/pbx\.dashboard\.service\.js/);
  assert.doesNotMatch(vos, /phonesystem\.voslogic\.com|VOSLOGIC_(?:EMAIL|PASSWORD)|\/api\/auth\/login|\bfetch\s*\(/);
  const statsHandler = vos.slice(
    vos.indexOf('router.get("/vos/stats"'),
    vos.indexOf('router.get("/vos/missed-no-callback"'),
  );
  const liveHandler = vos.slice(
    vos.indexOf('router.get("/vos/live"'),
    vos.indexOf('router.get("/vos/debug/calls"'),
  );
  assert.match(statsHandler, /pbxDashboardService\.getStats/);
  assert.match(liveHandler, /pbxDashboardService\.getLive/);
  assert.doesNotMatch(`${statsHandler}\n${liveHandler}`, /fetchPbxJson|canAccess(?:Metric|Live)Agent|loadAuthorizationAgentDirectory/);
  assert.match(retentionPbxService, /retention\.pbx\.repository\.js/);
  assert.match(retentionPbxService, /integrations\/pbx\/client\.js/);
  assert.doesNotMatch(retentionPbxService, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(retentionPbxService, /@workspace\/db|drizzle-orm/);
  assert.match(retentionPbxRepository, /backgroundJobStore/);
  assert.doesNotMatch(retentionPbxRepository, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
});

test("onboarding analytics keeps HTTP concerns out of its application module", async () => {
  const [route, analytics] = await Promise.all([
    source("routes/obAnalytics.ts"),
    source("modules/onboarding/analytics.ts"),
  ]);
  assert.match(route, /computeOnboardingAnalytics/);
  assert.match(route, /buildOnboardingAnalyticsWorkbook/);
  assert.doesNotMatch(route, /@workspace\/db|drizzle-orm|ExcelJS/);
  assert.doesNotMatch(analytics, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(analytics, /router\.(?:get|post|put|patch|delete)\(/);
});

test("onboarding reporting keeps HTTP concerns out of its application module", async () => {
  const [route, report, backgroundHandlers] = await Promise.all([
    source("routes/obReport.ts"),
    source("modules/onboarding/report.ts"),
    source("lib/backgroundJobHandlers.ts"),
  ]);
  for (const operation of [
    "requestOnboardingReportRefresh",
    "getOnboardingReportStatus",
    "buildOnboardingReportWorkbook",
    "importOnboardingClassifications",
  ]) {
    assert.match(route, new RegExp(`\\b${operation}\\b`));
  }
  assert.doesNotMatch(route, /@workspace\/db|drizzle-orm|ExcelJS|@anthropic-ai/);
  assert.doesNotMatch(report, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(report, /router\.(?:get|post|put|patch|delete)\(/);
  assert.match(backgroundHandlers, /modules\/onboarding\/report\.js/);
});

test("live-transfer reporting keeps HTTP concerns out of its application module", async () => {
  const [route, service, backgroundHandlers] = await Promise.all([
    source("routes/liveTransfers.ts"),
    source("modules/transfers/liveTransfers.ts"),
    source("lib/backgroundJobHandlers.ts"),
  ]);
  for (const operation of [
    "getLiveTransferStatus",
    "requestLiveTransferRefresh",
    "buildLiveTransferWorkbook",
  ]) {
    assert.match(route, new RegExp(`\\b${operation}\\b`));
  }
  assert.doesNotMatch(route, /@workspace\/db|drizzle-orm|ExcelJS|@anthropic-ai/);
  assert.doesNotMatch(route, /\bfetch\s*\(/);
  assert.doesNotMatch(service, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(service, /router\.(?:get|post|put|patch|delete)\(/);
  assert.match(backgroundHandlers, /modules\/transfers\/liveTransfers\.js/);
});

test("Attendance routes delegate application, source, and PostgreSQL work through accepted boundaries", async () => {
  const [route, service, callsService, recordService, pbxSource, repository, importIntegration] = await Promise.all([
    source("routes/attendance.ts"),
    source("modules/attendance/attendance.service.ts"),
    source("modules/attendance/attendance.calls.service.ts"),
    source("lib/attendanceService.ts"),
    source("modules/attendance/attendance.pbx.source.ts"),
    source("modules/attendance/attendance.repository.ts"),
    source("integrations/googleSheets/attendanceImport.ts"),
  ]);

  assert.doesNotMatch(route, /@workspace\/db|drizzle-orm|\bdb\.|attendanceMembersTable|attendanceRecordsTable|phoneCallsTable/);
  assert.match(repository, /@workspace\/db/);
  assert.doesNotMatch(repository, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(repository, /integrations\//);
  for (const operation of ["getDashboard", "createMember", "updateMember", "updateRecord", "importAttendance", "setRecords"]) {
    assert.match(route, new RegExp(`attendanceService\\.${operation}`));
  }
  assert.match(service, /attendance\.repository\.js/);
  assert.match(service, /integrations\/googleSheets\/attendanceImport\.js/);
  assert.doesNotMatch(service, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(service, /@workspace\/db|drizzle-orm/);
  for (const operation of ["getCallLogs", "autoMark", "getAgentContacts"]) {
    assert.match(route, new RegExp(`attendanceCallsService\\.${operation}`));
  }
  assert.match(callsService, /attendance\.repository\.js/);
  assert.match(callsService, /attendance\.pbx\.source\.js/);
  assert.doesNotMatch(callsService, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  assert.doesNotMatch(callsService, /@workspace\/db|drizzle-orm|routes\/vos/);
  assert.match(recordService, /attendance\.repository\.js/);
  assert.doesNotMatch(recordService, /@workspace\/db|drizzle-orm|\bdb\.|attendanceMembersTable|attendanceRecordsTable/);
  assert.match(pbxSource, /pbx\/pbx\.state\.js/);
  assert.doesNotMatch(pbxSource, /from ["']express["']|@workspace\/db|drizzle-orm/);
  assert.doesNotMatch(route, /attendanceRepository|@workspace\/db|drizzle-orm|routes\/vos/);
  assert.doesNotMatch(route, /loadAttendanceImportCandidates/);
  assert.doesNotMatch(route, /googleCsvUrl|attendanceImportSources|parseCsv|\bfetch\s*\(/i);
  assert.doesNotMatch(importIntegration, /from ["']express["']|@workspace\/db|drizzle-orm/);
});

test("PBX routes delegate reporting, refresh, diagnostics, state, and persistence through accepted boundaries", async () => {
  const [
    route,
    dashboardService,
    diagnosticsService,
    noCallbackService,
    refreshService,
    providerService,
    missedRepository,
    noCallbackRepository,
    refreshRepository,
    backgroundHandlers,
  ] = await Promise.all([
    source("routes/vos.ts"),
    source("modules/pbx/pbx.dashboard.service.ts"),
    source("modules/pbx/pbx.diagnostics.service.ts"),
    source("modules/pbx/pbx.no-callback.service.ts"),
    source("modules/pbx/pbx.refresh.service.ts"),
    source("modules/pbx/pbx.provider.service.ts"),
    source("modules/pbx/pbx.missed.repository.ts"),
    source("modules/pbx/pbx.no-callback.repository.ts"),
    source("modules/pbx/pbx.refresh.repository.ts"),
    source("lib/backgroundJobHandlers.ts"),
  ]);

  for (const operation of ["pbxDashboardService", "pbxNoCallbackService", "pbxRefreshService", "pbxDiagnosticsService"]) {
    assert.match(route, new RegExp(`\\b${operation}\\b`));
  }
  assert.doesNotMatch(
    route,
    /@workspace\/db|drizzle-orm|integrations\/|fetchPbxJson|approvedVosDebugPath|pbxRuntimeState|pbxMissedReportingService|retentionPbxService/,
  );

  for (const service of [dashboardService, noCallbackService, refreshService]) {
    assert.doesNotMatch(service, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(|@workspace\/db|drizzle-orm/);
  }
  assert.doesNotMatch(refreshService, /integrations\/pbx\/client|integrations\/quo\/client/);
  assert.match(providerService, /integrations\/pbx\/client\.js/);
  assert.match(providerService, /integrations\/quo\/client\.js/);
  assert.doesNotMatch(providerService, /from ["']express["']|@workspace\/db|drizzle-orm/);
  assert.match(diagnosticsService, /integrations\/pbx\/client\.js/);
  assert.doesNotMatch(diagnosticsService, /from ["']express["']|@workspace\/db|drizzle-orm/);

  for (const repository of [missedRepository, noCallbackRepository, refreshRepository]) {
    assert.match(repository, /@workspace\/db/);
    assert.doesNotMatch(repository, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(|integrations\//);
  }
  assert.match(backgroundHandlers, /modules\/pbx\/pbx\.refresh\.service\.js/);
  assert.doesNotMatch(backgroundHandlers, /routes\/vos\.js/);
});

test("QA routes delegate validation, authorization, application, persistence, and integration work", async () => {
  const [
    route,
    authorization,
    evaluationService,
    manualService,
    jobsService,
    reportingService,
    exportService,
    repository,
    backgroundHandlers,
  ] = await Promise.all([
    source("routes/qa.ts"),
    source("modules/qa/qa.authorization.ts"),
    source("modules/qa/qa.evaluation.service.ts"),
    source("modules/qa/qa.manual.service.ts"),
    source("modules/qa/qa.jobs.service.ts"),
    source("modules/qa/qa.reporting.service.ts"),
    source("modules/qa/qa.export.service.ts"),
    source("modules/qa/qa.repository.ts"),
    source("lib/backgroundJobHandlers.ts"),
  ]);

  for (const operation of [
    "qaManualEvaluationService",
    "runAdminBiweeklyQa",
    "runWeeklyAssignment",
    "enqueueScheduledBiweeklyQa",
    "qaReportingService",
    "qaExportService",
  ]) {
    assert.match(route, new RegExp(`\\b${operation}\\b`));
  }
  assert.match(route, /qa\.schemas\.js/);
  assert.match(route, /qa\.authorization\.js/);
  assert.doesNotMatch(
    route,
    /@workspace\/db|drizzle-orm|ExcelJS|@anthropic-ai|integrations\/quo|lib\/quoCall|reserveQaAgentRun|createAnthropicToolMessage|getQuoCallArtifacts|\bdb\./,
  );

  assert.match(repository, /@workspace\/db/);
  assert.doesNotMatch(repository, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(|integrations\//);
  for (const service of [authorization, evaluationService, manualService, jobsService, reportingService, exportService]) {
    assert.doesNotMatch(service, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(/);
  }
  for (const service of [evaluationService, manualService, jobsService, reportingService, exportService]) {
    assert.doesNotMatch(service, /@workspace\/db|drizzle-orm/);
  }
  assert.match(evaluationService, /qa\.repository\.js/);
  assert.match(evaluationService, /getQuoCallArtifacts/);
  assert.match(manualService, /qa\.repository\.js/);
  assert.match(manualService, /qa\.evaluation\.service\.js/);
  assert.match(manualService, /getQuoCallArtifacts/);
  assert.match(jobsService, /qa\.repository\.js/);
  assert.match(jobsService, /qa\.evaluation\.service\.js/);
  assert.match(jobsService, /getQuoCallArtifacts/);
  assert.match(reportingService, /qa\.repository\.js/);
  assert.match(exportService, /qa\.repository\.js/);
  assert.match(backgroundHandlers, /modules\/qa\/qa\.jobs\.service\.js/);
});

test("NSF ReadyMode routes delegate queue policy and PostgreSQL work through service boundaries", async () => {
  const [route, schemas, service, repository, refreshService] = await Promise.all([
    source("routes/nsfReadymode.ts"),
    source("modules/nsf/nsf.readymode.schemas.ts"),
    source("modules/nsf/nsf.readymode.service.ts"),
    source("modules/nsf/nsf.readymode.repository.ts"),
    source("modules/pbx/pbx.refresh.service.ts"),
  ]);

  assert.match(route, /nsfReadymodeService\.(?:listActive|add|markDoneById|markDoneByNumber)/);
  assert.match(route, /nsf\.readymode\.schemas\.js/);
  assert.doesNotMatch(route, /@workspace\/db|drizzle-orm|\bdb\.|nsfReadymodeQueueTable|phoneCallsTable/);

  for (const applicationSource of [schemas, service]) {
    assert.doesNotMatch(applicationSource, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(|@workspace\/db|drizzle-orm/);
  }
  assert.match(service, /nsf\.readymode\.repository\.js/);
  assert.match(repository, /@workspace\/db/);
  assert.doesNotMatch(repository, /from ["']express["']|:\s*(?:Request|Response)\b|\bRouter\(|integrations\//);
  assert.match(refreshService, /nsfReadymodeService/);
  assert.doesNotMatch(refreshService, /routes\/nsfReadymode\.js/);
});

test("the production API relative-import graph remains acyclic", async () => {
  const files = await productionTypeScriptFiles(sourceRoot);
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const imports = relativeImports(await readFile(file, "utf8"));
    graph.set(file, imports.flatMap((specifier) => {
      const resolved = resolveTypeScriptImport(file, specifier, known);
      return resolved ? [resolved] : [];
    }));
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string, stack: string[]): void => {
    if (visiting.has(file)) {
      const cycleStart = stack.indexOf(file);
      const cycle = [...stack.slice(cycleStart), file]
        .map((item) => path.relative(sourceRoot, item))
        .join(" -> ");
      assert.fail(`circular API dependency: ${cycle}`);
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency, [...stack, file]);
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of files) visit(file, []);
});
