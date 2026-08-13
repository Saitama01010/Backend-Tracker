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
    source("routes/obReport.ts"),
    source("routes/liveTransfers.ts"),
    source("lib/backgroundJobHandlers.ts"),
  ]);
  for (const route of [onboarding, liveTransfers]) {
    assert.match(route, /integrations\/quo\/transcripts\.js/);
    assert.doesNotMatch(route, /api\.openphone\.com\/v1/);
    assert.doesNotMatch(route, /fetch\([^\n]*call-transcripts/);
  }
  assert.match(backgroundHandlers, /integrations\/quo\/sync\.js/);
  await assert.rejects(access(path.join(sourceRoot, "routes/quoSync.ts")));
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
