import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeAgentDisplayName,
  normalizeAgentArabicName,
  normalizeAgentEmail,
  normalizeAgentEnglishName,
} from "@workspace/api-zod/agent-identity";
import { validateRosterIdentity } from "./agentRosterIdentity";

test("canonical roster normalization handles English, Arabic, and email identities", () => {
  assert.equal(normalizeAgentEnglishName("Anna Stone"), "anna stone");
  assert.equal(normalizeAgentEnglishName(" anna stone "), "anna stone");
  assert.equal(normalizeAgentEnglishName("Anna   Stone"), "anna stone");
  assert.equal(normalizeAgentEmail("Agent@Company.com"), "agent@company.com");
  assert.equal(normalizeAgentEmail(" agent@company.com "), "agent@company.com");
  assert.equal(normalizeAgentArabicName("  آمال   حسن  "), "آمال حسن");
  assert.equal(
    normalizeAgentArabicName("ﺁﻣﺎﻝ ﺣﺴﻦ"),
    normalizeAgentArabicName("آمال حسن"),
  );
  assert.equal(canonicalizeAgentDisplayName("  Anna   Stone "), "Anna Stone");
});

test("client validation is global, includes inactive identities, and excludes the edited ID", () => {
  const roster = [
    { id: 1, name: "Anna Stone", arabicName: "آمال حسن", email: "anna@company.com", active: false },
    { id: 2, name: "Unique Agent", arabicName: null, email: null, active: true },
  ];
  assert.deepEqual(validateRosterIdentity(
    { name: " anna   stone ", arabicName: " آمال  حسن ", email: "ANNA@COMPANY.COM" },
    roster,
    { requireEmail: true },
  ), {
    name: "An agent with this English name already exists.",
    arabicName: "An agent with this Arabic name already exists.",
    email: "An agent with this email already exists.",
  });
  assert.deepEqual(validateRosterIdentity(
    { name: "Anna Stone", arabicName: "آمال حسن", email: "anna@company.com" },
    roster,
    { excludeId: 1, requireEmail: false },
  ), {});
  assert.deepEqual(validateRosterIdentity(
    { name: "New Agent", arabicName: "", email: "not-an-email" },
    roster,
    { requireEmail: true },
  ), { email: "Enter a valid email address." });
});
