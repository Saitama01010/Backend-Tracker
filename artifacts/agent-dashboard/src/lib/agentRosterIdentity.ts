import {
  canonicalizeAgentDisplayName,
  isValidAgentEmail,
  normalizeAgentArabicName,
  normalizeAgentEmail,
  normalizeAgentEnglishName,
} from "@workspace/api-zod/agent-identity";

export type RosterIdentityField = "name" | "arabicName" | "email";

export type RosterIdentityRecord = {
  id: number;
  name: string;
  arabicName?: string | null;
  email?: string | null;
};

export type RosterIdentityInput = {
  name: string;
  arabicName: string;
  email: string;
};

export function validateRosterIdentity(
  input: RosterIdentityInput,
  roster: readonly RosterIdentityRecord[],
  options: { excludeId?: number; requireEmail: boolean },
): Partial<Record<RosterIdentityField, string>> {
  const errors: Partial<Record<RosterIdentityField, string>> = {};
  const name = canonicalizeAgentDisplayName(input.name);
  const arabicName = canonicalizeAgentDisplayName(input.arabicName);
  const email = normalizeAgentEmail(input.email);

  if (!name) errors.name = "English name is required.";
  if (options.requireEmail && !email) {
    errors.email = "Email is required for new agents.";
  } else if (email && !isValidAgentEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  const others = roster.filter((agent) => agent.id !== options.excludeId);
  if (name && others.some((agent) => normalizeAgentEnglishName(agent.name) === normalizeAgentEnglishName(name))) {
    errors.name = "An agent with this English name already exists.";
  }
  if (arabicName && others.some(
    (agent) => agent.arabicName
      && normalizeAgentArabicName(agent.arabicName) === normalizeAgentArabicName(arabicName),
  )) {
    errors.arabicName = "An agent with this Arabic name already exists.";
  }
  if (email && others.some(
    (agent) => agent.email && normalizeAgentEmail(agent.email) === email,
  )) {
    errors.email = "An agent with this email already exists.";
  }

  return errors;
}
