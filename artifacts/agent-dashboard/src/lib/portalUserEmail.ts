import { isValidAgentEmail } from "@workspace/api-zod/agent-identity";

export function validateOptionalPortalUserEmail(value: string): string | null {
  return !value.trim() || isValidAgentEmail(value)
    ? null
    : "Enter a valid email address.";
}

export function validateRequiredPortalUserEmail(value: string): string | null {
  return value.trim() ? validateOptionalPortalUserEmail(value) : "Email is required for login.";
}
