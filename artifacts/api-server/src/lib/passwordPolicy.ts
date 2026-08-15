export const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 15 characters and no more than 72 UTF-8 bytes. Passphrases and spaces are allowed.";

export function validateNewPassword(password: unknown, username?: string): string | null {
  if (
    typeof password !== "string"
    || password.length < 15
    || !password.trim()
    || Buffer.byteLength(password, "utf8") > 72
  ) {
    return PASSWORD_POLICY_MESSAGE;
  }
  const normalizedUsername = username?.trim().toLowerCase();
  if (normalizedUsername && normalizedUsername.length >= 3 && password.toLowerCase().includes(normalizedUsername)) {
    return "Password must not contain the username.";
  }
  return null;
}
