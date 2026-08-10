import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

const enabled = process.env["RUN_ATTENDANCE_NOTE_INTEGRATION_TEST"] === "1";

test("attendance note set, clear, read, repeat-clear, validation, and authorization", { skip: !enabled }, async () => {
  const databaseUrl = process.env["DATABASE_URL"] ?? "";
  assert.match(databaseUrl, /test/i, "integration test requires an isolated test database URL");
  process.env["NODE_ENV"] = "test";
  process.env["SESSION_SECRET"] = "sanitized-attendance-integration-session-secret";
  process.env["ENABLE_BACKGROUND_JOBS"] = "false";

  const [{ default: app }, { pool }, { signToken }] = await Promise.all([
    import("../app.js"),
    import("@workspace/db"),
    import("../middleware/auth.js"),
  ]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const api = `http://127.0.0.1:${port}/api`;
  const usernamePrefix = `attendance-regression-${process.pid}`;
  const memberName = `Attendance Regression Agent ${process.pid}`;

  try {
    await pool.query("DELETE FROM portal_users WHERE username LIKE $1", [`${usernamePrefix}%`]);
    await pool.query("DELETE FROM attendance_members WHERE name = $1", [memberName]);
    const editor = await pool.query<{ id: number }>(
      `INSERT INTO portal_users (username, password_hash, role, permissions, active)
       VALUES ($1, 'unused-in-integration-test', 'edit', $2, true)
       RETURNING id`,
      [`${usernamePrefix}-editor`, JSON.stringify(["view_attendance", "edit_attendance"])],
    );
    const viewer = await pool.query<{ id: number }>(
      `INSERT INTO portal_users (username, password_hash, role, permissions, active)
       VALUES ($1, 'unused-in-integration-test', 'view', $2, true)
       RETURNING id`,
      [`${usernamePrefix}-viewer`, JSON.stringify(["view_attendance"])],
    );
    const member = await pool.query<{ id: number }>(
      `INSERT INTO attendance_members (name, shift, shift_hours, department, active)
       VALUES ($1, '8', '8', 'CS', true)
       RETURNING id`,
      [memberName],
    );
    const memberId = member.rows[0]!.id;
    const date = "2026-08-10";
    const editorToken = signToken({
      userId: editor.rows[0]!.id,
      username: `${usernamePrefix}-editor`,
      role: "edit",
      permissions: ["view_attendance", "edit_attendance"],
    });
    const viewerToken = signToken({
      userId: viewer.rows[0]!.id,
      username: `${usernamePrefix}-viewer`,
      role: "view",
      permissions: ["view_attendance"],
    });
    const put = (token: string, body: Record<string, unknown>) => fetch(`${api}/attendance/record`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const set = await put(editorToken, { memberId, date, status: "in", note: "sanitized note", coaching: false });
    assert.equal(set.status, 200);
    assert.equal((await set.json() as { note: string | null }).note, "sanitized note");
    assert.equal((await pool.query<{ note: string | null }>(
      "SELECT note FROM attendance_records WHERE member_id = $1 AND date = $2",
      [memberId, date],
    )).rows[0]?.note, "sanitized note");

    const clear = await put(editorToken, { memberId, date, status: "in", note: null, coaching: false });
    assert.equal(clear.status, 200);
    assert.equal((await clear.json() as { note: string | null }).note, null);
    assert.equal((await pool.query<{ note: string | null }>(
      "SELECT note FROM attendance_records WHERE member_id = $1 AND date = $2",
      [memberId, date],
    )).rows[0]?.note, null);

    const read = await fetch(`${api}/attendance?from=${date}&to=${date}`, {
      headers: { authorization: `Bearer ${editorToken}` },
    });
    assert.equal(read.status, 200);
    const readBody = await read.json() as { records: Array<{ memberId: number; note: string | null }> };
    assert.equal(readBody.records.find((record) => record.memberId === memberId)?.note, null);

    const repeatClear = await put(editorToken, { memberId, date, status: "in", note: null, coaching: false });
    assert.equal(repeatClear.status, 200);
    assert.equal((await repeatClear.json() as { note: string | null }).note, null);

    const forbidden = await put(viewerToken, { memberId, date, status: "late", note: "must not persist", coaching: false });
    assert.equal(forbidden.status, 403);
    const invalid = await put(editorToken, { memberId, date, status: "not-a-status", note: null, coaching: false });
    assert.equal(invalid.status, 400);
    const final = await pool.query<{ status: string; note: string | null }>(
      "SELECT status, note FROM attendance_records WHERE member_id = $1 AND date = $2",
      [memberId, date],
    );
    assert.deepEqual(final.rows[0], { status: "in", note: null });
  } finally {
    await pool.query("DELETE FROM portal_users WHERE username LIKE $1", [`${usernamePrefix}%`]).catch(() => undefined);
    await pool.query("DELETE FROM attendance_members WHERE name = $1", [memberName]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
