import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateOptionalPortalUserEmail, validateRequiredPortalUserEmail } from "./portalUserEmail.js";

test("Portal account email is optional and validated when supplied", () => {
  assert.equal(validateOptionalPortalUserEmail(""), null);
  assert.equal(validateOptionalPortalUserEmail("   "), null);
  assert.equal(validateOptionalPortalUserEmail("Admin.User+dashboard@example.com"), null);
  assert.equal(validateOptionalPortalUserEmail("not-an-email"), "Enter a valid email address.");
});

test("active login accounts require a valid email", () => {
  assert.equal(validateRequiredPortalUserEmail(""), "Email is required for login.");
  assert.equal(validateRequiredPortalUserEmail("not-an-email"), "Enter a valid email address.");
  assert.equal(validateRequiredPortalUserEmail("Admin.User+dashboard@example.com"), null);
});

test("Canonical User Management uses roster email for Agents and Portal email for other active accounts", async () => {
  const source = await readFile(new URL("../components/CanonicalUserManagementPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /type PortalUser = \{[\s\S]*email\?: string \| null/);
  assert.match(source, /type UserForm = \{[\s\S]*email: string/);
  assert.match(source, /type="email"/);
  assert.match(source, /email: newForm\.email\.trim\(\) \|\| null/);
  assert.match(source, /email: editForm\.email\.trim\(\) \|\| null/);
  assert.match(source, /hasRosterLoginEmail/);
  assert.match(source, /validateLoginEmail\(newForm, true\)/);
  assert.match(source, /!!newForm\.email\.trim\(\) \|\| hasRosterLoginEmail\(newForm\)/);
  assert.match(source, /Portal Login Email/);
  assert.match(source, /Uses Agent Roster email/);
});
