import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("third-party workflow actions are pinned to immutable commits", async () => {
  const workflows = await Promise.all([
    read(".github/workflows/ci.yml"),
    read(".github/workflows/security.yml"),
  ]);
  const uses = workflows.flatMap((workflow) =>
    [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(
      (match) => match[1],
    ),
  );

  assert.ok(uses.length >= 8);
  for (const action of uses) {
    assert.match(
      action,
      /@[0-9a-f]{40}$/i,
      `${action} must use a full commit SHA`,
    );
  }
});

test("security reports stay ephemeral and are never uploaded", async () => {
  const workflow = await read(".github/workflows/security.yml");

  assert.match(workflow, /RUNNER_TEMP/);
  assert.doesNotMatch(workflow, /upload-artifact/i);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /--redact=100/);
  assert.match(workflow, />\s*"\$RUNNER_TEMP\/gitleaks\.log"\s+2>&1/);
  assert.match(
    workflow,
    /edcfc41d257db36148f065055655fe3fcfc434b0b423ea67468a84c207524e0c/,
  );
  assert.match(
    workflow,
    /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/,
  );
});

test("PR security checks cover dependencies, OSV, secrets, and CodeQL", async () => {
  const workflow = await read(".github/workflows/security.yml");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /pnpm run audit:dependencies/);
  assert.match(workflow, /osv-scanner/);
  assert.match(workflow, /gitleaks/);
  assert.match(workflow, /github\/codeql-action\/analyze/);
});

test("scanner exceptions remain narrow and time bounded", async () => {
  const [osv, gitleaks] = await Promise.all([
    read("osv-scanner.toml"),
    read(".gitleaksignore"),
  ]);

  assert.equal((osv.match(/\[\[IgnoredVulns\]\]/g) ?? []).length, 1);
  assert.match(osv, /id = "GHSA-w5hq-g745-h8pq"/);
  assert.match(osv, /ignoreUntil = 2026-11-08/);

  const gitleaksEntries = gitleaks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(gitleaksEntries.sort(), [
    "2694da7e4c8a43a6c1eaa641669339e6ce3c57ae:artifacts/api-server/src/security/backgroundJobs.test.ts:generic-api-key:230",
    "6b751acf4bc47de775ef9d435a1fd690ae86f4cf:.replit:generic-api-key:54",
    "artifacts/api-server/src/security/backgroundJobs.test.ts:generic-api-key:230",
    "fa47625f200a92daaddfc69bcc1e4c8ffceee8ad:.replit:generic-api-key:41",
  ].sort());
});
