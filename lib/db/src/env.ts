import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

function findEnvFile(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, ".env");
    if (existsSync(candidate)) return candidate;
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return null;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function candidateStartDirs(): string[] {
  const dirs = [process.cwd()];
  try {
    dirs.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // import.meta.url is available in normal ESM execution; this keeps bundled
    // edge cases from blocking startup.
  }
  return [...new Set(dirs)];
}

function parseEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  const quote = value[0];

  if (
    (quote === `"` || quote === "'") &&
    value.length >= 2 &&
    value[value.length - 1] === quote
  ) {
    value = value.slice(1, -1);
    if (quote === `"`) {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, `"`)
        .replace(/\\\\/g, "\\");
    }
    return value;
  }

  const commentIndex = value.search(/\s#/);
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;

  const envFile = candidateStartDirs()
    .map((dir) => findEnvFile(dir))
    .find((file): file is string => Boolean(file));

  if (!envFile) return;

  const lines = readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = parseEnvValue(rawValue);
    if (value && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();
