export const PASSWORD_POLICY_MESSAGE =
  "Password must be 12-128 characters and include at least three of: lowercase, uppercase, number, and symbol.";

export function validateNewPassword(password: unknown, username?: string): string | null {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    return PASSWORD_POLICY_MESSAGE;
  }
  const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]
    .filter((pattern) => pattern.test(password)).length;
  if (categories < 3) return PASSWORD_POLICY_MESSAGE;
  const normalizedUsername = username?.trim().toLowerCase();
  if (normalizedUsername && normalizedUsername.length >= 3 && password.toLowerCase().includes(normalizedUsername)) {
    return "Password must not contain the username.";
  }
  return null;
}
