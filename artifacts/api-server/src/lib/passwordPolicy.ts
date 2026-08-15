export const CURRENT_PASSWORD_POLICY_VERSION = 1;

export const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 15 characters and no more than 72 UTF-8 bytes. Passphrases and spaces are allowed.";

export function validateNewPassword(password: unknown): string | null {
  if (
    typeof password !== "string"
    || password.length < 15
    || !password.trim()
    || Buffer.byteLength(password, "utf8") > 72
  ) {
    return PASSWORD_POLICY_MESSAGE;
  }
  return null;
}
