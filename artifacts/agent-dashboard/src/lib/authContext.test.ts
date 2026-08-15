import assert from "node:assert/strict";
import test from "node:test";
import { canUserSeeTab, type AuthUser } from "./authContext.js";

const canonicalAgent: AuthUser = {
  id: 1,
  username: "canonical-agent-fixture",
  role: "view",
  permissions: ["view_metrics"],
  accessModel: "canonical",
  accessRole: "agent",
  allowedTabs: ["retention"],
};
const canonicalManager: AuthUser = {
  ...canonicalAgent,
  id: 2,
  username: "canonical-manager-fixture",
  accessRole: "manager",
  allowedTabs: ["nsf", "qa"],
};

test("canonical Agent and Manager see Onboarding only with the explicit tab grant", () => {
  assert.equal(canUserSeeTab(canonicalAgent, "onboarding"), false);
  assert.equal(canUserSeeTab(canonicalManager, "onboarding"), false);
  assert.equal(canUserSeeTab({ ...canonicalAgent, allowedTabs: ["retention", "onboarding"] }, "onboarding"), true);
  assert.equal(canUserSeeTab({ ...canonicalManager, allowedTabs: ["nsf", "qa", "onboarding"] }, "onboarding"), true);
});

test("Admin and legacy Onboarding tab behavior remains unchanged", () => {
  assert.equal(canUserSeeTab({ ...canonicalAgent, role: "admin", accessRole: "admin", allowedTabs: [] }, "onboarding"), true);
  assert.equal(canUserSeeTab({ ...canonicalAgent, accessModel: "legacy", accessRole: null, allowedTabs: null, teamAccess: null }, "onboarding"), true);
  assert.equal(canUserSeeTab({ ...canonicalAgent, accessModel: "legacy", accessRole: null, allowedTabs: null, teamAccess: "retention" }, "onboarding"), false);
});
