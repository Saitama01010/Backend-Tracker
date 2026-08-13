const AGENT_EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/**
 * Canonical display cleanup shared by roster validation and persistence.
 * Capitalization is deliberately preserved for human-readable names.
 */
export function canonicalizeAgentDisplayName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function normalizeAgentEnglishName(value: string): string {
  return canonicalizeAgentDisplayName(value).toLowerCase();
}

export function normalizeAgentArabicName(value: string): string {
  return canonicalizeAgentDisplayName(value);
}

export function normalizeAgentEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidAgentEmail(value: string): boolean {
  return AGENT_EMAIL_PATTERN.test(normalizeAgentEmail(value));
}
