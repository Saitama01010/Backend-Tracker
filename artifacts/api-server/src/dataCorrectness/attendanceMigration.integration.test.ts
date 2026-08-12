import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env["DATA_CORRECTNESS_DATABASE_URL"];

test("attendance date migration is additive, compatible, and reversible", { skip: databaseUrl ? false : "DATA_CORRECTNESS_DATABASE_URL is not configured" }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const schema = `data_correctness_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE attendance_records (
        id serial PRIMARY KEY,
        member_id integer NOT NULL,
        date text NOT NULL,
        status text NOT NULL,
        note text,
        coaching boolean NOT NULL DEFAULT false,
        updated_at timestamp NOT NULL DEFAULT now(),
        UNIQUE (member_id, date)
      )
    `);
    await client.query(`
      INSERT INTO attendance_records (member_id, date, status, note) VALUES
        (1, '2026-02-28', 'in', 'sanitized'),
        (1, '2026-03-08', 'late', NULL),
        (2, '2026-03-09', 'off', NULL),
        (3, 'legacy-free-text', 'historic-custom', 'must survive')
    `);

    const before = await client.query(`
      SELECT member_id, date, status, note, coaching
      FROM attendance_records
      ORDER BY id
    `);
    const migrationUrl = new URL("../../../../lib/db/drizzle/0010_attendance_date_compatibility.sql", import.meta.url);
    await client.query(await readFile(migrationUrl, "utf8"));

    const after = await client.query(`
      SELECT member_id, coalesce(attendance_date::text, date) AS date, status, note, coaching
      FROM attendance_records
      ORDER BY id
    `);
    assert.deepEqual(after.rows, before.rows);
    const backfill = await client.query(`SELECT date, attendance_date::text AS attendance_date FROM attendance_records ORDER BY id`);
    assert.deepEqual(backfill.rows, [
      { date: "2026-02-28", attendance_date: "2026-02-28" },
      { date: "2026-03-08", attendance_date: "2026-03-08" },
      { date: "2026-03-09", attendance_date: "2026-03-09" },
      { date: "legacy-free-text", attendance_date: null },
    ]);

    await client.query(`INSERT INTO attendance_records (member_id, date, status) VALUES (4, '2027-01-01', 'in')`);
    const inserted = await client.query(`SELECT attendance_date::text AS attendance_date FROM attendance_records WHERE member_id = 4`);
    assert.equal(inserted.rows[0]?.attendance_date, "2027-01-01");

    const rollbackUrl = new URL("../../../../docs/sql/0010_attendance_date_compatibility.rollback.sql", import.meta.url);
    await client.query(await readFile(rollbackUrl, "utf8"));
    const rolledBack = await client.query(`
      SELECT member_id, date, status, note, coaching
      FROM attendance_records
      WHERE member_id <> 4
      ORDER BY id
    `);
    assert.deepEqual(rolledBack.rows, before.rows);
    const shadowColumn = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'attendance_records' AND column_name = 'attendance_date'
    `, [schema]);
    assert.equal(shadowColumn.rowCount, 0);
  } finally {
    await client.query("RESET search_path").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
  }
});
