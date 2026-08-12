import { spawnSync } from "node:child_process";

const pnpmEntrypoint = process.env.npm_execpath;
const command = pnpmEntrypoint ? process.execPath : "pnpm";
const args = pnpmEntrypoint
  ? [pnpmEntrypoint, "audit", "--json", "--audit-level=high"]
  : ["audit", "--json", "--audit-level=high"];
const result = spawnSync(command, args, {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) {
  console.error("Dependency audit could not start.");
  process.exit(2);
}

let audit;
try {
  audit = JSON.parse(result.stdout);
} catch {
  console.error("Dependency audit returned an unreadable report.");
  process.exit(2);
}

const counts = audit?.metadata?.vulnerabilities ?? {};
const high = Number(counts.high ?? 0);
const critical = Number(counts.critical ?? 0);

if (audit?.error) {
  console.error("Dependency audit service returned an error.");
  process.exit(2);
}

if (high > 0 || critical > 0) {
  console.error(
    `Dependency audit gate failed (${critical} critical, ${high} high). Review the JSON report locally; CI intentionally does not print advisory details.`,
  );
  process.exit(1);
}

console.log(
  "Dependency audit gate passed with no high or critical advisories.",
);
