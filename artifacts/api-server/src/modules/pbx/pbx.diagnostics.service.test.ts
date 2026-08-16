import assert from "node:assert/strict";
import test from "node:test";
import {
  PbxDiagnosticPathError,
  PbxDiagnosticsService,
} from "./pbx.diagnostics.service.js";

test("PBX diagnostics preserves encoded calls queries and response shape", async () => {
  const paths: string[] = [];
  const service = new PbxDiagnosticsService(async <T>(path: string) => {
    paths.push(path);
    return { total: 1, calls: [{ id: 7 }] } as T;
  });

  assert.deepEqual(await service.getCalls({ limit: "5", agentId: "7" }), {
    total: 1,
    calls: [{ id: 7 }],
  });
  assert.deepEqual(paths, ["/api/calls?limit=5&agentId=7"]);
});

test("PBX diagnostic proxy defaults safely and rejects unapproved paths before provider work", async () => {
  const paths: string[] = [];
  const service = new PbxDiagnosticsService(async <T>(path: string) => {
    paths.push(path);
    return { ok: true } as T;
  });

  assert.deepEqual(await service.proxy(undefined), { ok: true });
  await assert.rejects(() => service.proxy("https://example.invalid/private"), PbxDiagnosticPathError);
  assert.deepEqual(paths, ["/api/calls?limit=1"]);
});
