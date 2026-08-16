export interface ViolationsQueryInput {
  from: unknown;
  to: unknown;
}

export function parseViolationsQuery(input: Record<string, unknown>): ViolationsQueryInput {
  return { from: input["from"], to: input["to"] };
}
