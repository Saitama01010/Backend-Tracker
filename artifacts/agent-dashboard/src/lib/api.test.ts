import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiHttpError,
  ApiUnauthorizedError,
  apiBlobWithRuntime,
  apiFetchWithRuntime,
  apiJsonWithRuntime,
  type ApiClientRuntime,
} from "./api.js";

function runtimeFor(
  responder: (input: URL, init?: RequestInit) => Response | Promise<Response>,
  token = "sanitized-test-token",
) {
  const requests: Array<{ input: URL; init?: RequestInit }> = [];
  let unauthorizedCount = 0;
  const runtime: ApiClientRuntime = {
    origin: "https://dashboard.example.test",
    getToken: () => token,
    onUnauthorized: () => { unauthorizedCount += 1; },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push({ input: url, init });
      return responder(url, init);
    }) as typeof fetch,
  };
  return { runtime, requests, unauthorizedCount: () => unauthorizedCount };
}

test("private API requests preserve options and add bearer authentication for every HTTP method", async () => {
  const { runtime, requests } = runtimeFor(() => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    await apiFetchWithRuntime("/api/private?fixture=1", {
      method,
      headers: { "X-Fixture": "preserved" },
      ...(method === "GET" ? {} : { body: JSON.stringify({ fixture: true }) }),
    }, runtime);
  }

  assert.equal(requests.length, 5);
  for (const request of requests) {
    const headers = new Headers(request.init?.headers);
    assert.equal(request.input.href, "https://dashboard.example.test/api/private?fixture=1");
    assert.equal(headers.get("Authorization"), "Bearer sanitized-test-token");
    assert.equal(headers.get("X-Fixture"), "preserved");
  }
  assert.deepEqual(requests.map(({ init }) => init?.method), ["GET", "POST", "PUT", "PATCH", "DELETE"]);
});

test("public API requests omit tokens and leave login 401 responses available to the caller", async () => {
  const { runtime, requests, unauthorizedCount } = runtimeFor(() => new Response(
    JSON.stringify({ error: "Invalid credentials" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  ));

  const response = await apiFetchWithRuntime("/api/auth/login", { method: "POST", auth: "none" }, runtime);

  assert.equal(response.status, 401);
  assert.equal(new Headers(requests[0]?.init?.headers).has("Authorization"), false);
  assert.equal(unauthorizedCount(), 0);
});

test("private 401 responses clear the authenticated session through one consistent callback", async () => {
  const { runtime, unauthorizedCount } = runtimeFor(() => new Response(null, { status: 401 }));

  await assert.rejects(
    apiFetchWithRuntime("/api/private", {}, runtime),
    (error: unknown) => error instanceof ApiUnauthorizedError && error.status === 401,
  );
  assert.equal(unauthorizedCount(), 1);
});

test("the API client refuses third-party URLs before fetch and never exposes the token", async () => {
  const { runtime, requests } = runtimeFor(() => new Response(null, { status: 200 }));

  await assert.rejects(
    apiFetchWithRuntime("https://third-party.example/api", {}, runtime),
    /same-origin/,
  );
  assert.equal(requests.length, 0);
});

test("JSON and blob helpers preserve response types and surface non-authentication failures", async () => {
  const jsonRuntime = runtimeFor(() => new Response(JSON.stringify({ total: 7 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })).runtime;
  assert.deepEqual(await apiJsonWithRuntime<{ total: number }>("/api/stats", {}, jsonRuntime), { total: 7 });

  const blobRuntime = runtimeFor(() => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
    status: 200,
    headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  })).runtime;
  const workbook = await apiBlobWithRuntime("/api/export", {}, blobRuntime);
  assert.deepEqual(Array.from(new Uint8Array(await workbook.arrayBuffer())), [0x50, 0x4b, 0x03, 0x04]);

  const failedRuntime = runtimeFor(() => new Response(null, { status: 503 })).runtime;
  await assert.rejects(
    apiJsonWithRuntime("/api/stats", {}, failedRuntime),
    (error: unknown) => error instanceof ApiHttpError && error.status === 503,
  );
});
