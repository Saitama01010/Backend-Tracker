import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateOptionalPortalUserEmail } from "./portalUserEmail.js";

test("Portal account email is optional and validated when supplied", () => {
  assert.equal(validateOptionalPortalUserEmail(""), null);
  assert.equal(validateOptionalPortalUserEmail("   "), null);
  assert.equal(validateOptionalPortalUserEmail("Admin.User+dashboard@example.com"), null);
  assert.equal(validateOptionalPortalUserEmail("not-an-email"), "Enter a valid email address.");
});

test("Canonical User Management exposes email for create and edit without requiring a roster link", async () => {
  const source = await readFile(new URL("../components/CanonicalUserManagementPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /type PortalUser = \{[\s\S]*email\?: string \| null/);
  assert.match(source, /type UserForm = \{[\s\S]*email: string/);
  assert.match(source, /type="email"/);
  assert.match(source, /email: newForm\.email\.trim\(\) \|\| null/);
  assert.match(source, /email: editForm\.email\.trim\(\) \|\| null/);
});
