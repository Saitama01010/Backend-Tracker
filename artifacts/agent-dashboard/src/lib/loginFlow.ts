export type LoginFlowState =
  | { mode: "login"; upgradeToken: null; username: null }
  | { mode: "password-upgrade"; upgradeToken: string; username: string };

export type LoginFlowAction =
  | { type: "password-upgrade-required"; upgradeToken: string; username: string }
  | { type: "reset" };

export interface PasswordUpgradeResponse {
  passwordChangeRequired: true;
  upgradeToken: string;
}

export interface AuthenticatedSession<TUser> {
  token: string;
  user: TUser;
}

interface SessionStorageWriter {
  setItem(key: string, value: string): void;
}

export function initialLoginFlowState(): LoginFlowState {
  return { mode: "login", upgradeToken: null, username: null };
}

export function loginFlowReducer(state: LoginFlowState, action: LoginFlowAction): LoginFlowState {
  if (action.type === "reset") return initialLoginFlowState();
  return {
    mode: "password-upgrade",
    upgradeToken: action.upgradeToken,
    username: action.username,
  };
}

export function isPasswordUpgradeResponse(value: unknown): value is PasswordUpgradeResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate["passwordChangeRequired"] === true
    && typeof candidate["upgradeToken"] === "string"
    && candidate["upgradeToken"].length > 0;
}

export function validatePasswordUpgradeForm(
  newPassword: string,
  confirmPassword: string,
  username: string,
): string | null {
  if (newPassword !== confirmPassword) return "Passwords do not match.";
  if (newPassword.length < 15 || !newPassword.trim()) {
    return "Password must be at least 15 characters.";
  }
  if (new TextEncoder().encode(newPassword).byteLength > 72) {
    return "Password must be no more than 72 UTF-8 bytes.";
  }
  const normalizedUsername = username.trim().toLowerCase();
  if (
    normalizedUsername.length >= 3
    && newPassword.toLowerCase().includes(normalizedUsername)
  ) {
    return "Password must not contain your username.";
  }
  return null;
}

export function persistAuthenticatedSession<TUser>(
  storage: SessionStorageWriter,
  session: AuthenticatedSession<TUser>,
): void {
  storage.setItem("tracker_token", session.token);
  storage.setItem("tracker_user", JSON.stringify(session.user));
}
