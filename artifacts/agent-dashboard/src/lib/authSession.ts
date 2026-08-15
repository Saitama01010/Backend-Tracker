export const AUTH_TOKEN_KEY = "tracker_token";
export const AUTH_USER_KEY = "tracker_user";
export const AUTH_SESSION_BINDING_KEY = "tracker_session_binding";

export interface AuthSessionUser {
  role: string;
}

export interface AuthenticatedSession<TUser extends AuthSessionUser> {
  token: string;
  user: TUser;
  sessionBinding?: string;
}

export interface BrowserAuthStores {
  local: Storage;
  session: Storage;
}

function removeSession(storage: Storage): void {
  storage.removeItem(AUTH_TOKEN_KEY);
  storage.removeItem(AUTH_USER_KEY);
  storage.removeItem(AUTH_SESSION_BINDING_KEY);
}

function readSession<TUser extends AuthSessionUser>(
  storage: Storage,
  expected: "admin" | "temporary",
): AuthenticatedSession<TUser> | null {
  const token = storage.getItem(AUTH_TOKEN_KEY);
  const rawUser = storage.getItem(AUTH_USER_KEY);
  if (!token || !rawUser) return null;
  try {
    const user = JSON.parse(rawUser) as TUser;
    const isAdmin = user?.role === "admin";
    if ((expected === "admin") !== isAdmin) {
      removeSession(storage);
      return null;
    }
    const sessionBinding = storage.getItem(AUTH_SESSION_BINDING_KEY) ?? undefined;
    return { token, user, ...(sessionBinding ? { sessionBinding } : {}) };
  } catch {
    removeSession(storage);
    return null;
  }
}

export function readBrowserAuthSession<TUser extends AuthSessionUser>(
  stores: BrowserAuthStores,
): AuthenticatedSession<TUser> | null {
  return readSession<TUser>(stores.session, "temporary")
    ?? readSession<TUser>(stores.local, "admin");
}

export function persistBrowserAuthSession<TUser extends AuthSessionUser>(
  stores: BrowserAuthStores,
  session: AuthenticatedSession<TUser>,
): void {
  const persistent = session.user.role === "admin";
  const target = persistent ? stores.local : stores.session;
  const existingBinding = persistent ? null : target.getItem(AUTH_SESSION_BINDING_KEY);
  removeSession(stores.local);
  removeSession(stores.session);
  target.setItem(AUTH_TOKEN_KEY, session.token);
  target.setItem(AUTH_USER_KEY, JSON.stringify(session.user));
  const binding = session.sessionBinding ?? existingBinding;
  if (!persistent && binding) target.setItem(AUTH_SESSION_BINDING_KEY, binding);
}

export function clearBrowserAuthSession(stores: BrowserAuthStores): void {
  removeSession(stores.local);
  removeSession(stores.session);
}

export function browserAccessToken(stores: BrowserAuthStores): string | null {
  return readBrowserAuthSession(stores)?.token ?? null;
}

export function browserSessionBinding(stores: BrowserAuthStores): string | null {
  const session = readSession(stores.session, "temporary");
  return session?.sessionBinding ?? null;
}

export interface PasswordCredentialRuntime {
  createPasswordCredential(data: { id: string; password: string; name?: string }): unknown;
  store(credential: unknown): Promise<unknown>;
}

function browserPasswordCredentialRuntime(): PasswordCredentialRuntime | null {
  const credentialConstructor = (globalThis as typeof globalThis & {
    PasswordCredential?: new (data: { id: string; password: string; name?: string }) => unknown;
  }).PasswordCredential;
  if (!credentialConstructor || !globalThis.navigator?.credentials?.store) return null;
  return {
    createPasswordCredential: (data) => new credentialConstructor(data),
    store: (credential) => globalThis.navigator.credentials.store(credential as Credential),
  };
}

export async function saveAdminBrowserCredential<TUser extends AuthSessionUser & { username?: string }>(
  email: string,
  password: string,
  user: TUser,
  runtime: PasswordCredentialRuntime | null = browserPasswordCredentialRuntime(),
): Promise<boolean> {
  if (user.role !== "admin" || !email || !password || !runtime) return false;
  const credential = runtime.createPasswordCredential({ id: email, password, name: user.username });
  await runtime.store(credential);
  return true;
}

