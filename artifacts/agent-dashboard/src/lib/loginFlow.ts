export type LoginFlowState =
  | { mode: "login"; upgradeToken: null; email: null }
  | { mode: "password-upgrade"; upgradeToken: string; email: string };

export type LoginFlowAction =
  | { type: "password-upgrade-required"; upgradeToken: string; email: string }
  | { type: "reset" };

export interface PasswordUpgradeResponse {
  passwordChangeRequired: true;
  upgradeToken: string;
}

export function initialLoginFlowState(): LoginFlowState {
  return { mode: "login", upgradeToken: null, email: null };
}

export function loginFlowReducer(state: LoginFlowState, action: LoginFlowAction): LoginFlowState {
  if (action.type === "reset") return initialLoginFlowState();
  return {
    mode: "password-upgrade",
    upgradeToken: action.upgradeToken,
    email: action.email,
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
): string | null {
  if (newPassword !== confirmPassword) return "Passwords do not match.";
  if (newPassword.length < 15 || !newPassword.trim()) {
    return "Password must be at least 15 characters.";
  }
  if (new TextEncoder().encode(newPassword).byteLength > 72) {
    return "Password must be no more than 72 UTF-8 bytes.";
  }
  return null;
}
