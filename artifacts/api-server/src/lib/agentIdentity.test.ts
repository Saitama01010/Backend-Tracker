import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeAgentDisplayName,
  isValidAgentEmail,
  normalizeAgentArabicName,
  normalizeAgentEmail,
  normalizeAgentEnglishName,
} from "@workspace/api-zod/agent-identity";

test("English roster identity normalization is Unicode-aware, trimmed, collapsed, and case-insensitive", () => {
  assert.equal(normalizeAgentEnglishName("Anna Stone"), "anna stone");
  assert.equal(normalizeAgentEnglishName(" anna stone "), "anna stone");
  assert.equal(normalizeAgentEnglishName("Anna   Stone"), "anna stone");
  assert.equal(canonicalizeAgentDisplayName("  ANNA   Stone  "), "ANNA Stone");
});

test("Arabic roster identity normalization uses NFKC and conservative whitespace cleanup", () => {
  assert.equal(normalizeAgentArabicName("  آمال   حسن  "), "آمال حسن");
  assert.equal(
    normalizeAgentArabicName("ﺁﻣﺎﻝ ﺣﺴﻦ"),
    normalizeAgentArabicName("آمال حسن"),
  );
  assert.notEqual(normalizeAgentArabicName("احمد"), normalizeAgentArabicName("أحمد"));
});

test("email normalization trims and lowercases without provider-specific rewriting", () => {
  assert.equal(normalizeAgentEmail("Agent@Company.com"), "agent@company.com");
  assert.equal(normalizeAgentEmail(" agent@company.com "), "agent@company.com");
  assert.equal(normalizeAgentEmail("agent+roster@company.com"), "agent+roster@company.com");
  assert.equal(isValidAgentEmail("agent@company.com"), true);
  assert.equal(isValidAgentEmail("not-an-email"), false);
});
