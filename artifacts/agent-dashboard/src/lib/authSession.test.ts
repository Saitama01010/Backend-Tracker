import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_SESSION_BINDING_KEY,
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
  browserAccessToken,
  browserSessionBinding,
  clearBrowserAuthSession,
  persistBrowserAuthSession,
  readBrowserAuthSession,
  saveAdminBrowserCredential,
  type PasswordCredentialRuntime,
} from "./authSession.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function stores() {
  return { local: new MemoryStorage(), session: new MemoryStorage() };
}

test("admins persist in local storage without an application-stored password", () => {
  const storage = stores();
  persistBrowserAuthSession(storage, {
    token: "admin-access-token",
    user: { role: "admin", username: "admin" },
  });
  assert.equal(storage.local.getItem(AUTH_TOKEN_KEY), "admin-access-token");
  assert.equal(storage.session.getItem(AUTH_TOKEN_KEY), null);
  assert.doesNotMatch(storage.local.getItem(AUTH_USER_KEY) ?? "", /password/i);
  assert.equal(storage.local.getItem(AUTH_SESSION_BINDING_KEY), null);
  assert.equal(browserAccessToken(storage), "admin-access-token");
});

test("agents and managers persist only in tab-scoped session storage", () => {
  for (const role of ["view", "edit"]) {
    const storage = stores();
    persistBrowserAuthSession(storage, {
      token: `${role}-access-token`,
      user: { role },
      sessionBinding: `${role}-tab-binding`,
    });
    assert.equal(storage.local.length, 0);
    assert.equal(storage.session.getItem(AUTH_TOKEN_KEY), `${role}-access-token`);
    assert.equal(browserSessionBinding(storage), `${role}-tab-binding`);
    assert.equal(readBrowserAuthSession(storage)?.user.role, role);
    clearBrowserAuthSession(storage);
    assert.equal(storage.session.length, 0);
  }
});

test("legacy non-admin local storage is rejected after the persistence policy change", () => {
  const storage = stores();
  storage.local.setItem(AUTH_TOKEN_KEY, "legacy-agent-token");
  storage.local.setItem(AUTH_USER_KEY, JSON.stringify({ role: "view" }));
  assert.equal(readBrowserAuthSession(storage), null);
  assert.equal(storage.local.length, 0);
});

test("the browser credential manager is invoked only after an admin login", async () => {
  const stored: unknown[] = [];
  const runtime: PasswordCredentialRuntime = {
    createPasswordCredential: (data) => ({ browserManaged: data }),
    store: async (credential) => { stored.push(credential); return credential; },
  };
  assert.equal(await saveAdminBrowserCredential(
    "admin@example.test", "admin passphrase only in memory", { role: "admin", username: "admin" }, runtime,
  ), true);
  assert.equal(stored.length, 1);
  assert.equal(await saveAdminBrowserCredential(
    "agent@example.test", "agent passphrase only in memory", { role: "view", username: "agent" }, runtime,
  ), false);
  assert.equal(await saveAdminBrowserCredential(
    "manager@example.test", "manager passphrase only in memory", { role: "edit", username: "manager" }, runtime,
  ), false);
  assert.equal(stored.length, 1);
});
