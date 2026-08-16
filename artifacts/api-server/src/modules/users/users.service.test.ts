import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PASSWORD_POLICY_VERSION } from "../../lib/passwordPolicy.js";
import type {
  AdminCandidate,
  CanonicalAgentAccessRecord,
  PortalUserCreate,
  PortalUserGrantUpdate,
  PortalUserListData,
  PortalUserListRow,
  PortalUserRecord,
  PortalUserUpdates,
  UsersRepository,
} from "./users.repository.js";
import { UserRequestError, UsersService } from "./users.service.js";

function userRecord(overrides: Partial<PortalUserListRow> = {}): PortalUserListRow {
  return {
    id: 2,
    username: "existing",
    email: "existing@example.com",
    emailNormalized: "existing@example.com",
    passwordHash: "stored-hash",
    passwordPolicyVersion: CURRENT_PASSWORD_POLICY_VERSION,
    passwordChangedAt: new Date("2026-08-01T00:00:00.000Z"),
    role: "view",
    permissions: "[]",
    teamAccess: null,
    allowedTabs: null,
    allowedAgents: null,
    allowedSubTabs: null,
    lockToToday: false,
    samiaCurse: false,
    hideBackendStats: false,
    accessRole: null,
    teamAgentId: null,
    primaryTeam: null,
    active: true,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    canonicalAgentId: null,
    canonicalAgentName: null,
    canonicalAgentTeam: null,
    canonicalAgentActive: null,
    canonicalAgentEmail: null,
    ...overrides,
  };
}

class FakeUsersRepository implements UsersRepository {
  users: PortalUserListRow[] = [userRecord()];
  created: { values: PortalUserCreate; grants: PortalUserGrantUpdate } | null = null;
  updated: { id: number; updates: PortalUserUpdates; grants: PortalUserGrantUpdate | null; revokeSessions: boolean } | null = null;

  async loadCanonicalAgent(_id: number): Promise<CanonicalAgentAccessRecord | null> { return null; }
  async loadRosterEmailNormalized(_id: number) { return null; }
  async findRosterIdentityByEmail(_email: string) { return null; }
  async listUsersData(): Promise<PortalUserListData> {
    return { users: this.users, teamGrants: [], tabGrants: [] };
  }
  async listAdminCandidates(): Promise<AdminCandidate[]> {
    return this.users.map(({ id, role, accessRole, active }) => ({ id, role, accessRole, active }));
  }
  async findUser(id: number): Promise<PortalUserRecord | null> {
    return this.users.find((user) => user.id === id) ?? null;
  }
  async createUser(values: PortalUserCreate, grants: PortalUserGrantUpdate): Promise<number> {
    this.created = { values, grants };
    const id = 3;
    this.users.push(userRecord({
      ...values,
      id,
      canonicalAgentId: null,
      canonicalAgentName: null,
      canonicalAgentTeam: null,
      canonicalAgentActive: null,
      canonicalAgentEmail: null,
    }));
    return id;
  }
  async updateUser(input: { id: number; updates: PortalUserUpdates; grants: PortalUserGrantUpdate | null; revokeSessions: boolean }) {
    this.updated = input;
    const user = this.users.find((candidate) => candidate.id === input.id);
    if (user) Object.assign(user, input.updates);
  }
  async deleteUser(id: number) { this.users = this.users.filter((user) => user.id !== id); }
}

test("User Administration list and create preserve safe output and password metadata", async () => {
  const repository = new FakeUsersRepository();
  const service = new UsersService(repository);
  const listed = await service.listUsers();
  assert.equal(Object.prototype.hasOwnProperty.call(listed[0], "passwordHash"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(listed[0], "emailNormalized"), false);
  assert.equal(listed[0]?.loginEmail, "existing@example.com");

  const created = await service.createUser({
    username: " NewAdmin ",
    email: "NewAdmin@Example.com",
    password: "StrongPassword123!",
    accessRole: "admin",
    teamGrants: [],
    tabGrants: [],
  });
  assert.equal(repository.created?.values.username, "newadmin");
  assert.equal(repository.created?.values.emailNormalized, "newadmin@example.com");
  assert.equal(repository.created?.values.passwordPolicyVersion, CURRENT_PASSWORD_POLICY_VERSION);
  assert.notEqual(repository.created?.values.passwordHash, "StrongPassword123!");
  assert.equal(Object.prototype.hasOwnProperty.call(created ?? {}, "passwordHash"), false);
});

test("User Administration password changes preserve transactional session revocation", async () => {
  const repository = new FakeUsersRepository();
  const service = new UsersService(repository);
  await service.updateUser({
    actorId: 1,
    id: "2",
    body: { password: "AnotherStrongPassword123!" },
  });
  assert.equal(repository.updated?.id, 2);
  assert.equal(repository.updated?.revokeSessions, true);
  assert.equal(repository.updated?.updates.passwordPolicyVersion, CURRENT_PASSWORD_POLICY_VERSION);
  assert.ok(repository.updated?.updates.passwordChangedAt instanceof Date);

  await assert.rejects(
    service.updateUser({ actorId: 2, id: "2", body: { active: false } }),
    (error) => error instanceof UserRequestError && error.message === "Cannot deactivate or demote your own account",
  );
});
