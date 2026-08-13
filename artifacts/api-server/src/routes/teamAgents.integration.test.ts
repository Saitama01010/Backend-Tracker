import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import test from "node:test";

const configuredUrl = process.env["AGENT_ROSTER_TEST_DATABASE_URL"]?.trim();
const databaseUrl = process.env["DATABASE_URL"]?.trim();
const enabled = Boolean(
  configuredUrl
  && databaseUrl
  && configuredUrl === databaseUrl
  && new URL(configuredUrl).pathname.toLowerCase().includes("test"),
);

test("Agent Roster API enforces canonical identity and database concurrency", { skip: !enabled }, async (t) => {
  const [{ default: express }, { default: router }, { pool }] = await Promise.all([
    import("express"),
    import("./teamAgents.js"),
    import("@workspace/db"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      userId: 1,
      username: "agent-roster-test-admin",
      role: "admin",
      permissions: [],
    };
    req.log = { error: () => undefined } as unknown as typeof req.log;
    next();
  });
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const unique = `${process.pid}-${Date.now()}`;
  const prefix = `roster fixture ${unique}`;
  const post = (body: Record<string, unknown>) => fetch(`${origin}/team-agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const patch = (id: number, body: Record<string, unknown>) => fetch(`${origin}/team-agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const createBody = (suffix: string, overrides: Record<string, unknown> = {}) => ({
    name: `Roster Fixture ${unique} ${suffix}`,
    arabicName: null,
    email: `roster-${unique}-${suffix.toLowerCase().replace(/\s+/g, "-")}@example.test`,
    shift: "9-5",
    team: "retention",
    ...overrides,
  });
  const expectConflict = async (
    response: Response,
    error: string,
    field: string,
  ) => {
    assert.equal(response.status, 409);
    const body = await response.json() as { error: string; field: string; message: string };
    assert.equal(body.error, error);
    assert.equal(body.field, field);
    assert.ok(body.message.length > 0);
  };

  try {
    let canonicalId = 0;
    await t.test("valid create succeeds and persists normalized email", async () => {
      const response = await post(createBody("Canonical", {
        name: `  Roster   Fixture ${unique} Canonical  `,
        email: ` ROSTER-${unique}-CANONICAL@EXAMPLE.TEST `,
      }));
      assert.equal(response.status, 201);
      const body = await response.json() as { id: number; name: string; email: string };
      canonicalId = body.id;
      assert.equal(body.name, `Roster Fixture ${unique} Canonical`);
      assert.equal(body.email, `roster-${unique}-canonical@example.test`);
    });

    await t.test("exact, case, and whitespace English duplicates return deterministic 409", async () => {
      for (const [label, name] of [
        ["exact", `Roster Fixture ${unique} Canonical`],
        ["case", `roster fixture ${unique} canonical`],
        ["whitespace", ` Roster   Fixture ${unique}   Canonical `],
      ]) {
        const response = await post(createBody(`English ${label}`, { name }));
        await expectConflict(response, "AGENT_ENGLISH_NAME_ALREADY_EXISTS", "name");
      }
    });

    let arabicOwnerId = 0;
    await t.test("Arabic duplicates return deterministic 409", async () => {
      const owner = await post(createBody("Arabic Owner", { arabicName: "آمال حسن" }));
      assert.equal(owner.status, 201);
      arabicOwnerId = (await owner.json() as { id: number }).id;
      const duplicate = await post(createBody("Arabic Duplicate", { arabicName: "  آمال   حسن " }));
      await expectConflict(duplicate, "AGENT_ARABIC_NAME_ALREADY_EXISTS", "arabicName");
    });

    await t.test("email and email-case duplicates return deterministic 409", async () => {
      let index = 0;
      for (const email of [
        `roster-${unique}-canonical@example.test`,
        ` ROSTER-${unique}-CANONICAL@EXAMPLE.TEST `,
      ]) {
        index += 1;
        const response = await post(createBody(`Email Duplicate ${index}`, { email }));
        await expectConflict(response, "AGENT_EMAIL_ALREADY_EXISTS", "email");
      }
    });

    await t.test("malformed and missing new-agent emails fail validation", async () => {
      const malformed = await post(createBody("Malformed Email", { email: "not-an-email" }));
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), {
        error: "INVALID_AGENT_EMAIL",
        field: "email",
        message: "Enter a valid email address.",
      });
      const missing = await post(createBody("Missing Email", { email: "" }));
      assert.equal(missing.status, 400);
      assert.equal((await missing.json() as { error: string }).error, "AGENT_EMAIL_REQUIRED");
    });

    await t.test("inactive identities remain reserved", async () => {
      const inactive = await post(createBody("Inactive", { active: false }));
      assert.equal(inactive.status, 201);
      const duplicate = await post(createBody("Inactive Duplicate", {
        name: `roster fixture ${unique} inactive`,
      }));
      await expectConflict(duplicate, "AGENT_ENGLISH_NAME_ALREADY_EXISTS", "name");
    });

    let secondId = 0;
    await t.test("updates exclude the same immutable ID and preserve ordinary edits", async () => {
      const second = await post(createBody("Second", { arabicName: "ليلى منصور" }));
      assert.equal(second.status, 201);
      secondId = (await second.json() as { id: number }).id;

      const unchanged = await patch(canonicalId, {
        name: `Roster Fixture ${unique} Canonical`,
        email: `roster-${unique}-canonical@example.test`,
      });
      assert.equal(unchanged.status, 200);
      assert.equal((await unchanged.json() as { id: number }).id, canonicalId);

      const shift = await patch(canonicalId, { shift: "Night" });
      assert.equal(shift.status, 200);
      assert.equal((await shift.json() as { shift: string }).shift, "Night");

      const department = await patch(canonicalId, { team: "cs" });
      assert.equal(department.status, 200);
      assert.equal((await department.json() as { team: string }).team, "cs");

      const email = await patch(canonicalId, { email: `roster-${unique}-canonical-new@example.test` });
      assert.equal(email.status, 200);
      assert.equal(
        (await email.json() as { email: string }).email,
        `roster-${unique}-canonical-new@example.test`,
      );
    });

    await t.test("updates cannot take another identity's English, Arabic, or email value", async () => {
      await expectConflict(
        await patch(canonicalId, { name: `Roster Fixture ${unique} Second` }),
        "AGENT_ENGLISH_NAME_ALREADY_EXISTS",
        "name",
      );
      await expectConflict(
        await patch(canonicalId, { arabicName: " ليلى   منصور " }),
        "AGENT_ARABIC_NAME_ALREADY_EXISTS",
        "arabicName",
      );
      await expectConflict(
        await patch(canonicalId, { email: `ROSTER-${unique}-SECOND@EXAMPLE.TEST` }),
        "AGENT_EMAIL_ALREADY_EXISTS",
        "email",
      );
      assert.ok(secondId > 0 && arabicOwnerId > 0);
    });

    await t.test("simultaneous POST requests cannot both create one normalized identity", async () => {
      const [first, second] = await Promise.all([
        post(createBody("Concurrent Post A", {
          name: `Roster Fixture ${unique} Concurrent Post`,
        })),
        post(createBody("Concurrent Post B", {
          name: ` roster   fixture ${unique} concurrent post `,
        })),
      ]);
      assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [201, 409]);
      const conflict = first.status === 409 ? first : second;
      await expectConflict(conflict, "AGENT_ENGLISH_NAME_ALREADY_EXISTS", "name");
    });

    await t.test("two concurrent database inserts cannot both claim one normalized identity", async () => {
      const normalized = `${prefix} concurrent`;
      const insert = (variant: string, email: string) => pool.query(
        `INSERT INTO team_agents
          (name, name_normalized, arabic_name, arabic_name_normalized, email, email_normalized, shift, team, active)
         VALUES ($1, $2, NULL, NULL, $3, $3, '9-5', 'retention', true)
         RETURNING id`,
        [variant, normalized, email],
      );
      const attempts = await Promise.allSettled([
        insert(`Roster Fixture ${unique} Concurrent`, `roster-${unique}-concurrent-a@example.test`),
        insert(` roster   fixture ${unique} concurrent `, `roster-${unique}-concurrent-b@example.test`),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
      assert.equal((rejected?.reason as { code?: string }).code, "23505");
      assert.equal(
        (rejected?.reason as { constraint?: string }).constraint,
        "team_agents_name_normalized_uidx",
      );
    });

    await t.test("database checks reject normalized values that disagree with display identity", async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO team_agents
            (name, name_normalized, arabic_name, arabic_name_normalized, email, email_normalized, shift, team, active)
           VALUES ($1, $2, NULL, NULL, $3, $3, '9-5', 'retention', true)`,
          [
            `Roster Fixture ${unique} Database Authority`,
            `${prefix} different identity`,
            `roster-${unique}-database-authority@example.test`,
          ],
        ),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
          && (error as { constraint?: string }).constraint === "team_agents_name_normalized_required",
      );
    });

    await t.test("DELETE compatibility route deactivates without deleting the canonical ID", async () => {
      const response = await fetch(`${origin}/team-agents/${secondId}`, { method: "DELETE" });
      assert.equal(response.status, 204);
      const result = await pool.query<{ active: boolean }>(
        "SELECT active FROM team_agents WHERE id = $1",
        [secondId],
      );
      assert.deepEqual(result.rows, [{ active: false }]);
    });

    await t.test("migration aborts before schema changes when legacy duplicates exist", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          ALTER TABLE team_agents
            DROP COLUMN name_normalized CASCADE,
            DROP COLUMN arabic_name_normalized CASCADE,
            DROP COLUMN email CASCADE,
            DROP COLUMN email_normalized CASCADE
        `);
        await client.query(
          `INSERT INTO team_agents (name, arabic_name, shift, team, active)
           VALUES ($1, NULL, '9-5', 'retention', false),
                  ($2, NULL, 'Night', 'cs', true)`,
          [`Roster Fixture ${unique} Migration Duplicate`, ` roster   fixture ${unique} migration duplicate `],
        );
        const migrationPath = fileURLToPath(
          new URL("../../../../lib/db/drizzle/0013_canonical_agent_roster_identity.sql", import.meta.url),
        );
        const migrationSql = await readFile(migrationPath, "utf8");
        await assert.rejects(
          client.query(migrationSql),
          /AGENT_IDENTITY_MIGRATION_BLOCKED_BY_EXISTING_DUPLICATES:ENGLISH_NAME/,
        );
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });
  } finally {
    await pool.query("DELETE FROM team_agents WHERE name_normalized LIKE $1", [`${prefix}%`]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
